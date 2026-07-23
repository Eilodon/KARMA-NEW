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
    let deployer = env.get_account(0);
    let init_args = AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
        governance_signers: vec![deployer],
        governance_threshold: 1,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
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

fn dispute_bond_for(price: u64) -> U512 {
    let bond = U512::from(10_000u32) * U512::from(price) / U512::from(10_000u32);
    let min = U512::from(MIN_DISPUTE_BOND_MOTES);
    if bond < min { min } else { bond }
}

fn deliver_and_dispute(
    env: &HostEnv,
    reg: &mut AgentSkillRegistryHostRef,
    alpha: Address,
    beta: Address,
    job_id: u64,
) -> U512 {
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result(job_id);
    bond
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
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    // P1-A: dispute now holds escrow + bond; not auto-refunded until resolution
    let d = reg.get_dispute_info(job_id).expect("dispute info present");
    assert_eq!(d.dispute_bond, bond, "dispute bond recorded");
    assert!(d.provider_bond.is_zero(), "provider hasn't responded yet");
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
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(bond).try_dispute_result(job_id),
        Err(Error::ReviewWindowClosed.into())
    );
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
    let deployer = env.get_account(0);
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: MIN_REVIEW_WINDOW - 1,
        governance_signers: vec![deployer],
        governance_threshold: 1,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
    };
    assert_eq!(
        AgentSkillRegistry::try_deploy(&env, bad).err(),
        Some(Error::BadReviewWindow.into())
    );
}

#[test]
fn constructor_rejects_above_max() {
    let env = odra_test::env();
    let deployer = env.get_account(0);
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: MAX_REVIEW_WINDOW + 1,
        governance_signers: vec![deployer],
        governance_threshold: 1,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
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

// ─── Composition primitive (T2.1) ───────────────────────────────────────────
//
// Setup uses three primitives owned by three distinct accounts so revenue split + per-leaf
// reputation are observable independently. The composite wrapper is owned by `omega` so we
// can also verify that wrapper-vs-leaf trust signals route correctly.

const LEAF_PRICE: u64 = 100_000;
const COMPOSITE_PRICE: u64 = 3_000_000;

fn register_leaf(env: &HostEnv, contract: &mut AgentSkillRegistryHostRef, owner: Address, label: &str) -> u64 {
    env.set_caller(owner);
    contract.register_skill(
        format!("leaf-{label}"),
        format!("leaf primitive {label}"),
        format!("mcp://leaf/{label}"),
        U512::from(LEAF_PRICE),
        0,
        IDENTITY_POLICY_NONE,
    )
}

fn register_composite(
    env: &HostEnv,
    contract: &mut AgentSkillRegistryHostRef,
    wrapper_owner: Address,
    leaves: Vec<u64>,
    weights: Vec<u32>,
    price: u64,
) -> u64 {
    env.set_caller(wrapper_owner);
    contract.register_composition(
        "compose-alpha-beta-omega".to_string(),
        "5/3/2 fanout across three primitives".to_string(),
        "mcp://omega/compose".to_string(),
        U512::from(price),
        0,
        IDENTITY_POLICY_NONE,
        leaves,
        weights,
    )
}

#[test]
fn composition_register_persists_and_views_distinguish_composite_from_primitive() {
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let omega = env.get_account(3);
    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let composite = register_composite(
        &env, &mut reg, omega, vec![leaf_a, leaf_b], vec![6_000, 4_000], COMPOSITE_PRICE,
    );

    assert!(reg.is_composite(composite), "wrapper is composite");
    assert!(!reg.is_composite(leaf_a), "leaf is primitive");
    assert!(!reg.is_composite(leaf_b), "leaf is primitive");

    let comp = reg.get_composition(composite).expect("composition present");
    assert_eq!(comp.leaf_skill_ids, vec![leaf_a, leaf_b]);
    assert_eq!(comp.weights_bps, vec![6_000u32, 4_000u32]);

    let wrapper_skill = reg.get_skill(composite);
    assert_eq!(wrapper_skill.owner, omega, "wrapper owner == caller of register_composition");
    assert_eq!(wrapper_skill.price_per_call, U512::from(COMPOSITE_PRICE));
}

#[test]
fn composition_rejects_empty_leaves() {
    let (env, mut reg, _, _) = setup();
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE, vec![], vec![],
        ),
        Err(Error::EmptyComposition.into()),
    );
}

#[test]
fn composition_rejects_weight_length_mismatch() {
    let (env, mut reg, alpha, _) = setup();
    let leaf = register_leaf(&env, &mut reg, alpha, "a");
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![leaf], vec![5_000, 5_000],
        ),
        Err(Error::WeightsMismatch.into()),
    );
}

#[test]
fn composition_rejects_weights_not_summing_to_denominator() {
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![leaf_a, leaf_b], vec![3_000, 3_000], // sums to 6_000, not 10_000
        ),
        Err(Error::WeightsMismatch.into()),
    );
}

#[test]
fn composition_rejects_unknown_leaf() {
    let (env, mut reg, _, _) = setup();
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![42u64], vec![10_000],
        ),
        Err(Error::LeafSkillNotFound.into()),
    );
}

#[test]
fn composition_rejects_inactive_leaf() {
    let (env, mut reg, alpha, _) = setup();
    let leaf = register_leaf(&env, &mut reg, alpha, "a");
    env.set_caller(alpha);
    reg.deactivate_skill(leaf);
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![leaf], vec![10_000],
        ),
        Err(Error::LeafSkillInactive.into()),
    );
}

#[test]
fn composition_rejects_composite_leaf_single_level_only() {
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let omega = env.get_account(3);
    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let composite = register_composite(
        &env, &mut reg, omega, vec![leaf_a, leaf_b], vec![5_000, 5_000], COMPOSITE_PRICE,
    );
    // Try to wrap the composite again — must be rejected.
    let theta = env.get_account(4);
    env.set_caller(theta);
    assert_eq!(
        reg.try_register_composition(
            "c2".to_string(), "".to_string(), "mcp://c2".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![composite], vec![10_000],
        ),
        Err(Error::LeafIsComposite.into()),
    );
}

#[test]
fn composition_completion_splits_escrow_per_weights_and_credits_leaf_owners() {
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let gamma = env.get_account(4);
    let omega = env.get_account(3);
    let requester = env.get_account(5);

    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let leaf_c = register_leaf(&env, &mut reg, gamma, "c");
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_a, leaf_b, leaf_c],
        vec![5_000, 3_000, 2_000], // 50/30/20
        COMPOSITE_PRICE,
    );

    // Requester escrows the composite price; provider (= wrapper owner omega) delivers.
    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(COMPOSITE_PRICE))
        .create_job(composite, task_hash("compose-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("compose-result"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    // Each leaf owner has a pending withdrawal == their share of the escrow.
    assert_eq!(
        reg.pending_withdrawals_of(alpha),
        U512::from(COMPOSITE_PRICE * 5_000 / 10_000), "alpha = 50%",
    );
    assert_eq!(
        reg.pending_withdrawals_of(beta),
        U512::from(COMPOSITE_PRICE * 3_000 / 10_000), "beta = 30%",
    );
    assert_eq!(
        reg.pending_withdrawals_of(gamma),
        U512::from(COMPOSITE_PRICE * 2_000 / 10_000), "gamma = 20%",
    );
    // Wrapper owner gets ZERO escrow by default (they get a slice only by including themselves
    // as a leaf — the design point that forces wrapper cuts to be on-chain visible).
    assert_eq!(
        reg.pending_withdrawals_of(omega),
        U512::zero(),
        "wrapper owner has no implicit slice",
    );

    // Σ payouts == escrow_amount (the pull-payment invariant).
    let total = reg.pending_withdrawals_of(alpha)
        + reg.pending_withdrawals_of(beta)
        + reg.pending_withdrawals_of(gamma);
    assert_eq!(total, U512::from(COMPOSITE_PRICE), "escrow fully distributed (no dust lost)");

    // Reputation propagation: each leaf skill + composite all bump by REPUTATION_STEP.
    assert_eq!(reg.get_skill(leaf_a).reputation_score, BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.get_skill(leaf_b).reputation_score, BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.get_skill(leaf_c).reputation_score, BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.get_skill(composite).reputation_score, BASE_REPUTATION + REPUTATION_STEP);
    // Each leaf owner + the wrapper owner + the requester all bump in agent rep.
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(beta), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(gamma), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(omega), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(requester), BASE_REPUTATION + REPUTATION_STEP);
}

#[test]
fn composition_completion_last_leaf_absorbs_rounding_remainder() {
    // 3 leaves with weights that don't divide escrow evenly: 3333/3333/3334 of 1000 motes.
    // 1000 * 3333 / 10000 = 333.3 → 333 each for first two, last one gets 1000-333-333 = 334.
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let gamma = env.get_account(4);
    let omega = env.get_account(3);
    let requester = env.get_account(5);

    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let leaf_c = register_leaf(&env, &mut reg, gamma, "c");
    const DUSTY_PRICE: u64 = 1_000;
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_a, leaf_b, leaf_c],
        vec![3_333, 3_333, 3_334],
        DUSTY_PRICE,
    );
    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(DUSTY_PRICE))
        .create_job(composite, task_hash("dust-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("dust-result"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    assert_eq!(reg.pending_withdrawals_of(alpha), U512::from(333u64));
    assert_eq!(reg.pending_withdrawals_of(beta),  U512::from(333u64));
    // Last leaf absorbs the rounding remainder — Σ == escrow (no dust).
    assert_eq!(reg.pending_withdrawals_of(gamma), U512::from(334u64));
    let total = reg.pending_withdrawals_of(alpha)
        + reg.pending_withdrawals_of(beta)
        + reg.pending_withdrawals_of(gamma);
    assert_eq!(total, U512::from(DUSTY_PRICE));
}

#[test]
fn composition_wrapper_can_include_itself_as_leaf_for_explicit_cut() {
    // Wrapper-owner omega registers a primitive of their own, then composes
    // (wrapper-primitive, leaf-a, leaf-b) with a 4_000/3_000/3_000 split — proving the
    // "wrapper cut" is achievable IF AND ONLY IF it appears as an explicit on-chain leaf.
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let omega = env.get_account(3);
    let requester = env.get_account(5);

    let leaf_omega = register_leaf(&env, &mut reg, omega, "omega");
    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_omega, leaf_a, leaf_b],
        vec![4_000, 3_000, 3_000],
        COMPOSITE_PRICE,
    );

    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(COMPOSITE_PRICE))
        .create_job(composite, task_hash("cut-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("cut-result"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    assert_eq!(
        reg.pending_withdrawals_of(omega),
        U512::from(COMPOSITE_PRICE * 4_000 / 10_000),
        "wrapper owner gets exactly the slice tied to their own primitive leaf",
    );
}

// ─── Cross-chain reputation via governance (P0-B) ──────────────────────────────

#[test]
fn cross_chain_rep_defaults_to_zero() {
    let (env, reg, _, _) = setup();
    let fresh = env.get_account(7);
    assert_eq!(reg.get_cross_chain_rep(fresh), 0);
}

#[test]
fn governance_propose_approve_execute_sets_cross_chain_rep() {
    let (env, mut reg, _, _) = setup();
    let agent = env.get_account(3);
    let signer = env.get_account(0);

    env.set_caller(signer);
    let pid = reg.propose_set_cross_chain_rep(agent, 85, "stellar".to_string());
    assert_eq!(pid, 1);

    // 1-of-1 threshold met at proposal time; wait for timelock
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    env.set_caller(signer);
    reg.execute_proposal(pid);

    assert_eq!(reg.get_cross_chain_rep(agent), 85);
    assert!(env.emitted_event(
        &reg,
        CrossChainRepUpdated {
            agent,
            score: 85,
            source_chain: "stellar".to_string(),
        }
    ));
}

#[test]
fn governance_overwrite_cross_chain_rep_via_second_proposal() {
    let (env, mut reg, _, _) = setup();
    let agent = env.get_account(3);
    let signer = env.get_account(0);

    env.set_caller(signer);
    let p1 = reg.propose_set_cross_chain_rep(agent, 70, "stellar".to_string());
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(p1);
    assert_eq!(reg.get_cross_chain_rep(agent), 70);

    env.set_caller(signer);
    let p2 = reg.propose_set_cross_chain_rep(agent, 95, "stellar".to_string());
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(p2);
    assert_eq!(reg.get_cross_chain_rep(agent), 95);
}

#[test]
fn governance_propose_rejects_non_signer() {
    let (env, mut reg, alpha, _) = setup();
    let agent = env.get_account(3);
    env.set_caller(alpha); // not a governance signer
    assert_eq!(
        reg.try_propose_set_cross_chain_rep(agent, 80, "stellar".to_string()),
        Err(Error::NotGovernanceSigner.into())
    );
}

#[test]
fn governance_propose_rejects_score_over_max() {
    let (env, mut reg, _, _) = setup();
    let agent = env.get_account(3);
    let signer = env.get_account(0);
    env.set_caller(signer);
    assert_eq!(
        reg.try_propose_set_cross_chain_rep(agent, 101, "stellar".to_string()),
        Err(Error::BadThreshold.into())
    );
}

// ─── Ported from PR#7 (claude/karma-t2-1-skill-composition-odra) ──────────────
// PR#7 and this branch implement T2.1 with different revenue-split designs (PR#7:
// explicit `orchestrator_bps` + dust-to-orchestrator; here: weights sum to 10_000,
// wrapper-as-explicit-leaf, dust-to-last-leaf). The three cases below cover PR#7
// invariants that had no twin here — the leaf-count bound, the composite dispute
// refund, and the per-leaf self-deal carve-out — re-expressed for this design.

#[test]
fn composition_rejects_more_than_max_leaves() {
    // MAX_COMPOSITION_LEAVES + 1 distinct active leaves must be rejected. The leaf-count
    // bound is the first structural guard after the empty check, so it fires before the
    // weights-sum check regardless of the weight values.
    let (env, mut reg, alpha, _) = setup();
    let n = (MAX_COMPOSITION_LEAVES + 1) as usize;
    let mut leaves = Vec::with_capacity(n);
    for i in 0..n {
        leaves.push(register_leaf(&env, &mut reg, alpha, &format!("m{i}")));
    }
    let weights = vec![WEIGHT_DENOMINATOR / n as u32; n];
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "too-many".to_string(), "".to_string(), "mcp://too-many".to_string(),
            U512::from(COMPOSITE_PRICE), 0, IDENTITY_POLICY_NONE,
            leaves, weights,
        ),
        Err(Error::TooManyLeaves.into()),
    );
}

#[test]
fn composition_dispute_refunds_full_escrow_and_freezes_reputation() {
    // Disputing a composite job refunds the WHOLE escrow to the requester — no leaf owner
    // and no wrapper owner is paid — and bumps nobody's reputation.
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let gamma = env.get_account(4);
    let omega = env.get_account(3);
    let requester = env.get_account(5);

    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let leaf_c = register_leaf(&env, &mut reg, gamma, "c");
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_a, leaf_b, leaf_c],
        vec![5_000, 3_000, 2_000],
        COMPOSITE_PRICE,
    );

    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(COMPOSITE_PRICE))
        .create_job(composite, task_hash("disp-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("garbage"));
    env.set_caller(requester);
    let bond = dispute_bond_for(COMPOSITE_PRICE);
    reg.with_tokens(bond).dispute_result(job_id);

    // P1-A: bond-backed dispute holds escrow; concede or arbitrate to release
    // Force default concede to release funds
    env.advance_block_time(RESPONSE_WINDOW + 1);
    reg.resolve_default_concede(job_id);

    // Full escrow + bond back to requester; every producer slice is zero.
    assert_eq!(reg.pending_withdrawals_of(requester), U512::from(COMPOSITE_PRICE) + bond, "full refund + bond");
    assert_eq!(reg.pending_withdrawals_of(alpha), U512::zero(), "leaf A unpaid on dispute");
    assert_eq!(reg.pending_withdrawals_of(beta), U512::zero(), "leaf B unpaid on dispute");
    assert_eq!(reg.pending_withdrawals_of(gamma), U512::zero(), "leaf C unpaid on dispute");
    assert_eq!(reg.pending_withdrawals_of(omega), U512::zero(), "wrapper unpaid on dispute");

    // P1-A: default concede slashes provider (omega) and composite skill rep.
    // Leaf skills are unaffected (only the job's skill_id is slashed).
    assert_eq!(reg.get_skill(composite).reputation_score, BASE_REPUTATION - REP_SLASH_STEP, "composite rep slashed");
    assert_eq!(reg.agent_reputation(omega), BASE_REPUTATION - REP_SLASH_STEP, "provider (omega) agent rep slashed");
    assert_eq!(reg.get_skill(leaf_a).reputation_score, BASE_REPUTATION, "leaf A rep frozen");
    assert_eq!(reg.get_skill(leaf_b).reputation_score, BASE_REPUTATION, "leaf B rep frozen");
    assert_eq!(reg.get_skill(leaf_c).reputation_score, BASE_REPUTATION, "leaf C rep frozen");
}

#[test]
fn composition_settle_self_deal_leaf_paid_but_no_reputation() {
    // A leaf whose owner is ALSO the requester is still PAID (payment is not a self-deal
    // guard) but earns NO reputation; the arm's-length leaf and the composite wrapper do.
    let (env, mut reg, _, _) = setup();
    let requester = env.get_account(1); // also owns leaf_a → the self-deal target
    let arms = env.get_account(2);
    let omega = env.get_account(3);

    let leaf_a = register_leaf(&env, &mut reg, requester, "self");
    let leaf_b = register_leaf(&env, &mut reg, arms, "arms");
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_a, leaf_b],
        vec![6_000, 4_000],
        COMPOSITE_PRICE,
    );

    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(COMPOSITE_PRICE))
        .create_job(composite, task_hash("self-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("ok"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    // Payment is unconditional — the self-dealing leaf owner (= requester) is still paid.
    assert_eq!(
        reg.pending_withdrawals_of(requester),
        U512::from(COMPOSITE_PRICE * 6_000 / 10_000), "leaf A (self) paid 60%",
    );
    assert_eq!(
        reg.pending_withdrawals_of(arms),
        U512::from(COMPOSITE_PRICE * 4_000 / 10_000), "leaf B (arm's length) paid 40%",
    );

    // Reputation: self-deal leaf frozen; arm's-length leaf + composite bump.
    assert_eq!(reg.get_skill(leaf_a).reputation_score, BASE_REPUTATION, "self-deal leaf rep frozen");
    assert_eq!(reg.get_skill(leaf_b).reputation_score, BASE_REPUTATION + REPUTATION_STEP, "arm's-length leaf bumped");
    assert_eq!(reg.get_skill(composite).reputation_score, BASE_REPUTATION + REPUTATION_STEP, "composite bumped");

    // Requester earns exactly one step (the composite layer), not a second from leaf_a.
    assert_eq!(reg.agent_reputation(requester), BASE_REPUTATION + REPUTATION_STEP, "requester one composite-layer bump");
    assert_eq!(reg.agent_reputation(arms), BASE_REPUTATION + REPUTATION_STEP, "arm's-length leaf owner bumped");
}

// ─── P0-A: Evaluator Agent ──────────────────────────────────────────────────
//
// Mirrors the 23 Foundry evaluator tests from `test/AgentSkillRegistry.t.sol`.
// The evaluator is a neutral third party that can approve or reject a delivered
// result. Fee routing: evaluator gets paid regardless of verdict; escrow goes
// to provider on approval, requester on rejection.

const EVAL_FEE: u64 = 100_000; // motes — evaluator's fee

fn open_job_with_evaluator(
    env: &HostEnv,
    contract: &mut AgentSkillRegistryHostRef,
    requester: Address,
    skill_id: u64,
    evaluator: Address,
    label: &str,
) -> u64 {
    env.set_caller(requester);
    contract
        .with_tokens(U512::from(PRICE + EVAL_FEE))
        .create_job_with_evaluator(
            skill_id,
            task_hash(label),
            DEADLINE_MS,
            evaluator,
            U512::from(EVAL_FEE),
        )
}

#[test]
fn evaluator_create_job_with_evaluator_happy_path() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "eval-t1");

    let j = reg.get_job(job_id);
    assert_eq!(j.evaluator, Some(evaluator));
    assert_eq!(j.evaluator_fee, U512::from(EVAL_FEE));
    assert_eq!(j.escrow_amount, U512::from(PRICE));
}

#[test]
fn evaluator_rejects_zero_address_not_applicable() {
    // Odra uses Option<Address> — None is the "no evaluator" case, handled by create_job.
    // This test ensures backward compat: create_job sets evaluator=None, fee=0.
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "no-eval");
    let j = reg.get_job(job_id);
    assert_eq!(j.evaluator, None);
    assert_eq!(j.evaluator_fee, U512::zero());
}

#[test]
fn evaluator_rejects_evaluator_is_requester() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(U512::from(PRICE + EVAL_FEE))
            .try_create_job_with_evaluator(
                skill_id,
                task_hash("self-eval"),
                DEADLINE_MS,
                beta, // evaluator == requester
                U512::from(EVAL_FEE),
            ),
        Err(Error::EvaluatorCannotBeRequester.into())
    );
}

#[test]
fn evaluator_rejects_evaluator_is_provider() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(U512::from(PRICE + EVAL_FEE))
            .try_create_job_with_evaluator(
                skill_id,
                task_hash("provider-eval"),
                DEADLINE_MS,
                alpha, // evaluator == provider (skill owner)
                U512::from(EVAL_FEE),
            ),
        Err(Error::EvaluatorCannotBeProvider.into())
    );
}

#[test]
fn evaluator_escrow_must_include_fee() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    env.set_caller(beta);
    // Send only PRICE, not PRICE + EVAL_FEE
    assert_eq!(
        reg.with_tokens(U512::from(PRICE))
            .try_create_job_with_evaluator(
                skill_id,
                task_hash("short"),
                DEADLINE_MS,
                evaluator,
                U512::from(EVAL_FEE),
            ),
        Err(Error::EscrowMustEqualPrice.into())
    );
}

#[test]
fn evaluator_approve_pays_provider_and_evaluator() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "approve-1");

    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("result"));

    env.set_caller(evaluator);
    reg.evaluate_result(job_id, true);

    // Provider gets escrow via pull-payment
    assert_eq!(reg.pending_withdrawals_of(alpha), U512::from(PRICE));
    // Evaluator gets fee
    assert_eq!(reg.pending_withdrawals_of(evaluator), U512::from(EVAL_FEE));
    // Requester gets nothing
    assert_eq!(reg.pending_withdrawals_of(beta), U512::zero());

    let j = reg.get_job(job_id);
    assert_eq!(j.status, JobStatus::Completed);
}

#[test]
fn evaluator_reject_refunds_requester_and_pays_evaluator() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "reject-1");

    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("result"));

    env.set_caller(evaluator);
    reg.evaluate_result(job_id, false);

    // Requester gets escrow back
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(PRICE));
    // Evaluator gets fee regardless
    assert_eq!(reg.pending_withdrawals_of(evaluator), U512::from(EVAL_FEE));
    // Provider gets nothing
    assert_eq!(reg.pending_withdrawals_of(alpha), U512::zero());

    let j = reg.get_job(job_id);
    assert_eq!(j.status, JobStatus::Disputed);
}

#[test]
fn evaluator_approve_emits_job_evaluated_event() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "event-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(evaluator);
    reg.evaluate_result(job_id, true);

    assert!(env.emitted_event(
        &reg,
        JobEvaluated {
            job_id,
            evaluator,
            approved: true,
            evaluator_payout: U512::from(EVAL_FEE),
        }
    ));
}

#[test]
fn evaluator_reject_emits_job_evaluated_and_result_disputed() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "event-2");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(evaluator);
    reg.evaluate_result(job_id, false);

    assert!(env.emitted_event(
        &reg,
        JobEvaluated {
            job_id,
            evaluator,
            approved: false,
            evaluator_payout: U512::from(EVAL_FEE),
        }
    ));
    assert!(env.emitted_event(
        &reg,
        ResultDisputed {
            job_id,
            requester: beta,
            amount: U512::from(PRICE),
        }
    ));
}

#[test]
fn evaluator_not_evaluator_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let outsider = env.get_account(4);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "auth-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    // Outsider tries to evaluate
    env.set_caller(outsider);
    assert_eq!(reg.try_evaluate_result(job_id, true), Err(Error::NotEvaluator.into()));
}

#[test]
fn evaluator_requester_cannot_evaluate() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "auth-2");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.set_caller(beta); // requester, not evaluator
    assert_eq!(reg.try_evaluate_result(job_id, true), Err(Error::NotEvaluator.into()));
}

#[test]
fn evaluator_provider_cannot_evaluate() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "auth-3");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.set_caller(alpha); // provider, not evaluator
    assert_eq!(reg.try_evaluate_result(job_id, true), Err(Error::NotEvaluator.into()));
}

#[test]
fn evaluator_double_evaluate_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "double-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(evaluator);
    reg.evaluate_result(job_id, true);

    // Second evaluation → job is already Completed, not Delivered
    env.set_caller(evaluator);
    assert_eq!(reg.try_evaluate_result(job_id, false), Err(Error::JobNotDelivered.into()));
}

#[test]
fn evaluator_after_window_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "late-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 1);
    env.set_caller(evaluator);
    assert_eq!(reg.try_evaluate_result(job_id, true), Err(Error::ReviewWindowClosed.into()));
}

#[test]
fn evaluator_on_job_without_evaluator_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let outsider = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "no-eval-job");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.set_caller(outsider);
    assert_eq!(reg.try_evaluate_result(job_id, true), Err(Error::NotEvaluator.into()));
}

// ── Fee routing for requester-override paths ──

#[test]
fn evaluator_confirm_completion_refunds_fee_to_requester() {
    // Requester uses confirm_completion directly (bypassing evaluator) → evaluator fee refunded.
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "confirm-fee-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.set_caller(beta);
    reg.confirm_completion(job_id);

    // Provider gets escrow
    assert_eq!(reg.pending_withdrawals_of(alpha), U512::from(PRICE));
    // Requester gets evaluator fee refund
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(EVAL_FEE));
    // Evaluator gets nothing (didn't act)
    assert_eq!(reg.pending_withdrawals_of(evaluator), U512::zero());
}

#[test]
fn evaluator_dispute_result_refunds_escrow_and_fee_to_requester() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "dispute-fee-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result(job_id);

    // P1-A: evaluator fee immediately refunded; escrow held until resolution
    // Evaluator fee returned immediately on dispute
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(EVAL_FEE), "eval fee refunded immediately");
    // Force default concede to release escrow + bond
    env.advance_block_time(RESPONSE_WINDOW + 1);
    reg.resolve_default_concede(job_id);
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(EVAL_FEE) + U512::from(PRICE) + bond);
    assert_eq!(reg.pending_withdrawals_of(alpha), U512::zero());
    assert_eq!(reg.pending_withdrawals_of(evaluator), U512::zero());
}

#[test]
fn evaluator_claim_after_review_refunds_fee_to_requester() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "claim-fee-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 1);
    env.set_caller(alpha);
    reg.claim_after_review(job_id);

    // Provider gets escrow
    assert_eq!(reg.pending_withdrawals_of(alpha), U512::from(PRICE));
    // Requester gets evaluator fee refund
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(EVAL_FEE));
    // Evaluator gets nothing (didn't act)
    assert_eq!(reg.pending_withdrawals_of(evaluator), U512::zero());
}

#[test]
fn evaluator_claim_refund_returns_escrow_and_fee() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "refund-fee-1");

    env.advance_block_time(DEADLINE_MS + 1);
    env.set_caller(beta);
    reg.claim_refund(job_id);

    // Requester gets escrow + evaluator fee
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(PRICE + EVAL_FEE));
    assert_eq!(reg.pending_withdrawals_of(evaluator), U512::zero());
}

#[test]
fn evaluator_approve_bumps_reputation() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "rep-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(evaluator);
    reg.evaluate_result(job_id, true);

    let s = reg.get_skill(skill_id);
    assert_eq!(s.reputation_score, BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(s.total_invocations, 1);
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(beta), BASE_REPUTATION + REPUTATION_STEP);
}

#[test]
fn evaluator_reject_freezes_reputation() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "rep-2");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(evaluator);
    reg.evaluate_result(job_id, false);

    let s = reg.get_skill(skill_id);
    assert_eq!(s.reputation_score, BASE_REPUTATION, "rejected → no rep change");
    assert_eq!(s.total_invocations, 0);
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION);
    assert_eq!(reg.agent_reputation(beta), BASE_REPUTATION);
}

#[test]
fn evaluator_zero_fee_approve_still_works() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);

    env.set_caller(beta);
    let job_id = reg
        .with_tokens(U512::from(PRICE))
        .create_job_with_evaluator(skill_id, task_hash("zero-fee"), DEADLINE_MS, evaluator, U512::zero());

    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(evaluator);
    reg.evaluate_result(job_id, true);

    assert_eq!(reg.pending_withdrawals_of(alpha), U512::from(PRICE));
    assert_eq!(reg.pending_withdrawals_of(evaluator), U512::zero()); // zero fee
    assert_eq!(reg.pending_withdrawals_of(beta), U512::zero());
}

#[test]
fn evaluator_backward_compat_create_job_still_works() {
    // Old create_job path must still work unchanged — evaluator=None, fee=0.
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "compat-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(beta);
    reg.confirm_completion(job_id);

    assert_eq!(reg.pending_withdrawals_of(alpha), U512::from(PRICE));
    assert_eq!(reg.pending_withdrawals_of(beta), U512::zero()); // no fee to refund
}

#[test]
fn evaluator_get_job_evaluator_view() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "view-1");

    let (ev, fee) = reg.get_job_evaluator(job_id);
    assert_eq!(ev, Some(evaluator));
    assert_eq!(fee, U512::from(EVAL_FEE));

    // Job without evaluator
    let job_id2 = open_job(&env, &mut reg, beta, skill_id, "view-2");
    let (ev2, fee2) = reg.get_job_evaluator(job_id2);
    assert_eq!(ev2, None);
    assert_eq!(fee2, U512::zero());
}

// ─── P0-B: Governance multisig + timelock tests ────────────────────────────────

fn setup_multisig() -> (HostEnv, AgentSkillRegistryHostRef, Address, Address, Address) {
    let env = odra_test::env();
    let signer_a = env.get_account(0);
    let signer_b = env.get_account(1);
    let signer_c = env.get_account(2);
    let init_args = AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
        governance_signers: vec![signer_a, signer_b, signer_c],
        governance_threshold: 2,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
    };
    let contract = AgentSkillRegistry::deploy(&env, init_args);
    (env, contract, signer_a, signer_b, signer_c)
}

#[test]
fn governance_multisig_2_of_3_happy_path() {
    let (env, mut reg, sa, sb, _sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());

    env.set_caller(sb);
    reg.approve_proposal(pid);

    assert_eq!(reg.proposal_approval_count(pid), 2);

    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);

    // Anyone can execute after threshold + timelock
    let executor = env.get_account(7);
    env.set_caller(executor);
    reg.execute_proposal(pid);

    assert_eq!(reg.get_cross_chain_rep(agent), 80);
}

#[test]
fn governance_execute_before_threshold_reverts() {
    let (env, mut reg, sa, _sb, _sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());

    // Only 1 approval, threshold is 2
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    env.set_caller(sa);
    assert_eq!(reg.try_execute_proposal(pid), Err(Error::ThresholdNotMet.into()));
}

#[test]
fn governance_execute_before_timelock_reverts() {
    let (env, mut reg, sa, sb, _sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());
    env.set_caller(sb);
    reg.approve_proposal(pid);

    // Threshold met but timelock not elapsed
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY - 1);
    env.set_caller(sa);
    assert_eq!(reg.try_execute_proposal(pid), Err(Error::TimelockNotElapsed.into()));
}

#[test]
fn governance_duplicate_approval_reverts() {
    let (env, mut reg, sa, _sb, _sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());

    // Proposer already auto-approved; second approval reverts
    env.set_caller(sa);
    assert_eq!(reg.try_approve_proposal(pid), Err(Error::AlreadyApproved.into()));
}

#[test]
fn governance_approve_by_non_signer_reverts() {
    let (env, mut reg, sa, _sb, _sc) = setup_multisig();
    let agent = env.get_account(5);
    let outsider = env.get_account(7);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());

    env.set_caller(outsider);
    assert_eq!(reg.try_approve_proposal(pid), Err(Error::NotGovernanceSigner.into()));
}

#[test]
fn governance_cancel_proposal() {
    let (env, mut reg, sa, sb, _sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());
    env.set_caller(sb);
    reg.approve_proposal(pid);

    // Any signer can cancel
    env.set_caller(sa);
    reg.cancel_proposal(pid);

    // Cancelled proposal can't be executed
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    env.set_caller(sa);
    assert_eq!(reg.try_execute_proposal(pid), Err(Error::ProposalCancelled.into()));
}

#[test]
fn governance_cancel_by_non_signer_reverts() {
    let (env, mut reg, sa, _sb, _sc) = setup_multisig();
    let agent = env.get_account(5);
    let outsider = env.get_account(7);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());

    env.set_caller(outsider);
    assert_eq!(reg.try_cancel_proposal(pid), Err(Error::NotGovernanceSigner.into()));
}

#[test]
fn governance_double_execute_reverts() {
    let (env, mut reg, _, _) = setup();
    let sa = env.get_account(0);
    let agent = env.get_account(3);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(pid);

    env.set_caller(sa);
    assert_eq!(reg.try_execute_proposal(pid), Err(Error::ProposalAlreadyExecuted.into()));
}

#[test]
fn governance_approve_executed_proposal_reverts() {
    let (env, mut reg, sa, sb, sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());
    env.set_caller(sb);
    reg.approve_proposal(pid);
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(pid);

    env.set_caller(sc);
    assert_eq!(reg.try_approve_proposal(pid), Err(Error::ProposalAlreadyExecuted.into()));
}

#[test]
fn governance_approve_cancelled_proposal_reverts() {
    let (env, mut reg, sa, sb, _sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());
    env.set_caller(sb);
    reg.cancel_proposal(pid);

    env.set_caller(sb);
    assert_eq!(reg.try_approve_proposal(pid), Err(Error::ProposalCancelled.into()));
}

#[test]
fn governance_nonexistent_proposal_reverts() {
    let (env, mut reg, sa, _sb, _sc) = setup_multisig();
    env.set_caller(sa);
    assert_eq!(reg.try_approve_proposal(999), Err(Error::ProposalNotFound.into()));
    assert_eq!(reg.try_execute_proposal(999), Err(Error::ProposalNotFound.into()));
    assert_eq!(reg.try_cancel_proposal(999), Err(Error::ProposalNotFound.into()));
}

#[test]
fn governance_views() {
    let (env, reg, sa, sb, sc) = setup_multisig();

    assert!(reg.is_governance_signer(sa));
    assert!(reg.is_governance_signer(sb));
    assert!(reg.is_governance_signer(sc));
    assert!(!reg.is_governance_signer(env.get_account(7)));
    assert_eq!(reg.get_governance_threshold(), 2);
    assert_eq!(reg.get_governance_signers(), vec![sa, sb, sc]);
    assert_eq!(reg.get_timelock_delay(), DEFAULT_TIMELOCK_DELAY);
}

#[test]
fn governance_proposal_view() {
    let (env, mut reg, sa, _sb, _sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 75, "cosmos".to_string());

    let proposal = reg.get_proposal(pid);
    assert_eq!(proposal.proposer, sa);
    assert!(!proposal.executed);
    assert!(!proposal.cancelled);
    assert_eq!(reg.proposal_approval_count(pid), 1);
}

#[test]
fn governance_emits_events() {
    let (env, mut reg, sa, sb, _sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());

    assert!(env.emitted_event(&reg, ProposalCreated { proposal_id: pid, proposer: sa }));
    assert!(env.emitted_event(&reg, ProposalApproved {
        proposal_id: pid,
        signer: sa,
        approval_count: 1,
        threshold: 2,
    }));

    env.set_caller(sb);
    reg.approve_proposal(pid);
    assert!(env.emitted_event(&reg, ProposalApproved {
        proposal_id: pid,
        signer: sb,
        approval_count: 2,
        threshold: 2,
    }));

    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    let executor = env.get_account(7);
    env.set_caller(executor);
    reg.execute_proposal(pid);
    assert!(env.emitted_event(&reg, ProposalExecuted { proposal_id: pid, executor }));
}

#[test]
fn governance_cancel_emits_event() {
    let (env, mut reg, sa, _sb, _sc) = setup_multisig();
    let agent = env.get_account(5);

    env.set_caller(sa);
    let pid = reg.propose_set_cross_chain_rep(agent, 80, "soroban".to_string());
    env.set_caller(sa);
    reg.cancel_proposal(pid);
    assert!(env.emitted_event(&reg, ProposalCancelled { proposal_id: pid }));
}

#[test]
fn governance_init_emits_configured_event() {
    let (env, reg, _sa, _sb, _sc) = setup_multisig();
    assert!(env.emitted_event(&reg, GovernanceConfigured {
        threshold: 2,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
    }));
}

// ── Governance init validation ──

#[test]
fn governance_init_rejects_empty_signers() {
    let env = odra_test::env();
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
        governance_signers: vec![],
        governance_threshold: 1,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
    };
    assert_eq!(
        AgentSkillRegistry::try_deploy(&env, bad).err(),
        Some(Error::InvalidGovernanceConfig.into())
    );
}

#[test]
fn governance_init_rejects_threshold_zero() {
    let env = odra_test::env();
    let deployer = env.get_account(0);
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
        governance_signers: vec![deployer],
        governance_threshold: 0,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
    };
    assert_eq!(
        AgentSkillRegistry::try_deploy(&env, bad).err(),
        Some(Error::InvalidGovernanceConfig.into())
    );
}

#[test]
fn governance_init_rejects_threshold_over_signers() {
    let env = odra_test::env();
    let deployer = env.get_account(0);
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
        governance_signers: vec![deployer],
        governance_threshold: 2,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
    };
    assert_eq!(
        AgentSkillRegistry::try_deploy(&env, bad).err(),
        Some(Error::InvalidGovernanceConfig.into())
    );
}

#[test]
fn governance_init_rejects_duplicate_signers() {
    let env = odra_test::env();
    let deployer = env.get_account(0);
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
        governance_signers: vec![deployer, deployer],
        governance_threshold: 1,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
    };
    assert_eq!(
        AgentSkillRegistry::try_deploy(&env, bad).err(),
        Some(Error::DuplicateSigner.into())
    );
}

#[test]
fn evaluator_withdraw_flow_after_approve() {
    // Full end-to-end: evaluator approves → both provider and evaluator withdraw
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "withdraw-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(evaluator);
    reg.evaluate_result(job_id, true);

    // Provider withdraws escrow
    let bal_before_alpha = env.balance_of(&alpha);
    env.set_caller(alpha);
    reg.withdraw();
    assert_eq!(env.balance_of(&alpha), bal_before_alpha + U512::from(PRICE));

    // Evaluator withdraws fee
    let bal_before_eval = env.balance_of(&evaluator);
    env.set_caller(evaluator);
    reg.withdraw();
    assert_eq!(env.balance_of(&evaluator), bal_before_eval + U512::from(EVAL_FEE));
}

// ─── P1-A: Symmetric Dispute Bond ──────────────────────────────────────────────

#[test]
fn p1a_provider_at_fault_full_flow() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-paf");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    // Provider responds
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    // Arbiter rules ProviderAtFault
    let deployer = env.get_account(0); // = arbiter
    env.set_caller(deployer);
    reg.arbitrate(job_id, Verdict::ProviderAtFault);

    let j = reg.get_job(job_id);
    assert_eq!(j.status, JobStatus::Refunded);
    // Requester gets escrow + both bonds
    assert_eq!(
        reg.pending_withdrawals_of(beta),
        U512::from(PRICE) + bond + bond,
    );
    assert_eq!(reg.pending_withdrawals_of(alpha), U512::zero());
    // Provider rep slashed
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION - REP_SLASH_STEP);
    assert_eq!(reg.get_skill(skill_id).reputation_score, BASE_REPUTATION - REP_SLASH_STEP);
}

#[test]
fn p1a_requester_at_fault_full_flow() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-raf");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    let deployer = env.get_account(0);
    env.set_caller(deployer);
    reg.arbitrate(job_id, Verdict::RequesterAtFault);

    let j = reg.get_job(job_id);
    assert_eq!(j.status, JobStatus::Completed);
    // Provider gets escrow + both bonds
    assert_eq!(
        reg.pending_withdrawals_of(alpha),
        U512::from(PRICE) + bond + bond,
    );
    assert_eq!(reg.pending_withdrawals_of(beta), U512::zero());
    // Provider rep bumped (arm's-length)
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.get_skill(skill_id).reputation_score, BASE_REPUTATION + REPUTATION_STEP);
}

#[test]
fn p1a_provider_concedes() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-conc");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(alpha);
    reg.concede_dispute(job_id);

    let j = reg.get_job(job_id);
    assert_eq!(j.status, JobStatus::Refunded);
    assert_eq!(
        reg.pending_withdrawals_of(beta),
        U512::from(PRICE) + bond,
    );
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION - REP_SLASH_STEP);
    assert_eq!(reg.get_skill(skill_id).reputation_score, BASE_REPUTATION - REP_SLASH_STEP);
}

#[test]
fn p1a_default_concede_after_response_window() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-dflt");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.advance_block_time(RESPONSE_WINDOW + 1);
    // Anyone can trigger
    let outsider = env.get_account(5);
    env.set_caller(outsider);
    reg.resolve_default_concede(job_id);

    assert_eq!(reg.get_job(job_id).status, JobStatus::Refunded);
    assert_eq!(
        reg.pending_withdrawals_of(beta),
        U512::from(PRICE) + bond,
    );
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION - REP_SLASH_STEP);
}

#[test]
fn p1a_wrong_bond_amount_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-wrong");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(bond + U512::from(1u64)).try_dispute_result(job_id),
        Err(Error::WrongDisputeBond.into()),
    );
}

#[test]
fn p1a_zero_escrow_uses_min_dispute_bond() {
    // When escrow is zero, the dispute bond defaults to MIN_DISPUTE_BOND_MOTES
    let (env, mut reg, _, _) = setup();
    let alpha = env.get_account(1);
    env.set_caller(alpha);
    let skill_id = reg.register_skill(
        "free".to_string(), "free skill".to_string(), "mcp://free".to_string(),
        U512::zero(), 0, IDENTITY_POLICY_NONE,
    );

    let beta = env.get_account(2);
    env.set_caller(beta);
    let job_id = reg.with_tokens(U512::zero()).create_job(skill_id, task_hash("free-job"), DEADLINE_MS);

    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    let min_bond = U512::from(MIN_DISPUTE_BOND_MOTES);
    env.set_caller(beta);
    reg.with_tokens(min_bond).dispute_result(job_id);

    let d = reg.get_dispute_info(job_id).unwrap();
    assert_eq!(d.dispute_bond, min_bond, "MIN_DISPUTE_BOND_MOTES used for zero-escrow");
}

#[test]
fn p1a_response_after_window_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-late-resp");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.advance_block_time(RESPONSE_WINDOW + 1);
    env.set_caller(alpha);
    assert_eq!(
        reg.with_tokens(bond).try_respond_to_dispute(job_id),
        Err(Error::ResponseWindowClosed.into()),
    );
}

#[test]
fn p1a_double_response_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-dbl");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    env.set_caller(alpha);
    assert_eq!(
        reg.with_tokens(bond).try_respond_to_dispute(job_id),
        Err(Error::AlreadyResponded.into()),
    );
}

#[test]
fn p1a_concede_after_response_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-conc-resp");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    env.set_caller(alpha);
    assert_eq!(
        reg.try_concede_dispute(job_id),
        Err(Error::AlreadyResponded.into()),
    );
}

#[test]
fn p1a_arbitrate_before_response_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-arb-early");
    deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    let deployer = env.get_account(0);
    env.set_caller(deployer);
    assert_eq!(
        reg.try_arbitrate(job_id, Verdict::ProviderAtFault),
        Err(Error::ProviderNotResponded.into()),
    );
}

#[test]
fn p1a_not_arbiter_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-na");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    env.set_caller(alpha); // alpha is not arbiter
    assert_eq!(
        reg.try_arbitrate(job_id, Verdict::ProviderAtFault),
        Err(Error::NotArbiter.into()),
    );
}

#[test]
fn p1a_default_concede_before_window_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-early-dflt");
    deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(beta);
    assert_eq!(
        reg.try_resolve_default_concede(job_id),
        Err(Error::ResponseWindowOpen.into()),
    );
}

#[test]
fn p1a_rep_slash_floors_at_rep_floor() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);

    // Slash multiple times to drive rep to floor
    for i in 0..10u64 {
        let job_id = open_job(&env, &mut reg, beta, skill_id, &format!("slash-{i}"));
        let _bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);
        env.set_caller(alpha);
        reg.concede_dispute(job_id);
    }

    assert_eq!(reg.agent_reputation(alpha), REP_FLOOR, "agent rep floored at REP_FLOOR, not 0");
    assert_eq!(reg.get_skill(skill_id).reputation_score, REP_FLOOR, "skill rep floored at REP_FLOOR");
}

#[test]
fn p1a_set_dispute_bond_bps() {
    // P0-B: dispute-bond-bps changes go through the same propose/approve(1-of-1)/timelock/execute
    // lifecycle as cross-chain-rep — no single-signer immediate-effect path.
    let (env, mut reg, _, _) = setup();
    let deployer = env.get_account(0); // governance signer
    env.set_caller(deployer);
    let pid = reg.propose_set_dispute_bond_bps(5_000);
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(pid);
    assert_eq!(reg.get_dispute_bond_bps(), 5_000);

    assert!(env.emitted_event(
        &reg,
        DisputeBondBpsUpdated { old_bps: 10_000, new_bps: 5_000 },
    ));
}

#[test]
fn p1a_set_arbiter() {
    // P0-B: arbiter changes go through the same propose/approve(1-of-1)/timelock/execute
    // lifecycle as cross-chain-rep — no single-signer immediate-effect path.
    let (env, mut reg, alpha, _) = setup();
    let deployer = env.get_account(0);
    let old_arbiter = reg.get_arbiter();
    assert_eq!(old_arbiter, deployer);

    env.set_caller(deployer);
    let pid = reg.propose_set_arbiter(alpha);
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(pid);
    assert_eq!(reg.get_arbiter(), alpha);

    assert!(env.emitted_event(
        &reg,
        ArbiterUpdated { old_arbiter: deployer, new_arbiter: alpha },
    ));
}

#[test]
fn p1a_set_dispute_bond_bps_non_signer_reverts() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha); // not governance signer
    assert_eq!(
        reg.try_propose_set_dispute_bond_bps(5_000),
        Err(Error::NotGovernanceSigner.into()),
    );
}

#[test]
fn p1a_set_arbiter_non_signer_reverts() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    assert_eq!(
        reg.try_propose_set_arbiter(alpha),
        Err(Error::NotGovernanceSigner.into()),
    );
}

#[test]
fn p1a_evaluator_rejection_still_terminal() {
    // Evaluator rejection (evaluate_result(false)) is still terminal —
    // no bonded dispute, no need for resolution
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "eval-rej");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.set_caller(evaluator);
    reg.evaluate_result(job_id, false);

    let j = reg.get_job(job_id);
    assert_eq!(j.status, JobStatus::Disputed);
    // No dispute info → evaluator rejection, not bonded dispute
    assert!(reg.get_dispute_info(job_id).is_none(), "no DisputeInfo for evaluator rejection");
    // Requester gets escrow refund immediately
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(PRICE));
    // Evaluator gets fee
    assert_eq!(reg.pending_withdrawals_of(evaluator), U512::from(EVAL_FEE));
}

#[test]
fn p1a_requester_can_still_dispute_with_bond_after_evaluator_set() {
    let (env, mut reg, alpha, beta) = setup();
    let evaluator = env.get_account(3);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job_with_evaluator(&env, &mut reg, beta, skill_id, evaluator, "req-disp-eval");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    // Requester can dispute (with bond) even when there's an evaluator set
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result(job_id);

    let j = reg.get_job(job_id);
    assert_eq!(j.status, JobStatus::Disputed);
    let d = reg.get_dispute_info(job_id).unwrap();
    assert_eq!(d.dispute_bond, bond);
    // Evaluator fee returned to requester immediately
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(EVAL_FEE));
}

#[test]
fn p1a_provider_wrong_bond_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-wrong-prov");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(alpha);
    assert_eq!(
        reg.with_tokens(bond + U512::from(1u64)).try_respond_to_dispute(job_id),
        Err(Error::WrongDisputeBond.into()),
    );
}

#[test]
fn p1a_full_withdrawal_after_arbitration() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-withdraw");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    let deployer = env.get_account(0);
    env.set_caller(deployer);
    reg.arbitrate(job_id, Verdict::ProviderAtFault);

    // Requester withdraws everything
    let expected = U512::from(PRICE) + bond + bond;
    assert_eq!(reg.pending_withdrawals_of(beta), expected);
    let bal_before = env.balance_of(&beta);
    env.set_caller(beta);
    reg.withdraw();
    assert_eq!(env.balance_of(&beta), bal_before + expected);
    assert_eq!(reg.pending_withdrawals_of(beta), U512::zero());
}

#[test]
fn p1a_events_emitted_on_dispute_and_response() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-events");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    assert!(env.emitted_event(
        &reg,
        DisputeBondPosted { job_id, requester: beta, bond },
    ));
    assert!(env.emitted_event(
        &reg,
        ResultDisputed { job_id, requester: beta, amount: U512::from(PRICE) },
    ));

    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);
    assert!(env.emitted_event(
        &reg,
        DisputeResponsePosted { job_id, provider: alpha, bond },
    ));
}

#[test]
fn p1a_concede_event_emitted() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-conc-ev");
    deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(alpha);
    reg.concede_dispute(job_id);

    assert!(env.emitted_event(
        &reg,
        DisputeConceded { job_id, provider: alpha },
    ));
}

#[test]
fn p1a_arbitrate_event_emitted() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-arb-ev");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);

    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    let deployer = env.get_account(0);
    env.set_caller(deployer);
    reg.arbitrate(job_id, Verdict::RequesterAtFault);

    assert!(env.emitted_event(
        &reg,
        DisputeArbitrated {
            job_id,
            verdict: Verdict::RequesterAtFault,
            arbiter: deployer,
        },
    ));
}

#[test]
fn p1a_lower_bps_changes_required_bond() {
    let (env, mut reg, _, _) = setup();
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let pid = reg.propose_set_dispute_bond_bps(5_000); // 0.5× escrow
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(pid);

    let alpha = env.get_account(1);
    let beta = env.get_account(2);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "p1a-lowbps");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    // Bond should be 0.5 × PRICE
    let expected_bond = U512::from(5_000u32) * U512::from(PRICE) / U512::from(10_000u32);
    let min_bond = U512::from(MIN_DISPUTE_BOND_MOTES);
    let bond = if expected_bond < min_bond { min_bond } else { expected_bond };

    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result(job_id);

    let d = reg.get_dispute_info(job_id).unwrap();
    assert_eq!(d.dispute_bond, bond);
}

// ── P2-A: AI decision rationale attestation ─────────────────────────────────
fn rationale_hash(label: &str) -> Bytes {
    // A real caller hashes the plaintext rationale (blake2b/keccak) to 32 bytes; tests just need
    // *some* fixed 32-byte value, so pad/truncate a label deterministically.
    let mut buf = [0u8; 32];
    let bytes = label.as_bytes();
    let n = bytes.len().min(32);
    buf[..n].copy_from_slice(&bytes[..n]);
    Bytes::from(buf.to_vec())
}

#[test]
fn attest_rationale_requester_can_attest_and_view() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "attest-1");

    assert_eq!(reg.get_rationale_hash(job_id), None);

    env.set_caller(beta);
    let h = rationale_hash("chose this skill: highest EV, rep 80");
    reg.attest_rationale(job_id, h.clone());

    assert_eq!(reg.get_rationale_hash(job_id), Some(h));
}

#[test]
#[should_panic]
fn attest_rationale_rejects_non_requester() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "attest-2");

    env.set_caller(alpha); // provider, not requester
    reg.attest_rationale(job_id, rationale_hash("not mine to attest"));
}

#[test]
#[should_panic]
fn attest_rationale_rejects_wrong_length_hash() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "attest-3");

    env.set_caller(beta);
    reg.attest_rationale(job_id, Bytes::from(vec![1u8, 2, 3])); // not 32 bytes
}

#[test]
#[should_panic]
fn attest_rationale_rejects_double_attest() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "attest-4");

    env.set_caller(beta);
    reg.attest_rationale(job_id, rationale_hash("first"));
    reg.attest_rationale(job_id, rationale_hash("second")); // rewriting history — must revert
}

#[test]
fn attest_rationale_is_independent_of_job_lifecycle() {
    // Attestation is a record of WHY the requester bought the skill, not a claim about outcome —
    // it must not interact with settlement, and must remain readable after the job completes.
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "attest-5");

    env.set_caller(beta);
    let h = rationale_hash("attest after delivery+confirm still allowed");
    reg.attest_rationale(job_id, h.clone());

    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(beta);
    reg.confirm_completion(job_id);

    assert_eq!(reg.get_job(job_id).status, JobStatus::Completed);
    assert_eq!(reg.get_rationale_hash(job_id), Some(h));
}

#[test]
fn attest_rationale_none_for_jobs_never_attested() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "attest-6");
    assert_eq!(reg.get_rationale_hash(job_id), None);
}

// ── P4-A: Panel Arbitration (N-of-M) ──────────────────────────────────────────

fn seed_panel(env: &HostEnv, reg: &mut AgentSkillRegistryHostRef) -> (Address, Address, Address) {
    let deployer = env.get_account(0);
    let arb1 = env.get_account(3);
    let arb2 = env.get_account(4);
    let arb3 = env.get_account(5);
    env.set_caller(deployer);
    let pid = reg.propose_set_arbiter_panel(vec![arb1, arb2, arb3], 2);
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(pid);
    (arb1, arb2, arb3)
}

#[test]
fn p1b_propose_set_arbiter_panel_rejects_even_length() {
    let (env, mut reg, alpha, _beta) = setup();
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let panel = vec![alpha, env.get_account(3), env.get_account(4), env.get_account(5)]; // 4, even
    assert_eq!(
        reg.try_propose_set_arbiter_panel(panel, 3),
        Err(Error::PanelSizeMustBeOdd.into()),
    );
}

#[test]
fn p1b_propose_set_arbiter_panel_rejects_below_min_size() {
    let (env, mut reg, alpha, beta) = setup();
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    // len=2: both "too small" and "even" apply; too-small is checked first.
    assert_eq!(
        reg.try_propose_set_arbiter_panel(vec![alpha, beta], 2),
        Err(Error::PanelSizeTooSmall.into()),
    );
}

#[test]
fn p1b_propose_set_arbiter_panel_rejects_wrong_threshold() {
    let (env, mut reg, alpha, beta) = setup();
    let deployer = env.get_account(0);
    let gamma = env.get_account(3);
    env.set_caller(deployer);
    // len=3, correct threshold is 2 (3/2+1); propose 3 (unanimity) — must reject, only strict-
    // majority-of-odd is allowed per audit-design's L1 finding.
    assert_eq!(
        reg.try_propose_set_arbiter_panel(vec![alpha, beta, gamma], 3),
        Err(Error::InvalidPanelThreshold.into()),
    );
}

#[test]
fn p1b_propose_set_arbiter_panel_rejects_duplicate_member() {
    let (env, mut reg, alpha, beta) = setup();
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    assert_eq!(
        reg.try_propose_set_arbiter_panel(vec![alpha, alpha, beta], 2),
        Err(Error::DuplicatePanelMember.into()),
    );
}

#[test]
fn p1b_propose_and_execute_arbiter_panel_full_lifecycle() {
    let (env, mut reg, alpha, beta) = setup();
    let deployer = env.get_account(0);
    let gamma = env.get_account(3);
    env.set_caller(deployer);
    let pid = reg.propose_set_arbiter_panel(vec![alpha, beta, gamma], 2);
    // governance_threshold=1 in `setup()` (single signer), so it's already approved; still
    // must wait out the timelock like every other proposal.
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(pid);
    assert_eq!(reg.get_arbiter_panel(), vec![alpha, beta, gamma]);
    assert_eq!(reg.get_panel_threshold(), 2);
    assert!(env.emitted_event(
        &reg,
        ArbiterPanelUpdated { old_panel: vec![], new_panel: vec![alpha, beta, gamma], threshold: 2 },
    ));
}

#[test]
fn p1b_propose_set_arbiter_panel_non_signer_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let gamma = env.get_account(3);
    env.set_caller(alpha); // not a governance signer
    assert_eq!(
        reg.try_propose_set_arbiter_panel(vec![alpha, beta, gamma], 2),
        Err(Error::NotGovernanceSigner.into()),
    );
}

#[test]
fn p1b_propose_and_execute_panel_arbiter_fee() {
    let (env, mut reg, _alpha, _beta) = setup();
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let pid = reg.propose_set_panel_arbiter_fee(U512::from(300_000u64));
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(pid);
    assert!(env.emitted_event(
        &reg,
        PanelArbiterFeeUpdated { old_fee: U512::zero(), new_fee: U512::from(300_000u64) },
    ));
}

#[test]
fn p1b_seed_panel_helper_produces_a_working_panel() {
    // Sanity check on the test helper itself before other p1b tests rely on it.
    let (env, mut reg, _alpha, _beta) = setup();
    let (arb1, arb2, arb3) = seed_panel(&env, &mut reg);
    assert_eq!(reg.get_arbiter_panel(), vec![arb1, arb2, arb3]);
    assert_eq!(reg.get_panel_threshold(), 2);
}

#[test]
fn p1b_dispute_via_panel_rejects_when_no_panel_configured() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-no-config");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(bond).try_dispute_result_via_panel(job_id),
        Err(Error::PanelNotConfigured.into()),
    );
}

#[test]
fn p1b_dispute_via_panel_wrong_amount_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    seed_panel(&env, &mut reg);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-wrong-amt");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE); // no fee added — panel_arbiter_fee defaults to 0, so
                                         // this actually succeeds; use bond+1 to force a mismatch
    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(bond + U512::one()).try_dispute_result_via_panel(job_id),
        Err(Error::WrongPanelDisputeAmount.into()),
    );
}

#[test]
fn p1b_panel_majority_reached_settles_provider_at_fault_and_pays_participating_arbiters() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, arb2, arb3) = seed_panel(&env, &mut reg);
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let fee_pid = reg.propose_set_panel_arbiter_fee(U512::from(300_000u64));
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(fee_pid);

    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-majority");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    let bond = dispute_bond_for(PRICE);
    let fee = U512::from(300_000u64);
    env.set_caller(beta);
    reg.with_tokens(bond + fee).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault);
    // Only 1 of 3 voted so far — not settled yet.
    assert_eq!(reg.get_job(job_id).status, JobStatus::Disputed);

    env.set_caller(arb2);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault); // 2 of 3 = threshold reached

    assert_eq!(reg.get_job(job_id).status, JobStatus::Refunded);
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(PRICE) + bond + bond);
    // Fee split between the 2 who voted (arb3 never voted, gets nothing).
    assert_eq!(reg.pending_withdrawals_of(arb1), U512::from(150_000u64));
    assert_eq!(reg.pending_withdrawals_of(arb2), U512::from(150_000u64));
    assert_eq!(reg.pending_withdrawals_of(arb3), U512::zero());

    assert!(env.emitted_event(
        &reg,
        PanelArbitrated {
            job_id,
            verdict: Verdict::ProviderAtFault,
            provider_at_fault_votes: 2,
            requester_at_fault_votes: 0,
        },
    ));
}

#[test]
fn p1b_panel_majority_requester_at_fault_settles_like_completion() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, arb2, _arb3) = seed_panel(&env, &mut reg);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-req-fault");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::RequesterAtFault);
    env.set_caller(arb2);
    reg.cast_panel_vote(job_id, Verdict::RequesterAtFault);

    assert_eq!(reg.get_job(job_id).status, JobStatus::Completed);
    assert_eq!(reg.pending_withdrawals_of(alpha), U512::from(PRICE) + bond + bond);
}

#[test]
fn p1b_panel_vote_after_settlement_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, arb2, arb3) = seed_panel(&env, &mut reg);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-after-settle");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);
    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::RequesterAtFault);
    env.set_caller(arb2);
    reg.cast_panel_vote(job_id, Verdict::RequesterAtFault); // settles

    env.set_caller(arb3);
    assert_eq!(
        reg.try_cast_panel_vote(job_id, Verdict::ProviderAtFault),
        Err(Error::NotDisputed.into()),
    );
}

#[test]
fn p1b_double_vote_from_same_arbiter_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, _arb2, _arb3) = seed_panel(&env, &mut reg);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-double-vote");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);
    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault);
    assert_eq!(
        reg.try_cast_panel_vote(job_id, Verdict::RequesterAtFault),
        Err(Error::AlreadyVotedOnPanel.into()),
    );
}

#[test]
fn p1b_vote_from_non_panel_address_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    seed_panel(&env, &mut reg);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-outsider");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    let outsider = env.get_account(6);
    env.set_caller(outsider);
    assert_eq!(
        reg.try_cast_panel_vote(job_id, Verdict::ProviderAtFault),
        Err(Error::NotPanelArbiter.into()),
    );
}

#[test]
fn p1b_single_arbiter_arbitrate_rejects_a_panel_mode_job() {
    // Cross-mode guard, the direction that actually matters for panel-arbitration to mean
    // anything: if the single arbiter could unilaterally settle a job the requester specifically
    // routed through (and paid extra for) N-of-M panel review, panel mode would provide zero
    // additional guarantee over the single-arbiter path — trivially bypassable by the exact
    // single-key trust it exists to move away from. This must revert.
    let (env, mut reg, alpha, beta) = setup();
    seed_panel(&env, &mut reg);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-cross-mode");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    let deployer = env.get_account(0); // the plain single arbiter
    env.set_caller(deployer);
    assert_eq!(
        reg.try_arbitrate(job_id, Verdict::ProviderAtFault),
        Err(Error::WrongArbitrationMode.into()),
    );
    // Confirm it's genuinely blocked, not just reverted for an unrelated reason — the job is
    // still Disputed and fully resolvable via the correct panel path.
    assert_eq!(reg.get_job(job_id).status, JobStatus::Disputed);
}

#[test]
fn p1b_existing_single_arbiter_flow_is_unaffected_by_the_new_mode_guard() {
    // The new guard in `arbitrate()` must only ever reject Panel-mode jobs — every existing
    // Single-mode (the default, via plain `dispute_result`) flow must behave byte-for-byte as
    // before. This is the other half of the cross-mode guard's correctness, and the reason it's
    // additive rather than a regression risk to the already-demoed courtroom flow.
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "single-mode-unaffected");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    let deployer = env.get_account(0);
    env.set_caller(deployer);
    reg.arbitrate(job_id, Verdict::ProviderAtFault);
    assert_eq!(reg.get_job(job_id).status, JobStatus::Refunded);
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(PRICE) + bond + bond);
}

#[test]
fn p1b_resolve_panel_default_before_window_elapses_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    seed_panel(&env, &mut reg);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-default-early");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    assert_eq!(
        reg.try_resolve_panel_default(job_id),
        Err(Error::PanelVoteWindowOpen.into()),
    );
}

#[test]
fn p1b_resolve_panel_default_before_provider_responds_reverts() {
    // Distinguishes from resolve_default_concede's job: that function already handles
    // "provider never responded at all"; resolve_panel_default is specifically for "provider
    // DID respond, panel just never reached majority."
    let (env, mut reg, alpha, beta) = setup();
    seed_panel(&env, &mut reg);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-default-no-response");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    // alpha never calls respond_to_dispute.
    env.advance_block_time(PANEL_VOTE_WINDOW + 1);
    assert_eq!(
        reg.try_resolve_panel_default(job_id),
        Err(Error::ProviderNotResponded.into()),
    );
}

#[test]
fn p1b_resolve_panel_default_after_window_refunds_requester_and_pays_partial_voters() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, _arb2, _arb3) = seed_panel(&env, &mut reg);
    let deployer = env.get_account(0);
    env.set_caller(deployer);
    let fee_pid = reg.propose_set_panel_arbiter_fee(U512::from(300_000u64));
    env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
    reg.execute_proposal(fee_pid);

    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-default-partial");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    let fee = U512::from(300_000u64);
    env.set_caller(beta);
    reg.with_tokens(bond + fee).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);

    // Only 1 of 3 ever votes — never reaches threshold=2.
    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault);

    env.advance_block_time(PANEL_VOTE_WINDOW + 1);
    reg.resolve_panel_default(job_id);

    assert_eq!(reg.get_job(job_id).status, JobStatus::Refunded);
    assert_eq!(reg.pending_withdrawals_of(beta), U512::from(PRICE) + bond + bond);
    // Only arb1 voted — gets the whole fee, not a third of it.
    assert_eq!(reg.pending_withdrawals_of(arb1), fee);

    assert!(env.emitted_event(&reg, PanelDefaultResolved { job_id }));
}

#[test]
fn p1b_resolve_panel_default_after_settlement_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let (arb1, arb2, _arb3) = seed_panel(&env, &mut reg);
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "panel-default-after-settle");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    let bond = dispute_bond_for(PRICE);
    env.set_caller(beta);
    reg.with_tokens(bond).dispute_result_via_panel(job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);
    env.set_caller(arb1);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault);
    env.set_caller(arb2);
    reg.cast_panel_vote(job_id, Verdict::ProviderAtFault); // settles before the window even matters

    env.advance_block_time(PANEL_VOTE_WINDOW + 1);
    assert_eq!(
        reg.try_resolve_panel_default(job_id),
        Err(Error::NotDisputed.into()),
    );
}

#[test]
fn p1b_resolve_panel_default_on_single_mode_job_reverts() {
    // Cross-mode guard, the other direction: resolve_panel_default must not be usable to
    // shortcut a plain Single-mode dispute's own resolve_default_concede path.
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "single-mode-default-guard");
    let bond = deliver_and_dispute(&env, &mut reg, alpha, beta, job_id);
    env.set_caller(alpha);
    reg.with_tokens(bond).respond_to_dispute(job_id);
    env.advance_block_time(PANEL_VOTE_WINDOW + 1);
    assert_eq!(
        reg.try_resolve_panel_default(job_id),
        Err(Error::WrongArbitrationMode.into()),
    );
}
