# ADR: N-of-M Panel Arbitration for Casper Dispute Resolution

## 1. Title
Add an opt-in N-of-M arbiter panel as an alternative to the single-arbiter dispute
resolution path in `AgentSkillRegistry` (contracts-odra), for the Casper Agentic
Buildathon submission.

## 2. Context
KARMA's existing dispute-resolution path (P1-A) trusts one governance-appointed
arbiter to adjudicate every contested job. A rival buildathon project ("Casproof")
publicly critiqued single-arbiter designs as a centralization/trust weak point.
KARMA's own roadmap already listed "N-of-M arbitration" as a known gap. The user
directed research into competitor repos and KARMA's own internals to find the
highest-leverage improvements ranked by effort/effectiveness (deadline explicitly
excluded from scoring, per the user's instruction), then asked for this item to go
through a full spec → audit-design → plan → execute cycle rather than being
special-cased.

Constraints surfaced during design (recorded in
`docs/super-skills/specs/2026-07-22-panel-arbitration-design.md`, Gate Result: PASS
WITH FLAGS):
- Must not touch the bond economics of the existing single-arbiter path (already
  live-demoed, evidence published in `DEMO_CASPER.md`).
- Needed a tie-breaking guarantee (odd panel size + strict-majority threshold,
  chosen over the initially-discussed "arbiter re-vote" approach after the user
  proposed it directly).
- Needed a participation incentive so a panel of arbiters actually forms in
  practice (flat per-vote fee, chosen over majority-only payment to avoid an
  incentive to copy/herd toward the expected majority).
- A mid-dispute governance change to the panel (new members added/removed) must
  never be able to invalidate an in-flight vote tally (audit-design HIGH finding).

## 3. Decision
Added `dispute_result_via_panel` / `cast_panel_vote` / `resolve_panel_default` as
new, additive entry points alongside (never replacing) the existing
`dispute_result` / `arbitrate` / `resolve_default_concede` single-arbiter path.
Both paths share one settlement code path (`settle_dispute_verdict`, extracted
verbatim from `arbitrate`'s original body — Task 2, the plan's only HIGH-risk
task) so a fund-movement/reputation bug can't diverge between the two modes
[verified 2026-07-22 — re-diffed against the Task 1/2 patch: the extraction
moves the existing match arms into a new private method unchanged, only
`d.dispute_bond`/`d.provider_bond` become parameters and the event emit moves
to the caller].
Panel composition, threshold, and fee are governance-managed (same
propose/approve/execute + timelock lifecycle as every other governance action)
but are **snapshotted onto the job's own storage at dispute-post time**
(`job_panel_snapshot` / `job_panel_threshold_snapshot` /
`panel_arbiter_fee_collected`) — `cast_panel_vote` reads only the snapshot, never
live governance state, so a governance change mid-dispute cannot alter an
already-posted dispute's terms. Panel shape is validated (odd size,
`MIN_ARBITER_PANEL_SIZE=3..=MAX_ARBITER_PANEL_SIZE=9`, `threshold =
panel.len()/2 + 1`, no duplicates) at both propose time and execute time
(defense-in-depth against a race between proposal creation and execution)
[verified 2026-07-22 — `validate_panel_shape` is called from both
`propose_set_arbiter_panel` (line 1306) and `execute_proposal`'s
`SetArbiterPanel` arm (line 1674)]. A
single arbiter can no longer unilaterally settle a panel-mode dispute (a guard
added to `arbitrate()` mid-implementation, after writing a test that initially
tried to document the opposite as acceptable — see Section 10).
`distribute_panel_fee` pays every voter (not just the winning side) via the
existing pull-payment ledger, with the last voter absorbing the integer-division
remainder (same pattern as `settle_completion`'s composite-skill payout).
`resolve_panel_default` is a liveness backstop: after `PANEL_VOTE_WINDOW` elapses
without reaching threshold, it defaults to `ProviderAtFault` (mirroring
`resolve_default_concede`'s direction) and still pays whichever arbiters did vote.

The TypeScript mirror (`live_client.ts` + `casper.tool.ts`) exposes all of this
as new MCP tools. Two corrections were made against the plan's own draft code
during implementation, both caught by reading the actual Rust source rather than
trusting the plan: `dispute_result_via_panel` is `#[odra(payable)]` [verified
2026-07-22 — the attribute sits immediately above the `pub fn` in
`agent_skill_registry.rs`] with
`attached_value == required_bond + panel_arbiter_fee`, so the client method uses
`submitPayable` with an explicit combined amount, not `submit`; and
`proposeSetPanelArbiterFee` was in the plan's `CasperClientLike` Pick-list but had
no corresponding MCP tool in the plan's draft, which would have left it
uncallable dead code — a `casper_propose_set_panel_arbiter_fee` tool was added,
and `casper_get_governance_state` was extended to surface the panel/threshold
that were otherwise read-but-never-called.

## 4. Status
ACCEPTED

## 5. Consequences
**Improved:**
- Requesters can opt into multi-party dispute review instead of trusting one
  arbiter, directly answering the "verify-then-act, single-trust-point" class of
  critique aimed at KARMA's dispute design.
- Zero risk to the existing single-arbiter path's already-published demo
  evidence — every new entry point is additive; `settle_dispute_verdict`'s
  extraction was confirmed behavior-preserving by an independent reviewer
  subagent (CPT + STRIDE lenses, Tier 3) before Tasks 3-8 proceeded.
- A participation-fee market for "dispute arbitration as a service" becomes
  possible on top of this primitive (the user's own framing when approving the
  incentive design).

**Worsened / new surface:**
- Two parallel dispute-settlement entry-point families now exist
  (single-arbiter vs. panel) instead of one — `dispute_arbitration_mode` must be
  checked correctly everywhere a dispute is read or acted on; a missed check is
  the most likely future bug class here (see Known Debts).
- Panel governance (who's on the panel, the fee) is a new lever governance can
  pull; a misconfigured panel (e.g. proposing a panel that then gets left with a
  fee of 0) degrades to "technically live but no economic incentive to
  participate" rather than reverting outright — this is an intentional design
  choice (fee=0 is a valid, if weak, governance default) but worth flagging.
- No dashboard/indexer support yet for panel-mode disputes specifically (the
  read-only dashboard item, #1 in the broader research list, remains explicitly
  deferred/un-started — separate from this feature).

## 6. Alternatives Considered
- **Arbiter re-vote on tie** (re-run arbitration with the same panel until a
  majority emerges) — rejected by the user directly in favor of eliminating ties
  by construction (odd panel size + strict majority), which is simpler to reason
  about and has no liveness risk from a panel that keeps tying.
- **Majority-only fee payment** (pay only arbiters who voted with the winning
  side) — rejected because it creates an incentive to copy/herd toward the
  expected majority rather than vote independently; flat per-vote payment removes
  that incentive at the cost of a slightly higher total payout per dispute.
- **Reading live governance panel state at vote time** instead of snapshotting —
  rejected per the audit-design HIGH finding: a governance change mid-dispute
  could otherwise invalidate votes already cast or let a newly-added arbiter vote
  on a dispute they weren't part of when it was posted.

## 7. Evidence
- Rust: `cargo +nightly test --lib` in `contracts-odra/` — **155 passed, 0
  failed** [verified 2026-07-22], including `escrow_is_conserved_across_panel_arbitrated_dispute`
  and `reputation_stays_within_bounds_over_many_panel_rounds` (proptest,
  `ProptestConfig::with_cases(64)`) and ~25 new `p1b_*` unit tests covering panel
  lifecycle, vote tallying, fee distribution, and the default-liveness backstop.
- TypeScript: `pnpm test` — **844 passed, 2 failed** (same 2 pre-existing,
  unrelated failures as the pre-feature baseline of 837 passed: a
  `plugin_external_runner.test.ts` permission-hardening pair that depends on a
  local `tsc` compile step, and an `x402_casper` suite that fails to import
  `@casper-ecosystem/casper-eip-712`, a package missing from this environment —
  neither touches any file this feature changed) [verified 2026-07-22].
- `pnpm typecheck` — no new errors attributable to any file this feature touched
  (same 4 pre-existing errors as baseline: 2x missing `@casper-ecosystem/casper-eip-712`,
  1x missing `@anthropic-ai/sdk`, 1x pre-existing implicit-any in
  `llm_strategy.ts`) [verified 2026-07-22].
- Independent subagent review (specialist-review, CPT + STRIDE lenses, Tier 3)
  of Tasks 1-2 confirmed: (a) Odra's `Mapping`/`Var` storage keys are derived
  from positional struct-declaration order, not field name, making the new
  storage fields' append-only placement load-bearing and correctly placed; (b)
  the `arbitrate()` → `settle_dispute_verdict()` extraction is exactly
  behavior-preserving, no logic changed.
- Field-index cross-check (`odra_storage_key.ts`, indices 26-33): every new
  index's dictionary-item digest independently verified against
  `python3 -c "import hashlib; ..."` (`hashlib.blake2b`), matching the
  TypeScript `odraMappingDictionaryKey` output byte-for-byte — see
  `src/__tests__/casper_odra_storage_key.test.ts`.

## 8. Owner
**Eilodon (repository owner) — implemented with Claude Code agent assistance,
session dated 2026-07-22.**

## 8b. Known Debts (PATTERN-DEBT)
No `docs/super-skills/pattern-debt.md` exists yet in this repository — this is
the first ADR recorded for it. No PATTERN-DEBT entries to reference. Two
forward-looking debts worth tracking once that ledger exists:
  - PATTERN-DEBT-dual-dispute-mode-checks: every future dispute-related entry
    point or off-chain reader must branch on `dispute_arbitration_mode` (or the
    snapshot mappings) correctly — no lint/type-level enforcement exists that a
    new dispute-touching function handles both modes. [status: OPEN, introduced
    by this change]
  - PATTERN-DEBT-panel-fee-zero-default: a freshly-proposed panel with no
    corresponding `SetPanelArbiterFee` proposal defaults to fee=0, which is
    valid but economically inert (no incentive to vote) — worth a follow-up
    governance-tooling nudge (e.g. `casper_propose_set_arbiter_panel`'s tool
    description could warn if fee is still 0) if this surfaces as a real
    liveness problem in practice. [status: OPEN, introduced by this change]

## 9. Next Cycle Trigger
When a panel-mode dispute is actually posted against a live deployed contract
(the first real `dispute_result_via_panel` transaction lands on testnet or
mainnet) OR when the dashboard/indexer work (research item #1) is picked up and
needs to represent `ArbitrationMode`/panel votes in its UI — whichever happens
first.

## 10. Cycle Retrospective
- The plan's own draft TypeScript code for Task 7 assumed `dispute_result_via_panel`
  was a plain (non-payable) call; the actual Rust entry point is
  `#[odra(payable)]` with a combined bond+fee attached value. Always re-read the
  actual Rust source for a new entry point's payability before writing its
  TypeScript mirror — don't trust a plan draft's shape for anything payable.
- Writing a test can surface a design gap a written plan missed: the test
  `p1b_single_arbiter_arbitrate_rejects_a_panel_mode_job` was initially drafted
  to assert the OPPOSITE (that a single arbiter could still bypass a panel-mode
  dispute), which on reflection defeats the entire feature's purpose. The fix
  was a guard in `arbitrate()` that the plan hadn't listed as a task. Treat a
  test that documents surprising-but-"acceptable" behavior as a prompt to stop
  and re-examine the design, not just record it.
- `CasperClientLike`'s Pick-list included `proposeSetPanelArbiterFee` (Task 7)
  with no MCP tool ever calling it (Task 8's draft omitted it) — a plan's own
  internal consistency (a type listing a method) is not proof every method is
  actually wired to something callable; cross-check the Pick-list against the
  tool-registration array explicitly, not just against the tests provided.
- Odra's `cargo test` requires the nightly toolchain (`odra-macros` uses
  `#![feature(box_patterns)]`) — `cargo test` on stable fails at the dependency
  compile step, not this crate's own code; always use `cargo +nightly test` in
  this repo.
- No debt from this cycle required deferring a task — all 8 plan tasks landed
  as scoped, with 2 in-flight corrections (both caught before commit, not after).
