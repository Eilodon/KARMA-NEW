//! Mirror of the most critical `test/AgentSkillRegistry.t.sol` invariants. Names are
//! Rust-cased twins of the Foundry tests so a reviewer can grep both files side by side.

use super::*;
use odra::casper_types::bytesrepr::Bytes;
use odra::casper_types::U512;
use odra::host::{Deployer, HostEnv, HostRef};

const PRICE: u64 = 1_000_000; // motes, arbitrary — only price/escrow equality matters
const DEADLINE_MS: u64 = 24 * 60 * 60 * 1_000; // 1 day

fn setup() -> (HostEnv, AgentSkillRegistryHostRef, Address, Address) {
    let env = odra_test::env();
    let init_args = AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    };
    let contract = AgentSkillRegistry::deploy(&env, init_args);
    let alpha = env.get_account(1); // provider (skill owner)
    let beta = env.get_account(2); // requester
    (env, contract, alpha, beta)
}

fn task_hash(label: &str) -> Bytes {
    Bytes::from(label.as_bytes().to_vec())
}

fn register_skill(env: &HostEnv, contract: &mut AgentSkillRegistryHostRef, alpha: Address) -> u64 {
    env.set_caller(alpha);
    contract.register_skill(
        "search".to_string(),
        "paid discover_skills".to_string(),
        "mcp://alpha".to_string(),
        U512::from(PRICE),
        0,
        IDENTITY_POLICY_NONE,
    )
}

fn register_gated_skill(
    env: &HostEnv,
    contract: &mut AgentSkillRegistryHostRef,
    alpha: Address,
    min_rep: u32,
) -> u64 {
    env.set_caller(alpha);
    contract.register_skill(
        "premium".to_string(),
        "institutional".to_string(),
        "mcp://alpha".to_string(),
        U512::from(PRICE),
        min_rep,
        IDENTITY_POLICY_NONE,
    )
}

fn open_job(
    env: &HostEnv,
    contract: &mut AgentSkillRegistryHostRef,
    beta: Address,
    skill_id: u64,
    label: &str,
) -> u64 {
    env.set_caller(beta);
    contract
        .with_tokens(U512::from(PRICE))
        .create_job(skill_id, task_hash(label), DEADLINE_MS)
}

// ── Happy path ─────────────────────────────────────────────
#[test]
fn happy_path_escrow_flow_and_reputation() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-params");

    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("result-data"));

    env.set_caller(beta);
    reg.confirm_completion(job_id);

    let bal_before = env.balance_of(&alpha);
    env.set_caller(alpha);
    reg.withdraw();
    assert_eq!(env.balance_of(&alpha), bal_before + U512::from(PRICE));

    let s = reg.get_skill(skill_id);
    assert_eq!(s.reputation_score, 55, "skill reputation +5 from base 50");
    assert_eq!(s.total_invocations, 1);
    assert_eq!(reg.agent_reputation(alpha), 55, "provider agent rep +5");
    assert_eq!(reg.agent_reputation(beta), 55, "requester agent rep +5");
}

#[test]
fn create_job_requires_exact_escrow() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(U512::from(PRICE - 1))
            .try_create_job(skill_id, task_hash("t"), DEADLINE_MS),
        Err(Error::EscrowMustEqualPrice.into())
    );
}

// ── Open-state refund (Solidity FM1: must remain intact after `deadline` is repurposed) ──
#[test]
fn refund_after_deadline() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-1");

    env.advance_block_time(DEADLINE_MS + 1);
    env.set_caller(beta);
    reg.claim_refund(job_id);

    let bal_before = env.balance_of(&beta);
    env.set_caller(beta);
    reg.withdraw();
    assert_eq!(env.balance_of(&beta), bal_before + U512::from(PRICE));
}

#[test]
fn refund_at_exact_deadline_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-1");

    env.advance_block_time(DEADLINE_MS); // == deadline, not strictly past
    env.set_caller(beta);
    assert_eq!(reg.try_claim_refund(job_id), Err(Error::BeforeDeadline.into()));
}

#[test]
fn refund_after_delivered_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEADLINE_MS + 1);
    env.set_caller(beta);
    assert_eq!(reg.try_claim_refund(job_id), Err(Error::NotRefundable.into()));
}

// ── Claim 3 (no permanent fund lock): delivered + ghost requester → provider claims after window ──
#[test]
fn delivered_ghost_requester_provider_claims_after_window() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 1);
    env.set_caller(alpha);
    reg.claim_after_review(job_id);

    let bal_before = env.balance_of(&alpha);
    env.set_caller(alpha);
    reg.withdraw();
    assert_eq!(env.balance_of(&alpha), bal_before + U512::from(PRICE));
    assert_eq!(reg.agent_reputation(alpha), 55, "claim_after_review bumps arm's-length rep");
}

#[test]
fn delivered_junk_result_requester_disputes_within_window() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.set_caller(beta);
    reg.dispute_result(job_id);

    let bal_before = env.balance_of(&beta);
    env.set_caller(beta);
    reg.withdraw();
    assert_eq!(env.balance_of(&beta), bal_before + U512::from(PRICE), "requester refunded on dispute");
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION, "dispute grants no provider rep");
}

#[test]
fn dispute_after_window_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 1);
    env.set_caller(beta);
    assert_eq!(reg.try_dispute_result(job_id), Err(Error::ReviewWindowClosed.into()));
}

#[test]
fn claim_at_exact_window_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW); // == deadline, not strictly past
    env.set_caller(alpha);
    assert_eq!(reg.try_claim_after_review(job_id), Err(Error::ReviewWindowOpen.into()));
}

#[test]
fn confirm_completion_still_works_after_window() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 100);
    env.set_caller(beta);
    reg.confirm_completion(job_id);
    assert_eq!(reg.agent_reputation(alpha), 55, "late confirm still settles");
}

#[test]
fn double_complete_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(beta);
    reg.confirm_completion(job_id);

    env.set_caller(beta);
    assert_eq!(reg.try_confirm_completion(job_id), Err(Error::JobNotDelivered.into()));
}

// ── Trust Gate (PD-005) ──
#[test]
fn gate_bootstrap_base_50() {
    let (env, reg, _, _) = setup();
    let fresh = env.get_account(7);
    assert_eq!(reg.agent_reputation(fresh), BASE_REPUTATION);
}

#[test]
fn gate_blocks_under_rep_requester() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_gated_skill(&env, &mut reg, alpha, 55);
    env.set_caller(beta); // fresh rep 50
    assert_eq!(
        reg.with_tokens(U512::from(PRICE))
            .try_create_job(skill_id, task_hash("t"), DEADLINE_MS),
        Err(Error::InsufficientReputation.into())
    );
}

#[test]
fn set_min_reputation_owner_only() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    env.set_caller(beta);
    assert_eq!(reg.try_set_min_reputation(skill_id, 70), Err(Error::NotSkillOwner.into()));

    env.set_caller(alpha);
    reg.set_min_reputation(skill_id, 70);
    assert_eq!(reg.get_skill(skill_id).min_reputation_to_invoke, 70);
}

// ── P0: identity policy is declarative; owner-only ──
#[test]
fn identity_policy_defaults_to_none_and_owner_can_set() {
    let (env, mut reg, alpha, _) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    assert_eq!(reg.get_skill(skill_id).identity_policy, IDENTITY_POLICY_NONE);

    env.set_caller(alpha);
    reg.set_identity_policy(skill_id, IDENTITY_POLICY_T3N);
    assert_eq!(reg.get_skill(skill_id).identity_policy, IDENTITY_POLICY_T3N);
}

#[test]
fn set_identity_policy_owner_only() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    env.set_caller(beta);
    assert_eq!(
        reg.try_set_identity_policy(skill_id, IDENTITY_POLICY_T3N),
        Err(Error::NotSkillOwner.into())
    );
}

#[test]
fn register_skill_persists_identity_policy() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    let skill_id = reg.register_skill(
        "s".to_string(),
        "d".to_string(),
        "mcp://a".to_string(),
        U512::from(PRICE),
        0,
        IDENTITY_POLICY_T3N_FRESH,
    );
    assert_eq!(reg.get_skill(skill_id).identity_policy, IDENTITY_POLICY_T3N_FRESH);
}

// ── Self-deal nullification (Solidity audit Abductive-2 + Tier-0) ──
#[test]
fn self_deal_no_rep_farm() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    let skill_id = reg.register_skill(
        "self".to_string(),
        "self".to_string(),
        "mcp://alpha".to_string(),
        U512::from(PRICE),
        0,
        IDENTITY_POLICY_NONE,
    );

    // Path 1: confirm_completion on a self-job.
    env.set_caller(alpha);
    let j1 = reg
        .with_tokens(U512::from(PRICE))
        .create_job(skill_id, task_hash("self-1"), DEADLINE_MS);
    env.set_caller(alpha);
    reg.deliver_result(j1, task_hash("r"));
    env.set_caller(alpha);
    reg.confirm_completion(j1);
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION, "self-deal confirm grants no agent rep");

    // Path 2: claim_after_review on a self-job.
    env.set_caller(alpha);
    let j2 = reg
        .with_tokens(U512::from(PRICE))
        .create_job(skill_id, task_hash("self-2"), DEADLINE_MS);
    env.set_caller(alpha);
    reg.deliver_result(j2, task_hash("r"));
    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 1);
    env.set_caller(alpha);
    reg.claim_after_review(j2);
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION, "self-deal claim grants no agent rep");

    let s = reg.get_skill(skill_id);
    assert_eq!(s.reputation_score, BASE_REPUTATION, "self-deal must not inflate BM25 boost input");
    assert_eq!(s.total_invocations, 0, "self-deal must not inflate invocation count");
}

// ── PD-003: O(1) dedup index ──
#[test]
fn job_by_task_hash_dedup_index() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-params");
    assert_eq!(reg.job_id_for_task_hash(task_hash("task-params")), job_id);
    assert_eq!(reg.job_id_for_task_hash(task_hash("never")), 0);
}

// ── Fix 5: durable exactly-once ──
#[test]
fn create_job_duplicate_task_hash_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let _job_id = open_job(&env, &mut reg, beta, skill_id, "task-params");

    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(U512::from(PRICE))
            .try_create_job(skill_id, task_hash("task-params"), DEADLINE_MS),
        Err(Error::DuplicateTaskHash.into())
    );
    // Exactly-one escrow held — registry balance equals one PRICE.
    assert_eq!(env.balance_of(&reg), U512::from(PRICE));
}

// ── Constructor bounds (immutable review window) ──
#[test]
fn constructor_default_window() {
    let (_, reg, _, _) = setup();
    assert_eq!(reg.review_window(), DEFAULT_REVIEW_WINDOW);
}

#[test]
fn constructor_rejects_below_min() {
    let env = odra_test::env();
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: MIN_REVIEW_WINDOW - 1,
    };
    assert_eq!(
        AgentSkillRegistry::try_deploy(&env, bad).err(),
        Some(Error::BadReviewWindow.into())
    );
}

#[test]
fn constructor_rejects_above_max() {
    let env = odra_test::env();
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: MAX_REVIEW_WINDOW + 1,
    };
    assert_eq!(
        AgentSkillRegistry::try_deploy(&env, bad).err(),
        Some(Error::BadReviewWindow.into())
    );
}

// ── Tier-2 Sybil-resistance bond (PD-007) ──
const BOND: u64 = 2_000_000;

#[test]
fn bond_deposit_seeds_and_is_per_agent() {
    let (env, reg, alpha, beta) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();

    assert_eq!(reg.bonded_of(alpha), U512::from(BOND), "bond locked");
    assert_eq!(reg.seed_eligible_bond(alpha), U512::from(BOND), "active bond seeds");
    assert_eq!(reg.bonded_of(beta), U512::zero(), "per-agent: alpha's does not seed beta");
    assert_eq!(reg.seed_eligible_bond(beta), U512::zero());

    assert!(env.emitted_event(
        &reg,
        BondUpdated {
            agent: alpha,
            bonded_amount: U512::from(BOND),
            seed_eligible: U512::from(BOND),
        }
    ));
}

#[test]
fn bond_deposit_zero_reverts() {
    let (env, reg, alpha, _) = setup();
    env.set_caller(alpha);
    assert_eq!(
        reg.with_tokens(U512::zero()).try_deposit_bond(),
        Err(Error::NoBond.into())
    );
}

#[test]
fn bond_request_unlock_stops_seeding_but_keeps_capital() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    assert_eq!(reg.seed_eligible_bond(alpha), U512::zero(), "cooling-down bond does not seed");
    assert_eq!(reg.bonded_of(alpha), U512::from(BOND), "capital still locked across cooldown");
}

#[test]
fn bond_withdraw_before_cooldown_reverts() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    env.advance_block_time(BOND_UNLOCK_COOLDOWN - 1);
    env.set_caller(alpha);
    assert_eq!(reg.try_withdraw_bond(), Err(Error::CooldownActive.into()));
}

#[test]
fn bond_withdraw_without_request_reverts() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    assert_eq!(reg.try_withdraw_bond(), Err(Error::NotUnlocking.into()));
}

#[test]
fn bond_withdraw_after_cooldown_returns_capital_via_pull_payment() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    env.advance_block_time(BOND_UNLOCK_COOLDOWN);
    env.set_caller(alpha);
    reg.withdraw_bond();
    assert_eq!(reg.bonded_of(alpha), U512::zero(), "bond cleared");
    assert_eq!(
        reg.pending_withdrawals_of(alpha),
        U512::from(BOND),
        "credited to the audited pull-payment ledger"
    );

    let bal_before = env.balance_of(&alpha);
    env.set_caller(alpha);
    reg.withdraw();
    assert_eq!(env.balance_of(&alpha), bal_before + U512::from(BOND));
}

#[test]
fn bond_cancel_unlock_reactivates_seed() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    assert_eq!(reg.seed_eligible_bond(alpha), U512::zero());
    env.set_caller(alpha);
    reg.cancel_bond_unlock();
    assert_eq!(reg.seed_eligible_bond(alpha), U512::from(BOND));
}

#[test]
fn bond_deposit_during_cooldown_reactivates_and_adds() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    assert_eq!(reg.bonded_of(alpha), U512::from(2 * BOND), "added to the existing bond");
    assert_eq!(reg.seed_eligible_bond(alpha), U512::from(2 * BOND), "re-committed: seeds the full amount");
    assert_eq!(reg.bond_unlock_at_of(alpha), 0, "pending unlock cleared by re-deposit");
}

#[test]
fn bond_request_unlock_without_bond_reverts() {
    let (env, mut reg, _, beta) = setup();
    env.set_caller(beta);
    assert_eq!(reg.try_request_bond_unlock(), Err(Error::NoBond.into()));
}

// ─── T2.1 — Skill composition (composite skills, bps split, propagated reputation) ──

const COMP_PRICE: u64 = 4_000_000;

/// Convenience: helper registers two children + one composite (50/40/10) with `setup()` accounts.
/// Returns (env, contract, requester, orchestrator, child_a_owner, child_b_owner, ids).
fn setup_with_composite() -> (
    HostEnv, AgentSkillRegistryHostRef, Address, Address, Address, Address, u64, u64, u64,
) {
    let env = odra_test::env();
    let init_args = AgentSkillRegistryInitArgs { review_window_ms: DEFAULT_REVIEW_WINDOW };
    let mut reg = AgentSkillRegistry::deploy(&env, init_args);

    let child_a_owner = env.get_account(1);
    let child_b_owner = env.get_account(2);
    let orchestrator = env.get_account(3);
    let requester = env.get_account(4);

    env.set_caller(child_a_owner);
    let child_a = reg.register_skill(
        "summarize".to_string(),
        "summarize a document".to_string(),
        "mcp://a".to_string(),
        U512::from(PRICE),
        0,
        IDENTITY_POLICY_NONE,
    );
    env.set_caller(child_b_owner);
    let child_b = reg.register_skill(
        "translate".to_string(),
        "translate text".to_string(),
        "mcp://b".to_string(),
        U512::from(PRICE),
        0,
        IDENTITY_POLICY_NONE,
    );

    // Composite at price COMP_PRICE: 50% to child_a, 40% to child_b, 10% orchestrator.
    env.set_caller(orchestrator);
    let composite = reg.register_composition(
        "summarize+translate".to_string(),
        "compose summarize then translate".to_string(),
        "mcp://composite".to_string(),
        U512::from(COMP_PRICE),
        0,
        IDENTITY_POLICY_NONE,
        vec![child_a, child_b],
        vec![5000, 4000],
        1000,
    );

    (env, reg, requester, orchestrator, child_a_owner, child_b_owner, child_a, child_b, composite)
}

#[test]
fn composition_register_persists_manifest_and_underlying_skill() {
    let (_env, reg, _, orchestrator, _, _, ca, cb, composite) = setup_with_composite();
    assert!(reg.is_composite(composite), "is_composite=true for the composite");
    assert!(!reg.is_composite(ca), "child A is not composite");
    assert!(!reg.is_composite(cb), "child B is not composite");

    let comp = reg.get_composition(composite);
    assert_eq!(comp.child_skill_ids, vec![ca, cb]);
    assert_eq!(comp.weights_bps, vec![5000u32, 4000u32]);
    assert_eq!(comp.orchestrator_bps, 1000u32);

    let s = reg.get_skill(composite);
    assert_eq!(s.owner, orchestrator, "composite's owner = orchestrator");
    assert_eq!(s.price_per_call, U512::from(COMP_PRICE));
    assert!(s.active);
}

#[test]
fn composition_empty_children_reverts() {
    let env = odra_test::env();
    let mut reg = AgentSkillRegistry::deploy(&env, AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    });
    env.set_caller(env.get_account(1));
    let err = reg.try_register_composition(
        "x".to_string(), "y".to_string(), "z".to_string(),
        U512::from(PRICE), 0, IDENTITY_POLICY_NONE,
        vec![], vec![], 10_000,
    );
    assert_eq!(err, Err(Error::EmptyComposition.into()));
}

#[test]
fn composition_weight_sum_mismatch_reverts() {
    let env = odra_test::env();
    let mut reg = AgentSkillRegistry::deploy(&env, AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    });
    let owner_a = env.get_account(1);
    env.set_caller(owner_a);
    let child = reg.register_skill(
        "x".into(), "y".into(), "z".into(),
        U512::from(PRICE), 0, IDENTITY_POLICY_NONE,
    );
    env.set_caller(env.get_account(2));
    // 5000 + 5000 + 1000 = 11_000 — over BPS_TOTAL.
    let err = reg.try_register_composition(
        "comp".into(), "y".into(), "z".into(),
        U512::from(COMP_PRICE), 0, IDENTITY_POLICY_NONE,
        vec![child, child], vec![5000, 5000], 1000,
    );
    assert_eq!(err, Err(Error::WeightSumMismatch.into()));
}

#[test]
fn composition_weights_len_mismatch_reverts() {
    let env = odra_test::env();
    let mut reg = AgentSkillRegistry::deploy(&env, AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    });
    let owner_a = env.get_account(1);
    env.set_caller(owner_a);
    let child = reg.register_skill(
        "x".into(), "y".into(), "z".into(),
        U512::from(PRICE), 0, IDENTITY_POLICY_NONE,
    );
    env.set_caller(env.get_account(2));
    // 2 children but 3 weight slots.
    let err = reg.try_register_composition(
        "comp".into(), "y".into(), "z".into(),
        U512::from(COMP_PRICE), 0, IDENTITY_POLICY_NONE,
        vec![child, child], vec![3000, 3000, 3000], 1000,
    );
    assert_eq!(err, Err(Error::WeightsLenMismatch.into()));
}

#[test]
fn composition_too_many_children_reverts() {
    let env = odra_test::env();
    let mut reg = AgentSkillRegistry::deploy(&env, AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    });
    let owner_a = env.get_account(1);
    env.set_caller(owner_a);
    // 9 distinct skills + a composite would exceed MAX_COMPOSITION_CHILDREN=8.
    let mut ids = Vec::new();
    for i in 0..(MAX_COMPOSITION_CHILDREN + 1) {
        env.set_caller(owner_a);
        ids.push(reg.register_skill(
            format!("s{}", i), "y".into(), "z".into(),
            U512::from(PRICE), 0, IDENTITY_POLICY_NONE,
        ));
    }
    let mut weights = vec![1000u32; (MAX_COMPOSITION_CHILDREN + 1) as usize];
    // Won't even reach the sum check — too-many fires first.
    let _ = &mut weights;
    env.set_caller(env.get_account(2));
    let err = reg.try_register_composition(
        "comp".into(), "y".into(), "z".into(),
        U512::from(COMP_PRICE), 0, IDENTITY_POLICY_NONE,
        ids, weights, 1000,
    );
    assert_eq!(err, Err(Error::TooManyChildren.into()));
}

#[test]
fn composition_unknown_child_reverts() {
    let env = odra_test::env();
    let mut reg = AgentSkillRegistry::deploy(&env, AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    });
    env.set_caller(env.get_account(2));
    let err = reg.try_register_composition(
        "comp".into(), "y".into(), "z".into(),
        U512::from(COMP_PRICE), 0, IDENTITY_POLICY_NONE,
        vec![9999u64], vec![9000], 1000,
    );
    assert_eq!(err, Err(Error::ChildSkillNotFound.into()));
}

#[test]
fn composition_inactive_child_reverts() {
    let env = odra_test::env();
    let mut reg = AgentSkillRegistry::deploy(&env, AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    });
    let owner_a = env.get_account(1);
    env.set_caller(owner_a);
    let child = reg.register_skill(
        "x".into(), "y".into(), "z".into(),
        U512::from(PRICE), 0, IDENTITY_POLICY_NONE,
    );
    env.set_caller(owner_a);
    reg.deactivate_skill(child);
    env.set_caller(env.get_account(2));
    let err = reg.try_register_composition(
        "comp".into(), "y".into(), "z".into(),
        U512::from(COMP_PRICE), 0, IDENTITY_POLICY_NONE,
        vec![child], vec![9000], 1000,
    );
    assert_eq!(err, Err(Error::ChildSkillInactive.into()));
}

#[test]
fn composite_create_job_escrows_at_composite_price() {
    let (env, mut reg, requester, _orch, _, _, _, _, composite) = setup_with_composite();
    env.set_caller(requester);
    let job_id = reg.with_tokens(U512::from(COMP_PRICE)).create_job(
        composite,
        task_hash("c1"),
        DEADLINE_MS,
    );
    let j = reg.get_job(job_id);
    assert_eq!(j.escrow_amount, U512::from(COMP_PRICE));
    assert_eq!(j.skill_id, composite);
    assert_eq!(j.status, JobStatus::Open);
}

#[test]
fn composite_settle_splits_escrow_per_bps_and_dust_to_orchestrator() {
    let (env, mut reg, requester, orchestrator, child_a_owner, child_b_owner, _, _, composite) =
        setup_with_composite();
    env.set_caller(requester);
    let job_id = reg.with_tokens(U512::from(COMP_PRICE)).create_job(
        composite, task_hash("split-1"), DEADLINE_MS,
    );
    env.set_caller(orchestrator);
    reg.deliver_result(job_id, task_hash("ok"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    // 4_000_000 × 5000 / 10000 = 2_000_000 to child_a_owner
    // 4_000_000 × 4000 / 10000 = 1_600_000 to child_b_owner
    // remainder = 400_000 to orchestrator (declared 1000 bps = 400_000 — no dust this run)
    assert_eq!(reg.pending_withdrawals_of(child_a_owner), U512::from(2_000_000u64), "child A share");
    assert_eq!(reg.pending_withdrawals_of(child_b_owner), U512::from(1_600_000u64), "child B share");
    assert_eq!(reg.pending_withdrawals_of(orchestrator), U512::from(400_000u64), "orchestrator share");
}

#[test]
fn composite_settle_dust_lands_with_orchestrator_not_lost() {
    let env = odra_test::env();
    let mut reg = AgentSkillRegistry::deploy(&env, AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    });
    let oa = env.get_account(1);
    let ob = env.get_account(2);
    let orch = env.get_account(3);
    let req = env.get_account(4);

    env.set_caller(oa);
    let ca = reg.register_skill("a".into(), "x".into(), "x".into(),
        U512::from(PRICE), 0, IDENTITY_POLICY_NONE);
    env.set_caller(ob);
    let cb = reg.register_skill("b".into(), "x".into(), "x".into(),
        U512::from(PRICE), 0, IDENTITY_POLICY_NONE);

    // Use price = 7 motes to FORCE rounding dust (7 × 3333 / 10000 = 2, not 2.333…).
    // 3333 + 3333 + 3334 = 10000. Children get 2 each, orchestrator gets 7 - 4 = 3.
    env.set_caller(orch);
    let composite = reg.register_composition(
        "c".into(), "x".into(), "x".into(),
        U512::from(7u64), 0, IDENTITY_POLICY_NONE,
        vec![ca, cb], vec![3333, 3333], 3334,
    );
    env.set_caller(req);
    let job_id = reg.with_tokens(U512::from(7u64)).create_job(composite, task_hash("d"), DEADLINE_MS);
    env.set_caller(orch);
    reg.deliver_result(job_id, task_hash("ok"));
    env.set_caller(req);
    reg.confirm_completion(job_id);

    assert_eq!(reg.pending_withdrawals_of(oa), U512::from(2u64), "child A: 7 × 3333 / 10000 = 2");
    assert_eq!(reg.pending_withdrawals_of(ob), U512::from(2u64), "child B: same");
    // Orchestrator gets the remainder = 7 - 2 - 2 = 3 (their share AND the dust).
    assert_eq!(reg.pending_withdrawals_of(orch), U512::from(3u64), "orchestrator gets remainder, no mote lost");
    // Sanity: total payouts == escrow.
    let total = reg.pending_withdrawals_of(oa) + reg.pending_withdrawals_of(ob) + reg.pending_withdrawals_of(orch);
    assert_eq!(total, U512::from(7u64), "no mote lost in the split");
}

#[test]
fn composite_settle_propagates_reputation_to_children_and_composite() {
    let (env, mut reg, requester, orchestrator, child_a_owner, child_b_owner, ca, cb, composite) =
        setup_with_composite();
    let base_orch = reg.agent_reputation(orchestrator);
    let base_req = reg.agent_reputation(requester);
    let base_ca_owner = reg.agent_reputation(child_a_owner);
    let base_cb_owner = reg.agent_reputation(child_b_owner);

    env.set_caller(requester);
    let job_id = reg.with_tokens(U512::from(COMP_PRICE)).create_job(
        composite, task_hash("rep-1"), DEADLINE_MS,
    );
    env.set_caller(orchestrator);
    reg.deliver_result(job_id, task_hash("ok"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    // Composite + every child skill score bumped by REPUTATION_STEP.
    assert_eq!(reg.get_skill(composite).reputation_score, BASE_REPUTATION + REPUTATION_STEP, "composite bumped");
    assert_eq!(reg.get_skill(ca).reputation_score, BASE_REPUTATION + REPUTATION_STEP, "child A bumped");
    assert_eq!(reg.get_skill(cb).reputation_score, BASE_REPUTATION + REPUTATION_STEP, "child B bumped");
    // Agent rep for orchestrator + requester + each child owner bumped (anti-self-deal off here).
    assert_eq!(reg.agent_reputation(orchestrator), base_orch + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(requester), base_req + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(child_a_owner), base_ca_owner + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(child_b_owner), base_cb_owner + REPUTATION_STEP);
}

#[test]
fn composite_settle_self_deal_pays_but_no_reputation_for_self() {
    // Composite where one CHILD's owner is the requester: that child gets PAID but no rep.
    // The other child + composite still get rep (arm's length).
    let env = odra_test::env();
    let mut reg = AgentSkillRegistry::deploy(&env, AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    });
    let req = env.get_account(1);
    let arms_length = env.get_account(2);
    let orch = env.get_account(3);
    // Child A owner = the requester (self-deal target).
    env.set_caller(req);
    let ca = reg.register_skill("a".into(), "x".into(), "x".into(),
        U512::from(PRICE), 0, IDENTITY_POLICY_NONE);
    env.set_caller(arms_length);
    let cb = reg.register_skill("b".into(), "x".into(), "x".into(),
        U512::from(PRICE), 0, IDENTITY_POLICY_NONE);
    env.set_caller(orch);
    let composite = reg.register_composition(
        "c".into(), "x".into(), "x".into(),
        U512::from(COMP_PRICE), 0, IDENTITY_POLICY_NONE,
        vec![ca, cb], vec![5000, 4000], 1000,
    );

    let base_ca = reg.get_skill(ca).reputation_score;
    let base_cb = reg.get_skill(cb).reputation_score;
    let base_req = reg.agent_reputation(req);
    let base_arms = reg.agent_reputation(arms_length);

    env.set_caller(req);
    let job_id = reg.with_tokens(U512::from(COMP_PRICE)).create_job(
        composite, task_hash("self"), DEADLINE_MS,
    );
    env.set_caller(orch);
    reg.deliver_result(job_id, task_hash("ok"));
    env.set_caller(req);
    reg.confirm_completion(job_id);

    // Payment: child A (= requester) still gets paid; arm's-length child B too; orchestrator too.
    assert_eq!(reg.pending_withdrawals_of(req), U512::from(2_000_000u64), "child A paid (self-deal NOT a payment guard)");
    assert_eq!(reg.pending_withdrawals_of(arms_length), U512::from(1_600_000u64));
    assert_eq!(reg.pending_withdrawals_of(orch), U512::from(400_000u64));

    // Reputation: child A NOT bumped (self-deal blocks rep). Child B bumped. Composite bumped.
    assert_eq!(reg.get_skill(ca).reputation_score, base_ca, "child A rep frozen (self-deal)");
    assert_eq!(reg.get_skill(cb).reputation_score, base_cb + REPUTATION_STEP, "child B (arm's length) bumped");
    assert_eq!(reg.get_skill(composite).reputation_score, BASE_REPUTATION + REPUTATION_STEP, "composite bumped");
    // Agent rep: requester gets the composite-level bump (arm's length to orchestrator),
    // arms_length child owner gets a bump, child A owner (= requester) NO extra child-side bump
    // (the composite already gave req a bump — net effect is one step, not two).
    assert_eq!(reg.agent_reputation(req), base_req + REPUTATION_STEP, "requester: one bump from composite layer");
    assert_eq!(reg.agent_reputation(arms_length), base_arms + REPUTATION_STEP);
}

#[test]
fn composite_dispute_path_refunds_full_escrow_to_requester() {
    let (env, mut reg, requester, orchestrator, child_a_owner, child_b_owner, _, _, composite) =
        setup_with_composite();
    env.set_caller(requester);
    let job_id = reg.with_tokens(U512::from(COMP_PRICE)).create_job(
        composite, task_hash("disp-1"), DEADLINE_MS,
    );
    env.set_caller(orchestrator);
    reg.deliver_result(job_id, task_hash("bad"));
    env.set_caller(requester);
    reg.dispute_result(job_id);

    // Full refund to requester; NO children + orchestrator paid.
    assert_eq!(reg.pending_withdrawals_of(requester), U512::from(COMP_PRICE), "full escrow refunded");
    assert_eq!(reg.pending_withdrawals_of(child_a_owner), U512::zero());
    assert_eq!(reg.pending_withdrawals_of(child_b_owner), U512::zero());
    assert_eq!(reg.pending_withdrawals_of(orchestrator), U512::zero());
}

#[test]
fn get_composition_for_regular_skill_reverts() {
    let (env, reg, _, _) = setup();
    env.set_caller(env.get_account(1));
    // Register a plain skill, then ask for its composition.
    // The contract is fresh here; use setup() helper which uses a different deploy.
    // Reuse setup_with_composite minus composition:
    let (_env, reg2, _, _, _, _, ca, _, _) = setup_with_composite();
    let err = reg2.try_get_composition(ca);
    assert_eq!(err, Err(Error::NotComposite.into()));
    let _ = (reg, env); // silence unused
}
