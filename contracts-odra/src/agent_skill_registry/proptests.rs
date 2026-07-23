//! Property-based invariant tests (P3 — added 2026-07-21), complementing `tests.rs`'s
//! example-based cases. Where `tests.rs` checks "this exact sequence produces this exact
//! number," these check "for ANY input in a wide randomized range, this invariant never
//! breaks" — the kind of boundary case a hand-picked example rarely hits by accident.
//!
//! Two invariants, chosen because they're the ones a real bug would actually violate silently:
//!   1. Escrow conservation across the bonded-dispute path: no CSPR is created or destroyed
//!      by `dispute_result` → `respond_to_dispute` → `arbitrate`, for any price/verdict.
//!   2. Reputation never leaves its documented [`REP_FLOOR`, `MAX_REPUTATION`] band, no matter
//!      how long a random sequence of slash/bump events runs.

use super::*;
use odra::casper_types::U512;
use odra::host::{Deployer, HostRef};
use proptest::prelude::*;

fn setup() -> (odra::host::HostEnv, AgentSkillRegistryHostRef, Address, Address) {
    let env = odra_test::env();
    let deployer = env.get_account(0);
    let init_args = AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
        governance_signers: vec![deployer],
        governance_threshold: 1,
        timelock_delay_ms: DEFAULT_TIMELOCK_DELAY,
    };
    let contract = AgentSkillRegistry::deploy(&env, init_args);
    let alpha = env.get_account(1); // provider
    let beta = env.get_account(2); // requester
    (env, contract, alpha, beta)
}

fn dispute_bond_for(price: u64) -> U512 {
    let bond = U512::from(10_000u32) * U512::from(price) / U512::from(10_000u32);
    let min = U512::from(MIN_DISPUTE_BOND_MOTES);
    if bond < min { min } else { bond }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Invariant 1: whichever way `arbitrate` rules, `winner.pending_withdrawals` increases by
    /// exactly `price + 2*bond` and `loser.pending_withdrawals` stays exactly zero — the
    /// contract's own custody purse never leaks or manufactures a single mote across the
    /// dispute path, for ANY valid price and EITHER verdict.
    #[test]
    fn escrow_is_conserved_across_arbitrated_dispute(
        price in 1_000_000u64..10_000_000_000u64,
        provider_at_fault in proptest::bool::ANY,
    ) {
        let (env, mut reg, alpha, beta) = setup();

        env.set_caller(alpha);
        let skill_id = reg.register_skill(
            "prop-search".to_string(),
            "proptest skill".to_string(),
            "mcp://alpha".to_string(),
            U512::from(price),
            0,
            IDENTITY_POLICY_NONE,
        );

        env.set_caller(beta);
        let job_id = reg
            .with_tokens(U512::from(price))
            .create_job(skill_id, Bytes::from(b"proptest-task".to_vec()), 24 * 60 * 60 * 1_000);

        env.set_caller(alpha);
        reg.deliver_result(job_id, Bytes::from(b"proptest-result".to_vec()));

        let bond = dispute_bond_for(price);
        env.set_caller(beta);
        reg.with_tokens(bond).dispute_result(job_id);

        env.set_caller(alpha);
        reg.with_tokens(bond).respond_to_dispute(job_id);

        let deployer = env.get_account(0); // arbiter
        env.set_caller(deployer);
        let verdict = if provider_at_fault { Verdict::ProviderAtFault } else { Verdict::RequesterAtFault };
        reg.arbitrate(job_id, verdict);

        let expected_payout = U512::from(price) + bond + bond;
        let (winner, loser) = if provider_at_fault { (beta, alpha) } else { (alpha, beta) };

        prop_assert_eq!(reg.pending_withdrawals_of(winner), expected_payout);
        prop_assert_eq!(reg.pending_withdrawals_of(loser), U512::zero());
        // Conservation, stated directly: total credited equals total collected (escrow + both
        // bonds), no more, no less — not just "the winner got *something*."
        prop_assert_eq!(
            reg.pending_withdrawals_of(winner) + reg.pending_withdrawals_of(loser),
            expected_payout,
        );
    }

    /// Invariant 2: after any random-length sequence of adjudicated disputes on the same
    /// skill/agent, reputation never leaves [`REP_FLOOR`, `MAX_REPUTATION`] — no saturating-math
    /// bug can push it negative (u32 underflow) or past the documented ceiling.
    #[test]
    fn reputation_stays_within_bounds_over_many_rounds(
        // Each `true` = a round where the arbiter rules ProviderAtFault (slash); `false` =
        // RequesterAtFault (bump). Skewed toward slashing so the floor gets exercised, not just
        // the ceiling — a pure-bump sequence would only ever probe MAX_REPUTATION.
        rounds in proptest::collection::vec(proptest::bool::weighted(0.7), 1..40),
    ) {
        let (env, mut reg, alpha, beta) = setup();

        env.set_caller(alpha);
        let skill_id = reg.register_skill(
            "prop-rep".to_string(),
            "proptest reputation skill".to_string(),
            "mcp://alpha".to_string(),
            U512::from(1_000_000u64),
            0,
            IDENTITY_POLICY_NONE,
        );

        for (i, provider_at_fault) in rounds.iter().enumerate() {
            let task_label = format!("prop-rep-round-{i}");

            env.set_caller(beta);
            let job_id = reg
                .with_tokens(U512::from(1_000_000u64))
                .create_job(skill_id, Bytes::from(task_label.clone().into_bytes()), 24 * 60 * 60 * 1_000);

            env.set_caller(alpha);
            reg.deliver_result(job_id, Bytes::from(format!("{task_label}-result").into_bytes()));

            let bond = dispute_bond_for(1_000_000);
            env.set_caller(beta);
            reg.with_tokens(bond).dispute_result(job_id);
            env.set_caller(alpha);
            reg.with_tokens(bond).respond_to_dispute(job_id);

            let deployer = env.get_account(0);
            env.set_caller(deployer);
            let verdict = if *provider_at_fault { Verdict::ProviderAtFault } else { Verdict::RequesterAtFault };
            reg.arbitrate(job_id, verdict);

            let skill_rep = reg.get_skill(skill_id).reputation_score;
            let agent_rep = reg.agent_reputation(alpha);

            prop_assert!(
                (REP_FLOOR..=MAX_REPUTATION).contains(&skill_rep),
                "round {i}: skill reputation {skill_rep} left [{REP_FLOOR}, {MAX_REPUTATION}]",
            );
            prop_assert!(
                (REP_FLOOR..=MAX_REPUTATION).contains(&agent_rep),
                "round {i}: agent reputation {agent_rep} left [{REP_FLOOR}, {MAX_REPUTATION}]",
            );
        }
    }

    /// Panel-mode mirror of `escrow_is_conserved_across_arbitrated_dispute` — same invariant,
    /// routed through dispute_result_via_panel + cast_panel_vote (3-arbiter panel, 2-of-3)
    /// instead of dispute_result + arbitrate. Fee flows are asserted separately (fee is
    /// additive to the bond math, not a slice of it — audit-design HIGH #1 in practice).
    #[test]
    fn escrow_is_conserved_across_panel_arbitrated_dispute(
        price in 1_000_000u64..10_000_000_000u64,
        provider_at_fault in proptest::bool::ANY,
        panel_fee in 0u64..5_000_000u64,
    ) {
        let (env, mut reg, alpha, beta) = setup();
        let deployer = env.get_account(0);
        let arb1 = env.get_account(3);
        let arb2 = env.get_account(4);
        let arb3 = env.get_account(5);

        env.set_caller(deployer);
        let panel_proposal = reg.propose_set_arbiter_panel(vec![arb1, arb2, arb3], 2);
        env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
        reg.execute_proposal(panel_proposal);
        let fee_proposal = reg.propose_set_panel_arbiter_fee(U512::from(panel_fee));
        env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
        reg.execute_proposal(fee_proposal);

        env.set_caller(alpha);
        let skill_id = reg.register_skill(
            "prop-panel".to_string(), "proptest panel skill".to_string(), "mcp://alpha".to_string(),
            U512::from(price), 0, IDENTITY_POLICY_NONE,
        );
        env.set_caller(beta);
        let job_id = reg.with_tokens(U512::from(price))
            .create_job(skill_id, Bytes::from(b"proptest-panel-task".to_vec()), 24 * 60 * 60 * 1_000);
        env.set_caller(alpha);
        reg.deliver_result(job_id, Bytes::from(b"proptest-panel-result".to_vec()));

        let bond = dispute_bond_for(price);
        let fee = U512::from(panel_fee);
        env.set_caller(beta);
        reg.with_tokens(bond + fee).dispute_result_via_panel(job_id);
        env.set_caller(alpha);
        reg.with_tokens(bond).respond_to_dispute(job_id);

        let verdict = if provider_at_fault { Verdict::ProviderAtFault } else { Verdict::RequesterAtFault };
        env.set_caller(arb1);
        reg.cast_panel_vote(job_id, verdict);
        env.set_caller(arb2);
        reg.cast_panel_vote(job_id, verdict); // 2-of-3 reached, settles

        let expected_bond_payout = U512::from(price) + bond + bond;
        let (winner, loser) = if provider_at_fault { (beta, alpha) } else { (alpha, beta) };

        prop_assert_eq!(reg.pending_withdrawals_of(winner), expected_bond_payout);
        prop_assert_eq!(reg.pending_withdrawals_of(loser), U512::zero());

        // Fee conservation, checked separately from bond conservation: exactly `fee` total
        // credited to arbiters, split across the 2 who voted, arb3 gets zero.
        let arb_total = reg.pending_withdrawals_of(arb1) + reg.pending_withdrawals_of(arb2);
        prop_assert_eq!(arb_total, fee);
        prop_assert_eq!(reg.pending_withdrawals_of(arb3), U512::zero());

        // Global conservation: bond-path payout + fee-path payout together equal exactly what
        // was attached across all 3 payable calls (escrow + 2×bond + fee), no more, no less.
        let total_credited = reg.pending_withdrawals_of(winner)
            + reg.pending_withdrawals_of(loser)
            + reg.pending_withdrawals_of(arb1)
            + reg.pending_withdrawals_of(arb2)
            + reg.pending_withdrawals_of(arb3);
        prop_assert_eq!(total_credited, expected_bond_payout + fee);
    }

    /// Panel-mode mirror of `reputation_stays_within_bounds_over_many_rounds` — same invariant,
    /// routed through the panel path over a random-length sequence of rounds.
    #[test]
    fn reputation_stays_within_bounds_over_many_panel_rounds(
        rounds in proptest::collection::vec(proptest::bool::weighted(0.7), 1..40),
    ) {
        let (env, mut reg, alpha, beta) = setup();
        let deployer = env.get_account(0);
        let arb1 = env.get_account(3);
        let arb2 = env.get_account(4);
        let arb3 = env.get_account(5);
        env.set_caller(deployer);
        let panel_proposal = reg.propose_set_arbiter_panel(vec![arb1, arb2, arb3], 2);
        env.advance_block_time(DEFAULT_TIMELOCK_DELAY + 1);
        reg.execute_proposal(panel_proposal);

        env.set_caller(alpha);
        let skill_id = reg.register_skill(
            "prop-panel-rep".to_string(), "proptest panel reputation skill".to_string(),
            "mcp://alpha".to_string(), U512::from(1_000_000u64), 0, IDENTITY_POLICY_NONE,
        );

        for (i, provider_at_fault) in rounds.iter().enumerate() {
            let task_label = format!("prop-panel-rep-round-{i}");

            env.set_caller(beta);
            let job_id = reg.with_tokens(U512::from(1_000_000u64))
                .create_job(skill_id, Bytes::from(task_label.clone().into_bytes()), 24 * 60 * 60 * 1_000);
            env.set_caller(alpha);
            reg.deliver_result(job_id, Bytes::from(format!("{task_label}-result").into_bytes()));

            let bond = dispute_bond_for(1_000_000);
            env.set_caller(beta);
            reg.with_tokens(bond).dispute_result_via_panel(job_id);
            env.set_caller(alpha);
            reg.with_tokens(bond).respond_to_dispute(job_id);

            let verdict = if *provider_at_fault { Verdict::ProviderAtFault } else { Verdict::RequesterAtFault };
            env.set_caller(arb1);
            reg.cast_panel_vote(job_id, verdict);
            env.set_caller(arb2);
            reg.cast_panel_vote(job_id, verdict);

            let skill_rep = reg.get_skill(skill_id).reputation_score;
            let agent_rep = reg.agent_reputation(alpha);

            prop_assert!(
                (REP_FLOOR..=MAX_REPUTATION).contains(&skill_rep),
                "panel round {i}: skill reputation {skill_rep} left [{REP_FLOOR}, {MAX_REPUTATION}]",
            );
            prop_assert!(
                (REP_FLOOR..=MAX_REPUTATION).contains(&agent_rep),
                "panel round {i}: agent reputation {agent_rep} left [{REP_FLOOR}, {MAX_REPUTATION}]",
            );
        }
    }
}
