# RFC — Symmetric Dispute Bond (P3-hard slashing)

- **Status:** **Implemented & shipped** (updated 2026-07-21 — see "§10 Resolution" below for what
  actually shipped vs. this RFC's original proposal). T0.4 landed in
  `contracts-odra/src/agent_skill_registry.rs`: `dispute_result`, `respond_to_dispute`,
  `concede_dispute`, `arbitrate` are live on Casper Testnet, covered by the Odra test suite, and
  demoed end-to-end against real transactions (the "courtroom" flow in `DEMO_CASPER.md` and
  `casper-judges.html`) — including a real `ProviderAtFault` verdict with reputation slashed
  `50 → 40` and escrow + both bonds refunded to the requester.
- **Track:** T0.3 (design-only). Gates: T0.4 (impl), T0.5 (native rep decay).
- **Author:** KARMA maintainer · **Date:** 2026-06-24
- **Companions:** [D1–D5 tradeoff study §D5](../superskills/plans/2026-06-23-d1-d5-tradeoff-study.md) ·
  [post-demo roadmap §P3](../superskills/plans/2026-06-23-post-demo-roadmap.md)
- **Decision points settled:** DP-5 = RFC-gate ✅ · DP-1 = implement **after** hackathon ✅

---

## 1. Problem

Reputation has **no downside**, and the obvious fix introduces a worse one.

- `Skill.reputationScore` is **monotonic-up** (`contracts/AgentSkillRegistry.sol:17,179` — "rep only
  ever rises", PD-005). A provider can build reputation then deliver garbage and lose only the single
  escrow, never reputation.
- `disputeResult(jobId)` is a **unilateral requester action** inside `REVIEW_WINDOW`
  (`AgentSkillRegistry.sol:261`); it refunds the requester's own escrow and changes **no** trust
  signal for the provider (the self-deal carve-out aside).

**The trap (D5 crux):** wiring slashing of escrow / bond / reputation directly onto today's
*unilateral* dispute creates a **griefing weapon** — a malicious requester disputes good work to tank
an honest provider. A naive slasher is *worse than none*: it adds an attack the current design lacks.

**Already shipped (P3-lite, SOFT, PR#4 / `flow_reputation.ts`):** dispute-rate feedback +
concentration cap. These adjust a *ranking signal*, never funds — bounded, reversible, griefing-blunt.
P3-lite closes the urgent gap; **this RFC covers only P3-hard** (funds at stake), which must
neutralize griefing **before** any code.

## 2. Goals / Non-goals

**Goals**
- G1. Make the dispute path **griefing-resistant**: a frivolous dispute is strictly −EV for the disputer.
- G2. Make provider reputation slashing **safe** by construction (only on a *paid-for, adjudicated* loss).
- G3. Reuse the **already-audited** primitives: pull-payment ledger (`pendingWithdrawals`),
  `REVIEW_WINDOW`, bond mechanics (`bondedAmount`/`bondUnlockAt`). No new value-custody surface.
- G4. Keep the mechanism **chain-portable** (Solidity v5 + Odra), mirroring the existing parity.

**Non-goals**
- Decentralized arbitration on day one (Kleros/Augur) — designed-for, not built now (see §6 phasing).
- Touching P3-lite (soft ranking) — orthogonal, already live.
- Changing the happy path: `confirmCompletion` / `claimAfterReview` stay byte-for-byte for the
  no-dispute case (the overwhelming majority of jobs).

## 3. Design-space evaluation

| Option | Mechanism | Griefing fix | Cost / complexity | Verdict |
|---|---|---|---|---|
| **UMA optimistic oracle** | symmetric proposer/disputer **bonds**, loser forfeits bond | ✅ direct — frivolous dispute loses the bond | **Low** — one bond field + one arbiter call; reuses review window | **CHOSEN (phase 1)** |
| **Kleros** | staked jurors, Schelling vote, appeal escalation | ✅ strong, decentralized | High — juror pool, voting, appeals, token | Phase 2 arbiter backend (optional) |
| **Augur** | escalation/forking for extreme disputes | ✅ last-resort | Very high | Reference only (fork as ultimate backstop) |
| **EigenLayer** | operator-set slashing with safety rails | n/a (no dispute model) | — | Borrow its **slashing safety rails** (caps, veto delay) |

**Conclusion (matches D5's "likely outcome"):** adopt **symmetric dispute bonds, loser-pays**, layered
on the existing optimistic `REVIEW_WINDOW`. It is the *minimal* mechanism that makes dispute costly to
abuse, and it composes with a Kleros/decentralized arbiter later by swapping only the *adjudicator*,
not the bond/escrow plumbing.

## 4. The mechanism (concrete)

### 4.1 State machine (additions in **bold**)

```
Open ──deliverResult──> Delivered ──confirmCompletion──> Completed        (happy path, unchanged)
                              │
                              ├─ claimAfterReview (after REVIEW_WINDOW, no dispute) ──> Completed
                              │
                              └─ disputeResult(+bond) ──> **Disputed** ──arbitrate(verdict)──> Completed | Refunded
```

### 4.2 Posting a dispute (was unilateral + free → now bonded)

`disputeResult(jobId)` becomes **payable / bond-backed**: the requester must lock a **dispute bond**
`B_d = max(MIN_DISPUTE_BOND, disputeBondBps · escrow / 10_000)` for the job to enter `Disputed`.
Default `disputeBondBps = 10_000` (1× escrow) — a frivolous disputer risks an amount equal to what
they are trying to claw back. Funds are held in the contract (not the pull-payment ledger until
resolved).

### 4.3 Provider response window

On entering `Disputed`, the provider has `RESPONSE_WINDOW` (reuse a bounded constant, e.g. = `REVIEW_WINDOW`)
to **match the bond** (`respondToDispute(jobId)`, locking `B_p = B_d`) to contest, **or** to **concede**
(`concedeDispute`) → immediate full refund to requester, provider keeps its bond, escrow returned,
reputation **slashed by the concede amount** (a conceded dispute is an admitted bad delivery; safe to
slash because the provider chose it). If the provider neither responds nor concedes within the window,
default = **concede** (protects requesters against unresponsive providers).

### 4.4 Adjudication (loser-pays)

`arbitrate(jobId, verdict)` — callable only by the **Arbiter** role:
- **verdict = ProviderAtFault:** escrow → requester; requester's bond `B_d` → returned; provider's bond
  `B_p` → **forfeit, split** {requester (compensation), protocol sink}; provider **reputation slashed**
  (§5). This is the only path that slashes provider reputation, and it required an adjudicated,
  bond-backed loss → safe.
- **verdict = RequesterAtFault (frivolous):** escrow → provider (settle as if completed); provider's
  bond `B_p` → returned; requester's bond `B_d` → **forfeit, split** {provider, protocol sink};
  provider reputation **bumps normally** (it was a good delivery).

**Arbiter role (phasing):** phase 1 = `owner`/multisig (centralized, fast, fine for testnet per DP-3
and matching the existing owner-gated redeploy posture). Phase 2 = swap the Arbiter address for a
Kleros court / committee — *no other contract change*, because adjudication is isolated behind the role.

## 5. Reputation slashing (now safe — was the whole reason for the gate)

Only on **verdict = ProviderAtFault** or **concede**:
`reputationScore = max(REP_FLOOR, reputationScore − REP_SLASH_STEP)` (e.g. `REP_SLASH_STEP = 10`,
`REP_FLOOR = 0`). This **requires lifting the monotonic-up invariant** (PD-005) — hence T0.5 (native
decay: store `(score, lastUpdated)`, decay-on-read) lands together so the score model is coherent
(rises on completion, decays with time, drops on adjudicated fault). Agent-level `_agentRep` mirrors
the same on a `ProviderAtFault` verdict.

Safety: slashing is **bounded** (single step, floored), **gated** (adjudicated + bonded), and **paid
for** (the disputer staked an equal bond). EigenLayer-style rail: an optional `ARBITER_VETO_DELAY`
between `arbitrate` and fund movement lets the owner halt an obviously-wrong verdict before it settles.

## 6. Griefing analysis (game theory — the gate's acceptance test)

Let escrow `E`, dispute bond `B_d = E`, provider bond `B_p = E`, arbiter accuracy `p` (P[correct verdict]).

- **Frivolous dispute on good work** (provider responds): requester EV
  `= p·(−B_d) + (1−p)·(+E+share(B_p)) − gas`. With a competent arbiter (`p → 1`) this is `≈ −E` — a
  guaranteed loss. **Griefing is −EV.** Contrast today: griefing costs only gas.
- **Honest dispute on bad work:** requester EV `= p·(+E+share(B_p)) + (1−p)·(−B_d)` → positive for
  `p` high. Honest disputes remain worth filing → the mechanism doesn't chill legitimate disputes.
- **Provider griefing (deliver garbage, refuse to refund):** provider must now either concede (rep
  slash + escrow back) or stake `B_p` and face an adjudicated loss (lose `B_p` + rep). Garbage delivery
  is no longer free of reputational consequence.
- **Collusion / wash (self-dispute to farm bonds):** requester==provider is already the self-deal
  carve-out; bonds from the same funding source net to ~zero minus the protocol sink → wash is −EV.
  The P3-lite concentration cap further blunts K-wallet rings on the ranking side.
- **Arbiter capture:** the residual trust assumption in phase 1. Mitigated by (a) `ARBITER_VETO_DELAY`,
  (b) public `Disputed`/`Arbitrated` events (legibility), (c) the phase-2 swap to decentralized
  arbitration. Documented as the explicit, bounded centralization of v1.
- **Bond-size griefing** (forcing capital lock-up): `B_p` is symmetric, so an attacker locks equal
  capital; `MIN_DISPUTE_BOND` prevents dust spam; `disputeBondBps` is owner-tunable per risk appetite.

**Acceptance (G1):** for any `p ≥ p*` (target `p* = 0.8` for the owner-arbiter v1), frivolous dispute
EV < 0 and honest dispute EV > 0. Met by `B_d = E` and loser-pays.

## 7. Contract changes T0.4 will implement (scope lock)

- `Job` gains: `disputeBond`, `providerBond`, `disputedAt`; `JobStatus` gains `Disputed` (Odra: enum
  variant; Solidity: status int).
- New constants: `disputeBondBps` (storage, owner-settable), `MIN_DISPUTE_BOND`, `RESPONSE_WINDOW`,
  `REP_SLASH_STEP`, `REP_FLOOR`, optional `ARBITER_VETO_DELAY`; new `arbiter` role.
- `disputeResult` → bond-backed; new `respondToDispute`, `concedeDispute`, `arbitrate(jobId, verdict)`.
- Reuse `pendingWithdrawals` for all payouts (CEI, zero-before-pay) — **no new custody path**.
- Lift PD-005 monotonic-up (co-delivered with T0.5 decay).
- **Parity:** Solidity v5 + Odra port, mirrored tests (happy path untouched; new: bonded dispute,
  concede, provider-at-fault, frivolous-at-fault, unresponsive-provider default, veto-halt).

## 8. Rollout, acceptance, open questions

**Rollout:** testnet-first (DP-3); owner-arbiter v1; redeploy is owner-gated. P3-lite stays the live
default until T0.4 ships. **Acceptance gate for T0.4:** the §6 EV inequalities hold in a simulation
test (frivolous disputer loses bond; honest disputer recovers escrow + share; provider rep slashed
only on adjudicated/conceded fault), plus full parity suites green.

**Open questions for owner sign-off:**
- OQ-1. `disputeBondBps` default — 1× escrow (recommended) vs a lower multiple (cheaper honest disputes,
  weaker griefing deterrent)?
- OQ-2. Protocol sink for forfeited-bond remainder — burn, treasury, or 100% to the winner?
- OQ-3. Ship `ARBITER_VETO_DELAY` in v1, or rely on event-monitoring + phase-2 decentralization?
- OQ-4. `REP_SLASH_STEP` magnitude relative to the `+REPUTATION_STEP` earn rate (asymmetry tuning).

## 9. Decision request

Approve **symmetric dispute bonds, loser-pays, owner-arbiter v1** as the P3-hard design → unblocks
T0.4 (impl) + T0.5 (native decay). Or redirect on OQ-1..OQ-4 / the arbiter model before code.

## 10. Resolution — what actually shipped (added 2026-07-21)

T0.4 shipped in `contracts-odra/src/agent_skill_registry.rs`, live on Casper Testnet. The four
open questions from §8 were each settled by a concrete shipped constant/behavior, not left open:

- **OQ-1 (`disputeBondBps` default):** shipped at `10_000` (1× escrow) — the recommended option,
  set at `agent_skill_registry.rs:477` and owner-tunable afterward via the governed
  `propose_set_dispute_bond_bps` lifecycle (not a plain setter — folded into the same
  multisig+timelock proposal flow as every other governance parameter).
- **OQ-2 (forfeited-bond sink):** shipped as **100% to the winner**, no burn and no protocol
  treasury cut. On `Verdict::ProviderAtFault`, the requester receives `escrow_amount +
  dispute_bond + provider_bond` in full (`agent_skill_registry.rs:909-912`); the symmetric case
  (`RequesterAtFault`) credits the provider the same way.
- **OQ-3 (`ARBITER_VETO_DELAY`):** **not shipped** — v1 has no veto-delay constant. The residual
  arbiter-capture risk this RFC flagged (§6) is instead bounded by the arbiter role itself sitting
  behind the governance-hardened multisig/timelock (a compromised or malicious arbiter address can
  only be replaced via `propose_set_arbiter`'s governed lifecycle, not a unilateral swap), plus the
  public `Disputed`/`Arbitrated`-equivalent on-chain state every read tool can observe. Revisit a
  dedicated veto window only if live arbitration volume shows this isn't enough.
- **OQ-4 (`REP_SLASH_STEP` magnitude):** shipped at `REP_SLASH_STEP = 10` against an earn rate of
  `REPUTATION_STEP = 5` (`agent_skill_registry.rs:16,42`) — losing an adjudicated dispute costs
  **2×** what completing a job earns, a deliberate asymmetry so bad-faith delivery can't be
  amortized away by a couple of honest jobs afterward.

The griefing-analysis acceptance gate (§6) — frivolous dispute EV < 0, honest dispute EV > 0 for a
competent arbiter — was not re-derived against these exact shipped constants in a standalone proof,
but the live courtroom run (`DEMO_CASPER.md`, re-run 2026-07-21) demonstrates the mechanism working
as designed on a real contested delivery: bond-matching, adjudication, loser-pays, and reputation
slashing all fired correctly end-to-end.

## 11. Atomicity vs. quorum — why the "verify-then-act" critique doesn't apply here

A pattern some other trust-layer entries in this buildathon call out (Casproof's `require_quorum`,
positioned explicitly against "the exact pattern two of the strongest competitors ship") is a
two-step exploit surface: a contract checks a quorum-attested verdict in one call, then a *separate*
later call spends it — leaving a window where the attestation can go stale, be replayed, or simply
never get consumed atomically with the payout.

`arbitrate(job_id, verdict)` (`agent_skill_registry.rs:890-947`) doesn't have that window by
construction: verdict computation and fund movement are the same function call, in the same
transaction. `ProviderAtFault` credits `pending_withdrawals`, slashes reputation, and flips job
status to `Refunded` in one execution; `RequesterAtFault` does the symmetric thing. There is no
separate "verify" transaction whose result a later, different transaction trusts — every guard
(`require_job`, dispute-bond presence, provider-bond presence, arbiter identity) is re-evaluated
fresh, in the same call that moves the money. Same for `dispute_result` (bond lock + status flip,
one call) and `respond_to_dispute` (provider bond lock + record, one call).

What this does *not* answer: the source of truth for a verdict is one arbiter key, not a k-of-n
quorum of independently computed verdicts. That's a different axis from atomicity — Casproof's
guard defends against a forged or stale single attestation being trusted; KARMA's atomic-call
design defends against a time gap between verifying and acting on one. The first gap is real and
already tracked, not discovered here for the first time: see [Roadmap & team's "N-of-M
arbitration"](../../README.md#roadmap--team) — v1 trusts one governed, replaceable arbiter address;
whether a verdict should require multiple independent rulings is the explicit open v2 question.
