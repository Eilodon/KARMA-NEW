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

// ─── Composition constants (T2.1) ──────────────────────────────────────────
//
// A composite skill bundles N child skills with a weights vector (basis points). A composite
// job's settle splits the escrow across each child's owner + the orchestrator (= composite's
// owner), per the declared bps. Reputation propagates to children + composite + orchestrator
// on a successful arm's-length completion.

/// Maximum number of children a composition can bundle. Caps storage reads at settle time so
/// a deep composition cannot exceed the deploy gas budget. Set conservatively for the
/// hackathon scope; a v2 with batched settlement could raise this.
pub const MAX_COMPOSITION_CHILDREN: u32 = 8;

/// Basis-points total. A composite's `weights_bps.sum() + orchestrator_bps` MUST equal this
/// exactly — no over- or under-allocation. Mirrors EigenLayer's bps-vault convention.
pub const BPS_TOTAL: u32 = 10_000;

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
    // T2.1 composition errors
    EmptyComposition = 25,
    TooManyChildren = 26,
    WeightsLenMismatch = 27,
    WeightSumMismatch = 28,
    ChildSkillInactive = 29,
    ChildSkillNotFound = 30,
    NotComposite = 31,
    IsComposite = 32,
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

/// T2.1: composite-skill manifest — the children + bps split that `settle_completion` reads.
/// Stored in a separate Mapping keyed by composite skill_id; absence ⇒ regular (non-composite)
/// skill. Keeps `Skill` byte-layout unchanged so this is a clean add for existing storage.
///
/// Invariants enforced at `register_composition`:
///   • `child_skill_ids.len() == weights_bps.len()` and both ∈ [1, MAX_COMPOSITION_CHILDREN]
///   • `weights_bps.iter().sum::<u32>() + orchestrator_bps == BPS_TOTAL` (exact equality)
///   • Each child_skill_id exists and is active at registration time. (Children may later
///     deactivate; settle does not re-check — bps stay declarative, the orchestrator picks
///     up the consequence in reputation.)
#[odra::odra_type]
pub struct Composition {
    pub child_skill_ids: Vec<u64>,
    pub weights_bps: Vec<u32>,
    pub orchestrator_bps: u32,
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

#[odra::event]
pub struct CompositionRegistered {
    pub skill_id: u64,
    pub orchestrator: Address,
    pub child_count: u32,
    pub orchestrator_bps: u32,
}

#[odra::event]
pub struct CompositePayout {
    pub job_id: u64,
    pub recipient: Address,
    pub amount: U512,
    pub bps: u32,
}

// ─── Contract ──────────────────────────────────────────────────────────────
#[odra::module(events = [
    SkillRegistered, SkillDeactivated, JobCreated, ResultDelivered, JobCompleted,
    JobRefunded, ResultDisputed, MinReputationSet, IdentityPolicySet, Withdrawn,
    BondUpdated, CompositionRegistered, CompositePayout,
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
    /// T2.1: composite manifests. Keyed by composite skill_id; absence ⇒ regular skill.
    compositions: Mapping<u64, Composition>,
}

#[odra::module]
impl AgentSkillRegistry {
    /// Deploy-time configured, then immutable. Bounded to `[MIN_REVIEW_WINDOW, MAX_REVIEW_WINDOW]`.
    pub fn init(&mut self, review_window_ms: u64) {
        if review_window_ms < MIN_REVIEW_WINDOW || review_window_ms > MAX_REVIEW_WINDOW {
            self.env().revert(Error::BadReviewWindow);
        }
        self.review_window.set(review_window_ms);
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

    /// T2.1: register a composite skill that bundles N existing children with a bps split.
    /// Creates an ordinary `Skill` (so `discover_skills` / `create_job` / lifecycle work without
    /// special-casing) and a parallel `Composition` manifest the settle path reads.
    ///
    /// Invariants checked here (cheaper than re-checking at settle time):
    ///   • 1 ≤ child_skill_ids.len() ≤ MAX_COMPOSITION_CHILDREN
    ///   • child_skill_ids.len() == weights_bps.len()
    ///   • sum(weights_bps) + orchestrator_bps == BPS_TOTAL  (exact)
    ///   • Each child skill exists + is active at registration time
    ///
    /// The caller becomes the composite's owner = the orchestrator who gets `orchestrator_bps`.
    /// Children may later deactivate; settle does NOT re-check active-ness — bps stay declarative,
    /// the orchestrator picks up the reputation consequence if a child stops delivering.
    pub fn register_composition(
        &mut self,
        name: String,
        description: String,
        mcp_endpoint: String,
        price_per_call: U512,
        min_reputation_to_invoke: u32,
        identity_policy: u8,
        child_skill_ids: Vec<u64>,
        weights_bps: Vec<u32>,
        orchestrator_bps: u32,
    ) -> u64 {
        // ── Composition-specific shape checks (run BEFORE the skill is minted) ──
        if name.is_empty() {
            self.env().revert(Error::NameRequired);
        }
        if min_reputation_to_invoke > MAX_REPUTATION {
            self.env().revert(Error::BadThreshold);
        }
        let child_count = child_skill_ids.len() as u32;
        if child_count == 0 {
            self.env().revert(Error::EmptyComposition);
        }
        if child_count > MAX_COMPOSITION_CHILDREN {
            self.env().revert(Error::TooManyChildren);
        }
        if child_skill_ids.len() != weights_bps.len() {
            self.env().revert(Error::WeightsLenMismatch);
        }
        // Sum check: saturating to avoid u32 wrap on a malicious giant weight.
        let mut bps_sum: u32 = orchestrator_bps;
        for i in 0..child_count {
            bps_sum = bps_sum.saturating_add(weights_bps.get(i as usize).copied().unwrap_or(0));
        }
        if bps_sum != BPS_TOTAL {
            self.env().revert(Error::WeightSumMismatch);
        }
        // Per-child existence + active check. Also blocks "composite of composite" cycles in v1
        // (the existence check is the foundation; a future v2 can add a depth guard).
        for i in 0..child_count {
            let child_id = child_skill_ids.get(i as usize).copied().unwrap_or(0);
            let child = self
                .skills
                .get(&child_id)
                .unwrap_or_else(|| self.env().revert(Error::ChildSkillNotFound));
            if !child.active {
                self.env().revert(Error::ChildSkillInactive);
            }
        }

        // ── Mint the underlying Skill (orchestrator = self.env().caller()) ──
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

        // ── Persist the composition manifest under the same id ──
        let composition = Composition {
            child_skill_ids,
            weights_bps,
            orchestrator_bps,
        };
        self.compositions.set(&skill_id, composition);

        self.env().emit_event(SkillRegistered {
            skill_id,
            owner,
            name,
            price_per_call,
        });
        self.env().emit_event(CompositionRegistered {
            skill_id,
            orchestrator: owner,
            child_count,
            orchestrator_bps,
        });
        skill_id
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
    /// Payable. `deadline_secs` is a duration in **milliseconds** added to `now` to form the
    /// absolute open-state deadline (kept the Solidity name for surface compatibility).
    #[odra(payable)]
    pub fn create_job(&mut self, skill_id: u64, task_hash: Bytes, deadline_secs: u64) -> u64 {
        let s = self.require_skill(skill_id);
        if !s.active {
            self.env().revert(Error::SkillInactive);
        }
        let attached = self.env().attached_value();
        if attached != s.price_per_call {
            self.env().revert(Error::EscrowMustEqualPrice);
        }
        if deadline_secs == 0 {
            self.env().revert(Error::DeadlineRequired);
        }
        let caller = self.env().caller();
        if self.agent_reputation(caller) < s.min_reputation_to_invoke {
            self.env().revert(Error::InsufficientReputation);
        }
        // Fix 5 (Solidity): durable on-chain exactly-once. A second escrow for the same task_hash
        // would let a lost-ack retry double-escrow before the first tx finalised.
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
            escrow_amount: attached,
            deadline: now + deadline_secs,
            status: JobStatus::Open,
            result_hash: Bytes::new(),
            created_at: now,
            completed_at: 0,
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
        // Good-faith requester may confirm at any time while Delivered — no `<= deadline` guard.
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
        self.settle_completion(&mut j, job_id);
        self.jobs.set(&job_id, j);
    }

    pub fn dispute_result(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        if j.requester != self.env().caller() {
            self.env().revert(Error::NotRequester);
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        if self.env().get_block_time() > j.deadline {
            self.env().revert(Error::ReviewWindowClosed);
        }
        j.status = JobStatus::Disputed;
        let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default() + j.escrow_amount;
        self.pending_withdrawals.set(&j.requester, credit);
        let amount = j.escrow_amount;
        let requester = j.requester;
        self.jobs.set(&job_id, j);
        self.env().emit_event(ResultDisputed { job_id, requester, amount });
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
        let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default() + j.escrow_amount;
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

    // ── T2.1 composition views ─────────────────────────────────────────────
    pub fn is_composite(&self, skill_id: u64) -> bool {
        self.compositions.get(&skill_id).is_some()
    }

    pub fn get_composition(&self, skill_id: u64) -> Composition {
        self.compositions
            .get(&skill_id)
            .unwrap_or_else(|| self.env().revert(Error::NotComposite))
    }
}

// Private helpers — `#[odra::module]` impl block above only carries the public surface.
impl AgentSkillRegistry {
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

    fn bump_agent_rep(&mut self, agent: Address) {
        let next = self.agent_reputation(agent).saturating_add(REPUTATION_STEP);
        let capped = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
        self.agent_rep.set(&agent, capped);
    }

    /// Shared completion effects for [`confirm_completion`] + [`claim_after_review`]. CEI: only
    /// ledger writes (no external call). Self-deal guard widened from Solidity audit Abductive-2 +
    /// Tier-0: when `requester == provider`, escrow still settles, but NONE of the trust signals
    /// (skill rep, totalInvocations, requester rep, provider rep) move.
    ///
    /// T2.1: composite-skill aware. If the job's skill is a registered composition, the escrow
    /// splits across each child's owner + the orchestrator per the declared bps; reputation
    /// propagates to the composite, each child skill, each child owner, and the orchestrator
    /// (anti-self-deal: a recipient that is also the requester gets the payout but no rep).
    fn settle_completion(&mut self, j: &mut Job, job_id: u64) {
        j.status = JobStatus::Completed;
        j.completed_at = self.env().get_block_time();

        match self.compositions.get(&j.skill_id) {
            None => self.settle_simple(j, job_id),
            Some(comp) => self.settle_composite(j, job_id, comp),
        }
    }

    /// Original Solidity-mirror settlement: full escrow to provider, single bump per side.
    fn settle_simple(&mut self, j: &Job, job_id: u64) {
        let credit =
            self.pending_withdrawals.get(&j.provider).unwrap_or_default() + j.escrow_amount;
        self.pending_withdrawals.set(&j.provider, credit);

        let mut s = self.require_skill(j.skill_id);
        if j.requester != j.provider {
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

    /// T2.1: split escrow + reputation across the composition. CEI: all ledger writes only.
    ///
    /// Payment loop:
    ///   • For each child i: pending_withdrawals[child_i.owner] += escrow × weights_bps[i] / BPS_TOTAL
    ///   • pending_withdrawals[orchestrator] += escrow × orchestrator_bps / BPS_TOTAL
    /// The bps sum was validated at registration to equal BPS_TOTAL exactly, so the total payouts
    /// sum to the escrow amount (modulo integer-division dust at the last decimal — accepted as
    /// 1-2 mote rounding loss per settle).
    ///
    /// Reputation loop (anti-self-deal: skip a bump when recipient == requester):
    ///   • Bump composite skill's score + orchestrator (= composite owner) agent rep
    ///   • For each child skill: bump score + total_invocations
    ///   • For each child owner: bump agent rep
    fn settle_composite(&mut self, j: &Job, job_id: u64, comp: Composition) {
        let escrow = j.escrow_amount;
        let bps_total = U512::from(BPS_TOTAL);

        // ── Payment split — children first, orchestrator last (the orchestrator gets whatever
        //    remains so the rounding-dust always lands with the composite operator, not lost). ──
        let mut paid_to_children = U512::zero();
        let n = comp.child_skill_ids.len() as u32;
        for i in 0..n {
            let child_id = comp.child_skill_ids.get(i as usize).copied().unwrap_or(0);
            let bps = comp.weights_bps.get(i as usize).copied().unwrap_or(0);
            // U512 integer-divide preserves the bps semantics without float drift.
            let share = escrow * U512::from(bps) / bps_total;
            let child = self.require_skill(child_id);
            let pending = self.pending_withdrawals.get(&child.owner).unwrap_or_default() + share;
            self.pending_withdrawals.set(&child.owner, pending);
            paid_to_children += share;
            self.env().emit_event(CompositePayout {
                job_id,
                recipient: child.owner,
                amount: share,
                bps,
            });
        }
        // Orchestrator (composite owner) gets the remainder — declared bps + any rounding dust.
        // This is == j.provider (the composite skill's owner field, populated at registration).
        let orchestrator_share = escrow - paid_to_children;
        let pending_orch = self.pending_withdrawals.get(&j.provider).unwrap_or_default()
            + orchestrator_share;
        self.pending_withdrawals.set(&j.provider, pending_orch);
        self.env().emit_event(CompositePayout {
            job_id,
            recipient: j.provider,
            amount: orchestrator_share,
            bps: comp.orchestrator_bps,
        });

        // ── Reputation split — composite + all children + per-agent. Anti-self-deal:
        //    a recipient that IS the requester gets the payout but NOT the rep bump. ──
        let mut composite = self.require_skill(j.skill_id);
        if j.provider != j.requester {
            composite.total_invocations += 1;
            let next = composite.reputation_score.saturating_add(REPUTATION_STEP);
            composite.reputation_score = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
            self.skills.set(&j.skill_id, composite.clone());
            self.bump_agent_rep(j.provider);
            self.bump_agent_rep(j.requester);
        }
        for i in 0..n {
            let child_id = comp.child_skill_ids.get(i as usize).copied().unwrap_or(0);
            let mut child = self.require_skill(child_id);
            // Same self-deal guard: if the child's owner is the requester, no rep movement on
            // that child (skill score + agent rep both held). Composite-on-self still works
            // for payment but contributes nothing to the trust graph.
            if child.owner != j.requester {
                child.total_invocations += 1;
                let next = child.reputation_score.saturating_add(REPUTATION_STEP);
                child.reputation_score = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
                self.skills.set(&child_id, child.clone());
                self.bump_agent_rep(child.owner);
            }
        }

        self.env().emit_event(JobCompleted {
            job_id,
            provider: j.provider,
            payout: escrow,
            new_reputation: composite.reputation_score,
        });
    }
}

#[cfg(test)]
mod tests;
