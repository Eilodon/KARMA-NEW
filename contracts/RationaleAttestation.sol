// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice Minimal read surface into the live AgentSkillRegistry (0xBF285628869c2EFaf6731F8503B3
///         9B7130474Cd2 on X Layer testnet). `jobs` is already a public mapping there, so Solidity's
///         auto-generated getter already returns the full Job tuple on the contract as deployed —
///         no change to that contract's source or bytecode is needed for this interface to work.
interface IAgentSkillRegistryJobs {
    function jobs(uint256 jobId)
        external
        view
        returns (
            address requester,
            address provider,
            uint256 skillId,
            bytes32 taskHash,
            uint256 escrowAmount,
            uint256 deadline,
            uint8 status,
            bytes32 resultHash,
            uint256 createdAt,
            uint256 completedAt,
            address evaluator,
            uint256 evaluatorFee
        );
}

/// @title RationaleAttestation — sidecar contract for AgentSkillRegistry (P2-A, ported from Casper).
/// @notice Lets a job's requester commit an immutable, once-only hash of their (typically
///         LLM-generated) decision rationale for creating that job — a checkable anchor without
///         KARMA storing, or paying gas for, the plaintext rationale itself.
///
///         Deployed standalone next to AgentSkillRegistry instead of adding a function to it, so
///         the already-published, evidence-referenced registry address never changes. Validates
///         `jobId`/`requester` by reading the live registry's existing public `jobs` getter.
///
///         Mirrors contracts-odra/src/agent_skill_registry.rs's attest_rationale/get_rationale_hash
///         (P2-A): requester-only, set-once, independent of job lifecycle — callable any time after
///         the job exists, including after settlement, since it records WHY a decision was made,
///         not a claim about the job's outcome.
contract RationaleAttestation {
    IAgentSkillRegistryJobs public immutable registry;

    mapping(uint256 => bytes32) public rationaleHash;
    mapping(uint256 => bool) public attested;

    event RationaleAttested(uint256 indexed jobId, address indexed requester, bytes32 rationaleHash);

    error JobNotFound(uint256 jobId);
    error NotRequester(uint256 jobId, address caller);
    error RationaleAlreadyAttested(uint256 jobId);

    constructor(address registryAddress) {
        registry = IAgentSkillRegistryJobs(registryAddress);
    }

    /// @notice Commit `hash` as the requester's decision rationale for `jobId`, once.
    function attestRationale(uint256 jobId, bytes32 hash) external {
        (address requester,,,,,,,,,,,) = registry.jobs(jobId);
        if (requester == address(0)) revert JobNotFound(jobId);
        if (msg.sender != requester) revert NotRequester(jobId, msg.sender);
        if (attested[jobId]) revert RationaleAlreadyAttested(jobId);
        attested[jobId] = true;
        rationaleHash[jobId] = hash;
        emit RationaleAttested(jobId, msg.sender, hash);
    }

    /// @notice `bytes32(0)` when the requester never attested a rationale for `jobId`
    ///         (attestation is opt-in — most jobs, e.g. ones a human created directly, have none).
    function getRationaleHash(uint256 jobId) external view returns (bytes32) {
        return rationaleHash[jobId];
    }
}
