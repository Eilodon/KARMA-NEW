// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentSkillRegistry} from "../contracts/AgentSkillRegistry.sol";
import {RationaleAttestation} from "../contracts/RationaleAttestation.sol";

/// @notice Mirrors contracts-odra/src/agent_skill_registry/tests.rs's 6 P2-A rationale-attestation
///         cases (attest_rationale_requester_can_attest_and_view, _rejects_non_requester,
///         _rejects_double_attest, _is_independent_of_job_lifecycle, _none_for_jobs_never_attested)
///         plus a JobNotFound case specific to this sidecar's existence check (Solidity has no
///         wrong-length-hash case: `bytes32` already fixes the hash to exactly 32 bytes at the ABI
///         level, unlike Casper's dynamic `Bytes` parameter).
contract RationaleAttestationTest is Test {
    AgentSkillRegistry internal reg;
    RationaleAttestation internal att;

    address internal alpha = address(0xA1); // provider (skill owner)
    address internal beta = address(0xB2); // requester
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant DEADLINE_SECS = 1 days;
    bytes32 internal constant TASK_HASH = keccak256("task-params");
    bytes32 internal constant RESULT_HASH = keccak256("result-data");
    bytes32 internal constant RATIONALE_HASH = keccak256("chose this skill: highest EV, rep 80");

    function setUp() public {
        reg = new AgentSkillRegistry(3 days, address(this));
        att = new RationaleAttestation(address(reg));
        vm.deal(beta, 10 ether);
        vm.deal(alpha, 10 ether);
    }

    function _registerSkill() internal returns (uint256 skillId) {
        vm.prank(alpha);
        skillId = reg.registerSkill("search", "paid discover_skills", "mcp://alpha", PRICE, 0, 0);
    }

    function _openJob(uint256 skillId) internal returns (uint256 jobId) {
        vm.prank(beta);
        jobId = reg.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);
    }

    // ── attest_rationale_requester_can_attest_and_view ────────────
    function test_AttestRationale_Success() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);

        assertEq(att.getRationaleHash(jobId), bytes32(0));

        vm.expectEmit(true, true, false, true);
        emit RationaleAttestation.RationaleAttested(jobId, beta, RATIONALE_HASH);
        vm.prank(beta);
        att.attestRationale(jobId, RATIONALE_HASH);

        assertEq(att.getRationaleHash(jobId), RATIONALE_HASH);
        assertTrue(att.attested(jobId));
    }

    // ── attest_rationale_rejects_non_requester ─────────────────────
    function test_AttestRationale_RevertIfNotRequester() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);

        vm.prank(alpha); // provider, not requester
        vm.expectRevert(abi.encodeWithSelector(RationaleAttestation.NotRequester.selector, jobId, alpha));
        att.attestRationale(jobId, RATIONALE_HASH);
    }

    // ── attest_rationale_rejects_double_attest ─────────────────────
    function test_AttestRationale_RevertIfAlreadyAttested() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);

        vm.startPrank(beta);
        att.attestRationale(jobId, RATIONALE_HASH);
        vm.expectRevert(abi.encodeWithSelector(RationaleAttestation.RationaleAlreadyAttested.selector, jobId));
        att.attestRationale(jobId, keccak256("second"));
        vm.stopPrank();

        // Original hash survives the reverted rewrite attempt.
        assertEq(att.getRationaleHash(jobId), RATIONALE_HASH);
    }

    // ── attest_rationale_is_independent_of_job_lifecycle ───────────
    function test_AttestRationale_IndependentOfJobLifecycle() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);

        vm.prank(beta);
        att.attestRationale(jobId, RATIONALE_HASH);

        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);
        vm.prank(beta);
        reg.confirmCompletion(jobId);

        (,,,,,, AgentSkillRegistry.JobStatus status,,,,,) = reg.jobs(jobId);
        assertEq(uint8(status), uint8(AgentSkillRegistry.JobStatus.Completed));
        assertEq(att.getRationaleHash(jobId), RATIONALE_HASH);
    }

    // ── attest_rationale_none_for_jobs_never_attested ──────────────
    function test_GetRationaleHash_ReturnsZeroIfNotAttested() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        assertEq(att.getRationaleHash(jobId), bytes32(0));
    }

    // ── Solidity-specific: existence is derived from jobs(jobId).requester == address(0) ──
    function test_AttestRationale_RevertIfJobNotFound() public {
        uint256 neverCreatedJobId = 999;
        vm.prank(beta);
        vm.expectRevert(abi.encodeWithSelector(RationaleAttestation.JobNotFound.selector, neverCreatedJobId));
        att.attestRationale(neverCreatedJobId, RATIONALE_HASH);
    }
}
