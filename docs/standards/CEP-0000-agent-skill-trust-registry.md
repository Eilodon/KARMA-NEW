# CEP-0000: Agent Skill Trust Registry

| Field | Value |
|---|---|
| CEP | 0000 (draft — number assigned on submission to `casper-network/ceps`) |
| Title | Agent Skill Trust Registry: Identity-Gated, Reputation-Scored, Disputable Escrow for Autonomous Agent Skill Calls |
| Author | KARMA project ([DEMO_CASPER.md](../../DEMO_CASPER.md)) |
| Status | Draft |
| Type | Standards Track |
| Category | Interface |
| Created | 2026-07-08 |
| Requires | — |
| Reference implementation | [`contracts-odra/src/agent_skill_registry.rs`](../../contracts-odra/src/agent_skill_registry.rs) (Odra 2.x, 1659 LoC, 131/131 tests passing), live on Casper Testnet |

> This is a project-authored draft, written to the shape of the Casper CEP process, not yet
> submitted to `casper-network/ceps`. Before submission it needs: (1) a CEP number from the
> Casper core team, (2) conformance to whatever preamble fields the current CEP template
> requires (verify against the live template at submission time — this draft mirrors the
> EIP-style preamble Casper's process is modeled on, but the exact field set may have moved),
> and (3) an independent second implementation (see [Backwards Compatibility](#backwards-compatibility)
> and [Open Questions](#open-questions)).

## Simple Summary

A standard on-chain interface for agent-to-agent skill marketplaces: a skill registry gated by
pluggable identity policy, an off-chain-computed but on-chain-seeded reputation score, escrow
with a symmetric bond-backed dispute-and-arbitration lifecycle, and multisig+timelock governance
for the parameters that control all of the above — so any Casper contract can adopt agent-to-agent
trust and settlement without depending on a specific server implementation.

## Abstract

Existing building blocks for agent-to-agent commerce each solve one layer: a wire protocol gets a
request from caller to callee, a payment scheme moves money for that request, an identity registry
lets a caller point at who they are. None of them define what a Casper contract should expose so
that a *skill call* — not a generic token transfer — can be gated by trust, paid for escrow-safely,
and contested if the delivered result is wrong. This CEP specifies that contract-level interface:
`Skill` and `Job` state machines, an `identity_policy` gate per skill, a `u32` reputation score with
a defined bump/slash step size, a `U512`-denominated escrow-and-pull-payment settlement path, a
symmetric dispute-bond-and-arbiter-verdict lifecycle, and a multisig-plus-timelock governance
lifecycle for every mutable trust parameter (arbiter identity, dispute bond ratio, cross-chain
reputation attestations). It is derived from and kept in lockstep with an existing, audited
Solidity implementation (`contracts/AgentSkillRegistry.sol`) — this CEP is the Casper-native
expression of a design that has already been proven on a second chain, not a first draft.

## Motivation

Autonomous agents that call each other's skills over a protocol like MCP need three guarantees a
generic token-transfer contract does not provide:

1. **Gated calls.** Not every skill should be callable by every anonymous account — some require a
   verified identity, some require a minimum reputation, and today there is no standard way for a
   Casper contract to declare and enforce either.
2. **Escrow with recourse.** A per-call payment that just transfers value on invocation gives the
   payer no protection if the delivered result is wrong, and gives the payee no protection from a
   payer who claims "wrong result" in bad faith to avoid paying. Recourse needs to be symmetric and
   on-chain, not a support ticket.
3. **Governed trust parameters.** Who arbitrates disputes, how large a dispute bond must be, and
   what an agent's reputation is on another chain are all values that, if mutable by a single key,
   are a standing rug-pull risk for every skill built on top. They need multisig-plus-timelock
   governance, not an admin-only setter.

Today each of these is either solved ad hoc per-project (inconsistent trust semantics across the
ecosystem) or not solved at all (agents transact on trust-free rails and eat the loss when a
counterparty is bad). Standardizing the interface — not any one server's implementation of it —
lets any Casper project adopt agent-to-agent trust and dispute resolution by implementing (or
importing) one contract interface, the same way CEP-18 let any project adopt a fungible token
without re-deriving `transfer`/`approve` semantics from scratch.

## Specification

The keywords "MUST", "MUST NOT", "SHOULD", and "MAY" in this section are to be interpreted per
RFC 2119.

### 1. Data types

```rust
/// Reputation lives on a u32 0..=100 axis. 0 is reserved as the "unset" sentinel — a
/// conformant implementation MUST treat an unset score as BASE_REPUTATION (50), not 0.
pub const BASE_REPUTATION: u32 = 50;
pub const MAX_REPUTATION: u32 = 100;
pub const REPUTATION_STEP: u32 = 5;      // bump on successful completion
pub const REP_SLASH_STEP: u32 = 10;      // slash on dispute loss
pub const REP_FLOOR: u32 = 1;            // slash never zeroes a score

/// Identity policy values a Skill can require. Values >= 3 are reserved for future issuer
/// schemes (e.g. an ERC-8004-style registry pointer, a W3C Verifiable Credential type, or a
/// did:web resolver) — see docs/standards/IdentityPolicy-registry.md for the full registry
/// and its fail-closed rule.
pub const IDENTITY_POLICY_NONE: u8 = 0;
pub const IDENTITY_POLICY_VERIFIED: u8 = 1;       // e.g. T3N_VERIFIED
pub const IDENTITY_POLICY_VERIFIED_FRESH: u8 = 2; // e.g. T3N_VERIFIED_FRESH

pub enum JobStatus { Open, Delivered, Completed, Refunded, Disputed }
pub enum Verdict { ProviderAtFault, RequesterAtFault }

pub struct Skill {
    pub owner: Address,
    pub name: String,
    pub description: String,
    pub mcp_endpoint: String,          // discovery pointer; MAY be any URI scheme, not MCP-only
    pub price_per_call: U512,
    pub reputation_score: u32,         // BASE_REPUTATION..=MAX_REPUTATION
    pub total_invocations: u64,
    pub active: bool,
    pub registered_at: u64,            // ms since epoch (Casper block time)
    pub min_reputation_to_invoke: u32,
    pub identity_policy: u8,
}

pub struct Job {
    pub requester: Address,
    pub provider: Address,
    pub skill_id: u64,
    pub task_hash: Bytes,              // MUST be unique per job — see §5 exactly-once rule
    pub escrow_amount: U512,
    pub deadline: u64,                 // dual-purpose: refund deadline pre-delivery, review-window deadline post-delivery
    pub status: JobStatus,
    pub result_hash: Bytes,
    pub created_at: u64,
    pub completed_at: u64,
    pub evaluator: Option<Address>,    // optional neutral 3rd-party result verifier
    pub evaluator_fee: U512,
}

pub struct DisputeInfo {
    pub dispute_bond: U512,            // requester's posted bond
    pub provider_bond: U512,           // provider's matched bond (0 until respond_to_dispute)
    pub disputed_at: u64,
}

pub struct Composition {
    pub leaf_skill_ids: Vec<u64>,
    pub weights_bps: Vec<u32>,         // MUST sum to WEIGHT_DENOMINATOR (10_000)
}

pub enum ProposalAction {
    SetCrossChainRep { agent: Address, score: u32, source_chain: String },
    SetArbiter { new_arbiter: Address },
    SetDisputeBondBps { bps: u32 },
}

pub struct GovernanceProposal {
    pub action: ProposalAction,
    pub proposer: Address,
    pub proposed_at: u64,
    pub executed: bool,
    pub cancelled: bool,
}
```

### 2. Constants (implementations MUST expose equivalents, values MAY be deploy-time configured
where noted)

| Constant | Value | Configurable at deploy? |
|---|---|---|
| `MIN_REVIEW_WINDOW` | 1 hour (ms) | `review_window` bounded to `[MIN, MAX]` at `init` |
| `MAX_REVIEW_WINDOW` | 30 days (ms) | — |
| `DEFAULT_REVIEW_WINDOW` | 3 days (ms) | — |
| `BOND_UNLOCK_COOLDOWN` | 7 days (ms) | No — fixed |
| `DEFAULT_TIMELOCK_DELAY` | 48 hours (ms) | Yes, at `init` |
| `MAX_GOVERNANCE_SIGNERS` | 11 | No — fixed cap |
| `WEIGHT_DENOMINATOR` | 10,000 bps | No — fixed |
| `MAX_COMPOSITION_LEAVES` | 8 | No — fixed cap |
| `MIN_DISPUTE_BOND_MOTES` | 1 CSPR (1,000,000,000 motes) | No — fixed floor |
| `RESPONSE_WINDOW` | 3 days (ms) | No — fixed |
| Default `dispute_bond_bps` | 10,000 (= 1× escrow) | Yes, via governance proposal post-deploy |

Casper block time is milliseconds. An implementation targeting a chain with a different native
time unit MUST convert; this is the one non-portable detail relative to the EVM sibling
(`contracts/AgentSkillRegistry.sol`), which uses seconds.

### 3. Errors

A conformant implementation MUST reject invalid calls with a distinguishable error per condition
below (exact numeric codes are implementation-defined; the **conditions** are normative).

| Category | Conditions that MUST revert |
|---|---|
| Skill lifecycle | empty name; `min_reputation_to_invoke > MAX_REPUTATION`; caller ≠ skill owner on any owner-only setter; skill not found; skill already inactive |
| Job / escrow | attached value ≠ `price_per_call` (+ `evaluator_fee` if set); missing/empty `deadline_secs`; caller reputation `< min_reputation_to_invoke`; duplicate `task_hash` (exactly-once); caller ≠ provider on provider-only calls; caller ≠ requester on requester-only calls; job not in the required `JobStatus` for the call; action attempted outside its valid time window (before/after deadline as applicable) |
| Dispute / arbitration | dispute bond attached ≠ required bond (bps of escrow, floored at `MIN_DISPUTE_BOND_MOTES`); response posted after `RESPONSE_WINDOW`; second response to an already-answered dispute; arbitrate called by non-arbiter; arbitrate called on a dispute with no provider response yet |
| Governance | signer list empty or exceeds `MAX_GOVERNANCE_SIGNERS`; threshold is `0` or exceeds signer count; duplicate signer at `init`; non-signer calls a signer-only entry point; proposal not found; proposal already executed or cancelled; double-approval by the same signer; execute attempted before threshold approvals reached; execute attempted before timelock elapses |
| Bond (Sybil resistance) | zero-value bond deposit; unlock requested twice; withdraw attempted with no active unlock or before cooldown elapses |
| Composition | empty leaf list; leaf count exceeds `MAX_COMPOSITION_LEAVES`; `weights_bps` length ≠ leaf count; weights do not sum to `WEIGHT_DENOMINATOR`; a referenced leaf does not exist, is inactive, or is itself a composition (single-level only) |
| Pull-payment | withdraw called with a zero pending balance |

### 4. Entry points

Grouped by concern. `&self` = view (no state mutation); `&mut self` = mutating; `payable` = MUST
accept attached native-token value.

#### 4.1 Initialization & governance identity

| Entry point | Signature | Effect |
|---|---|---|
| `init` | `(review_window_ms: u64, governance_signers: Vec<Address>, governance_threshold: u32, timelock_delay_ms: u64)` | One-time. Sets the review window, the initial governance signer set + approval threshold, and the timelock delay. The **first** signer in the list MUST be set as the initial `arbiter`. Emits `GovernanceConfigured`. |
| `is_governance_signer` | `(addr: Address) -> bool` | View |
| `get_governance_threshold` | `() -> u32` | View |
| `get_governance_signers` | `() -> Vec<Address>` | View |
| `get_timelock_delay` | `() -> u64` | View |
| `get_arbiter` | `() -> Address` | View |

A conformant implementation MUST NOT expose any single-key "owner" path that can change the
arbiter, the dispute bond ratio, or cross-chain reputation without going through the proposal
lifecycle in §4.6. This is the standard's core trust property, not an implementation detail —
see [Rationale](#rationale).

#### 4.2 Skill lifecycle

| Entry point | Signature | Effect |
|---|---|---|
| `register_skill` | `(name, description, mcp_endpoint, price_per_call: U512, min_reputation_to_invoke: u32, identity_policy: u8) -> u64` | Creates a `Skill` at `BASE_REPUTATION`, active. Returns `skill_id`. Emits `SkillRegistered`. |
| `register_composition` | `(name, description, mcp_endpoint, price_per_call, min_reputation_to_invoke, identity_policy, leaf_skill_ids: Vec<u64>, weights_bps: Vec<u32>) -> u64` | Registers a wrapper `Skill` plus a `Composition` fan-out record. Single-level only — a leaf MUST NOT itself be a composition. Emits `SkillRegistered` + `CompositionRegistered`. |
| `deactivate_skill` | `(skill_id: u64)` | Owner-only. Idempotent-guarded (MUST reject if already inactive). Emits `SkillDeactivated`. |
| `set_min_reputation` | `(skill_id: u64, min_reputation: u32)` | Owner-only. Emits `MinReputationSet`. |
| `set_identity_policy` | `(skill_id: u64, policy: u8)` | Owner-only. Emits `IdentityPolicySet`. An implementation MUST fail closed (reject the call site, not just log) for any `policy` value it does not recognize — see `IdentityPolicy-registry.md`. |
| `get_skill` | `(skill_id: u64) -> Skill` | View |
| `get_composition` | `(skill_id: u64) -> Option<Composition>` | View |
| `is_composite` | `(skill_id: u64) -> bool` | View |
| `skill_count` | `() -> u64` | View |
| `get_agent_skills` | `(agent: Address) -> Vec<u64>` | View |

#### 4.3 Reputation

| Entry point | Signature | Effect |
|---|---|---|
| `agent_reputation` | `(agent: Address) -> u32` | View. MUST return `BASE_REPUTATION` for an agent with no recorded score (the `0` sentinel), never raw `0`. |
| `get_cross_chain_rep` | `(agent: Address) -> u32` | View. Returns `0` if no attestation exists for that agent from another chain. |

Reputation MUST only change via: (a) `REPUTATION_STEP` bump on non-self-dealing successful
completion (`requester != provider`), (b) `REP_SLASH_STEP` slash on a dispute resolved against the
provider, floored at `REP_FLOOR` (never zero), or (c) a governance-approved cross-chain attestation
(§4.6). No entry point may set reputation to an arbitrary value outside this state machine.

#### 4.4 Job / escrow lifecycle

| Entry point | Signature | Effect |
|---|---|---|
| `create_job` | `payable (skill_id: u64, task_hash: Bytes, deadline_secs: u64) -> u64` | Attached value MUST equal `price_per_call`. Caller reputation MUST meet `min_reputation_to_invoke`. `task_hash` MUST be unique (exactly-once). Emits `JobCreated`. |
| `create_job_with_evaluator` | `payable (skill_id, task_hash, deadline_secs, evaluator: Address, evaluator_fee: U512) -> u64` | As above, plus attached value MUST equal `price_per_call + evaluator_fee`. `evaluator` MUST NOT equal the requester. |
| `deliver_result` | `(job_id: u64, result_hash: Bytes)` | Provider-only. Job MUST be `Open`. Transitions to `Delivered` and repurposes `deadline` as `now + review_window`. Emits `ResultDelivered`. |
| `confirm_completion` | `(job_id: u64)` | Requester-only. Job MUST be `Delivered`. Releases escrow (+ any unused evaluator fee) to provider via pull-payment credit; bumps reputation. Emits `JobCompleted`. |
| `claim_after_review` | `(job_id: u64)` | Provider-only. Job MUST be `Delivered` and the review window MUST have elapsed with no requester action. Same settlement as `confirm_completion`. |
| `claim_refund` | `(job_id: u64)` | Requester-only. Job MUST still be `Open` (provider never delivered) and its deadline MUST have passed. Refunds escrow + evaluator fee to requester. Emits `JobRefunded`. |
| `evaluate_result` | `(job_id: u64, approved: bool)` | Callable only by the job's designated `evaluator`, within the review window. Evaluator fee releases regardless of verdict. `approved = true` settles as completion; `approved = false` moves the job to `Disputed` and refunds escrow to the requester's pull-payment balance. Emits `JobEvaluated` (+ `JobCompleted` or `ResultDisputed`). |

#### 4.5 Dispute & arbitration

This is the section with no equivalent in MCP, x402, or ERC-8004 — see
[relation-to-adjacent-standards.md](./relation-to-adjacent-standards.md#the-part-none-of-the-three-cover--dispute-resolution--is-live-on-casper).

| Entry point | Signature | Effect |
|---|---|---|
| `dispute_result` | `payable (job_id: u64)` | Requester-only, within the review window, job MUST be `Delivered`. Attached value MUST equal the required dispute bond (`dispute_bond_bps` of escrow, floored at `MIN_DISPUTE_BOND_MOTES`). Transitions job to `Disputed`. Any unused evaluator fee refunds immediately. Emits `DisputeBondPosted` + `ResultDisputed`. |
| `respond_to_dispute` | `payable (job_id: u64)` | Provider-only, within `RESPONSE_WINDOW` of the dispute. Attached value MUST exactly match the requester's posted bond (symmetric). Emits `DisputeResponsePosted`. |
| `concede_dispute` | `(job_id: u64)` | Provider-only. Callable any time before responding. Refunds escrow + requester's bond to requester; slashes provider (agent + skill) reputation by `REP_SLASH_STEP`. Emits `DisputeConceded` + `JobRefunded`. |
| `resolve_default_concede` | `(job_id: u64)` | Permissionless (anyone MAY call). Only valid once `RESPONSE_WINDOW` has elapsed with no provider response — functionally a forced concede. Same settlement as `concede_dispute`. Emits `DisputeConceded` + `JobRefunded`. |
| `arbitrate` | `(job_id: u64, verdict: Verdict)` | Arbiter-only. Requires BOTH bonds posted (dispute is "contested," not defaulted). `ProviderAtFault`: escrow + both bonds go to requester; provider (agent + skill) reputation slashed. `RequesterAtFault`: escrow + both bonds go to provider (loser-pays); provider reputation bumped (unless self-dealing). Emits `DisputeArbitrated` + (`JobRefunded` or `JobCompleted`). |
| `get_dispute_info` | `(job_id: u64) -> Option<DisputeInfo>` | View |
| `get_dispute_bond_bps` | `() -> u32` | View |

The dispute bond is symmetric and loser-pays by construction: both parties post equal collateral
before an arbiter is asked to rule, which is what makes `arbitrate`'s outcome economically
meaningful rather than a free "cry wolf" option for either side.

#### 4.6 Governance proposal lifecycle

Every mutable trust parameter this standard defines — the arbiter identity, the dispute bond
ratio, and any cross-chain reputation attestation — MUST route through this lifecycle. There MUST
NOT be a single-signer immediate-effect path for any of the three.

| Entry point | Signature | Effect |
|---|---|---|
| `propose_set_cross_chain_rep` | `(agent: Address, score: u32, source_chain: String) -> u64` | Signer-only. `score` MUST be `<= MAX_REPUTATION`. Proposer's approval counts automatically. Emits `ProposalCreated` + `ProposalApproved`. |
| `propose_set_arbiter` | `(new_arbiter: Address) -> u64` | Signer-only. Same lifecycle. |
| `propose_set_dispute_bond_bps` | `(bps: u32) -> u64` | Signer-only. Same lifecycle. |
| `approve_proposal` | `(proposal_id: u64)` | Signer-only. Each signer MAY approve once per proposal. Rejects if already executed/cancelled or already approved by that signer. Emits `ProposalApproved`. |
| `execute_proposal` | `(proposal_id: u64)` | Permissionless. Requires approvals `>= governance_threshold` AND elapsed time since proposal `>= timelock_delay`. Applies the `ProposalAction` and emits the matching domain event (`CrossChainRepUpdated` / `ArbiterUpdated` / `DisputeBondBpsUpdated`) + `ProposalExecuted`. |
| `cancel_proposal` | `(proposal_id: u64)` | Signer-only. Marks cancelled; MUST be rejected if already executed. Emits `ProposalCancelled`. |
| `get_proposal` | `(proposal_id: u64) -> GovernanceProposal` | View |
| `proposal_approval_count` | `(proposal_id: u64) -> u32` | View |

#### 4.7 Bond (Sybil resistance)

| Entry point | Signature | Effect |
|---|---|---|
| `deposit_bond` | `payable ()` | Attached value MUST be non-zero. Adds to the caller's bonded balance and clears any pending unlock. Emits `BondUpdated`. |
| `seed_eligible_bond` | `(agent: Address) -> U512` | View. Returns the bonded amount only if the agent is NOT currently unlocking (an unlocking bond is not eligible to seed reputation trust). |
| `request_bond_unlock` | `()` | Starts a `BOND_UNLOCK_COOLDOWN` timer. MUST reject if already unlocking or bond is zero. Emits `BondUpdated`. |
| `cancel_bond_unlock` | `()` | Clears the unlock timer. MUST reject if not currently unlocking. Emits `BondUpdated`. |
| `withdraw_bond` | `()` | MUST reject if not unlocking or cooldown has not elapsed. Moves the full bonded amount to the pull-payment balance. Emits `BondUpdated`. |
| `bonded_of` | `(agent: Address) -> U512` | View |
| `bond_unlock_at_of` | `(agent: Address) -> u64` | View |

#### 4.8 Pull-payment settlement

| Entry point | Signature | Effect |
|---|---|---|
| `withdraw` | `()` | Caller withdraws their full pending balance. MUST zero the ledger entry BEFORE transferring value (checks-effects-interactions ordering) regardless of whether the target chain's execution model requires it for reentrancy safety. MUST reject a zero-balance withdrawal. Emits `Withdrawn`. |
| `pending_withdrawals_of` | `(agent: Address) -> U512` | View |

All value transfers in this standard (escrow release, dispute bond return, evaluator fee, bond
withdrawal) MUST go through the pull-payment ledger, not a direct push-transfer at settlement time.
This is a security property, not a style choice — see [Security Considerations](#security-considerations).

#### 4.9 Remaining views

| Entry point | Signature |
|---|---|
| `get_job` | `(job_id: u64) -> Job` |
| `job_count` | `() -> u64` |
| `review_window` | `() -> u64` |
| `job_id_for_task_hash` | `(task_hash: Bytes) -> u64` |
| `get_job_evaluator` | `(job_id: u64) -> (Option<Address>, U512)` |
| `get_provider_jobs` | `(agent: Address) -> Vec<u64>` |
| `get_requester_jobs` | `(agent: Address) -> Vec<u64>` |

### 5. Events

A conformant implementation MUST emit an event for every state transition below (field sets are
normative; event names MAY differ, but a conformance table MUST map implementation event names to
this list — see `IPaymentPlugin-v1.md`'s reference-implementations pattern).

| Event | Fields |
|---|---|
| `SkillRegistered` | `skill_id, owner, name, price_per_call` |
| `SkillDeactivated` | `skill_id` |
| `CompositionRegistered` | `skill_id, owner, leaf_skill_ids, weights_bps` |
| `CompositionLeafPayout` | `job_id, composite_skill_id, leaf_skill_id, leaf_owner, payout` |
| `MinReputationSet` | `skill_id, min_reputation` |
| `IdentityPolicySet` | `skill_id, policy` |
| `JobCreated` | `job_id, requester, skill_id, escrow, deadline` |
| `ResultDelivered` | `job_id, result_hash` |
| `JobCompleted` | `job_id, provider, payout, new_reputation` |
| `JobRefunded` | `job_id, requester, amount` |
| `JobEvaluated` | `job_id, evaluator, approved, evaluator_payout` |
| `ResultDisputed` | `job_id, requester, amount` |
| `DisputeBondPosted` | `job_id, requester, bond` |
| `DisputeResponsePosted` | `job_id, provider, bond` |
| `DisputeConceded` | `job_id, provider` |
| `DisputeArbitrated` | `job_id, verdict, arbiter` |
| `ArbiterUpdated` | `old_arbiter, new_arbiter` |
| `DisputeBondBpsUpdated` | `old_bps, new_bps` |
| `CrossChainRepUpdated` | `agent, score, source_chain` |
| `ProposalCreated` | `proposal_id, proposer` |
| `ProposalApproved` | `proposal_id, signer, approval_count, threshold` |
| `ProposalExecuted` | `proposal_id, executor` |
| `ProposalCancelled` | `proposal_id` |
| `GovernanceConfigured` | `threshold, timelock_delay_ms` |
| `BondUpdated` | `agent, bonded_amount, seed_eligible` |
| `Withdrawn` | `who, amount` |

### 6. Job state machine

```text
                 create_job / create_job_with_evaluator
                              │
                              ▼
        ┌───────────────── Open ─────────────────┐
        │                    │                    │
   deliver_result     (deadline passes,      (never delivered)
        │              claim_refund)                │
        ▼                                            ▼
    Delivered ◄───────────────────────────────── Refunded
    │    │    │
    │    │    └─ dispute_result ──► Disputed ──┬─ concede_dispute ──────► Refunded
    │    │                                     ├─ resolve_default_concede ──► Refunded
    │    │                                     └─ arbitrate(ProviderAtFault) ──► Refunded
    │    │                                        arbitrate(RequesterAtFault) ──► Completed
    │    └─ evaluate_result(approved=false) ──► Disputed (no bond — evaluator already ruled)
    │
    ├─ confirm_completion ──► Completed
    ├─ claim_after_review (after window) ──► Completed
    └─ evaluate_result(approved=true) ──► Completed
```

`evaluate_result(approved=false)` is a distinct dispute entry from `dispute_result`: it is a
neutral evaluator's ruling (opt-in per job, §4.4), not a bonded adversarial dispute (§4.5), so it
does not require a bond and does not route through `arbitrate`.

## Rationale

- **Identity policy as a `u8` enum, not an inline registry pointer.** A skill needs to express
  "what level of proof is required," which is a small, closed-ish set of values, separately from
  "which registry resolves that proof," which is open-ended and evolves independently (see
  `IdentityPolicy-registry.md`). Coupling them would force a contract upgrade every time a new
  identity issuer scheme is adopted.
- **Reputation as a bounded `u32`, mutated only by defined state transitions.** An arbitrary
  `set_reputation` admin call would make the entire trust layer worth exactly as much as whoever
  holds that key. Every reputation change in this spec is a side effect of an economically
  meaningful event (successful completion, dispute loss, governed cross-chain attestation) — never
  a direct write.
- **Symmetric, bond-backed disputes instead of a single "flag for review" call.** An unbonded
  dispute mechanism is free to grief with — a requester could dispute every delivery to avoid
  paying, with zero cost. Requiring a matching provider bond before arbitration (§4.5) means both
  sides have skin in the game before a scarce arbiter resource gets involved, and a defaulted
  response (`resolve_default_concede`) resolves the common case (provider ghosts) without needing
  an arbiter at all.
- **Governance as multisig + timelock for every trust-parameter mutation, no single-EOA path.**
  The three governed values (arbiter, dispute bond ratio, cross-chain reputation) are exactly the
  values a malicious or compromised admin key would abuse first. Routing all three through one
  proposal lifecycle (§4.6) means the standard's security assumption is "N-of-M signers plus a
  48-hour delay," not "trust one private key."
- **Pull-payment, not push-transfer, for every value movement.** Escrow release, dispute bond
  return, and bond withdrawal all credit a ledger that the recipient later calls `withdraw()`
  against, rather than the contract pushing value at settlement time. This removes the settlement
  path from the failure surface of a misbehaving or non-payable recipient contract, independent of
  whether the target chain's execution model has EVM-style cross-call reentrancy at all.
- **Derived from an already-audited Solidity implementation, not written from scratch for
  Casper.** `contracts-odra/src/agent_skill_registry.rs` mirrors `contracts/AgentSkillRegistry.sol`
  1-to-1 in entry-point name and semantics (see [contracts-odra/README.md](../../contracts-odra/README.md)).
  The three invariants that implementation's audit focused on — checks-effects-interactions
  ordering, pull-payment-only settlement, and self-deal nullification (`requester == provider`
  never changes reputation) — are preserved here as normative MUSTs, not left as
  implementation-defined behavior.

## Backwards Compatibility

Not applicable — this is a new interface standard with no prior Casper-native version to be
compatible with. It intentionally does not touch CEP-18 (fungible tokens) or CEP-78 (NFTs); a
skill's `price_per_call` and escrow are denominated in the chain's native token (`U512` motes on
Casper) in this draft, and a CEP-18 payment rail is an explicit open question below, not something
this draft resolves.

## Reference Implementation

[`contracts-odra/src/agent_skill_registry.rs`](../../contracts-odra/src/agent_skill_registry.rs)
— Odra 2.x, deployed and verified on Casper Testnet (`hash-42f6945f…`, attestation-hardened
redeploy — tx-by-tx evidence in [DEMO_CASPER.md](../../DEMO_CASPER.md)). Every entry point in §4
is live and has been exercised against the deployed contract, not only in unit tests: a full job
lifecycle, a contested dispute ruled by a neutral on-chain arbiter (reputation slashed
`50 → 40`, escrow refunded), a governance proposal that correctly reverted
`TimelockNotElapsed` against the real 48-hour clock, and `attest_rationale`/`get_rationale_hash`
(P2-A) committing and reading back a decision-rationale hash on-chain (see `DEMO_CASPER.md`'s courtroom and
cross-chain-rep-governance sections).

Every entry point in this spec is also independently exposed as an MCP tool
(`casper_register_skill`, `casper_create_job`, `casper_dispute_result`, `casper_arbitrate`, …) in
[`src/plugins/casper.tool.ts`](../../src/plugins/casper.tool.ts), demonstrating the standard is
usable from an agent-facing client, not just from a test harness.

## Test Cases

131/131 passing in
[`contracts-odra/src/agent_skill_registry/tests.rs`](../../contracts-odra/src/agent_skill_registry/tests.rs)
(mirror of `test/AgentSkillRegistry.t.sol`) plus a `proptests.rs` property-based suite (escrow
conservation and reputation-bounds invariants, randomized over 64 cases each), covering per
`contracts-odra/README.md`: happy path,
refund window, ghost-requester / dispute / claim-after-review, double-complete guard, the trust
gate (`min_reputation_to_invoke`), identity policy enforcement, self-deal nullification, duplicate
task-hash exactly-once, constructor bounds, all seven Tier-2 bond cases, the evaluator flow, and
the governance/timelock mechanics. A conformance suite for a second implementation SHOULD mirror
this file's structure per category.

## Security Considerations

- **Self-dealing MUST be nullified, not merely discouraged.** `requester == provider` MUST NOT
  bump reputation on completion — the reference implementation checks this explicitly at
  settlement (§4.4). Without this check, an agent can wash-trade its own reputation for free.
- **The `MIN_DISPUTE_BOND_MOTES` floor MUST be enforced even when `dispute_bond_bps` is governed
  down toward zero.** Otherwise a future governance action (even a legitimate one lowering the
  bond ratio for low-value skills) could reintroduce free-dispute griefing.
- **The arbiter is a single address, governed by multisig+timelock, not multisig itself.** This
  is a deliberate scope limit: `arbitrate` needs a single caller identity check, and the multisig
  protects *who that address is*, not each individual ruling. An implementation wanting
  N-of-M arbitration on each individual verdict needs an additional layer this CEP does not
  specify — see Open Questions.
- **`task_hash` uniqueness prevents replay of the same off-chain task as two on-chain jobs.**
  An implementation MUST enforce this (`job_id_for_task_hash` existing is exactly-once, not
  advisory) — without it, a provider could be paid twice for identical delivered work, or a
  requester could re-submit a disputed task hash to reset state.
- **Fail-closed identity policy.** Per `IdentityPolicy-registry.md`, an `identity_policy` value the
  calling context doesn't recognize MUST reject the call, not silently treat it as `NONE`. A
  fail-open default would let a future, not-yet-understood policy value silently downgrade to "no
  identity required."
- **Timelock delay is a security parameter, not a UX inconvenience.** Governance actions that
  change the arbiter or the dispute bond ratio are exactly the actions a compromised signer set
  would want to execute quickly; the 48-hour default gives affected skill owners a window to
  notice and react (e.g., deactivate a skill) before a malicious governance change takes effect.

## Open Questions

- **CEP-18 payment rail.** This draft settles in the chain's native token only. A `price_per_call`
  denominated in a CEP-18 fungible token (stablecoin-priced skills) is a natural v2 extension and
  would need its own escrow-transfer semantics (`transfer_from`-style approval flow).
  See [`IPaymentPlugin-v1.md`](./IPaymentPlugin-v1.md), whose off-chain settlement abstraction
  already models "rail" as a pluggable dimension — the on-chain equivalent doesn't exist yet.
- **N-of-M arbitration.** Today `arbitrate` trusts one address (itself governed by multisig).
  Whether a future version should require multiple independent arbiter rulings per dispute is
  open — likely a v2 concern, not v1.
- **Cross-chain reputation source authentication.** `propose_set_cross_chain_rep` lets governance
  attest an off-chain-sourced score; it does not itself verify a ZK proof or a light-client
  attestation on-chain (unlike the Stellar track's Groth16/BN254 verifiers). Whether a future
  version should require an on-chain-verifiable proof rather than a governed attestation is open.
- **Independent second implementation.** A CEP with exactly one implementation is a library, not
  yet a standard the ecosystem can be said to have adopted — see the roadmap note in
  [README.md](../../README.md#why-karma). This draft should not be submitted upstream until either
  a second, independently authored Casper contract implements it, or the submission explicitly
  frames single-implementation status as a known gap for reviewers to weigh.

## Copyright

CC0 1.0 Universal — waived to the extent permitted by law, matching the Casper CEP repository's
standard licensing for accepted proposals.
