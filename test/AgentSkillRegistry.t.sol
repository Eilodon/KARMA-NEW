// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentSkillRegistry} from "../contracts/AgentSkillRegistry.sol";
import {KarmaTimelock} from "../contracts/KarmaTimelock.sol";

contract AgentSkillRegistryTest is Test {
    AgentSkillRegistry internal reg;

    address internal alpha = address(0xA1); // provider (skill owner)
    address internal beta = address(0xB2); // requester
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant DEADLINE_SECS = 1 days;

    bytes32 internal constant TASK_HASH = keccak256("task-params");
    bytes32 internal constant RESULT_HASH = keccak256("result-data");

    // Mirror of the contract event so tests can vm.expectEmit it (Tier-2 bond).
    event BondUpdated(address indexed agent, uint256 bondedAmount, uint256 seedEligible);

    function setUp() public {
        reg = new AgentSkillRegistry(3 days, address(this)); // DEFAULT_REVIEW_WINDOW, owner = test contract
        vm.deal(beta, 10 ether);
        vm.deal(alpha, 10 ether);
    }

    function _registerSkill() internal returns (uint256 skillId) {
        vm.prank(alpha);
        skillId = reg.registerSkill("search", "paid discover_skills", "mcp://alpha", PRICE, 0, 0);
    }

    function _registerSkillGated(uint256 minRep) internal returns (uint256 skillId) {
        vm.prank(alpha);
        skillId = reg.registerSkill("premium", "institutional", "mcp://alpha", PRICE, minRep, 0);
    }

    function _openJob(uint256 skillId) internal returns (uint256 jobId) {
        vm.prank(beta);
        jobId = reg.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);
    }

    // ── Happy path ─────────────────────────────────────────────
    function test_HappyPath_EscrowFlowAndReputation() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);

        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.prank(beta);
        reg.confirmCompletion(jobId);

        uint256 balBefore = alpha.balance;
        vm.prank(alpha);
        reg.withdraw();
        assertEq(alpha.balance, balBefore + PRICE, "provider paid escrow");

        (, , , , , uint256 reputation, uint256 invocations, , , , ) = reg.skills(skillId);
        assertEq(reputation, 55, "skill reputation +5 from base 50");
        assertEq(invocations, 1, "one invocation");

        // Arm's-length completion bumps both agents' on-chain reputation (PD-005).
        assertEq(reg.agentReputation(alpha), 55, "provider agent rep +5");
        assertEq(reg.agentReputation(beta), 55, "requester agent rep +5");
    }

    function test_CreateJob_RequiresExactEscrow() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("escrow must equal price + evaluator fee"));
        reg.createJob{value: PRICE - 1}(skillId, TASK_HASH, DEADLINE_SECS);
    }

    // ── Open-state refund (FM1: must remain intact after deadline is repurposed) ──
    function test_Refund_AfterDeadline() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);

        vm.warp(block.timestamp + DEADLINE_SECS + 1);
        vm.prank(beta);
        reg.claimRefund(jobId);

        uint256 balBefore = beta.balance;
        vm.prank(beta);
        reg.withdraw();
        assertEq(beta.balance, balBefore + PRICE, "requester refunded escrow");
    }

    function test_Refund_AtExactDeadline_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        uint256 created = block.timestamp;

        vm.warp(created + DEADLINE_SECS); // == deadline, not strictly after
        vm.prank(beta);
        vm.expectRevert(bytes("before deadline"));
        reg.claimRefund(jobId);
    }

    function test_Refund_AfterDelivered_Reverts() public {
        // Once delivered, claimRefund is closed (status != Open) — resolution moves to dispute/claim.
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + DEADLINE_SECS + 1);
        vm.prank(beta);
        vm.expectRevert(bytes("not refundable"));
        reg.claimRefund(jobId);
    }

    // ── Claim 3: delivered-job resolution (no permanent fund lock) ──
    function test_Delivered_GhostRequester_ProviderClaimsAfterWindow() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 1);
        vm.prank(alpha);
        reg.claimAfterReview(jobId);

        uint256 balBefore = alpha.balance;
        vm.prank(alpha);
        reg.withdraw();
        assertEq(alpha.balance, balBefore + PRICE, "provider paid after review window");
        assertEq(reg.agentReputation(alpha), 55, "claimAfterReview bumps provider rep (arm's-length)");
    }

    function test_Delivered_JunkResult_RequesterDisputesWithinWindow() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        // P1-A: bonded dispute — requester posts 1× escrow bond
        uint256 bond = PRICE;
        vm.prank(beta);
        reg.disputeResult{value: bond}(jobId);

        // Provider concedes → escrow + bond refunded, provider rep slashed
        vm.prank(alpha);
        reg.concedeDispute(jobId);

        uint256 balBefore = beta.balance;
        vm.prank(beta);
        reg.withdraw();
        assertEq(beta.balance, balBefore + PRICE + bond, "requester refunded escrow + bond on concede");
        assertEq(reg.agentReputation(alpha), 40, "provider rep slashed on concede");
    }

    function test_Dispute_AfterWindow_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 1);
        vm.prank(beta);
        vm.expectRevert(bytes("review window closed"));
        reg.disputeResult{value: PRICE}(jobId);
    }

    function test_Claim_AtExactWindow_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);
        uint256 delivered = block.timestamp;

        vm.warp(delivered + reg.REVIEW_WINDOW()); // == deadline, not strictly after
        vm.prank(alpha);
        vm.expectRevert(bytes("review window open"));
        reg.claimAfterReview(jobId);
    }

    function test_ConfirmCompletion_StillWorksAfterWindow() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 100);
        vm.prank(beta);
        reg.confirmCompletion(jobId); // requester may always confirm while Delivered
        assertEq(reg.agentReputation(alpha), 55, "late confirm still settles");
    }

    // ── State machine guards ───────────────────────────────────
    function test_DoubleComplete_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);
        vm.prank(beta);
        reg.confirmCompletion(jobId);

        vm.prank(beta);
        vm.expectRevert(bytes("job not delivered"));
        reg.confirmCompletion(jobId);
    }

    // ── On-chain Trust Gate (PD-005) ───────────────────────────
    function test_Gate_BootstrapBase50() public view {
        assertEq(reg.agentReputation(address(0x1234)), 50, "fresh agent bootstraps to BASE");
    }

    function test_Gate_BlocksUnderRepRequester() public {
        uint256 skillId = _registerSkillGated(55);
        vm.prank(beta); // fresh requester, rep 50
        vm.expectRevert(bytes("insufficient reputation"));
        reg.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);
    }

    function test_Gate_AllowsAtOrAboveRep() public {
        // beta earns rep 55 by completing one arm's-length ungated job.
        uint256 ungated = _registerSkill();
        uint256 j1 = _openJob(ungated);
        vm.prank(alpha);
        reg.deliverResult(j1, RESULT_HASH);
        vm.prank(beta);
        reg.confirmCompletion(j1);
        assertEq(reg.agentReputation(beta), 55, "beta earned rep");

        // now beta (rep 55) can invoke a gated skill requiring 55.
        uint256 gated = _registerSkillGated(55);
        vm.prank(beta);
        uint256 j2 = reg.createJob{value: PRICE}(gated, keccak256("task-2"), DEADLINE_SECS);
        assertGt(j2, 0, "gated job created at threshold");
    }

    function test_SetMinReputation_OwnerOnly() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("not skill owner"));
        reg.setMinReputation(skillId, 70);

        vm.prank(alpha);
        reg.setMinReputation(skillId, 70);
        (, , , , , , , , , uint256 minRep, ) = reg.skills(skillId);
        assertEq(minRep, 70, "owner updated threshold");
    }

    // ── P0: on-chain identityPolicy (declarative; enforced server-side) ──
    function test_IdentityPolicy_DefaultsToNoneAndOwnerCanSet() public {
        uint256 skillId = _registerSkill(); // registered with policy 0
        (, , , , , , , , , , uint8 pol) = reg.skills(skillId);
        assertEq(pol, 0, "defaults to NONE");

        vm.prank(alpha);
        reg.setIdentityPolicy(skillId, 1);
        (, , , , , , , , , , uint8 pol2) = reg.skills(skillId);
        assertEq(pol2, 1, "owner set policy to T3N_VERIFIED");
    }

    function test_SetIdentityPolicy_OwnerOnly() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("not skill owner"));
        reg.setIdentityPolicy(skillId, 1);
    }

    function test_RegisterSkill_PersistsIdentityPolicy() public {
        vm.prank(alpha);
        uint256 skillId = reg.registerSkill("s", "d", "mcp://a", PRICE, 0, 2);
        (, , , , , , , , , , uint8 pol) = reg.skills(skillId);
        assertEq(pol, 2, "registered with T3N_VERIFIED_FRESH policy");
    }

    // ── Abductive-2 + Tier-0: self-deal must not farm ANY trust signal (both completion paths) ──
    function test_SelfDeal_NoRepFarm() public {
        vm.prank(alpha);
        uint256 skillId = reg.registerSkill("self", "self", "mcp://alpha", PRICE, 0, 0);

        // Path 1: confirmCompletion on a self-job (alpha requester == provider).
        vm.prank(alpha);
        uint256 j1 = reg.createJob{value: PRICE}(skillId, keccak256("self-1"), DEADLINE_SECS);
        vm.prank(alpha);
        reg.deliverResult(j1, RESULT_HASH);
        vm.prank(alpha);
        reg.confirmCompletion(j1);
        assertEq(reg.agentReputation(alpha), 50, "self-deal confirm grants no agent rep");

        // Path 2: claimAfterReview on a self-job.
        vm.prank(alpha);
        uint256 j2 = reg.createJob{value: PRICE}(skillId, keccak256("self-2"), DEADLINE_SECS);
        vm.prank(alpha);
        reg.deliverResult(j2, RESULT_HASH);
        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 1);
        vm.prank(alpha);
        reg.claimAfterReview(j2);
        assertEq(reg.agentReputation(alpha), 50, "self-deal claim grants no agent rep");

        // Tier-0: neither self-deal path may inflate the skill's discovery signals. reputationScore
        // drives the off-chain BM25 boost (1.0..2.0x); totalInvocations is shown as social proof.
        // Both stay at base despite two completed self-jobs — escrow settled, no trust manufactured.
        (, , , , , uint256 reputation, uint256 invocations, , , , ) = reg.skills(skillId);
        assertEq(reputation, 50, "self-deal must not inflate skill reputation (BM25 boost input)");
        assertEq(invocations, 0, "self-deal must not inflate invocation count");
    }

    // ── Tier-0 regression: single-wallet discovery-rank pump is neutralized ──
    // Pre-fix, reputationScore bumped unconditionally, so ONE wallet could self-deal price-0 jobs on
    // its own skill, driving reputationScore -> 100 (BM25 boost 2.0x) to drown real skills at zero
    // capital. Now self-deals earn nothing, so the rank cannot be pumped from a closed Sybil set.
    function test_SelfDeal_NoDiscoveryRankPump() public {
        vm.prank(alpha);
        uint256 skillId = reg.registerSkill("pump", "pump", "mcp://alpha", 0, 0, 0); // price 0 = zero capital

        for (uint256 i = 0; i < 5; i++) {
            vm.prank(alpha);
            uint256 jobId = reg.createJob{value: 0}(skillId, keccak256(abi.encode("pump", i)), DEADLINE_SECS);
            vm.prank(alpha);
            reg.deliverResult(jobId, RESULT_HASH);
            vm.prank(alpha);
            reg.confirmCompletion(jobId);
        }

        (, , , , , uint256 reputation, uint256 invocations, , , , ) = reg.skills(skillId);
        assertEq(reputation, 50, "5 self-deals cannot raise skill reputation above base");
        assertEq(invocations, 0, "self-deals never count as invocations");
    }

    // ── PD-003: O(1) dedup index ───────────────────────────────
    function test_JobByTaskHash_DedupIndex() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        assertEq(reg.jobByTaskHash(TASK_HASH), jobId, "taskHash maps to jobId");
        assertEq(reg.jobByTaskHash(keccak256("never")), 0, "unknown taskHash maps to 0");
    }

    // ── Fix 5: durable on-chain exactly-once (no double-escrow on lost-ack retry) ──
    // The app derives a deterministic taskHash from (requester, skillId, idempotencyNonce) and
    // does a check-before-write, but that check cannot see a tx still in the mempool. The contract
    // is the source of truth: a second escrow for an already-used taskHash MUST revert, so a retry
    // that re-broadcasts before the first tx mines cannot create a second escrowed job.
    function test_CreateJob_DuplicateTaskHash_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId); // first job with TASK_HASH
        assertEq(reg.jobByTaskHash(TASK_HASH), jobId, "first job indexed by taskHash");

        vm.prank(beta);
        vm.expectRevert(bytes("duplicate taskHash"));
        reg.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);

        // Escrow taken exactly once — the registry holds a single PRICE, not two.
        assertEq(address(reg).balance, PRICE, "no double escrow");
        assertEq(reg.jobByTaskHash(TASK_HASH), jobId, "dedup index still points at the first job");
    }

    // ── R1/ADR-1: review window is deploy-time config (immutable), bounded ──
    function test_Constructor_DefaultWindowMatchesConstant() public view {
        assertEq(reg.REVIEW_WINDOW(), reg.DEFAULT_REVIEW_WINDOW(), "setUp deploys the default window");
        assertEq(reg.DEFAULT_REVIEW_WINDOW(), 3 days, "default review window is 3 days");
    }

    function test_Constructor_SetsConfigurableImmutableWindow() public {
        AgentSkillRegistry r = new AgentSkillRegistry(7 days, address(this));
        assertEq(r.REVIEW_WINDOW(), 7 days, "review window taken from the constructor arg");
    }

    function test_Constructor_RejectsBelowMin() public {
        uint256 belowMin = reg.MIN_REVIEW_WINDOW() - 1; // read view BEFORE expectRevert latches
        vm.expectRevert(bytes("bad review window"));
        new AgentSkillRegistry(belowMin, address(this));
    }

    function test_Constructor_RejectsAboveMax() public {
        uint256 aboveMax = reg.MAX_REVIEW_WINDOW() + 1; // read view BEFORE expectRevert latches
        vm.expectRevert(bytes("bad review window"));
        new AgentSkillRegistry(aboveMax, address(this));
    }

    function test_Constructor_ConfiguredWindowDrivesDisputeBoundary() public {
        AgentSkillRegistry r = new AgentSkillRegistry(1 hours, address(this));
        vm.prank(alpha);
        uint256 skillId = r.registerSkill("s", "d", "mcp://a", PRICE, 0, 0);
        vm.prank(beta);
        uint256 jobId = r.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);
        vm.prank(alpha);
        r.deliverResult(jobId, RESULT_HASH);
        // dispute reverts just past the configured (short) window — boundary tracks REVIEW_WINDOW
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(beta);
        vm.expectRevert(bytes("review window closed"));
        r.disputeResult{value: PRICE}(jobId);
    }

    // ── Reentrancy (P2.5 HIGH) ─────────────────────────────────
    function test_Reentrancy_WithdrawBlocked() public {
        ReentrantProvider attacker = new ReentrantProvider(reg);
        vm.deal(beta, 10 ether);

        uint256 skillId = attacker.register(PRICE);
        vm.prank(beta);
        uint256 jobId = reg.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);
        attacker.deliver(jobId, RESULT_HASH);
        vm.prank(beta);
        reg.confirmCompletion(jobId);

        attacker.attack(); // its receive() re-enters withdraw()

        // Attacker must receive escrow exactly once; registry not drained.
        assertEq(address(attacker).balance, PRICE, "attacker paid exactly once");
        assertEq(address(reg).balance, 0, "registry fully settled, not drained");
    }

    // ── Tier-2 Sybil-resistance bond (PD-007) ──────────────────
    function test_Bond_DepositSeedsAndIsPerAgent() public {
        vm.expectEmit(true, false, false, true);
        emit BondUpdated(alpha, 2 ether, 2 ether);
        vm.prank(alpha);
        reg.depositBond{value: 2 ether}();

        assertEq(reg.bondedAmount(alpha), 2 ether, "bond locked");
        assertEq(reg.seedEligibleBond(alpha), 2 ether, "active bond seeds");
        assertEq(reg.bondedAmount(beta), 0, "bond is per-agent: alpha's does not seed beta");
        assertEq(reg.seedEligibleBond(beta), 0, "no bond means no seed (open, no paywall)");
    }

    function test_Bond_DepositZeroReverts() public {
        vm.prank(alpha);
        vm.expectRevert(bytes("no bond"));
        reg.depositBond{value: 0}();
    }

    function test_Bond_RequestUnlockStopsSeedingButKeepsCapitalLocked() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        // Flash-seed defense: seed weight drops to 0 immediately, but the capital stays locked.
        assertEq(reg.seedEligibleBond(alpha), 0, "cooling-down bond does not seed");
        assertEq(reg.bondedAmount(alpha), 1 ether, "capital still locked across the cooldown");
    }

    function test_Bond_WithdrawBeforeCooldownReverts() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        vm.warp(block.timestamp + reg.BOND_UNLOCK_COOLDOWN() - 1);
        vm.prank(alpha);
        vm.expectRevert(bytes("cooldown active"));
        reg.withdrawBond();
    }

    function test_Bond_WithdrawWithoutRequestReverts() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        vm.expectRevert(bytes("not unlocking"));
        reg.withdrawBond();
    }

    function test_Bond_WithdrawAfterCooldownReturnsCapitalViaPullPayment() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        vm.warp(block.timestamp + reg.BOND_UNLOCK_COOLDOWN());
        vm.prank(alpha);
        reg.withdrawBond();
        assertEq(reg.bondedAmount(alpha), 0, "bond cleared");
        assertEq(reg.pendingWithdrawals(alpha), 1 ether, "credited to the audited pull-payment ledger");

        uint256 balBefore = alpha.balance;
        vm.prank(alpha);
        reg.withdraw();
        assertEq(alpha.balance, balBefore + 1 ether, "bond returned to the agent");
    }

    function test_Bond_CancelUnlockReactivatesSeed() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        assertEq(reg.seedEligibleBond(alpha), 0, "not seeding while cooling");
        vm.prank(alpha);
        reg.cancelBondUnlock();
        assertEq(reg.seedEligibleBond(alpha), 1 ether, "seeding again after cancel");
    }

    function test_Bond_DepositDuringCooldownReactivatesAndAdds() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        assertEq(reg.bondedAmount(alpha), 2 ether, "added to the existing bond");
        assertEq(reg.seedEligibleBond(alpha), 2 ether, "re-committed: seeds the full amount");
        assertEq(reg.bondUnlockAt(alpha), 0, "pending unlock cleared by re-deposit");
    }

    function test_Bond_RequestUnlockWithoutBondReverts() public {
        vm.prank(beta);
        vm.expectRevert(bytes("no bond"));
        reg.requestBondUnlock();
    }

    // ══════════════════════════════════════════════════════════════
    // ── P0-A: Evaluator Agent ─────────────────────────────────────
    // ══════════════════════════════════════════════════════════════

    address internal evaluator = address(0xE3); // neutral evaluator
    uint256 internal constant EVAL_FEE = 0.1 ether;

    event JobEvaluated(uint256 indexed jobId, address indexed evaluator, bool approved, uint256 evaluatorPayout);
    event ResultDisputed(uint256 indexed jobId, address indexed requester, uint256 amount);
    event JobCompleted(uint256 indexed jobId, address indexed provider, uint256 payout, uint256 newReputation);

    function _openJobWithEvaluator(uint256 skillId) internal returns (uint256 jobId) {
        vm.prank(beta);
        jobId = reg.createJobWithEvaluator{value: PRICE + EVAL_FEE}(
            skillId, keccak256("eval-task"), DEADLINE_SECS, evaluator, EVAL_FEE
        );
    }

    // ── createJobWithEvaluator: happy path ────────────────────────
    function test_Evaluator_CreateJobWithEvaluator_HappyPath() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);

        (address ev, uint256 fee) = reg.getJobEvaluator(jobId);
        assertEq(ev, evaluator, "evaluator stored");
        assertEq(fee, EVAL_FEE, "evaluator fee stored");
        assertEq(address(reg).balance, PRICE + EVAL_FEE, "full escrow held");
    }

    // ── createJobWithEvaluator: guards ────────────────────────────
    function test_Evaluator_CreateJob_EvaluatorCannotBeZero() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("evaluator required"));
        reg.createJobWithEvaluator{value: PRICE + EVAL_FEE}(
            skillId, keccak256("z"), DEADLINE_SECS, address(0), EVAL_FEE
        );
    }

    function test_Evaluator_CreateJob_EvaluatorCannotBeRequester() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("evaluator cannot be requester"));
        reg.createJobWithEvaluator{value: PRICE + EVAL_FEE}(
            skillId, keccak256("r"), DEADLINE_SECS, beta, EVAL_FEE
        );
    }

    function test_Evaluator_CreateJob_EvaluatorCannotBeProvider() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("evaluator cannot be provider"));
        reg.createJobWithEvaluator{value: PRICE + EVAL_FEE}(
            skillId, keccak256("p"), DEADLINE_SECS, alpha, EVAL_FEE
        );
    }

    function test_Evaluator_CreateJob_WrongEscrowAmount() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("escrow must equal price + evaluator fee"));
        reg.createJobWithEvaluator{value: PRICE}(
            skillId, keccak256("w"), DEADLINE_SECS, evaluator, EVAL_FEE
        );
    }

    // ── evaluateResult: approved (happy path) ─────────────────────
    function test_Evaluator_Approved_SettlesLikeConfirm() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);

        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.prank(evaluator);
        reg.evaluateResult(jobId, true);

        // Provider gets escrow
        assertEq(reg.pendingWithdrawals(alpha), PRICE, "provider gets escrow");
        // Evaluator gets fee
        assertEq(reg.pendingWithdrawals(evaluator), EVAL_FEE, "evaluator gets fee");
        // Requester gets nothing
        assertEq(reg.pendingWithdrawals(beta), 0, "requester gets nothing on approve");

        // Reputation bumped (arm's-length)
        assertEq(reg.agentReputation(alpha), 55, "provider rep bumped");
        assertEq(reg.agentReputation(beta), 55, "requester rep bumped");
    }

    // ── evaluateResult: rejected ──────────────────────────────────
    function test_Evaluator_Rejected_SettlesLikeDispute() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);

        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.prank(evaluator);
        reg.evaluateResult(jobId, false);

        // Requester gets escrow back
        assertEq(reg.pendingWithdrawals(beta), PRICE, "requester gets escrow refund on reject");
        // Evaluator still gets fee (they did the work)
        assertEq(reg.pendingWithdrawals(evaluator), EVAL_FEE, "evaluator gets fee regardless");
        // Provider gets nothing
        assertEq(reg.pendingWithdrawals(alpha), 0, "provider gets nothing on reject");

        // No reputation bump on dispute
        assertEq(reg.agentReputation(alpha), 50, "no rep for provider on reject");
        assertEq(reg.agentReputation(beta), 50, "no rep for requester on reject");
    }

    // ── evaluateResult: guards ────────────────────────────────────
    function test_Evaluator_OnlyEvaluatorCanCall() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.prank(beta); // requester, not evaluator
        vm.expectRevert(bytes("not evaluator"));
        reg.evaluateResult(jobId, true);

        vm.prank(alpha); // provider, not evaluator
        vm.expectRevert(bytes("not evaluator"));
        reg.evaluateResult(jobId, true);
    }

    function test_Evaluator_RequiresDeliveredStatus() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);

        // Still Open (not Delivered yet)
        vm.prank(evaluator);
        vm.expectRevert(bytes("job not delivered"));
        reg.evaluateResult(jobId, true);
    }

    function test_Evaluator_RevertsAfterReviewWindow() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 1);

        vm.prank(evaluator);
        vm.expectRevert(bytes("review window closed"));
        reg.evaluateResult(jobId, true);
    }

    // ── evaluateResult: events ────────────────────────────────────
    function test_Evaluator_EmitsJobEvaluatedOnApprove() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.expectEmit(true, true, false, true);
        emit JobEvaluated(jobId, evaluator, true, EVAL_FEE);
        vm.prank(evaluator);
        reg.evaluateResult(jobId, true);
    }

    function test_Evaluator_EmitsJobEvaluatedAndDisputedOnReject() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.expectEmit(true, true, false, true);
        emit JobEvaluated(jobId, evaluator, false, EVAL_FEE);
        vm.prank(evaluator);
        reg.evaluateResult(jobId, false);
    }

    // ── Fee routing: confirmCompletion returns evaluator fee ───────
    function test_Evaluator_ConfirmCompletion_RefundsEvalFee() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        // Requester acts directly — evaluator didn't evaluate
        vm.prank(beta);
        reg.confirmCompletion(jobId);

        assertEq(reg.pendingWithdrawals(alpha), PRICE, "provider gets escrow");
        assertEq(reg.pendingWithdrawals(beta), EVAL_FEE, "requester gets eval fee refund");
        assertEq(reg.pendingWithdrawals(evaluator), 0, "evaluator gets nothing (didn't act)");
    }

    // ── Fee routing: claimAfterReview returns evaluator fee ────────
    function test_Evaluator_ClaimAfterReview_RefundsEvalFee() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 1);
        vm.prank(alpha);
        reg.claimAfterReview(jobId);

        assertEq(reg.pendingWithdrawals(alpha), PRICE, "provider gets escrow");
        assertEq(reg.pendingWithdrawals(beta), EVAL_FEE, "requester gets eval fee refund");
        assertEq(reg.pendingWithdrawals(evaluator), 0, "evaluator gets nothing (didn't act)");
    }

    // ── Fee routing: disputeResult with evaluator refunds eval fee immediately ──
    function test_Evaluator_DisputeResult_RefundsEvalFeeImmediately() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        uint256 bond = PRICE;
        vm.prank(beta);
        reg.disputeResult{value: bond}(jobId);

        // Eval fee refunded immediately on dispute; escrow + bond held for resolution
        assertEq(reg.pendingWithdrawals(beta), EVAL_FEE, "eval fee refunded to requester on dispute");
        assertEq(reg.pendingWithdrawals(evaluator), 0, "evaluator gets nothing (didn't act)");

        // After concede: escrow + bond also released
        vm.prank(alpha);
        reg.concedeDispute(jobId);
        assertEq(reg.pendingWithdrawals(beta), EVAL_FEE + PRICE + bond, "full refund after concede");
    }

    // ── Fee routing: claimRefund returns escrow + eval fee ─────────
    function test_Evaluator_ClaimRefund_RefundsEscrowAndEvalFee() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);

        vm.warp(block.timestamp + DEADLINE_SECS + 1);
        vm.prank(beta);
        reg.claimRefund(jobId);

        assertEq(reg.pendingWithdrawals(beta), PRICE + EVAL_FEE, "requester gets full refund");
        assertEq(reg.pendingWithdrawals(evaluator), 0, "evaluator gets nothing (never delivered)");
    }

    // ── Backward compat: createJob still works with zero evaluator ──
    function test_Evaluator_CreateJobLegacy_ZeroEvaluator() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId); // uses createJob (no evaluator)

        (address ev, uint256 fee) = reg.getJobEvaluator(jobId);
        assertEq(ev, address(0), "no evaluator on legacy job");
        assertEq(fee, 0, "no evaluator fee on legacy job");

        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);
        vm.prank(beta);
        reg.confirmCompletion(jobId);

        assertEq(reg.pendingWithdrawals(alpha), PRICE, "legacy flow still works");
    }

    // ── Evaluator cannot evaluate a legacy job (no evaluator set) ──
    function test_Evaluator_CannotEvaluateLegacyJob() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.prank(evaluator);
        vm.expectRevert(bytes("not evaluator"));
        reg.evaluateResult(jobId, true);
    }

    // ── Double-evaluation guard ───────────────────────────────────
    function test_Evaluator_CannotEvaluateTwice() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.prank(evaluator);
        reg.evaluateResult(jobId, true); // first evaluation settles

        vm.prank(evaluator);
        vm.expectRevert(bytes("job not delivered")); // status is now Completed
        reg.evaluateResult(jobId, true);
    }

    // ── Zero evaluator fee: evaluator works for free ──────────────
    function test_Evaluator_ZeroFee_StillWorks() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);

        vm.prank(beta);
        uint256 jobId = reg.createJobWithEvaluator{value: PRICE}(
            skillId, keccak256("free-eval"), DEADLINE_SECS, evaluator, 0
        );

        (address ev, uint256 fee) = reg.getJobEvaluator(jobId);
        assertEq(ev, evaluator, "evaluator set even with zero fee");
        assertEq(fee, 0, "zero fee stored");

        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);
        vm.prank(evaluator);
        reg.evaluateResult(jobId, true);

        assertEq(reg.pendingWithdrawals(alpha), PRICE, "provider gets escrow");
        assertEq(reg.pendingWithdrawals(evaluator), 0, "zero fee = no payout");
    }

    // ── Requester can still confirm even when evaluator is set ────
    function test_Evaluator_RequesterCanStillConfirm() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        // Requester confirms directly, bypassing evaluator
        vm.prank(beta);
        reg.confirmCompletion(jobId);

        assertEq(reg.pendingWithdrawals(alpha), PRICE, "provider paid");
        assertEq(reg.pendingWithdrawals(beta), EVAL_FEE, "eval fee refunded to requester");
    }

    // ── Requester can still dispute even when evaluator is set ────
    function test_Evaluator_RequesterCanStillDispute() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        uint256 bond = PRICE;
        vm.prank(beta);
        reg.disputeResult{value: bond}(jobId);

        // Eval fee refunded immediately; escrow + bond held until resolution
        assertEq(reg.pendingWithdrawals(beta), EVAL_FEE, "eval fee refunded on bonded dispute");

        vm.prank(alpha);
        reg.concedeDispute(jobId);
        assertEq(reg.pendingWithdrawals(beta), EVAL_FEE + PRICE + bond, "full refund after concede");
    }

    // ── Full withdrawal flow with evaluator ───────────────────────
    function test_Evaluator_FullWithdrawalFlow() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);

        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);
        vm.prank(evaluator);
        reg.evaluateResult(jobId, true);

        // Provider withdraws escrow
        uint256 alphaBefore = alpha.balance;
        vm.prank(alpha);
        reg.withdraw();
        assertEq(alpha.balance, alphaBefore + PRICE, "provider withdrew escrow");

        // Evaluator withdraws fee
        uint256 evalBefore = evaluator.balance;
        vm.prank(evaluator);
        reg.withdraw();
        assertEq(evaluator.balance, evalBefore + EVAL_FEE, "evaluator withdrew fee");

        // Registry fully settled
        assertEq(address(reg).balance, 0, "registry fully settled");
    }
    // ══════════════════════════════════════════════════════════════
    // ── P0-B: Admin Backdoor → Multisig + Timelock ────────────────
    // ══════════════════════════════════════════════════════════════

    event CrossChainRepUpdated(address indexed agent, uint256 score, string sourceChain);

    // ── Cross-chain rep: owner-gated ──────────────────────────────

    function test_CrossChainRep_DefaultsToZero() public view {
        assertEq(reg.crossChainRep(address(0x1234)), 0, "fresh agent cross-chain rep is 0");
    }

    function test_CrossChainRep_OwnerCanSet() public {
        reg.setCrossChainRep(alpha, 85, "stellar");
        assertEq(reg.crossChainRep(alpha), 85, "cross-chain rep set");
    }

    function test_CrossChainRep_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit CrossChainRepUpdated(alpha, 85, "stellar");
        reg.setCrossChainRep(alpha, 85, "stellar");
    }

    function test_CrossChainRep_OwnerCanOverwrite() public {
        reg.setCrossChainRep(alpha, 70, "stellar");
        assertEq(reg.crossChainRep(alpha), 70);
        reg.setCrossChainRep(alpha, 95, "stellar");
        assertEq(reg.crossChainRep(alpha), 95, "overwritten");
    }

    function test_CrossChainRep_RejectsNonOwner() public {
        vm.prank(beta);
        vm.expectRevert();
        reg.setCrossChainRep(alpha, 80, "stellar");
    }

    function test_CrossChainRep_RejectsScoreOverMax() public {
        vm.expectRevert(bytes("bad threshold"));
        reg.setCrossChainRep(alpha, 101, "stellar");
    }

    // ── Ownable2Step: two-step ownership transfer ────────────────

    function test_Ownership_InitialOwner() public view {
        assertEq(reg.owner(), address(this), "test contract is initial owner");
    }

    function test_Ownership_TransferTwoStep() public {
        reg.transferOwnership(alpha);
        assertEq(reg.owner(), address(this), "still old owner until accepted");
        assertEq(reg.pendingOwner(), alpha, "pending owner set");

        vm.prank(alpha);
        reg.acceptOwnership();
        assertEq(reg.owner(), alpha, "alpha is now owner");
        assertEq(reg.pendingOwner(), address(0), "pending cleared");
    }

    function test_Ownership_OnlyPendingCanAccept() public {
        reg.transferOwnership(alpha);
        vm.prank(beta);
        vm.expectRevert();
        reg.acceptOwnership();
    }

    function test_Ownership_OnlyOwnerCanTransfer() public {
        vm.prank(beta);
        vm.expectRevert();
        reg.transferOwnership(beta);
    }

    function test_Ownership_NewOwnerCanSetCrossChainRep() public {
        reg.transferOwnership(alpha);
        vm.prank(alpha);
        reg.acceptOwnership();

        vm.prank(alpha);
        reg.setCrossChainRep(beta, 75, "casper");
        assertEq(reg.crossChainRep(beta), 75, "new owner can set cross-chain rep");

        // Old owner (test contract) can no longer set
        vm.expectRevert();
        reg.setCrossChainRep(beta, 50, "casper");
    }

    // ── KarmaTimelock integration ────────────────────────────────

    function test_Timelock_ScheduleAndExecuteCrossChainRep() public {
        // Deploy timelock with test contract as proposer, anyone as executor
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(0); // anyone can execute
        KarmaTimelock timelock = new KarmaTimelock(proposers, executors);

        // Deploy registry with timelock as owner
        AgentSkillRegistry timelocked = new AgentSkillRegistry(3 days, address(timelock));

        // Schedule the setCrossChainRep call through the timelock
        bytes memory data = abi.encodeCall(timelocked.setCrossChainRep, (alpha, 90, "soroban"));
        bytes32 salt = keccak256("karma-cross-chain-rep-1");

        timelock.schedule(address(timelocked), 0, data, bytes32(0), salt, timelock.KARMA_MIN_DELAY());

        // Cannot execute before the delay
        vm.expectRevert();
        timelock.execute(address(timelocked), 0, data, bytes32(0), salt);

        // Warp past 48-hour delay and execute
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(timelocked), 0, data, bytes32(0), salt);

        assertEq(timelocked.crossChainRep(alpha), 90, "cross-chain rep set via timelock");
    }

    function test_Timelock_DirectCallBlockedWhenOwnerIsTimelock() public {
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        KarmaTimelock timelock = new KarmaTimelock(proposers, executors);

        AgentSkillRegistry timelocked = new AgentSkillRegistry(3 days, address(timelock));

        // Direct call (bypassing timelock) must revert — caller is not the owner (timelock is)
        vm.expectRevert();
        timelocked.setCrossChainRep(alpha, 90, "soroban");
    }

    function test_Timelock_MinDelayIs48Hours() public {
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        KarmaTimelock timelock = new KarmaTimelock(proposers, executors);

        assertEq(timelock.getMinDelay(), 48 hours, "KARMA_MIN_DELAY is 48 hours");
    }

    // ══════════════════════════════════════════════════════════════
    // ── P1-A: Symmetric Dispute Bond ──────────────────────────────
    // ══════════════════════════════════════════════════════════════

    address internal arbAddr = address(0xAB); // dedicated arbiter

    event DisputeBondPosted(uint256 indexed jobId, address indexed requester, uint256 bond);
    event DisputeResponsePosted(uint256 indexed jobId, address indexed provider, uint256 bond);
    event DisputeConceded(uint256 indexed jobId, address indexed provider);
    event DisputeArbitrated(uint256 indexed jobId, uint8 verdict, address indexed arbiter);
    event ArbiterUpdated(address indexed oldArbiter, address indexed newArbiter);
    event DisputeBondBpsUpdated(uint256 oldBps, uint256 newBps);

    function _deliverAndDispute(uint256 jobId) internal returns (uint256 bond) {
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);
        bond = PRICE; // default 10_000 bps = 1× escrow
        vm.prank(beta);
        reg.disputeResult{value: bond}(jobId);
    }

    // ── Full flow: ProviderAtFault ────────────────────────────────
    function test_BondedDispute_ProviderAtFault_FullFlow() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        uint256 bond = _deliverAndDispute(jobId);

        // Provider responds (matches bond)
        vm.prank(alpha);
        reg.respondToDispute{value: bond}(jobId);

        // Arbiter rules ProviderAtFault
        reg.arbitrate(jobId, AgentSkillRegistry.Verdict.ProviderAtFault);

        // Requester gets: escrow + own bond + provider's forfeited bond
        assertEq(reg.pendingWithdrawals(beta), PRICE + bond + bond, "requester gets escrow + both bonds");
        assertEq(reg.pendingWithdrawals(alpha), 0, "provider gets nothing");

        // Rep slashed
        assertEq(reg.agentReputation(alpha), 40, "provider agent rep slashed");
        (, , , , , uint256 skillRep, , , , , ) = reg.skills(skillId);
        assertEq(skillRep, 40, "skill rep slashed");
    }

    // ── Full flow: RequesterAtFault (frivolous dispute) ───────────
    function test_BondedDispute_RequesterAtFault_FullFlow() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        uint256 bond = _deliverAndDispute(jobId);

        vm.prank(alpha);
        reg.respondToDispute{value: bond}(jobId);

        reg.arbitrate(jobId, AgentSkillRegistry.Verdict.RequesterAtFault);

        // Provider gets: escrow + own bond + requester's forfeited bond
        assertEq(reg.pendingWithdrawals(alpha), PRICE + bond + bond, "provider gets escrow + both bonds");
        assertEq(reg.pendingWithdrawals(beta), 0, "requester gets nothing");

        // Provider rep bumped (good delivery), requester not rewarded
        assertEq(reg.agentReputation(alpha), 55, "provider rep bumped on frivolous dispute");
        (, , , , , uint256 skillRep, uint256 inv, , , , ) = reg.skills(skillId);
        assertEq(skillRep, 55, "skill rep bumped");
        assertEq(inv, 1, "invocation counted");
    }

    // ── Provider concedes ────────────────────────────────────────
    function test_BondedDispute_ProviderConcedes() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        uint256 bond = _deliverAndDispute(jobId);

        vm.prank(alpha);
        reg.concedeDispute(jobId);

        assertEq(reg.pendingWithdrawals(beta), PRICE + bond, "requester gets escrow + bond");
        assertEq(reg.agentReputation(alpha), 40, "provider rep slashed on concede");
        (, , , , , uint256 skillRep, , , , , ) = reg.skills(skillId);
        assertEq(skillRep, 40, "skill rep slashed on concede");
    }

    // ── Default concede (unresponsive provider) ──────────────────
    function test_BondedDispute_DefaultConcede() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        uint256 bond = _deliverAndDispute(jobId);

        vm.warp(block.timestamp + reg.RESPONSE_WINDOW() + 1);
        reg.resolveDefaultConcede(jobId); // anyone can call

        assertEq(reg.pendingWithdrawals(beta), PRICE + bond, "requester gets escrow + bond");
        assertEq(reg.agentReputation(alpha), 40, "provider rep slashed on default concede");
    }

    // ── Wrong bond amount reverts ────────────────────────────────
    function test_BondedDispute_WrongBondAmount_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.prank(beta);
        vm.expectRevert(bytes("wrong dispute bond"));
        reg.disputeResult{value: PRICE - 1}(jobId);

        vm.prank(beta);
        vm.expectRevert(bytes("wrong dispute bond"));
        reg.disputeResult{value: PRICE + 1}(jobId);
    }

    // ── Zero-escrow skill uses MIN_DISPUTE_BOND ──────────────────
    function test_BondedDispute_ZeroEscrow_MinBondApplies() public {
        vm.prank(alpha);
        uint256 skillId = reg.registerSkill("free", "free", "mcp://a", 0, 0, 0);
        vm.prank(beta);
        uint256 jobId = reg.createJob{value: 0}(skillId, TASK_HASH, DEADLINE_SECS);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        uint256 minBond = reg.MIN_DISPUTE_BOND();
        vm.prank(beta);
        reg.disputeResult{value: minBond}(jobId);

        (uint256 dBond, , ) = reg.disputes(jobId);
        assertEq(dBond, minBond, "min bond applied for zero-escrow skill");
    }

    // ── Response after window reverts ────────────────────────────
    function test_BondedDispute_ResponseAfterWindow_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        _deliverAndDispute(jobId);

        vm.warp(block.timestamp + reg.RESPONSE_WINDOW() + 1);
        vm.prank(alpha);
        vm.expectRevert(bytes("response window closed"));
        reg.respondToDispute{value: PRICE}(jobId);
    }

    // ── Double response reverts ──────────────────────────────────
    function test_BondedDispute_DoubleResponse_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        _deliverAndDispute(jobId);

        vm.prank(alpha);
        reg.respondToDispute{value: PRICE}(jobId);

        vm.prank(alpha);
        vm.expectRevert(bytes("already responded"));
        reg.respondToDispute{value: PRICE}(jobId);
    }

    // ── Concede after response reverts ───────────────────────────
    function test_BondedDispute_ConcedeAfterResponse_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        _deliverAndDispute(jobId);

        vm.prank(alpha);
        reg.respondToDispute{value: PRICE}(jobId);

        vm.prank(alpha);
        vm.expectRevert(bytes("already responded"));
        reg.concedeDispute(jobId);
    }

    // ── Arbitrate before response reverts ─────────────────────────
    function test_BondedDispute_ArbitrateBeforeResponse_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        _deliverAndDispute(jobId);

        vm.expectRevert(bytes("provider has not responded"));
        reg.arbitrate(jobId, AgentSkillRegistry.Verdict.ProviderAtFault);
    }

    // ── Not arbiter reverts ──────────────────────────────────────
    function test_BondedDispute_NotArbiter_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        _deliverAndDispute(jobId);
        vm.prank(alpha);
        reg.respondToDispute{value: PRICE}(jobId);

        vm.prank(beta);
        vm.expectRevert(bytes("not arbiter"));
        reg.arbitrate(jobId, AgentSkillRegistry.Verdict.ProviderAtFault);
    }

    // ── Default concede before window reverts ────────────────────
    function test_BondedDispute_DefaultConcedeBeforeWindow_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        _deliverAndDispute(jobId);

        vm.expectRevert(bytes("response window open"));
        reg.resolveDefaultConcede(jobId);
    }

    // ── Rep slash floors at REP_FLOOR ────────────────────────────
    function test_BondedDispute_RepSlashFloors() public {
        uint256 skillId = _registerSkill();

        // Slash alpha's rep 5 times: 50→40→30→20→10→1 (floor)
        for (uint256 i = 0; i < 5; i++) {
            bytes32 th = keccak256(abi.encode("slash", i));
            vm.prank(beta);
            uint256 jid = reg.createJob{value: PRICE}(skillId, th, DEADLINE_SECS);
            vm.prank(alpha);
            reg.deliverResult(jid, RESULT_HASH);
            vm.prank(beta);
            reg.disputeResult{value: PRICE}(jid);
            vm.prank(alpha);
            reg.concedeDispute(jid);
        }

        assertEq(reg.agentReputation(alpha), reg.REP_FLOOR(), "rep at floor after 5 slashes");
    }

    // ── setDisputeBondBps: owner-only ────────────────────────────
    function test_BondedDispute_SetDisputeBondBps() public {
        assertEq(reg.disputeBondBps(), 10_000, "default 100%");
        reg.setDisputeBondBps(5_000); // 50%
        assertEq(reg.disputeBondBps(), 5_000, "updated to 50%");

        vm.prank(beta);
        vm.expectRevert();
        reg.setDisputeBondBps(1_000);
    }

    // ── setArbiter: owner-only ───────────────────────────────────
    function test_BondedDispute_SetArbiter() public {
        assertEq(reg.arbiter(), address(this), "initial arbiter = owner");
        reg.setArbiter(arbAddr);
        assertEq(reg.arbiter(), arbAddr, "arbiter updated");

        vm.prank(beta);
        vm.expectRevert();
        reg.setArbiter(beta);
    }

    // ── setArbiter rejects zero address ──────────────────────────
    function test_BondedDispute_SetArbiterZero_Reverts() public {
        vm.expectRevert(bytes("zero arbiter"));
        reg.setArbiter(address(0));
    }

    // ── Lower disputeBondBps changes required bond ───────────────
    function test_BondedDispute_LowerBps_ReducesBond() public {
        reg.setDisputeBondBps(5_000); // 50%
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        uint256 halfBond = PRICE / 2;
        vm.prank(beta);
        reg.disputeResult{value: halfBond}(jobId);
        (uint256 dBond, , ) = reg.disputes(jobId);
        assertEq(dBond, halfBond, "bond is 50% of escrow");
    }

    // ── Evaluator rejection is still terminal (not bonded) ───────
    function test_BondedDispute_EvaluatorRejection_StillTerminal() public {
        uint256 skillId = _registerSkill();
        vm.deal(evaluator, 1 ether);
        uint256 jobId = _openJobWithEvaluator(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        // Evaluator rejects — terminal, no bond needed
        vm.prank(evaluator);
        reg.evaluateResult(jobId, false);

        // Requester gets escrow, evaluator gets fee
        assertEq(reg.pendingWithdrawals(beta), PRICE, "requester gets escrow on evaluator reject");
        assertEq(reg.pendingWithdrawals(evaluator), EVAL_FEE, "evaluator gets fee");

        // Dispute data is empty (no bonded dispute)
        (uint256 dBond, , ) = reg.disputes(jobId);
        assertEq(dBond, 0, "no dispute bond on evaluator rejection");

        // Cannot call bonded dispute functions
        vm.prank(alpha);
        vm.expectRevert(bytes("not a bonded dispute"));
        reg.concedeDispute(jobId);
    }

    // ── Full withdrawal flow after arbitration ───────────────────
    function test_BondedDispute_FullWithdrawal_ProviderAtFault() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        uint256 bond = _deliverAndDispute(jobId);
        vm.prank(alpha);
        reg.respondToDispute{value: bond}(jobId);
        reg.arbitrate(jobId, AgentSkillRegistry.Verdict.ProviderAtFault);

        // Registry holds: escrow (1) + requester bond (1) + provider bond (1) = 3 ether
        // Requester withdraws all 3
        uint256 balBefore = beta.balance;
        vm.prank(beta);
        reg.withdraw();
        assertEq(beta.balance, balBefore + PRICE + bond + bond, "requester withdrew all");
        assertEq(address(reg).balance, 0, "registry fully settled");
    }

    // ── Events: DisputeBondPosted + DisputeArbitrated ─────────────
    function test_BondedDispute_EmitsEvents() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.expectEmit(true, true, false, true);
        emit DisputeBondPosted(jobId, beta, PRICE);
        vm.prank(beta);
        reg.disputeResult{value: PRICE}(jobId);

        vm.expectEmit(true, true, false, true);
        emit DisputeResponsePosted(jobId, alpha, PRICE);
        vm.prank(alpha);
        reg.respondToDispute{value: PRICE}(jobId);

        vm.expectEmit(true, false, true, true);
        emit DisputeArbitrated(jobId, 0, address(this)); // 0 = ProviderAtFault
        reg.arbitrate(jobId, AgentSkillRegistry.Verdict.ProviderAtFault);
    }

    // ── Concede event ────────────────────────────────────────────
    function test_BondedDispute_ConcedeEmitsEvent() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        _deliverAndDispute(jobId);

        vm.expectEmit(true, true, false, true);
        emit DisputeConceded(jobId, alpha);
        vm.prank(alpha);
        reg.concedeDispute(jobId);
    }

    // ── Provider bond must match exactly ─────────────────────────
    function test_BondedDispute_WrongProviderBond_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        _deliverAndDispute(jobId);

        vm.prank(alpha);
        vm.expectRevert(bytes("bond must match dispute bond"));
        reg.respondToDispute{value: PRICE - 1}(jobId);
    }
}

contract ReentrantProvider {
    AgentSkillRegistry public reg;
    bool private reentered;

    constructor(AgentSkillRegistry _reg) {
        reg = _reg;
    }

    function register(uint256 price) external returns (uint256) {
        return reg.registerSkill("evil", "reentrant", "mcp://evil", price, 0, 0);
    }

    function deliver(uint256 jobId, bytes32 resultHash) external {
        reg.deliverResult(jobId, resultHash);
    }

    function attack() external {
        reg.withdraw();
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            // Re-entry attempt — must be blocked by nonReentrant / zeroed balance.
            try reg.withdraw() {} catch {}
        }
    }
}
