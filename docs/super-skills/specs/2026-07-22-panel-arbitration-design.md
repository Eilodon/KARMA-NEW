---
title: Panel Arbitration (N-of-M) — additive mode for Casper dispute resolution
date: 2026-07-22
author: Eilodon (design session with Claude)
SPEC_APPROVED: true
SPEC_ESCALATION: false
ESCALATION_FINDING: ""
---

# Panel Arbitration (N-of-M) — additive mode

**Merges and resolves two previously-flagged items from the buildathon prep audit:**
"#10 quorum-gate" and "#11 N-of-M arbitration" — both pointed at the same underlying gap
(single-arbiter trust) and were kept separately flagged (PASS WITH FLAGS / HOLD) pending a real
design pass. This is that pass.

**Companion doc:** [`docs/rfc/2026-06-24-symmetric-dispute-bond.md`](../../rfc/2026-06-24-symmetric-dispute-bond.md)
(§10 documents what shipped as v1's single-arbiter model; §11 — added earlier this session —
already defends the *atomicity* property this design preserves unchanged).

## 1. Problem

`arbitrate(job_id, verdict)` trusts exactly one governed, replaceable arbiter address. The
project's own roadmap already lists this as an open v2 question ("N-of-M arbitration"). Separately,
Casproof (a strong buildathon competitor) ships a generic `require_quorum` guard and positions it
against exactly this shape of trust model. Both point at the same gap: no competitor in this
buildathon's field combines a k-of-n independent verdict with KARMA's existing symmetric dual-bond
economics — but building it carelessly risks the two things that currently work and are already
demoed: the atomic settlement guarantee (RFC §11) and the proven griefing-resistance game theory
(RFC §6).

## 2. Goals / Non-goals

**Goals**
- G1. Offer panel-based (N-of-M) arbitration as an **opt-in alternative**, chosen by the disputer
  at dispute time — never mandatory, never a breaking change to any existing entry point.
- G2. Reuse the existing symmetric dispute-bond economics and RFC §6's proven griefing-resistance
  math **completely unchanged** — panel mode must not require re-deriving that proof.
- G3. Reuse the existing governance-hardened propose/approve/execute+timelock lifecycle for
  managing the panel — no new governance primitive.
- G4. Eliminate the "full participation but still tied" failure mode by construction (validation,
  not runtime logic) rather than by a policy tiebreaker.
- G5. Solve the "not enough arbiters participate" liveness problem primarily through incentive
  (a participation fee), with a timeout/default as the last-resort backstop, not the primary
  mechanism.
- G6. Exactly one audited settlement code path — the single-arbiter and panel paths must not
  duplicate the fund-movement/reputation-slash logic.

**Non-goals**
- Not touching `arbitrate()`, `dispute_result()`, `respond_to_dispute()`, `concede_dispute()`, or
  `resolve_default_concede()` — their behavior, tests, and existing on-chain evidence stay
  byte-for-byte as-is.
- Not per-skill custom panels (rejected in design discussion — single contract-wide panel only).
- Not a Kleros-style staked-juror/commit-reveal system — explicitly deferred, same as the original
  RFC's own Phase 2 framing. Majority-alignment-conditional fees were considered and rejected
  (herding-incentive risk) in favor of flat participation fees.

## 3. Design

### 3.1 State machine (new paths only; existing paths unchanged)

```
                          disputeResult (existing) ──> Disputed ──arbitrate(verdict)──> Completed | Refunded
Delivered ──┤
                          disputeResultViaPanel (new) ──> Disputed(panel mode) ──castPanelVote×N──> Completed | Refunded
                                                                    │
                                                                    └─(timeout, no majority)──> resolvePanelDefault ──> Refunded
```

### 3.2 Data model additions (`contracts-odra/src/agent_skill_registry.rs`)

- `arbiter_panel: Vec<Address>`, `panel_threshold: u32` — governance-managed, mirrors
  `governance_signers`/`governance_threshold`.
- New `ProposalAction::SetArbiterPanel { panel: Vec<Address>, threshold: u32 }`, same
  propose/approve/execute+timelock lifecycle as `SetArbiter`.
  - **Validation (enforced in the proposal-execution path, not just off-chain convention):**
    `panel.len()` must be odd, and `threshold` must equal exactly `panel.len() / 2 + 1`
    (strict majority of an odd count). Reject any other shape — this is what makes a
    "full participation, still tied" outcome mathematically impossible, so no policy
    tiebreaker is ever needed for that case.
- `dispute_arbitration_mode: Mapping<u64, ArbitrationMode>` (`Single | Panel`), set once at
  dispute time by which entry point the disputer calls. `arbitrate()` continues to require
  `Single` (or absence of a panel-mode record); the new panel entry points require `Panel`.
- `panel_votes: Mapping<(u64, Address), Verdict>` — one vote per (job, arbiter). Reusing the
  existing `Verdict` enum (`ProviderAtFault | RequesterAtFault`) means an abstain option does
  not exist at the type level; a non-vote is simply the absence of an entry, not a third value.
- `panel_vote_counts: Mapping<u64, (u32, u32)>` — running tally, updated on each `cast_panel_vote`
  (panel size is small and bounded like the existing quorum precedent in the field, so a direct
  tally is simpler than an iterator-based count-on-read).
- `panel_arbiter_fee: Mapping<u64, u512>` (or reuse the existing evaluator-fee field shape) — set
  from the `panelArbiterFeeWei` the disputer posts at `dispute_result_via_panel` time, **held
  separately from `dispute_bond`/`provider_bond`** so RFC §6's EV proof needs no changes.

### 3.3 New entry points

- **`dispute_result_via_panel(job_id)`** — same preconditions and bond-posting as `dispute_result`
  (payable = `dispute_bond` computed identically), **plus** an additional payable
  `panelArbiterFeeWei` collected into `panel_arbiter_fee[job_id]`. Sets
  `dispute_arbitration_mode[job_id] = Panel`.
- **`cast_panel_vote(job_id, verdict)`** — caller must be in `arbiter_panel`; job must be
  `Disputed` + `Panel` mode; provider must already have matched the bond (`respond_to_dispute`,
  unchanged); rejects a second vote from the same address. Records the vote, updates the tally.
  If the tally for `verdict` reaches `panel_threshold`: calls the **same private settlement
  function `arbitrate()` already uses** (extracted from `arbitrate()`'s body, parameterized only
  by `job_id` + `verdict` + the caller for the emitted event), then distributes
  `panel_arbiter_fee[job_id]` evenly across every address that has an entry in `panel_votes` for
  this job at that moment (regardless of which side they voted for — no majority-alignment
  condition, to avoid rewarding vote-copying over independent judgment).
- **`resolve_panel_default(job_id)`** — callable by anyone once `PANEL_VOTE_WINDOW` elapses past
  `disputed_at` without either side reaching `panel_threshold`. Resolves as `ProviderAtFault`
  (same direction `resolve_default_concede` already defaults to when a provider goes silent) —
  the participation fee makes this a rare backstop, not the primary liveness mechanism, so no new
  policy question is introduced: an under-participating panel is treated as an operational
  failure the panel-operator side (not the requester) bears, consistent with the existing
  unresponsive-provider precedent.

### 3.4 What stays exactly as-is

`arbitrate`, `dispute_result`, `respond_to_dispute`, `concede_dispute`, `resolve_default_concede`,
`create_job` (and every other existing entry point) — zero signature or behavior changes. A
`Single`-mode dispute is indistinguishable from today's contract in every way that matters.

## 4. Testing strategy

- New Rust test group `p1b_panel_*` in `agent_skill_registry/tests.rs`, mirroring the existing
  `p1a_*` naming convention for the single-arbiter symmetric-bond tests.
- **Required, not optional:** extend both existing property-based invariant tests
  (`agent_skill_registry/proptests.rs` — escrow conservation, reputation bounds) to also exercise
  panel-mode settlement. This closes the #1 failure mode flagged in the original audit-design pass
  on this idea (a new money-movement path added without proptest coverage).
- Explicit cases: majority reached exactly at threshold; majority reached with votes to spare;
  double-vote from the same arbiter (reject); vote from a non-panel address (reject); vote after
  settlement already executed (reject); timeout with no majority → `resolve_panel_default`; timeout
  fee distribution covers exactly the arbiters who voted, split evenly, none double-paid;
  `propose_set_arbiter_panel` rejects even-length panels and rejects any threshold other than
  strict majority.
- TS mirror in `odra_registry.ts` (in-process model, same pattern `casper_composition.test.ts`
  already established for skill composition) + new MCP tools (`casper_dispute_result_via_panel`,
  `casper_cast_panel_vote`, `casper_resolve_panel_default`, `casper_propose_set_arbiter_panel`,
  `casper_get_panel_vote_state`) matching the existing 1:1 Rust↔TS↔MCP-tool pattern used
  everywhere else in this codebase.

## 5. Environment preconditions (explicit, per brainstorming's own gotcha about surfacing these)

- Requires a new WASM build + redeploy of the **same live, governance-hardened, already-demoed**
  `AgentSkillRegistry` contract. This needs the owner's governance signer keys and the owner's
  explicit go-ahead **at execution time** — deliberately kept separate from design approval here,
  since a redeploy touches the contract judges are already looking at.
- Needs genuinely independently-operated panel keys to mean anything. Casproof's own README
  discloses that its live demo currently uses commonly-operated keys for its quorum signers —
  if KARMA's panel launches the same way, the "no single point of trust" claim is not yet earned
  in practice, only in code. Worth stating plainly rather than overclaiming at demo time.
- `panelArbiterFeeWei` needs a reasonable default value decided before the redeploy (open,
  low-stakes parameter — can be governance-tuned later via the same proposal lifecycle, no need
  to get it perfect at launch).

## Risk Assessment (audit-design)
<!-- audit-design: DO NOT DUPLICATE — update this section, do not append a second one -->
<!-- last-run: 2026-07-22 | trigger: NORMAL -->

**Tier:** 3 (payments/fund custody — dispute bonds + new arbiter fees on a live governed contract)
**Date:** 2026-07-22

### Failure Modes

1. **Fee distribution must stay pull-payment, or it's a new custody path** — HIGH — the spec
   says `cast_panel_vote` "distributes `panel_arbiter_fee[job_id]` evenly" without specifying
   *how*. The original RFC's G3 goal ("reuse `pendingWithdrawals`... no new value-custody
   surface") only holds if this credits `pending_withdrawals` for each voting arbiter, exactly
   like every other payout in the contract — never a push-transfer loop, which would be both the
   first non-CEI custody path in the contract and a gas-griefing surface (a malicious/broken
   arbiter address could make the whole settlement call revert for everyone). — mitigation in
   plan: **NO**, must be made explicit in `writing-plans`.
2. **Even-split remainder isn't specified** — MEDIUM — integer division of `panel_arbiter_fee`
   across N voters leaves a remainder for any N that doesn't divide evenly. The codebase already
   has a proven, tested answer to this exact shape of problem: skill-composition payout
   (`register_composition`) has the last leaf absorb the rounding remainder so no mote is lost.
   The same rule should apply here (e.g., lowest-address or last-to-vote arbiter absorbs it) —
   otherwise this reintroduces a bug class the project already fixed elsewhere. — mitigation in
   plan: **NO**, must be made explicit in `writing-plans`.
3. **Mid-dispute governance panel change** — HIGH — nothing in the spec says what happens if
   `propose_set_arbiter_panel` executes (new panel/threshold) while a job is `Disputed`+`Panel`
   with votes already cast under the *old* panel. Unlike the single-arbiter path (one atomic
   verdict call, no accumulated cross-transaction state), panel mode's vote tally accumulates
   across multiple transactions — a governance change mid-flight could let stale votes count
   toward a different threshold, or orphan an in-progress dispute. Needs an explicit rule: either
   (a) snapshot the panel + threshold onto the job record at `dispute_result_via_panel` time so a
   later governance change never affects an in-flight dispute, or (b) block
   `propose_set_arbiter_panel` execution while any job is `Disputed`+`Panel`. (a) is simpler and
   matches how `dispute_bond_bps` is already read at dispute time, not re-read later — recommend
   (a) in `writing-plans` unless a reason emerges not to. — mitigation in plan: **NO**.

### Layer Signals

- **L1 Logic:** a `panel.len() == 1` technically passes "odd + threshold = len/2+1" validation but
  is a degenerate one-person "panel" — same trust model as the existing single-arbiter path with
  extra plumbing and a fee on top, for zero security benefit. Add a minimum panel size (≥3) to
  the `propose_set_arbiter_panel` validation.
- **L2 Concurrency:** a vote landing after the job has already settled (two arbiters' votes both
  "would" reach threshold, only the first-included transaction actually does) is already covered
  by the existing test-plan line "vote after settlement already executed (reject)" — no new
  finding, confirming the state-machine precondition (`job must be Disputed + Panel mode`)
  already handles this correctly by construction.
- **L6 Observability:** no new events (`PanelVoteCast`, `PanelArbitrated`-equivalent,
  `PanelDefaultResolved`) are specified for the three new entry points, breaking the pattern
  every other state transition in this contract follows (`DisputeResponsePosted`,
  `DisputeArbitrated`, etc. all emit). Flagged as **ASSUMED** — add explicit event list in
  `writing-plans`.
- L3 Data, L4 Integration, L5 Security (beyond L1/L2 above), L7 Cross-cutting: no signal beyond
  what's already addressed in the spec's own §5 preconditions.

### Assumptions to Verify

- **ASSUMED:** "Independently operated panel keys" is an operational precondition, not something
  code can enforce — already disclosed plainly in §5, not hidden, but still unverified until real
  key ceremony happens.
- **ASSUMED:** event emissions will mirror the existing pattern exactly — not yet itemized (see
  L6 above).
- **Accepted, not a defect:** a flat participation fee guarantees an arbiter showed up, not that
  their vote was careful — this is the deliberate tradeoff made in brainstorming to avoid a
  majority-alignment herding incentive, and there's no on-chain ground truth to condition payment
  on correctness anyway. Worth one line in the eventual demo narrative so it isn't oversold as
  "guarantees quality," only "guarantees participation."

### Abductive Hypotheses

1. **Interaction:** removing the herding incentive (flat fee, not majority-conditional) also
   removes any on-chain incentive for *careful* judgment specifically — an arbiter who votes
   instantly and arbitrarily still gets paid. Individually-correct design choices (avoid herding;
   reward participation) compound into "payment tracks presence, not quality" — accepted per
   above, but worth naming since neither failure mode alone would have surfaced it.
2. **Adversarial/scale:** if the existing 2-of-2 governance multisig is ever compromised, the
   attacker could both stack `arbiter_panel` with their own keys **and** wait out the 48h
   timelock unopposed — this is the same "arbiter capture" residual risk the original RFC already
   named for the single-arbiter case (§6), now extended to cover panel composition too. Not a new
   risk category this design introduces — a cross-reference, not a new mitigation, is enough.

### Gate Result

PASS WITH FLAGS — proceed to `writing-plans`; it MUST include explicit mitigation for the two
HIGH findings (pull-payment fee distribution; mid-dispute governance-change handling) and should
also close the MEDIUM (remainder handling) and the L1/L6 gaps above before implementation.
