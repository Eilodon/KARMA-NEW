//! `AgentSkillRegistry` — Odra port of `contracts/AgentSkillRegistry.sol`.
//!
//! All public functions mirror the Solidity surface 1-to-1 in name and semantics. Diffs
//! that matter are inlined as comments at the call sites.

use odra::casper_types::bytesrepr::Bytes;
use odra::casper_types::U512;
use odra::prelude::*;

// ─── Constants ─────────────────────────────────────────────────────────────
//
// Reputation lives on a `u32` 0..=100 axis. The `_agent_rep` map uses `0` as the unset
// sentinel for lazy `BASE_REPUTATION` (50) initialisation — same invariant as Solidity.
pub const BASE_REPUTATION: u32 = 50;
pub const MAX_REPUTATION: u32 = 100;
pub const REPUTATION_STEP: u32 = 5;

// Casper block time is in **milliseconds** — every duration here is ms.
pub const MIN_REVIEW_WINDOW: u64 = 60 * 60 * 1_000; // 1 hour
pub const MAX_REVIEW_WINDOW: u64 = 30 * 24 * 60 * 60 * 1_000; // 30 days
pub const DEFAULT_REVIEW_WINDOW: u64 = 3 * 24 * 60 * 60 * 1_000; // 3 days
pub const BOND_UNLOCK_COOLDOWN: u64 = 7 * 24 * 60 * 60 * 1_000; // 7 days

// Identity policy values — documented in the Solidity contract and the README.
//   0 NONE · 1 T3N_VERIFIED · 2 T3N_VERIFIED_FRESH · ≥3 unknown ⇒ off-chain server fails closed.
pub const IDENTITY_POLICY_NONE: u8 = 0;
pub const IDENTITY_POLICY_T3N: u8 = 1;
pub const IDENTITY_POLICY_T3N_FRESH: u8 = 2;

// P0-B: governance constants. Multisig + timelock replaces single-EOA admin.
pub const DEFAULT_TIMELOCK_DELAY: u64 = 48 * 60 * 60 * 1_000; // 48 hours in ms
pub const MAX_GOVERNANCE_SIGNERS: u32 = 11;

// Composition primitive (T2.1). Weights live on a basis-points axis (10_000 = 100%) so
// integer arithmetic stays exact and the `register_composition` validation is a clean
// `sum == WEIGHT_DENOMINATOR` check. Single-level only for hackathon scope: a leaf may
// not itself be a composition.
pub const WEIGHT_DENOMINATOR: u32 = 10_000;
pub const MAX_COMPOSITION_LEAVES: u32 = 8;

// P1-A: Symmetric dispute bond constants.
pub const REP_SLASH_STEP: u32 = 10;
pub const REP_FLOOR: u32 = 1;
pub const MIN_DISPUTE_BOND_MOTES: u64 = 1_000_000_000; // 1 CSPR in motes (mirrors 0.001 ether)
pub const RESPONSE_WINDOW: u64 = 3 * 24 * 60 * 60 * 1_000; // 3 days in ms
// ── P4-A: Panel Arbitration (N-of-M) ──
pub const PANEL_VOTE_WINDOW: u64 = 3 * 24 * 60 * 60 * 1_000; // 3 days in ms, mirrors RESPONSE_WINDOW
pub const MIN_ARBITER_PANEL_SIZE: u32 = 3;
pub const MAX_ARBITER_PANEL_SIZE: u32 = 9; // small + bounded, mirrors MAX_COMPOSITION_LEAVES's spirit

// ─── Errors ────────────────────────────────────────────────────────────────
#[odra::odra_error]
pub enum Error {
    NameRequired = 1,
    BadThreshold = 2,
    NotSkillOwner = 3,
    AlreadyInactive = 4,
    SkillNotFound = 5,
    SkillInactive = 6,
    EscrowMustEqualPrice = 7,
    DeadlineRequired = 8,
    InsufficientReputation = 9,
    DuplicateTaskHash = 10,
    NotProvider = 11,
    JobNotOpen = 12,
    NotRequester = 13,
    JobNotDelivered = 14,
    ReviewWindowOpen = 15,
    ReviewWindowClosed = 16,
    NotRefundable = 17,
    BeforeDeadline = 18,
    NothingToWithdraw = 19,
    NoBond = 20,
    AlreadyUnlocking = 21,
    NotUnlocking = 22,
    CooldownActive = 23,
    BadReviewWindow = 24,
    // ── Composition primitive (T2.1) ──
    EmptyComposition = 25,
    TooManyLeaves = 26,
    WeightsMismatch = 27,
    LeafSkillNotFound = 28,
    LeafSkillInactive = 29,
    LeafIsComposite = 30,
    // ── Cross-chain reputation consumer (P0.1) ──
    NotContractOwner = 31,
    // ── P0-A: Evaluator Agent ──
    EvaluatorRequired = 32,
    EvaluatorCannotBeRequester = 33,
    EvaluatorCannotBeProvider = 34,
    NotEvaluator = 35,
    // ── P0-B: Governance (multisig + timelock) ──
    InvalidGovernanceConfig = 36,
    DuplicateSigner = 37,
    NotGovernanceSigner = 38,
    ProposalNotFound = 39,
    AlreadyApproved = 40,
    ThresholdNotMet = 41,
    TimelockNotElapsed = 42,
    ProposalAlreadyExecuted = 43,
    ProposalCancelled = 44,
    // ── P1-A: Symmetric Dispute Bond ──
    InsufficientDisputeBond = 45,
    WrongDisputeBond = 46,
    NotBondedDispute = 47,
    AlreadyResponded = 48,
    ResponseWindowClosed = 49,
    ResponseWindowOpen = 50,
    NotArbiter = 51,
    ProviderNotResponded = 52,
    NotDisputed = 53,
    // ── P2-A: AI decision rationale attestation ──
    RationaleAlreadyAttested = 54,
    InvalidRationaleHash = 55,
    // ── P4-A: Panel Arbitration (N-of-M) ──
    PanelSizeTooSmall = 56,
    PanelSizeMustBeOdd = 57,
    InvalidPanelThreshold = 58,
    DuplicatePanelMember = 59,
    PanelNotConfigured = 60,
    NotPanelArbiter = 61,
    AlreadyVotedOnPanel = 62,
    WrongArbitrationMode = 63,
    WrongPanelDisputeAmount = 64,
    PanelVoteWindowOpen = 65,
}

// ─── Types ─────────────────────────────────────────────────────────────────
/// Status guard for every state-transition guard. Rust's exhaustive `match` means any future
/// variant must be considered at every site — a compile-time state machine, per the team
/// blueprint's pattern-matched-status claim.
#[odra::odra_type]
pub enum JobStatus {
    Open,
    Delivered,
    Completed,
    Refunded,
    Disputed,
}

#[odra::odra_type]
#[derive(Copy)]
pub enum Verdict {
    ProviderAtFault,
    RequesterAtFault,
}

#[odra::odra_type]
pub enum ArbitrationMode {
    Single,
    Panel,
}

#[odra::odra_type]
pub struct PanelVote {
    pub arbiter: Address,
    pub verdict: Verdict,
}

#[odra::odra_type]
pub struct DisputeInfo {
    pub dispute_bond: U512,
    pub provider_bond: U512,
    pub disputed_at: u64,
}

#[odra::odra_type]
pub struct Skill {
    pub owner: Address,
    pub name: String,
    pub description: String,
    pub mcp_endpoint: String,
    pub price_per_call: U512,
    pub reputation_score: u32,
    pub total_invocations: u64,
    pub active: bool,
    pub registered_at: u64,
    pub min_reputation_to_invoke: u32,
    pub identity_policy: u8,
}

#[odra::odra_type]
pub struct Job {
    pub requester: Address,
    pub provider: Address,
    pub skill_id: u64,
    pub task_hash: Bytes,
    pub escrow_amount: U512,
    /// Open-state: refund-after deadline. After [`deliver_result`] it is repurposed as the
    /// review-window deadline (a status guard keeps the two phases from leaking — Solidity FM1).
    pub deadline: u64,
    pub status: JobStatus,
    pub result_hash: Bytes,
    pub created_at: u64,
    pub completed_at: u64,
    /// P0-A: neutral 3rd-party verifier; `None` = no evaluator (opt-in).
    pub evaluator: Option<Address>,
    /// P0-A: fee held for the evaluator; refunded to requester if unused.
    pub evaluator_fee: U512,
}

// ── P0-B: Governance types ──────────────────────────────────────────────────
#[odra::odra_type]
pub enum ProposalAction {
    SetCrossChainRep {
        agent: Address,
        score: u32,
        source_chain: String,
    },
    SetArbiter {
        new_arbiter: Address,
    },
    SetDisputeBondBps {
        bps: u32,
    },
    SetArbiterPanel {
        panel: Vec<Address>,
        threshold: u32,
    },
    SetPanelArbiterFee {
        fee: U512,
    },
}

#[odra::odra_type]
pub struct GovernanceProposal {
    pub action: ProposalAction,
    pub proposer: Address,
    pub proposed_at: u64,
    pub executed: bool,
    pub cancelled: bool,
}

// ─── Events ────────────────────────────────────────────────────────────────
#[odra::event]
pub struct SkillRegistered {
    pub skill_id: u64,
    pub owner: Address,
    pub name: String,
    pub price_per_call: U512,
}

#[odra::event]
pub struct SkillDeactivated {
    pub skill_id: u64,
}

#[odra::event]
pub struct JobCreated {
    pub job_id: u64,
    pub requester: Address,
    pub skill_id: u64,
    pub escrow: U512,
    pub deadline: u64,
}

#[odra::event]
pub struct ResultDelivered {
    pub job_id: u64,
    pub result_hash: Bytes,
}

#[odra::event]
pub struct JobCompleted {
    pub job_id: u64,
    pub provider: Address,
    pub payout: U512,
    pub new_reputation: u32,
}

#[odra::event]
pub struct JobRefunded {
    pub job_id: u64,
    pub requester: Address,
    pub amount: U512,
}

#[odra::event]
pub struct ResultDisputed {
    pub job_id: u64,
    pub requester: Address,
    pub amount: U512,
}

#[odra::event]
pub struct MinReputationSet {
    pub skill_id: u64,
    pub min_reputation: u32,
}

#[odra::event]
pub struct IdentityPolicySet {
    pub skill_id: u64,
    pub policy: u8,
}

#[odra::event]
pub struct Withdrawn {
    pub who: Address,
    pub amount: U512,
}

#[odra::event]
pub struct BondUpdated {
    pub agent: Address,
    pub bonded_amount: U512,
    pub seed_eligible: U512,
}

// ── P0-A Evaluator event ────────────────────────────────────────────────────
#[odra::event]
pub struct JobEvaluated {
    pub job_id: u64,
    pub evaluator: Address,
    pub approved: bool,
    pub evaluator_payout: U512,
}

// ── Cross-chain reputation consumer events (P0.1) ───────────────────────────
#[odra::event]
pub struct CrossChainRepUpdated {
    pub agent: Address,
    pub score: u32,
    pub source_chain: String,
}

// ── P0-B Governance events ──────────────────────────────────────────────────
#[odra::event]
pub struct ProposalCreated {
    pub proposal_id: u64,
    pub proposer: Address,
}

#[odra::event]
pub struct ProposalApproved {
    pub proposal_id: u64,
    pub signer: Address,
    pub approval_count: u32,
    pub threshold: u32,
}

#[odra::event]
pub struct ProposalExecuted {
    pub proposal_id: u64,
    pub executor: Address,
}

#[odra::event]
pub struct ProposalCancelled {
    pub proposal_id: u64,
}

#[odra::event]
pub struct GovernanceConfigured {
    pub threshold: u32,
    pub timelock_delay_ms: u64,
}

// ── P1-A: Symmetric dispute bond events ────────────────────────────────────────
#[odra::event]
pub struct DisputeBondPosted {
    pub job_id: u64,
    pub requester: Address,
    pub bond: U512,
}

#[odra::event]
pub struct DisputeResponsePosted {
    pub job_id: u64,
    pub provider: Address,
    pub bond: U512,
}

#[odra::event]
pub struct DisputeConceded {
    pub job_id: u64,
    pub provider: Address,
}

#[odra::event]
pub struct DisputeArbitrated {
    pub job_id: u64,
    pub verdict: Verdict,
    pub arbiter: Address,
}

#[odra::event]
pub struct ArbiterUpdated {
    pub old_arbiter: Address,
    pub new_arbiter: Address,
}

#[odra::event]
pub struct DisputeBondBpsUpdated {
    pub old_bps: u32,
    pub new_bps: u32,
}

// ── P2-A: AI decision rationale attestation ──────────────────────────────────
/// Emitted when a requester commits a hash of their (typically LLM-generated) decision
/// rationale for creating this job. `rationale_hash` is opaque on-chain — verifiers with the
/// plaintext rationale re-hash it and compare, giving the decision an immutable, queryable
/// on-chain anchor without KARMA having to store (or pay gas for) the plaintext itself.
#[odra::event]
pub struct RationaleAttested {
    pub job_id: u64,
    pub requester: Address,
    pub rationale_hash: Bytes,
}

// ── Composition events (T2.1) ────────────────────────────────────────────────
#[odra::event]
pub struct CompositionRegistered {
    pub skill_id: u64,
    pub owner: Address,
    pub leaf_skill_ids: Vec<u64>,
    pub weights_bps: Vec<u32>,
}

#[odra::event]
pub struct CompositionLeafPayout {
    pub job_id: u64,
    pub composite_skill_id: u64,
    pub leaf_skill_id: u64,
    pub leaf_owner: Address,
    pub payout: U512,
}

// ── Composition type (T2.1) ──────────────────────────────────────────────────
/// Single-level composition: a wrapper skill that fans out one job's escrow across
/// `leaf_skill_ids` according to `weights_bps`. Self-cuts are explicit — if the wrapper
/// owner wants a slice, the wrapper registers one of its OWN primitive skills as a leaf.
#[odra::odra_type]
pub struct Composition {
    pub leaf_skill_ids: Vec<u64>,
    pub weights_bps: Vec<u32>,
}

#[odra::event]
pub struct ArbiterPanelUpdated {
    pub old_panel: Vec<Address>,
    pub new_panel: Vec<Address>,
    pub threshold: u32,
}

#[odra::event]
pub struct PanelArbiterFeeUpdated {
    pub old_fee: U512,
    pub new_fee: U512,
}

#[odra::event]
pub struct PanelDisputePosted {
    pub job_id: u64,
    pub requester: Address,
    pub panel_fee: U512,
}

#[odra::event]
pub struct PanelVoteCast {
    pub job_id: u64,
    pub arbiter: Address,
    pub verdict: Verdict,
}

#[odra::event]
pub struct PanelArbitrated {
    pub job_id: u64,
    pub verdict: Verdict,
    pub provider_at_fault_votes: u32,
    pub requester_at_fault_votes: u32,
}

#[odra::event]
pub struct PanelFeeDistributed {
    pub job_id: u64,
    pub arbiter: Address,
    pub amount: U512,
}

#[odra::event]
pub struct PanelDefaultResolved {
    pub job_id: u64,
}

// ─── Contract ──────────────────────────────────────────────────────────────
#[odra::module(events = [
    SkillRegistered, SkillDeactivated, JobCreated, ResultDelivered, JobCompleted,
    JobRefunded, ResultDisputed, JobEvaluated, MinReputationSet, IdentityPolicySet,
    Withdrawn, BondUpdated, CompositionRegistered, CompositionLeafPayout, CrossChainRepUpdated,
    ProposalCreated, ProposalApproved, ProposalExecuted, ProposalCancelled, GovernanceConfigured,
    DisputeBondPosted, DisputeResponsePosted, DisputeConceded, DisputeArbitrated,
    ArbiterUpdated, DisputeBondBpsUpdated,
    ArbiterPanelUpdated, PanelArbiterFeeUpdated, PanelDisputePosted, PanelVoteCast,
    PanelArbitrated, PanelFeeDistributed, PanelDefaultResolved,
])]
pub struct AgentSkillRegistry {
    review_window: Var<u64>,
    skill_id_counter: Var<u64>,
    job_id_counter: Var<u64>,
    skills: Mapping<u64, Skill>,
    jobs: Mapping<u64, Job>,
    agent_provider_jobs: Mapping<Address, Vec<u64>>,
    agent_requester_jobs: Mapping<Address, Vec<u64>>,
    agent_skills: Mapping<Address, Vec<u64>>,
    pending_withdrawals: Mapping<Address, U512>,
    job_by_task_hash: Mapping<Bytes, u64>,
    agent_rep: Mapping<Address, u32>,
    bonded_amount: Mapping<Address, U512>,
    bond_unlock_at: Mapping<Address, u64>,
    /// Composite skills (T2.1). Empty entry = primitive skill; present entry = composite.
    /// Lookup is keyed by the wrapper's `skill_id` (same id space as `skills`).
    compositions: Mapping<u64, Composition>,
    /// Cross-chain reputation (P0.1). Admin-gated bridge from Soroban verifier attestations.
    cross_chain_rep: Mapping<Address, u32>,
    // ── P1-A: Symmetric dispute bond ──────────────────────────────────────────
    dispute_bond_bps: Var<u32>,
    arbiter: Var<Address>,
    disputes: Mapping<u64, DisputeInfo>,
    // ── P0-B: Governance (multisig + timelock) ─────────────────────────────────
    governance_signers: Var<Vec<Address>>,
    governance_threshold: Var<u32>,
    timelock_delay: Var<u64>,
    proposal_counter: Var<u64>,
    proposals: Mapping<u64, GovernanceProposal>,
    proposal_approvals: Mapping<u64, Vec<Address>>,
    // ── P2-A: AI decision rationale attestation ──────────────────────────────────
    /// Purely additive vs. the `Job` struct already on-chain — keeps the upgrade backward-
    /// compatible with every job written before this field existed.
    rationale_hash: Mapping<u64, Bytes>,
    // P4-A: Panel Arbitration (N-of-M). Governance-managed live fields (arbiter_panel,
    // panel_threshold, panel_arbiter_fee); a dispute snapshots them at post-time into the
    // job_panel_* mappings below so a later governance change never affects an in-flight
    // dispute (audit-design HIGH finding #3 mitigation).
    arbiter_panel: Var<Vec<Address>>,
    panel_threshold: Var<u32>,
    panel_arbiter_fee: Var<U512>,
    dispute_arbitration_mode: Mapping<u64, ArbitrationMode>,
    job_panel_snapshot: Mapping<u64, Vec<Address>>,
    job_panel_threshold_snapshot: Mapping<u64, u32>,
    panel_arbiter_fee_collected: Mapping<u64, U512>,
    panel_votes: Mapping<u64, Vec<PanelVote>>,
}

#[odra::module]
impl AgentSkillRegistry {
    /// Deploy-time configured, then immutable. Bounded to `[MIN_REVIEW_WINDOW, MAX_REVIEW_WINDOW]`.
    /// P0-B: governance signers + threshold + timelock replace single-EOA owner.
    pub fn init(
        &mut self,
        review_window_ms: u64,
        governance_signers: Vec<Address>,
        governance_threshold: u32,
        timelock_delay_ms: u64,
    ) {
        if !(MIN_REVIEW_WINDOW..=MAX_REVIEW_WINDOW).contains(&review_window_ms) {
            self.env().revert(Error::BadReviewWindow);
        }
        if governance_signers.is_empty() || governance_signers.len() as u32 > MAX_GOVERNANCE_SIGNERS {
            self.env().revert(Error::InvalidGovernanceConfig);
        }
        if governance_threshold == 0 || governance_threshold > governance_signers.len() as u32 {
            self.env().revert(Error::InvalidGovernanceConfig);
        }
        for i in 0..governance_signers.len() {
            for j in (i + 1)..governance_signers.len() {
                if governance_signers[i] == governance_signers[j] {
                    self.env().revert(Error::DuplicateSigner);
                }
            }
        }
        self.review_window.set(review_window_ms);
        self.dispute_bond_bps.set(10_000); // 1× escrow (default)
        self.arbiter.set(governance_signers[0]); // first signer = initial arbiter
        self.governance_signers.set(governance_signers);
        self.governance_threshold.set(governance_threshold);
        self.timelock_delay.set(timelock_delay_ms);
        self.env().emit_event(GovernanceConfigured {
            threshold: governance_threshold,
            timelock_delay_ms,
        });
    }

    // ── Skill lifecycle ────────────────────────────────────────────────────
    pub fn register_skill(
        &mut self,
        name: String,
        description: String,
        mcp_endpoint: String,
        price_per_call: U512,
        min_reputation_to_invoke: u32,
        identity_policy: u8,
    ) -> u64 {
        if name.is_empty() {
            self.env().revert(Error::NameRequired);
        }
        if min_reputation_to_invoke > MAX_REPUTATION {
            self.env().revert(Error::BadThreshold);
        }
        let skill_id = self.skill_id_counter.get_or_default() + 1;
        self.skill_id_counter.set(skill_id);

        let owner = self.env().caller();
        let now = self.env().get_block_time();
        let skill = Skill {
            owner,
            name: name.clone(),
            description,
            mcp_endpoint,
            price_per_call,
            reputation_score: BASE_REPUTATION,
            total_invocations: 0,
            active: true,
            registered_at: now,
            min_reputation_to_invoke,
            identity_policy,
        };
        self.skills.set(&skill_id, skill);

        let mut owned = self.agent_skills.get(&owner).unwrap_or_default();
        owned.push(skill_id);
        self.agent_skills.set(&owner, owned);

        self.env().emit_event(SkillRegistered {
            skill_id,
            owner,
            name,
            price_per_call,
        });
        skill_id
    }

    /// Register a composite skill (T2.1). The wrapper itself is a normal Skill entry; the
    /// `compositions` map records its leaf split. Constraints (all asserted on-chain):
    ///   - 1 ≤ leaves ≤ MAX_COMPOSITION_LEAVES
    ///   - `weights_bps.len() == leaf_skill_ids.len()`
    ///   - Σ weights_bps == WEIGHT_DENOMINATOR (10_000)
    ///   - every leaf_skill_id exists, is active, and is NOT itself a composition
    ///     (single-level only for hackathon scope)
    /// Reputation/identity gates on the WRAPPER are inherited from the wrapper's own Skill
    /// entry, so a composite can be gated independently of its leaves' gates.
    pub fn register_composition(
        &mut self,
        name: String,
        description: String,
        mcp_endpoint: String,
        price_per_call: U512,
        min_reputation_to_invoke: u32,
        identity_policy: u8,
        leaf_skill_ids: Vec<u64>,
        weights_bps: Vec<u32>,
    ) -> u64 {
        if leaf_skill_ids.is_empty() {
            self.env().revert(Error::EmptyComposition);
        }
        if leaf_skill_ids.len() as u32 > MAX_COMPOSITION_LEAVES {
            self.env().revert(Error::TooManyLeaves);
        }
        if leaf_skill_ids.len() != weights_bps.len() {
            self.env().revert(Error::WeightsMismatch);
        }
        let mut sum: u32 = 0;
        for w in weights_bps.iter() {
            sum = sum.saturating_add(*w);
        }
        if sum != WEIGHT_DENOMINATOR {
            self.env().revert(Error::WeightsMismatch);
        }
        for leaf_id in leaf_skill_ids.iter() {
            let leaf = self
                .skills
                .get(leaf_id)
                .unwrap_or_else(|| self.env().revert(Error::LeafSkillNotFound));
            if !leaf.active {
                self.env().revert(Error::LeafSkillInactive);
            }
            if self.compositions.get(leaf_id).is_some() {
                // Single-level only: leaves must be primitive. Lifts hackathon-scope ambiguity
                // about whether revenue/rep should cascade transitively. Revisit post-hackathon.
                self.env().revert(Error::LeafIsComposite);
            }
        }

        // Register the wrapper as a normal Skill entry — same id space — then attach the
        // composition record under that id. Reusing `register_skill`'s shape keeps discovery
        // and gating logic untouched.
        let skill_id = self.register_skill(
            name,
            description,
            mcp_endpoint,
            price_per_call,
            min_reputation_to_invoke,
            identity_policy,
        );
        let composition = Composition {
            leaf_skill_ids: leaf_skill_ids.clone(),
            weights_bps: weights_bps.clone(),
        };
        self.compositions.set(&skill_id, composition);

        let owner = self.env().caller();
        self.env().emit_event(CompositionRegistered {
            skill_id,
            owner,
            leaf_skill_ids,
            weights_bps,
        });
        skill_id
    }

    /// View: returns the composition record for a composite skill, or None for a primitive.
    pub fn get_composition(&self, skill_id: u64) -> Option<Composition> {
        self.compositions.get(&skill_id)
    }

    /// View: convenience boolean — is this skill a composite?
    pub fn is_composite(&self, skill_id: u64) -> bool {
        self.compositions.get(&skill_id).is_some()
    }

    pub fn deactivate_skill(&mut self, skill_id: u64) {
        let mut s = self.require_skill(skill_id);
        if s.owner != self.env().caller() {
            self.env().revert(Error::NotSkillOwner);
        }
        if !s.active {
            self.env().revert(Error::AlreadyInactive);
        }
        s.active = false;
        self.skills.set(&skill_id, s);
        self.env().emit_event(SkillDeactivated { skill_id });
    }

    pub fn set_min_reputation(&mut self, skill_id: u64, min_reputation: u32) {
        let mut s = self.require_skill(skill_id);
        if s.owner != self.env().caller() {
            self.env().revert(Error::NotSkillOwner);
        }
        if min_reputation > MAX_REPUTATION {
            self.env().revert(Error::BadThreshold);
        }
        s.min_reputation_to_invoke = min_reputation;
        self.skills.set(&skill_id, s);
        self.env().emit_event(MinReputationSet { skill_id, min_reputation });
    }

    pub fn set_identity_policy(&mut self, skill_id: u64, policy: u8) {
        let mut s = self.require_skill(skill_id);
        if s.owner != self.env().caller() {
            self.env().revert(Error::NotSkillOwner);
        }
        s.identity_policy = policy;
        self.skills.set(&skill_id, s);
        self.env().emit_event(IdentityPolicySet { skill_id, policy });
    }

    // ── Reputation ─────────────────────────────────────────────────────────
    pub fn agent_reputation(&self, agent: Address) -> u32 {
        let r = self.agent_rep.get(&agent).unwrap_or(0);
        if r == 0 { BASE_REPUTATION } else { r }
    }

    // ── Job lifecycle ──────────────────────────────────────────────────────
    /// Payable. Backward-compatible wrapper — creates a job without an evaluator.
    #[odra(payable)]
    pub fn create_job(&mut self, skill_id: u64, task_hash: Bytes, deadline_secs: u64) -> u64 {
        self._create_job(skill_id, task_hash, deadline_secs, None, U512::zero())
    }

    /// Payable. Create a job with a neutral third-party evaluator (P0-A).
    /// `attached_value` must equal `price_per_call + evaluator_fee`.
    #[odra(payable)]
    pub fn create_job_with_evaluator(
        &mut self,
        skill_id: u64,
        task_hash: Bytes,
        deadline_secs: u64,
        evaluator: Address,
        evaluator_fee: U512,
    ) -> u64 {
        let caller = self.env().caller();
        if evaluator == caller {
            self.env().revert(Error::EvaluatorCannotBeRequester);
        }
        self._create_job(skill_id, task_hash, deadline_secs, Some(evaluator), evaluator_fee)
    }

    pub fn deliver_result(&mut self, job_id: u64, result_hash: Bytes) {
        let mut j = self.require_job(job_id);
        if j.provider != self.env().caller() {
            self.env().revert(Error::NotProvider);
        }
        if j.status != JobStatus::Open {
            self.env().revert(Error::JobNotOpen);
        }
        j.status = JobStatus::Delivered;
        j.result_hash = result_hash.clone();
        // Repurpose `deadline` as the review-by time. `claim_refund`'s `status == Open` guard
        // stops cross-talk (Solidity FM1 audit).
        j.deadline = self.env().get_block_time() + self.review_window.get_or_default();
        self.jobs.set(&job_id, j);
        self.env().emit_event(ResultDelivered { job_id, result_hash });
    }

    pub fn confirm_completion(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        if j.requester != self.env().caller() {
            self.env().revert(Error::NotRequester);
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        // Evaluator fee refund: requester acted directly, evaluator didn't — fee returns to requester.
        if !j.evaluator_fee.is_zero() {
            let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default() + j.evaluator_fee;
            self.pending_withdrawals.set(&j.requester, credit);
        }
        self.settle_completion(&mut j, job_id);
        self.jobs.set(&job_id, j);
    }

    pub fn claim_after_review(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        if j.provider != self.env().caller() {
            self.env().revert(Error::NotProvider);
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        if self.env().get_block_time() <= j.deadline {
            self.env().revert(Error::ReviewWindowOpen);
        }
        // Evaluator fee refund: evaluator didn't act — fee returns to requester.
        if !j.evaluator_fee.is_zero() {
            let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default() + j.evaluator_fee;
            self.pending_withdrawals.set(&j.requester, credit);
        }
        self.settle_completion(&mut j, job_id);
        self.jobs.set(&job_id, j);
    }

    /// P1-A: Requester disputes a delivered result within the review window.
    /// Bond-backed — requester must lock a dispute bond proportional to escrow.
    /// Escrow is held until resolution; evaluator fee (if any) returned immediately.
    #[odra(payable)]
    pub fn dispute_result(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        let caller = self.env().caller();
        if j.requester != caller {
            self.env().revert(Error::NotRequester);
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        if self.env().get_block_time() > j.deadline {
            self.env().revert(Error::ReviewWindowClosed);
        }

        let bps = self.dispute_bond_bps.get_or_default();
        let mut required_bond = (U512::from(bps) * j.escrow_amount) / U512::from(10_000u32);
        let min_bond = U512::from(MIN_DISPUTE_BOND_MOTES);
        if required_bond < min_bond {
            required_bond = min_bond;
        }
        let attached = self.env().attached_value();
        if attached != required_bond {
            self.env().revert(Error::WrongDisputeBond);
        }

        j.status = JobStatus::Disputed;
        let dispute_info = DisputeInfo {
            dispute_bond: attached,
            provider_bond: U512::zero(),
            disputed_at: self.env().get_block_time(),
        };
        self.disputes.set(&job_id, dispute_info);

        if !j.evaluator_fee.is_zero() {
            let credit = self.pending_withdrawals.get(&caller).unwrap_or_default() + j.evaluator_fee;
            self.pending_withdrawals.set(&caller, credit);
        }

        let amount = j.escrow_amount;
        self.jobs.set(&job_id, j);
        self.env().emit_event(DisputeBondPosted { job_id, requester: caller, bond: attached });
        self.env().emit_event(ResultDisputed { job_id, requester: caller, amount });
    }

/// P4-A: Like `dispute_result`, but flags the job for panel arbitration and collects an
/// additional flat participation fee (governance-set) on top of the standard dispute bond.
/// Snapshots the panel + threshold + fee onto the job's own storage at this moment — a
/// later `propose_set_arbiter_panel`/`propose_set_panel_arbiter_fee` execution must never
/// change the terms an already-posted dispute is running under (audit-design HIGH #3).
#[odra(payable)]
pub fn dispute_result_via_panel(&mut self, job_id: u64) {
    let mut j = self.require_job(job_id);
    let caller = self.env().caller();
    if j.requester != caller {
        self.env().revert(Error::NotRequester);
    }
    if j.status != JobStatus::Delivered {
        self.env().revert(Error::JobNotDelivered);
    }
    if self.env().get_block_time() > j.deadline {
        self.env().revert(Error::ReviewWindowClosed);
    }
    let panel = self.arbiter_panel.get_or_default();
    if panel.is_empty() {
        self.env().revert(Error::PanelNotConfigured);
    }

    let bps = self.dispute_bond_bps.get_or_default();
    let mut required_bond = (U512::from(bps) * j.escrow_amount) / U512::from(10_000u32);
    let min_bond = U512::from(MIN_DISPUTE_BOND_MOTES);
    if required_bond < min_bond {
        required_bond = min_bond;
    }
    let fee = self.panel_arbiter_fee.get_or_default();
    let required_total = required_bond + fee;
    let attached = self.env().attached_value();
    if attached != required_total {
        self.env().revert(Error::WrongPanelDisputeAmount);
    }

    let threshold = self.panel_threshold.get_or_default();
    self.job_panel_snapshot.set(&job_id, panel);
    self.job_panel_threshold_snapshot.set(&job_id, threshold);
    self.panel_arbiter_fee_collected.set(&job_id, fee);
    self.dispute_arbitration_mode.set(&job_id, ArbitrationMode::Panel);

    j.status = JobStatus::Disputed;
    let dispute_info = DisputeInfo {
        dispute_bond: required_bond,
        provider_bond: U512::zero(),
        disputed_at: self.env().get_block_time(),
    };
    self.disputes.set(&job_id, dispute_info);

    if !j.evaluator_fee.is_zero() {
        let credit = self.pending_withdrawals.get(&caller).unwrap_or_default() + j.evaluator_fee;
        self.pending_withdrawals.set(&caller, credit);
    }

    let amount = j.escrow_amount;
    self.jobs.set(&job_id, j);
    self.env().emit_event(DisputeBondPosted { job_id, requester: caller, bond: required_bond });
    self.env().emit_event(PanelDisputePosted { job_id, requester: caller, panel_fee: fee });
    self.env().emit_event(ResultDisputed { job_id, requester: caller, amount });
}

    /// P1-A: Provider matches the dispute bond to contest (enter arbitration).
    #[odra(payable)]
    pub fn respond_to_dispute(&mut self, job_id: u64) {
        let j = self.require_job(job_id);
        let caller = self.env().caller();
        if j.provider != caller {
            self.env().revert(Error::NotProvider);
        }
        if j.status != JobStatus::Disputed {
            self.env().revert(Error::NotDisputed);
        }
        let mut d = self.disputes.get(&job_id)
            .unwrap_or_else(|| self.env().revert(Error::NotBondedDispute));
        if d.dispute_bond.is_zero() {
            self.env().revert(Error::NotBondedDispute);
        }
        if !d.provider_bond.is_zero() {
            self.env().revert(Error::AlreadyResponded);
        }
        if self.env().get_block_time() > d.disputed_at + RESPONSE_WINDOW {
            self.env().revert(Error::ResponseWindowClosed);
        }
        let attached = self.env().attached_value();
        if attached != d.dispute_bond {
            self.env().revert(Error::WrongDisputeBond);
        }

        d.provider_bond = attached;
        self.disputes.set(&job_id, d);
        self.env().emit_event(DisputeResponsePosted { job_id, provider: caller, bond: attached });
    }

    /// P1-A: Provider concedes the dispute. Escrow + requester bond returned; provider rep slashed.
    pub fn concede_dispute(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        let caller = self.env().caller();
        if j.provider != caller {
            self.env().revert(Error::NotProvider);
        }
        if j.status != JobStatus::Disputed {
            self.env().revert(Error::NotDisputed);
        }
        let d = self.disputes.get(&job_id)
            .unwrap_or_else(|| self.env().revert(Error::NotBondedDispute));
        if d.dispute_bond.is_zero() {
            self.env().revert(Error::NotBondedDispute);
        }
        if !d.provider_bond.is_zero() {
            self.env().revert(Error::AlreadyResponded);
        }

        j.status = JobStatus::Refunded;
        let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default()
            + j.escrow_amount + d.dispute_bond;
        self.pending_withdrawals.set(&j.requester, credit);
        self.slash_agent_rep(j.provider);
        self.slash_skill_rep(j.skill_id);
        let requester = j.requester;
        let escrow = j.escrow_amount;
        self.jobs.set(&job_id, j);
        self.env().emit_event(DisputeConceded { job_id, provider: caller });
        self.env().emit_event(JobRefunded { job_id, requester, amount: escrow });
    }

    /// P1-A: Anyone can trigger default concede if provider doesn't respond within RESPONSE_WINDOW.
    pub fn resolve_default_concede(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        if j.status != JobStatus::Disputed {
            self.env().revert(Error::NotDisputed);
        }
        let d = self.disputes.get(&job_id)
            .unwrap_or_else(|| self.env().revert(Error::NotBondedDispute));
        if d.dispute_bond.is_zero() {
            self.env().revert(Error::NotBondedDispute);
        }
        if !d.provider_bond.is_zero() {
            self.env().revert(Error::AlreadyResponded);
        }
        if self.env().get_block_time() <= d.disputed_at + RESPONSE_WINDOW {
            self.env().revert(Error::ResponseWindowOpen);
        }

        j.status = JobStatus::Refunded;
        let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default()
            + j.escrow_amount + d.dispute_bond;
        self.pending_withdrawals.set(&j.requester, credit);
        self.slash_agent_rep(j.provider);
        self.slash_skill_rep(j.skill_id);
        let provider = j.provider;
        let requester = j.requester;
        let escrow = j.escrow_amount;
        self.jobs.set(&job_id, j);
        self.env().emit_event(DisputeConceded { job_id, provider });
        self.env().emit_event(JobRefunded { job_id, requester, amount: escrow });
    }

/// P4-A: Anyone may call once `PANEL_VOTE_WINDOW` elapses without the panel reaching
/// majority. Defaults `ProviderAtFault` — the same direction `resolve_default_concede`
/// already defaults to when a provider goes silent — because under-participation is treated
/// as the panel-operator side's risk, not the requester's. Requires the provider to have
/// already responded (bonded); an unresponsive PROVIDER is still `resolve_default_concede`'s
/// job, unchanged (that function explicitly reverts `AlreadyResponded` once `provider_bond`
/// is set, so the two functions' preconditions are mutually exclusive by construction).
pub fn resolve_panel_default(&mut self, job_id: u64) {
    let j = self.require_job(job_id);
    if j.status != JobStatus::Disputed {
        self.env().revert(Error::NotDisputed);
    }
    if self.dispute_arbitration_mode.get(&job_id) != Some(ArbitrationMode::Panel) {
        self.env().revert(Error::WrongArbitrationMode);
    }
    let d = self.disputes.get(&job_id)
        .unwrap_or_else(|| self.env().revert(Error::NotBondedDispute));
    if d.provider_bond.is_zero() {
        self.env().revert(Error::ProviderNotResponded);
    }
    if self.env().get_block_time() <= d.disputed_at + PANEL_VOTE_WINDOW {
        self.env().revert(Error::PanelVoteWindowOpen);
    }

    self.settle_dispute_verdict(job_id, j, d.dispute_bond, d.provider_bond, Verdict::ProviderAtFault);
    self.env().emit_event(PanelDefaultResolved { job_id });

    let votes = self.panel_votes.get(&job_id).unwrap_or_default();
    self.distribute_panel_fee(job_id, &votes);
}

    /// P1-A: Arbiter adjudicates a contested dispute (both sides bonded). Loser-pays.
    pub fn arbitrate(&mut self, job_id: u64, verdict: Verdict) {
        let caller = self.env().caller();
        if caller != self.arbiter.get().unwrap() {
            self.env().revert(Error::NotArbiter);
        }
        let j = self.require_job(job_id);
        if j.status != JobStatus::Disputed {
            self.env().revert(Error::NotDisputed);
        }
        // P4-A: a job specifically routed through panel arbitration must only ever be settled
        // by cast_panel_vote reaching its own threshold — never by the single arbiter directly,
        // or panel mode provides no guarantee beyond the single-arbiter path it exists to
        // supplement. Pre-existing (Single-mode) jobs have no entry here, so this is additive.
        if self.dispute_arbitration_mode.get(&job_id) == Some(ArbitrationMode::Panel) {
            self.env().revert(Error::WrongArbitrationMode);
        }
        let d = self.disputes.get(&job_id)
            .unwrap_or_else(|| self.env().revert(Error::NotBondedDispute));
        if d.dispute_bond.is_zero() {
            self.env().revert(Error::NotBondedDispute);
        }
        if d.provider_bond.is_zero() {
            self.env().revert(Error::ProviderNotResponded);
        }

        self.settle_dispute_verdict(job_id, j, d.dispute_bond, d.provider_bond, verdict);
        self.env().emit_event(DisputeArbitrated { job_id, verdict, arbiter: caller });
    }

    /// Shared by `arbitrate` (single-arbiter) and `cast_panel_vote` (panel, once threshold is
    /// reached) — exactly one audited fund-movement/reputation code path for a dispute verdict,
    /// per audit-design goal G6 (plan Task 2). Extracted verbatim from `arbitrate`'s original
    /// body — no logic changed, only relocated.
    fn settle_dispute_verdict(
        &mut self,
        job_id: u64,
        mut j: Job,
        dispute_bond: U512,
        provider_bond: U512,
        verdict: Verdict,
    ) {
        match verdict {
            Verdict::ProviderAtFault => {
                j.status = JobStatus::Refunded;
                let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default()
                    + j.escrow_amount + dispute_bond + provider_bond;
                self.pending_withdrawals.set(&j.requester, credit);
                self.slash_agent_rep(j.provider);
                self.slash_skill_rep(j.skill_id);
                let requester = j.requester;
                let escrow = j.escrow_amount;
                self.jobs.set(&job_id, j);
                self.env().emit_event(JobRefunded { job_id, requester, amount: escrow });
            }
            Verdict::RequesterAtFault => {
                j.status = JobStatus::Completed;
                j.completed_at = self.env().get_block_time();
                let provider_total = j.escrow_amount + provider_bond + dispute_bond;
                let credit = self.pending_withdrawals.get(&j.provider).unwrap_or_default() + provider_total;
                self.pending_withdrawals.set(&j.provider, credit);
                let mut s = self.require_skill(j.skill_id);
                if j.requester != j.provider {
                    s.total_invocations += 1;
                    let rep = s.reputation_score.saturating_add(REPUTATION_STEP);
                    s.reputation_score = if rep > MAX_REPUTATION { MAX_REPUTATION } else { rep };
                    self.skills.set(&j.skill_id, s.clone());
                    self.bump_agent_rep(j.provider);
                }
                let provider = j.provider;
                let escrow = j.escrow_amount;
                self.jobs.set(&job_id, j);
                self.env().emit_event(JobCompleted {
                    job_id,
                    provider,
                    payout: escrow,
                    new_reputation: s.reputation_score,
                });
            }
        }
    }

/// P4-A: One vote from one panel member. `respond_to_dispute` (provider matching the bond)
/// is unchanged and still required before a panel dispute can settle — a panel doesn't let
/// a provider skip responding. Reads panel membership + threshold from the job's OWN
/// snapshot (`job_panel_snapshot`), never the live `arbiter_panel`, so a governance change
/// mid-dispute cannot affect this job (audit-design HIGH #3).
pub fn cast_panel_vote(&mut self, job_id: u64, verdict: Verdict) {
    let caller = self.env().caller();
    let j = self.require_job(job_id);
    if j.status != JobStatus::Disputed {
        self.env().revert(Error::NotDisputed);
    }
    if self.dispute_arbitration_mode.get(&job_id) != Some(ArbitrationMode::Panel) {
        self.env().revert(Error::WrongArbitrationMode);
    }
    let panel = self.job_panel_snapshot.get(&job_id).unwrap_or_default();
    if !panel.contains(&caller) {
        self.env().revert(Error::NotPanelArbiter);
    }
    let d = self.disputes.get(&job_id)
        .unwrap_or_else(|| self.env().revert(Error::NotBondedDispute));
    if d.provider_bond.is_zero() {
        self.env().revert(Error::ProviderNotResponded);
    }

    let mut votes = self.panel_votes.get(&job_id).unwrap_or_default();
    if votes.iter().any(|v| v.arbiter == caller) {
        self.env().revert(Error::AlreadyVotedOnPanel);
    }
    votes.push(PanelVote { arbiter: caller, verdict });
    self.panel_votes.set(&job_id, votes.clone());
    self.env().emit_event(PanelVoteCast { job_id, arbiter: caller, verdict });

    let provider_at_fault_votes = votes.iter()
        .filter(|v| v.verdict == Verdict::ProviderAtFault).count() as u32;
    let requester_at_fault_votes = votes.iter()
        .filter(|v| v.verdict == Verdict::RequesterAtFault).count() as u32;
    let threshold = self.job_panel_threshold_snapshot.get(&job_id).unwrap_or_default();

    let winning_verdict = if provider_at_fault_votes >= threshold {
        Some(Verdict::ProviderAtFault)
    } else if requester_at_fault_votes >= threshold {
        Some(Verdict::RequesterAtFault)
    } else {
        None
    };

    if let Some(final_verdict) = winning_verdict {
        self.settle_dispute_verdict(job_id, j, d.dispute_bond, d.provider_bond, final_verdict);
        self.env().emit_event(PanelArbitrated {
            job_id,
            verdict: final_verdict,
            provider_at_fault_votes,
            requester_at_fault_votes,
        });
        self.distribute_panel_fee(job_id, &votes);
    }
}

/// P4-A: Flat fee, split evenly across every arbiter who voted (regardless of which side),
/// pull-payment via `pending_withdrawals` — never a push-transfer, per audit-design HIGH #1
/// (independently confirmed safe/required by specialist-review of the Task 1+2 groundwork).
/// Last voter absorbs the rounding remainder, mirroring `settle_completion`'s composite-payout
/// pattern exactly (audit-design MEDIUM finding).
fn distribute_panel_fee(&mut self, job_id: u64, votes: &[PanelVote]) {
    let fee = self.panel_arbiter_fee_collected.get(&job_id).unwrap_or_default();
    if fee.is_zero() || votes.is_empty() {
        return;
    }
    let n = votes.len();
    let mut distributed = U512::zero();
    for (i, v) in votes.iter().enumerate() {
        let share = if i + 1 == n {
            fee - distributed
        } else {
            let s = fee / U512::from(n as u64);
            distributed += s;
            s
        };
        let credit = self.pending_withdrawals.get(&v.arbiter).unwrap_or_default() + share;
        self.pending_withdrawals.set(&v.arbiter, credit);
        self.env().emit_event(PanelFeeDistributed { job_id, arbiter: v.arbiter, amount: share });
    }
}

    /// P1-A/P0-B: Propose a dispute bond percentage change. 10_000 = 1× escrow (default).
    /// Governance-signer only; takes effect via the same multisig+timelock proposal lifecycle
    /// as `propose_set_cross_chain_rep` — no single-signer immediate-effect path.
    pub fn propose_set_dispute_bond_bps(&mut self, bps: u32) -> u64 {
        self.require_governance_signer();
        let caller = self.env().caller();
        let proposal_id = self.proposal_counter.get_or_default() + 1;
        self.proposal_counter.set(proposal_id);

        let proposal = GovernanceProposal {
            action: ProposalAction::SetDisputeBondBps { bps },
            proposer: caller,
            proposed_at: self.env().get_block_time(),
            executed: false,
            cancelled: false,
        };
        self.proposals.set(&proposal_id, proposal);
        self.proposal_approvals.set(&proposal_id, vec![caller]);

        self.env().emit_event(ProposalCreated { proposal_id, proposer: caller });
        self.env().emit_event(ProposalApproved {
            proposal_id,
            signer: caller,
            approval_count: 1,
            threshold: self.governance_threshold.get_or_default(),
        });
        proposal_id
    }

    /// P1-A/P0-B: Propose an arbiter change. Governance-signer only; same proposal lifecycle
    /// as `propose_set_cross_chain_rep` — no single-signer immediate-effect path.
    pub fn propose_set_arbiter(&mut self, new_arbiter: Address) -> u64 {
        self.require_governance_signer();
        let caller = self.env().caller();
        let proposal_id = self.proposal_counter.get_or_default() + 1;
        self.proposal_counter.set(proposal_id);

        let proposal = GovernanceProposal {
            action: ProposalAction::SetArbiter { new_arbiter },
            proposer: caller,
            proposed_at: self.env().get_block_time(),
            executed: false,
            cancelled: false,
        };
        self.proposals.set(&proposal_id, proposal);
        self.proposal_approvals.set(&proposal_id, vec![caller]);

        self.env().emit_event(ProposalCreated { proposal_id, proposer: caller });
        self.env().emit_event(ProposalApproved {
            proposal_id,
            signer: caller,
            approval_count: 1,
            threshold: self.governance_threshold.get_or_default(),
        });
        proposal_id
    }

/// P4-A: Propose a new N-of-M arbiter panel. Governance-signer only, same proposal
/// lifecycle as `propose_set_arbiter`. Validates panel shape at propose time so a bad
/// configuration never even reaches the approval queue.
pub fn propose_set_arbiter_panel(&mut self, panel: Vec<Address>, threshold: u32) -> u64 {
    self.require_governance_signer();
    self.validate_panel_shape(&panel, threshold);

    let caller = self.env().caller();
    let proposal_id = self.proposal_counter.get_or_default() + 1;
    self.proposal_counter.set(proposal_id);

    let proposal = GovernanceProposal {
        action: ProposalAction::SetArbiterPanel { panel, threshold },
        proposer: caller,
        proposed_at: self.env().get_block_time(),
        executed: false,
        cancelled: false,
    };
    self.proposals.set(&proposal_id, proposal);
    self.proposal_approvals.set(&proposal_id, vec![caller]);

    self.env().emit_event(ProposalCreated { proposal_id, proposer: caller });
    self.env().emit_event(ProposalApproved {
        proposal_id,
        signer: caller,
        approval_count: 1,
        threshold: self.governance_threshold.get_or_default(),
    });
    proposal_id
}

/// P4-A: Propose a new flat panel-arbiter participation fee. Same governed lifecycle.
pub fn propose_set_panel_arbiter_fee(&mut self, fee: U512) -> u64 {
    self.require_governance_signer();
    let caller = self.env().caller();
    let proposal_id = self.proposal_counter.get_or_default() + 1;
    self.proposal_counter.set(proposal_id);

    let proposal = GovernanceProposal {
        action: ProposalAction::SetPanelArbiterFee { fee },
        proposer: caller,
        proposed_at: self.env().get_block_time(),
        executed: false,
        cancelled: false,
    };
    self.proposals.set(&proposal_id, proposal);
    self.proposal_approvals.set(&proposal_id, vec![caller]);

    self.env().emit_event(ProposalCreated { proposal_id, proposer: caller });
    self.env().emit_event(ProposalApproved {
        proposal_id,
        signer: caller,
        approval_count: 1,
        threshold: self.governance_threshold.get_or_default(),
    });
    proposal_id
}

/// Shared by `propose_set_arbiter_panel` and `execute_proposal`'s `SetArbiterPanel` arm
/// (defense-in-depth per specialist-review: validated at propose time AND re-checked at
/// execute time, so no future code path that could construct a `SetArbiterPanel` action
/// without going through the validated constructor could ever store a broken panel).
fn validate_panel_shape(&self, panel: &[Address], threshold: u32) {
    let len = panel.len() as u32;
    if !(MIN_ARBITER_PANEL_SIZE..=MAX_ARBITER_PANEL_SIZE).contains(&len) {
        self.env().revert(Error::PanelSizeTooSmall);
    }
    if len.is_multiple_of(2) {
        self.env().revert(Error::PanelSizeMustBeOdd);
    }
    if threshold != len / 2 + 1 {
        self.env().revert(Error::InvalidPanelThreshold);
    }
    for i in 0..panel.len() {
        for j in (i + 1)..panel.len() {
            if panel[i] == panel[j] {
                self.env().revert(Error::DuplicatePanelMember);
            }
        }
    }
}

pub fn get_arbiter_panel(&self) -> Vec<Address> {
    self.arbiter_panel.get_or_default()
}

pub fn get_panel_threshold(&self) -> u32 {
    self.panel_threshold.get_or_default()
}

    /// Evaluator approves or rejects a delivered result (P0-A). Only callable by the job's
    /// designated evaluator within the review window. The evaluator fee is released regardless.
    pub fn evaluate_result(&mut self, job_id: u64, approved: bool) {
        let mut j = self.require_job(job_id);
        let caller = self.env().caller();
        match j.evaluator {
            Some(ev) if ev == caller => {},
            _ => self.env().revert(Error::NotEvaluator),
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        if self.env().get_block_time() > j.deadline {
            self.env().revert(Error::ReviewWindowClosed);
        }

        // Evaluator fee released to evaluator regardless of verdict.
        if !j.evaluator_fee.is_zero() {
            let credit = self.pending_withdrawals.get(&caller).unwrap_or_default() + j.evaluator_fee;
            self.pending_withdrawals.set(&caller, credit);
        }
        self.env().emit_event(JobEvaluated {
            job_id,
            evaluator: caller,
            approved,
            evaluator_payout: j.evaluator_fee,
        });

        if approved {
            self.settle_completion(&mut j, job_id);
        } else {
            j.status = JobStatus::Disputed;
            let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default() + j.escrow_amount;
            self.pending_withdrawals.set(&j.requester, credit);
            let amount = j.escrow_amount;
            let requester = j.requester;
            self.env().emit_event(ResultDisputed { job_id, requester, amount });
        }
        self.jobs.set(&job_id, j);
    }

    pub fn claim_refund(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        if j.requester != self.env().caller() {
            self.env().revert(Error::NotRequester);
        }
        if j.status != JobStatus::Open {
            self.env().revert(Error::NotRefundable);
        }
        if self.env().get_block_time() <= j.deadline {
            self.env().revert(Error::BeforeDeadline);
        }
        j.status = JobStatus::Refunded;
        // Escrow + evaluator fee both return to requester.
        let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default()
            + j.escrow_amount + j.evaluator_fee;
        self.pending_withdrawals.set(&j.requester, credit);
        let amount = j.escrow_amount;
        let requester = j.requester;
        self.jobs.set(&job_id, j);
        self.env().emit_event(JobRefunded { job_id, requester, amount });
    }

    // ── Pull-payment ───────────────────────────────────────────────────────
    /// CEI: ledger zeroed BEFORE the transfer. Casper's execution model is per-deploy isolated,
    /// so cross-call re-entrancy of the Solidity flavour isn't reachable; we still keep the
    /// zero-before-pay pattern for parity with the audited Solidity (and for any future cross-
    /// contract `transfer_tokens` invariants).
    pub fn withdraw(&mut self) {
        let caller = self.env().caller();
        let amount = self.pending_withdrawals.get(&caller).unwrap_or_default();
        if amount.is_zero() {
            self.env().revert(Error::NothingToWithdraw);
        }
        self.pending_withdrawals.set(&caller, U512::zero());
        self.env().transfer_tokens(&caller, &amount);
        self.env().emit_event(Withdrawn { who: caller, amount });
    }

    // ── Tier-2 Sybil-resistance bond (PD-007) ──────────────────────────────
    pub fn seed_eligible_bond(&self, agent: Address) -> U512 {
        if self.bond_unlock_at.get(&agent).unwrap_or(0) == 0 {
            self.bonded_amount.get(&agent).unwrap_or_default()
        } else {
            U512::zero()
        }
    }

    #[odra(payable)]
    pub fn deposit_bond(&mut self) {
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::NoBond);
        }
        let caller = self.env().caller();
        let bonded = self.bonded_amount.get(&caller).unwrap_or_default() + amount;
        self.bonded_amount.set(&caller, bonded);
        self.bond_unlock_at.set(&caller, 0);
        self.env().emit_event(BondUpdated {
            agent: caller,
            bonded_amount: bonded,
            seed_eligible: bonded,
        });
    }

    pub fn request_bond_unlock(&mut self) {
        let caller = self.env().caller();
        let bonded = self.bonded_amount.get(&caller).unwrap_or_default();
        if bonded.is_zero() {
            self.env().revert(Error::NoBond);
        }
        if self.bond_unlock_at.get(&caller).unwrap_or(0) != 0 {
            self.env().revert(Error::AlreadyUnlocking);
        }
        let unlock_at = self.env().get_block_time() + BOND_UNLOCK_COOLDOWN;
        self.bond_unlock_at.set(&caller, unlock_at);
        self.env().emit_event(BondUpdated {
            agent: caller,
            bonded_amount: bonded,
            seed_eligible: U512::zero(),
        });
    }

    pub fn cancel_bond_unlock(&mut self) {
        let caller = self.env().caller();
        if self.bond_unlock_at.get(&caller).unwrap_or(0) == 0 {
            self.env().revert(Error::NotUnlocking);
        }
        self.bond_unlock_at.set(&caller, 0);
        let bonded = self.bonded_amount.get(&caller).unwrap_or_default();
        self.env().emit_event(BondUpdated {
            agent: caller,
            bonded_amount: bonded,
            seed_eligible: bonded,
        });
    }

    pub fn withdraw_bond(&mut self) {
        let caller = self.env().caller();
        let unlock_at = self.bond_unlock_at.get(&caller).unwrap_or(0);
        if unlock_at == 0 {
            self.env().revert(Error::NotUnlocking);
        }
        if self.env().get_block_time() < unlock_at {
            self.env().revert(Error::CooldownActive);
        }
        let amount = self.bonded_amount.get(&caller).unwrap_or_default();
        self.bonded_amount.set(&caller, U512::zero());
        self.bond_unlock_at.set(&caller, 0);
        let credit = self.pending_withdrawals.get(&caller).unwrap_or_default() + amount;
        self.pending_withdrawals.set(&caller, credit);
        self.env().emit_event(BondUpdated {
            agent: caller,
            bonded_amount: U512::zero(),
            seed_eligible: U512::zero(),
        });
    }

    // ── Cross-chain reputation consumer (P0.1, governed by P0-B) ────────────
    //
    // Odra cannot verify Soroban Groth16 proofs directly. Cross-chain reputation is set
    // through the governance proposal lifecycle (multisig + timelock), eliminating the
    // single-EOA admin backdoor.

    /// Query cross-chain reputation for an agent. Returns 0 if no attestation exists.
    pub fn get_cross_chain_rep(&self, agent: Address) -> u32 {
        self.cross_chain_rep.get(&agent).unwrap_or(0)
    }

    // ── P0-B: Governance proposal lifecycle ───────────────────────────────────

    /// Propose a cross-chain reputation update. Governance-signer only.
    /// The proposer's approval is counted automatically.
    pub fn propose_set_cross_chain_rep(
        &mut self,
        agent: Address,
        score: u32,
        source_chain: String,
    ) -> u64 {
        self.require_governance_signer();
        if score > MAX_REPUTATION {
            self.env().revert(Error::BadThreshold);
        }
        let caller = self.env().caller();
        let proposal_id = self.proposal_counter.get_or_default() + 1;
        self.proposal_counter.set(proposal_id);

        let proposal = GovernanceProposal {
            action: ProposalAction::SetCrossChainRep { agent, score, source_chain },
            proposer: caller,
            proposed_at: self.env().get_block_time(),
            executed: false,
            cancelled: false,
        };
        self.proposals.set(&proposal_id, proposal);
        self.proposal_approvals.set(&proposal_id, vec![caller]);

        self.env().emit_event(ProposalCreated { proposal_id, proposer: caller });
        self.env().emit_event(ProposalApproved {
            proposal_id,
            signer: caller,
            approval_count: 1,
            threshold: self.governance_threshold.get_or_default(),
        });
        proposal_id
    }

    /// Approve an existing proposal. Governance-signer only. Each signer can approve once.
    pub fn approve_proposal(&mut self, proposal_id: u64) {
        self.require_governance_signer();
        let proposal = self.proposals.get(&proposal_id)
            .unwrap_or_else(|| self.env().revert(Error::ProposalNotFound));
        if proposal.executed {
            self.env().revert(Error::ProposalAlreadyExecuted);
        }
        if proposal.cancelled {
            self.env().revert(Error::ProposalCancelled);
        }

        let caller = self.env().caller();
        let mut approvals = self.proposal_approvals.get(&proposal_id).unwrap_or_default();
        if approvals.contains(&caller) {
            self.env().revert(Error::AlreadyApproved);
        }
        approvals.push(caller);
        let count = approvals.len() as u32;
        self.proposal_approvals.set(&proposal_id, approvals);

        self.env().emit_event(ProposalApproved {
            proposal_id,
            signer: caller,
            approval_count: count,
            threshold: self.governance_threshold.get_or_default(),
        });
    }

    /// Execute a proposal after threshold approvals + timelock elapsed. Anyone can call.
    pub fn execute_proposal(&mut self, proposal_id: u64) {
        let mut proposal = self.proposals.get(&proposal_id)
            .unwrap_or_else(|| self.env().revert(Error::ProposalNotFound));
        if proposal.executed {
            self.env().revert(Error::ProposalAlreadyExecuted);
        }
        if proposal.cancelled {
            self.env().revert(Error::ProposalCancelled);
        }

        let approvals = self.proposal_approvals.get(&proposal_id).unwrap_or_default();
        if (approvals.len() as u32) < self.governance_threshold.get_or_default() {
            self.env().revert(Error::ThresholdNotMet);
        }

        let elapsed = self.env().get_block_time().saturating_sub(proposal.proposed_at);
        if elapsed < self.timelock_delay.get_or_default() {
            self.env().revert(Error::TimelockNotElapsed);
        }

        proposal.executed = true;
        self.proposals.set(&proposal_id, proposal.clone());

        match &proposal.action {
            ProposalAction::SetCrossChainRep { agent, score, source_chain } => {
                self.cross_chain_rep.set(agent, *score);
                self.env().emit_event(CrossChainRepUpdated {
                    agent: *agent,
                    score: *score,
                    source_chain: source_chain.clone(),
                });
            }
            ProposalAction::SetArbiter { new_arbiter } => {
                let old_arbiter = self.arbiter.get().unwrap();
                self.arbiter.set(*new_arbiter);
                self.env().emit_event(ArbiterUpdated { old_arbiter, new_arbiter: *new_arbiter });
            }
            ProposalAction::SetDisputeBondBps { bps } => {
                let old_bps = self.dispute_bond_bps.get_or_default();
                self.dispute_bond_bps.set(*bps);
                self.env().emit_event(DisputeBondBpsUpdated { old_bps, new_bps: *bps });
            }
            ProposalAction::SetArbiterPanel { panel, threshold } => {
                // Defense-in-depth (specialist-review, plan Task 3): re-validate at execute
                // time too, not just at propose time, so no future code path that could
                // construct this action differently could ever store a broken panel.
                self.validate_panel_shape(panel, *threshold);
                let old_panel = self.arbiter_panel.get_or_default();
                self.arbiter_panel.set(panel.clone());
                self.panel_threshold.set(*threshold);
                self.env().emit_event(ArbiterPanelUpdated {
                    old_panel,
                    new_panel: panel.clone(),
                    threshold: *threshold,
                });
            }
            ProposalAction::SetPanelArbiterFee { fee } => {
                let old_fee = self.panel_arbiter_fee.get_or_default();
                self.panel_arbiter_fee.set(*fee);
                self.env().emit_event(PanelArbiterFeeUpdated { old_fee, new_fee: *fee });
            }
        }

        let executor = self.env().caller();
        self.env().emit_event(ProposalExecuted { proposal_id, executor });
    }

    /// Cancel a pending proposal. Governance-signer only.
    pub fn cancel_proposal(&mut self, proposal_id: u64) {
        self.require_governance_signer();
        let mut proposal = self.proposals.get(&proposal_id)
            .unwrap_or_else(|| self.env().revert(Error::ProposalNotFound));
        if proposal.executed {
            self.env().revert(Error::ProposalAlreadyExecuted);
        }
        if proposal.cancelled {
            self.env().revert(Error::ProposalCancelled);
        }
        proposal.cancelled = true;
        self.proposals.set(&proposal_id, proposal);
        self.env().emit_event(ProposalCancelled { proposal_id });
    }

    // ── Views ──────────────────────────────────────────────────────────────
    pub fn get_provider_jobs(&self, agent: Address) -> Vec<u64> {
        self.agent_provider_jobs.get(&agent).unwrap_or_default()
    }

    pub fn get_requester_jobs(&self, agent: Address) -> Vec<u64> {
        self.agent_requester_jobs.get(&agent).unwrap_or_default()
    }

    pub fn get_agent_skills(&self, agent: Address) -> Vec<u64> {
        self.agent_skills.get(&agent).unwrap_or_default()
    }

    pub fn skill_count(&self) -> u64 {
        self.skill_id_counter.get_or_default()
    }

    pub fn job_count(&self) -> u64 {
        self.job_id_counter.get_or_default()
    }

    pub fn review_window(&self) -> u64 {
        self.review_window.get_or_default()
    }

    pub fn get_skill(&self, skill_id: u64) -> Skill {
        self.require_skill(skill_id)
    }

    pub fn get_job(&self, job_id: u64) -> Job {
        self.require_job(job_id)
    }

    pub fn pending_withdrawals_of(&self, agent: Address) -> U512 {
        self.pending_withdrawals.get(&agent).unwrap_or_default()
    }

    pub fn job_id_for_task_hash(&self, task_hash: Bytes) -> u64 {
        self.job_by_task_hash.get(&task_hash).unwrap_or(0)
    }

    pub fn bonded_of(&self, agent: Address) -> U512 {
        self.bonded_amount.get(&agent).unwrap_or_default()
    }

    pub fn bond_unlock_at_of(&self, agent: Address) -> u64 {
        self.bond_unlock_at.get(&agent).unwrap_or(0)
    }

    /// P0-A view: returns the evaluator address and fee for a job.
    pub fn get_job_evaluator(&self, job_id: u64) -> (Option<Address>, U512) {
        let j = self.require_job(job_id);
        (j.evaluator, j.evaluator_fee)
    }

    // ── P0-B: Governance views ────────────────────────────────────────────────

    pub fn is_governance_signer(&self, addr: Address) -> bool {
        self.governance_signers.get_or_default().contains(&addr)
    }

    pub fn get_governance_threshold(&self) -> u32 {
        self.governance_threshold.get_or_default()
    }

    pub fn get_governance_signers(&self) -> Vec<Address> {
        self.governance_signers.get_or_default()
    }

    pub fn get_timelock_delay(&self) -> u64 {
        self.timelock_delay.get_or_default()
    }

    pub fn get_proposal(&self, proposal_id: u64) -> GovernanceProposal {
        self.proposals.get(&proposal_id)
            .unwrap_or_else(|| self.env().revert(Error::ProposalNotFound))
    }

    pub fn proposal_approval_count(&self, proposal_id: u64) -> u32 {
        self.proposal_approvals.get(&proposal_id).unwrap_or_default().len() as u32
    }

    // ── P1-A: Dispute views ──────────────────────────────────────────────
    pub fn get_dispute_info(&self, job_id: u64) -> Option<DisputeInfo> {
        self.disputes.get(&job_id)
    }

    pub fn get_dispute_bond_bps(&self) -> u32 {
        self.dispute_bond_bps.get_or_default()
    }

    pub fn get_arbiter(&self) -> Address {
        self.arbiter.get().unwrap()
    }

    // ── P2-A: AI decision rationale attestation ──────────────────────────────────
    /// Commits a hash of the requester's (typically LLM-generated) decision rationale for
    /// `job_id`, once. Requester-only (it is their own agent's stated reason for buying this
    /// skill) and set-once (an attestation that could be silently rewritten after the fact
    /// would be worthless as an anchor). Callable any time after the job exists — including
    /// after settlement — since it records WHY a decision was made, not a claim about the
    /// job's outcome, and doesn't participate in escrow/dispute settlement logic at all.
    pub fn attest_rationale(&mut self, job_id: u64, rationale_hash: Bytes) {
        let j = self.require_job(job_id);
        let caller = self.env().caller();
        if j.requester != caller {
            self.env().revert(Error::NotRequester);
        }
        if rationale_hash.len() != 32 {
            self.env().revert(Error::InvalidRationaleHash);
        }
        if self.rationale_hash.get(&job_id).is_some() {
            self.env().revert(Error::RationaleAlreadyAttested);
        }
        self.rationale_hash.set(&job_id, rationale_hash.clone());
        self.env().emit_event(RationaleAttested { job_id, requester: caller, rationale_hash });
    }

    /// `None` when the requester never attested a rationale for this job (attestation is
    /// optional — most jobs, e.g. ones a human created directly, will have none).
    pub fn get_rationale_hash(&self, job_id: u64) -> Option<Bytes> {
        self.rationale_hash.get(&job_id)
    }
}

// Private helpers — `#[odra::module]` impl block above only carries the public surface.
impl AgentSkillRegistry {
    fn _create_job(
        &mut self,
        skill_id: u64,
        task_hash: Bytes,
        deadline_secs: u64,
        evaluator: Option<Address>,
        evaluator_fee: U512,
    ) -> u64 {
        let s = self.require_skill(skill_id);
        if !s.active {
            self.env().revert(Error::SkillInactive);
        }
        let attached = self.env().attached_value();
        if attached != s.price_per_call + evaluator_fee {
            self.env().revert(Error::EscrowMustEqualPrice);
        }
        if deadline_secs == 0 {
            self.env().revert(Error::DeadlineRequired);
        }
        let caller = self.env().caller();
        if self.agent_reputation(caller) < s.min_reputation_to_invoke {
            self.env().revert(Error::InsufficientReputation);
        }
        if let Some(ev) = evaluator {
            if ev == s.owner {
                self.env().revert(Error::EvaluatorCannotBeProvider);
            }
        }
        if self.job_by_task_hash.get(&task_hash).unwrap_or(0) != 0 {
            self.env().revert(Error::DuplicateTaskHash);
        }

        let job_id = self.job_id_counter.get_or_default() + 1;
        self.job_id_counter.set(job_id);

        let now = self.env().get_block_time();
        let job = Job {
            requester: caller,
            provider: s.owner,
            skill_id,
            task_hash: task_hash.clone(),
            escrow_amount: s.price_per_call,
            deadline: now + deadline_secs,
            status: JobStatus::Open,
            result_hash: Bytes::new(),
            created_at: now,
            completed_at: 0,
            evaluator,
            evaluator_fee,
        };
        self.jobs.set(&job_id, job.clone());

        let mut rq = self.agent_requester_jobs.get(&caller).unwrap_or_default();
        rq.push(job_id);
        self.agent_requester_jobs.set(&caller, rq);

        let mut pv = self.agent_provider_jobs.get(&s.owner).unwrap_or_default();
        pv.push(job_id);
        self.agent_provider_jobs.set(&s.owner, pv);

        self.job_by_task_hash.set(&task_hash, job_id);

        self.env().emit_event(JobCreated {
            job_id,
            requester: caller,
            skill_id,
            escrow: job.escrow_amount,
            deadline: job.deadline,
        });
        job_id
    }

    fn require_skill(&self, skill_id: u64) -> Skill {
        self.skills
            .get(&skill_id)
            .unwrap_or_else(|| self.env().revert(Error::SkillNotFound))
    }

    fn require_job(&self, job_id: u64) -> Job {
        self.jobs
            .get(&job_id)
            .unwrap_or_else(|| self.env().revert(Error::JobNotOpen))
    }

    fn require_governance_signer(&self) {
        let caller = self.env().caller();
        let signers = self.governance_signers.get_or_default();
        if !signers.contains(&caller) {
            self.env().revert(Error::NotGovernanceSigner);
        }
    }

    fn bump_agent_rep(&mut self, agent: Address) {
        let next = self.agent_reputation(agent).saturating_add(REPUTATION_STEP);
        let capped = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
        self.agent_rep.set(&agent, capped);
    }

    fn slash_agent_rep(&mut self, agent: Address) {
        let rep = self.agent_reputation(agent);
        let slashed = if rep > REP_SLASH_STEP { rep - REP_SLASH_STEP } else { REP_FLOOR };
        self.agent_rep.set(&agent, slashed);
    }

    fn slash_skill_rep(&mut self, skill_id: u64) {
        let mut s = self.require_skill(skill_id);
        s.reputation_score = if s.reputation_score > REP_SLASH_STEP {
            s.reputation_score - REP_SLASH_STEP
        } else {
            REP_FLOOR
        };
        self.skills.set(&skill_id, s);
    }

    /// Shared completion effects for [`confirm_completion`] + [`claim_after_review`]. CEI: only
    /// ledger writes (no external call). Self-deal guard widened from Solidity audit Abductive-2 +
    /// Tier-0: when `requester == provider`, escrow still settles, but NONE of the trust signals
    /// (skill rep, totalInvocations, requester rep, provider rep) move.
    ///
    /// T2.1 composition split: if the job's skill has a `Composition` record, the escrow is
    /// distributed across the leaf skills' owners per `weights_bps`. The wrapper owner does
    /// NOT get an implicit slice — if they want a cut they must include one of their OWN
    /// primitive skills as a leaf. Per-leaf reputation + invocation counters and per-leaf-owner
    /// agent rep all bump, mirroring the primitive-skill semantics one level down.
    fn settle_completion(&mut self, j: &mut Job, job_id: u64) {
        j.status = JobStatus::Completed;
        j.completed_at = self.env().get_block_time();

        let composition = self.compositions.get(&j.skill_id);
        let self_deal = j.requester == j.provider;

        if let Some(comp) = composition.as_ref() {
            // ── Composite path: fan out escrow per weights to leaf owners. ──
            //
            // Crediting strategy: we split escrow with integer basis-points math and let the
            // last leaf absorb the rounding remainder, so Σ payouts == escrow_amount exactly.
            // This matches the pull-payment ledger invariant: sum(credited) == debited.
            let escrow = j.escrow_amount;
            let mut distributed = U512::zero();
            let n = comp.leaf_skill_ids.len();
            for (i, leaf_id) in comp.leaf_skill_ids.iter().enumerate() {
                let weight = comp.weights_bps[i];
                // Last leaf gets `escrow - distributed` so rounding never leaves dust behind.
                let payout = if i + 1 == n {
                    escrow - distributed
                } else {
                    let p = (escrow * U512::from(weight)) / U512::from(WEIGHT_DENOMINATOR);
                    distributed += p;
                    p
                };
                let leaf = self.require_skill(*leaf_id);
                let credit = self
                    .pending_withdrawals
                    .get(&leaf.owner)
                    .unwrap_or_default()
                    + payout;
                self.pending_withdrawals.set(&leaf.owner, credit);

                // Leaf reputation bumps mirror the primitive-skill path.
                if !self_deal && j.requester != leaf.owner {
                    let mut leaf_mut = leaf.clone();
                    leaf_mut.total_invocations += 1;
                    let next = leaf_mut.reputation_score.saturating_add(REPUTATION_STEP);
                    leaf_mut.reputation_score = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
                    self.skills.set(leaf_id, leaf_mut);
                    self.bump_agent_rep(leaf.owner);
                }

                self.env().emit_event(CompositionLeafPayout {
                    job_id,
                    composite_skill_id: j.skill_id,
                    leaf_skill_id: *leaf_id,
                    leaf_owner: leaf.owner,
                    payout,
                });
            }

            // Wrapper-level trust signals: composite skill rep + invocation count + wrapper
            // owner agent rep + requester agent rep all move on a successful arm's-length call.
            let mut s = self.require_skill(j.skill_id);
            if !self_deal {
                s.total_invocations += 1;
                let next = s.reputation_score.saturating_add(REPUTATION_STEP);
                s.reputation_score = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
                self.skills.set(&j.skill_id, s.clone());
                self.bump_agent_rep(j.provider);
                self.bump_agent_rep(j.requester);
            }
            self.env().emit_event(JobCompleted {
                job_id,
                provider: j.provider,
                payout: escrow,
                new_reputation: s.reputation_score,
            });
            return;
        }

        // ── Primitive-skill path (unchanged). ──
        let credit =
            self.pending_withdrawals.get(&j.provider).unwrap_or_default() + j.escrow_amount;
        self.pending_withdrawals.set(&j.provider, credit);

        let mut s = self.require_skill(j.skill_id);
        if !self_deal {
            s.total_invocations += 1;
            let next = s.reputation_score.saturating_add(REPUTATION_STEP);
            s.reputation_score = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
            self.skills.set(&j.skill_id, s.clone());
            self.bump_agent_rep(j.provider);
            self.bump_agent_rep(j.requester);
        }

        self.env().emit_event(JobCompleted {
            job_id,
            provider: j.provider,
            payout: j.escrow_amount,
            new_reputation: s.reputation_score,
        });
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod proptests;
