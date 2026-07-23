// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title AgentSkillRegistry — on-chain skill registry + escrowed job coordination for KARMA.
/// @notice Hardened per spec v3.1 D-8: pull-payment + ReentrancyGuard + checks-effects-interactions
///         + refund-after-deadline (no permanent fund lock).
///         P0-B: inherits Ownable2Step so ownership can transfer to a KarmaTimelock (multisig +
///         48h delay) — eliminating the single-EOA admin backdoor for setCrossChainRep.
contract AgentSkillRegistry is ReentrancyGuard, Ownable2Step {
    // ── Types ──────────────────────────────────────────────────
    struct Skill {
        address owner;
        string name;
        string description;
        string mcpEndpoint;
        uint256 pricePerCall; // wei
        uint256 reputationScore; // 0..100, starts 50
        uint256 totalInvocations;
        bool active;
        uint256 registeredAt;
        uint256 minReputationToInvoke; // Trust Gate (on-chain, PD-005): 0 = open
        // Identity Gate (P0): DECLARATIVE policy for a skill. A did:t3n cannot be verified on-chain
        // (it is proven off-chain via SIWE/WASM), so this field is NOT enforced here — the trusted
        // in-process KARMA server enforces it in create_job. Published on-chain so the requirement is
        // composable + credibly committed (not a server-mutable secret). Server semantics:
        //   0 = NONE (open) · 1 = T3N_VERIFIED (live session) · 2 = T3N_VERIFIED_FRESH (recent session)
        //   ≥3 = unknown → the server fails closed (rejects). uint8 leaves room for future issuers/tiers.
        uint8 identityPolicy;
    }

    struct Job {
        address requester;
        address provider; // skill owner snapshot at creation
        uint256 skillId;
        bytes32 taskHash;
        uint256 escrowAmount;
        uint256 deadline; // absolute unix timestamp
        JobStatus status;
        bytes32 resultHash;
        uint256 createdAt;
        uint256 completedAt;
        address evaluator; // P0-A: neutral 3rd-party verifier; address(0) = none (opt-in)
        uint256 evaluatorFee; // P0-A: fee held for the evaluator; refunded to requester if unused
    }

    /// @dev P1-A: dispute bond data stored separately from Job to avoid stack-too-deep on the
    ///      auto-generated `jobs()` getter. Keyed by jobId. All zeros = no bonded dispute.
    struct DisputeInfo {
        uint256 disputeBond; // requester's dispute bond (0 = uncontested/evaluator rejection)
        uint256 providerBond; // provider's matching bond (0 = not yet responded)
        uint256 disputedAt; // timestamp when bonded dispute opened (0 = not disputed)
    }

    enum JobStatus {
        Open,
        Delivered,
        Completed,
        Refunded,
        Disputed
    }

    enum Verdict { ProviderAtFault, RequesterAtFault }

    uint256 public constant BASE_REPUTATION = 50;
    uint256 public constant MAX_REPUTATION = 100;
    uint256 public constant REPUTATION_STEP = 5;
    /// @notice Post-delivery review window — a delivered job auto-settles to the provider after this.
    ///         Set once at deploy time (immutable): configurable per deployment but fixed and
    ///         predictable afterwards — no owner-mutable governance surface. Bounded so it stays
    ///         generous enough that mempool latency near the dispute boundary is negligible (R1/ADR-1):
    ///         a hard timestamp boundary is inherent to any optimistic dispute window, so the mitigation
    ///         is a sufficiently long window, not a (boundary-shifting) grace period.
    uint256 public immutable REVIEW_WINDOW;
    uint256 public constant MIN_REVIEW_WINDOW = 1 hours;
    uint256 public constant MAX_REVIEW_WINDOW = 30 days;
    /// @notice Recommended default review window when a deployer does not override it.
    uint256 public constant DEFAULT_REVIEW_WINDOW = 3 days;
    /// @notice Cooldown between requesting a bond unlock and being able to withdraw it (Tier-2,
    ///         PD-007). Capital must stay locked across the cooldown, so a Sybil cannot lock-seed-
    ///         unlock in a flash — bonded capital is committed, not flash-rentable.
    uint256 public constant BOND_UNLOCK_COOLDOWN = 7 days;
    // Identity Gate (P0): named policy values for the off-chain enforcer (documentation; not enforced here).
    uint8 public constant IDENTITY_POLICY_NONE = 0;
    uint8 public constant IDENTITY_POLICY_T3N = 1;
    uint8 public constant IDENTITY_POLICY_T3N_FRESH = 2;
    // P1-A: Symmetric dispute bond — makes disputes costly for frivolous disputers.
    uint256 public constant REP_SLASH_STEP = 10;
    uint256 public constant REP_FLOOR = 1;
    uint256 public constant MIN_DISPUTE_BOND = 0.001 ether;
    uint256 public constant RESPONSE_WINDOW = 3 days;

    // ── State ──────────────────────────────────────────────────
    uint256 private _skillIdCounter;
    uint256 private _jobIdCounter;

    mapping(uint256 => Skill) public skills;
    mapping(uint256 => Job) public jobs;
    mapping(address => uint256[]) public agentProviderJobs;
    mapping(address => uint256[]) public agentRequesterJobs;
    mapping(address => uint256[]) public agentSkills;
    mapping(address => uint256) public pendingWithdrawals; // pull-payment ledger
    mapping(bytes32 => uint256) public jobByTaskHash; // PD-003: O(1) dedup (taskHash binds requester)
    mapping(address => uint256) private _agentRep; // 0 = unset ⇒ BASE_REPUTATION; rises on completion, drops on fault (P1-A)
    // Tier-2 Sybil-resistance bond (PD-007): optional, per-agent, capital-at-risk SEED for off-chain
    // flow reputation. Locked while active; withdrawable only by the same agent after a cooldown, so
    // running N Sybil identities costs N bonds locked at once. NOT a paywall (zero-bond agents still
    // register/rank) and NOT slashed here — Sybil cost is the lockup, not punishment.
    mapping(address => uint256) public bondedAmount; // total locked bond per agent
    mapping(address => uint256) public bondUnlockAt; // 0 = active (seeds); >0 = cooling down (no seed)
    // P0-B / P0.1: cross-chain reputation bridge. Admin-gated (owner = KarmaTimelock in production).
    mapping(address => uint256) public crossChainRep;
    // P1-A: Symmetric dispute bond config + per-job dispute data.
    uint256 public disputeBondBps = 10_000; // basis points of escrow; 10_000 = 1× (owner-settable)
    address public arbiter;
    mapping(uint256 => DisputeInfo) public disputes;

    // ── Events ─────────────────────────────────────────────────
    event SkillRegistered(uint256 indexed skillId, address indexed owner, string name, uint256 pricePerCall);
    event SkillDeactivated(uint256 indexed skillId);
    event JobCreated(
        uint256 indexed jobId, address indexed requester, uint256 indexed skillId, uint256 escrow, uint256 deadline
    );
    event ResultDelivered(uint256 indexed jobId, bytes32 resultHash);
    event JobCompleted(uint256 indexed jobId, address indexed provider, uint256 payout, uint256 newReputation);
    event JobRefunded(uint256 indexed jobId, address indexed requester, uint256 amount);
    event ResultDisputed(uint256 indexed jobId, address indexed requester, uint256 amount);
    event JobEvaluated(uint256 indexed jobId, address indexed evaluator, bool approved, uint256 evaluatorPayout);
    event MinReputationSet(uint256 indexed skillId, uint256 minReputation);
    event IdentityPolicySet(uint256 indexed skillId, uint8 policy);
    event Withdrawn(address indexed who, uint256 amount);
    /// @param seedEligible bonded amount that currently counts as a flow-reputation seed (0 while
    ///        cooling down). The off-chain indexer mirrors this into FlowReputationParams.seeds.
    event BondUpdated(address indexed agent, uint256 bondedAmount, uint256 seedEligible);
    /// @notice P0-B / P0.1: cross-chain reputation attestation bridged from another chain (e.g. Soroban ZK proofs).
    event CrossChainRepUpdated(address indexed agent, uint256 score, string sourceChain);
    // P1-A: Symmetric dispute bond events.
    event DisputeBondPosted(uint256 indexed jobId, address indexed requester, uint256 bond);
    event DisputeResponsePosted(uint256 indexed jobId, address indexed provider, uint256 bond);
    event DisputeConceded(uint256 indexed jobId, address indexed provider);
    event DisputeArbitrated(uint256 indexed jobId, Verdict verdict, address indexed arbiter);
    event ArbiterUpdated(address indexed oldArbiter, address indexed newArbiter);
    event DisputeBondBpsUpdated(uint256 oldBps, uint256 newBps);

    // ── Constructor ────────────────────────────────────────────
    /// @param reviewWindowSecs post-delivery review window (seconds). Deploy-time config, then
    ///        immutable. Pass DEFAULT_REVIEW_WINDOW (3 days) for the recommended value; bounded
    ///        to [MIN_REVIEW_WINDOW, MAX_REVIEW_WINDOW] = [1 hour, 30 days].
    /// @param initialOwner governance address (deploy-time: deployer; production: KarmaTimelock).
    ///        Two-step transfer via transferOwnership() + acceptOwnership() (Ownable2Step).
    constructor(uint256 reviewWindowSecs, address initialOwner) Ownable(initialOwner) {
        require(
            reviewWindowSecs >= MIN_REVIEW_WINDOW && reviewWindowSecs <= MAX_REVIEW_WINDOW,
            "bad review window"
        );
        REVIEW_WINDOW = reviewWindowSecs;
        arbiter = initialOwner;
    }

    // ── Skill lifecycle ────────────────────────────────────────
    function registerSkill(
        string calldata name,
        string calldata description,
        string calldata mcpEndpoint,
        uint256 pricePerCall,
        uint256 minReputationToInvoke,
        uint8 identityPolicy
    ) external returns (uint256 skillId) {
        require(bytes(name).length > 0, "name required");
        require(minReputationToInvoke <= MAX_REPUTATION, "bad threshold");
        skillId = ++_skillIdCounter;
        skills[skillId] = Skill({
            owner: msg.sender,
            name: name,
            description: description,
            mcpEndpoint: mcpEndpoint,
            pricePerCall: pricePerCall,
            reputationScore: BASE_REPUTATION,
            totalInvocations: 0,
            active: true,
            registeredAt: block.timestamp,
            minReputationToInvoke: minReputationToInvoke,
            identityPolicy: identityPolicy
        });
        agentSkills[msg.sender].push(skillId);
        emit SkillRegistered(skillId, msg.sender, name, pricePerCall);
    }

    function deactivateSkill(uint256 skillId) external {
        Skill storage s = skills[skillId];
        require(s.owner == msg.sender, "not skill owner");
        require(s.active, "already inactive");
        s.active = false;
        emit SkillDeactivated(skillId);
    }

    /// @notice Owner adjusts the Trust Gate threshold for a skill (PD-005).
    function setMinReputation(uint256 skillId, uint256 minReputation) external {
        Skill storage s = skills[skillId];
        require(s.owner == msg.sender, "not skill owner");
        require(minReputation <= MAX_REPUTATION, "bad threshold");
        s.minReputationToInvoke = minReputation;
        emit MinReputationSet(skillId, minReputation);
    }

    /// @notice Owner sets the Identity Gate policy for a skill (P0). Declarative: the off-chain KARMA
    ///         server enforces it (a did:t3n cannot be verified on-chain). Published for composability.
    function setIdentityPolicy(uint256 skillId, uint8 policy) external {
        Skill storage s = skills[skillId];
        require(s.owner == msg.sender, "not skill owner");
        s.identityPolicy = policy;
        emit IdentityPolicySet(skillId, policy);
    }

    // ── Agent reputation (PD-005) ──────────────────────────────
    /// @notice Earned reputation, lazy-initialized to BASE_REPUTATION. 0 is the "unset" sentinel.
    ///         Rep rises on completion and drops on adjudicated fault (P1-A symmetric dispute bond).
    function agentReputation(address agent) public view returns (uint256) {
        uint256 r = _agentRep[agent];
        return r == 0 ? BASE_REPUTATION : r;
    }

    function _bumpAgentRep(address agent) private {
        uint256 next = agentReputation(agent) + REPUTATION_STEP;
        _agentRep[agent] = next > MAX_REPUTATION ? MAX_REPUTATION : next;
    }

    function _slashAgentRep(address agent) private {
        uint256 rep = agentReputation(agent);
        uint256 slashed = rep > REP_SLASH_STEP ? rep - REP_SLASH_STEP : REP_FLOOR;
        _agentRep[agent] = slashed;
    }

    function _slashSkillRep(uint256 skillId) private {
        Skill storage s = skills[skillId];
        s.reputationScore = s.reputationScore > REP_SLASH_STEP ? s.reputationScore - REP_SLASH_STEP : REP_FLOOR;
    }

    // ── Job lifecycle ──────────────────────────────────────────
    /// @param deadlineSecs duration (seconds) added to now → absolute deadline (avoids client clock skew).
    function createJob(uint256 skillId, bytes32 taskHash, uint256 deadlineSecs)
        external
        payable
        returns (uint256 jobId)
    {
        return _createJob(skillId, taskHash, deadlineSecs, address(0), 0);
    }

    /// @notice Create a job with a neutral third-party evaluator (P0-A).
    /// @param evaluator address of the evaluator agent; must not be requester or provider.
    /// @param evaluatorFee fee held for the evaluator (paid only if they evaluate).
    ///        msg.value must equal pricePerCall + evaluatorFee.
    function createJobWithEvaluator(
        uint256 skillId,
        bytes32 taskHash,
        uint256 deadlineSecs,
        address evaluator,
        uint256 evaluatorFee
    ) external payable returns (uint256 jobId) {
        require(evaluator != address(0), "evaluator required");
        require(evaluator != msg.sender, "evaluator cannot be requester");
        return _createJob(skillId, taskHash, deadlineSecs, evaluator, evaluatorFee);
    }

    function _createJob(
        uint256 skillId,
        bytes32 taskHash,
        uint256 deadlineSecs,
        address evaluator,
        uint256 evaluatorFee
    ) private returns (uint256 jobId) {
        Skill storage s = skills[skillId];
        require(s.owner != address(0), "skill not found");
        require(s.active, "skill inactive");
        require(msg.value == s.pricePerCall + evaluatorFee, "escrow must equal price + evaluator fee");
        require(deadlineSecs > 0, "deadline required");
        require(agentReputation(msg.sender) >= s.minReputationToInvoke, "insufficient reputation");
        if (evaluator != address(0)) {
            require(evaluator != s.owner, "evaluator cannot be provider");
        }
        // Fix 5: durable on-chain exactly-once. taskHash binds the requester (off-chain it is
        // keccak(requester, skillId, idempotencyNonce)), so a non-zero entry here means this exact
        // request already escrowed a job. Reverting refunds msg.value and stops a lost-ack retry —
        // one that re-broadcasts before the first tx mined — from creating a second escrowed job.
        require(jobByTaskHash[taskHash] == 0, "duplicate taskHash");

        jobId = ++_jobIdCounter;
        jobs[jobId] = Job({
            requester: msg.sender,
            provider: s.owner,
            skillId: skillId,
            taskHash: taskHash,
            escrowAmount: s.pricePerCall,
            deadline: block.timestamp + deadlineSecs,
            status: JobStatus.Open,
            resultHash: bytes32(0),
            createdAt: block.timestamp,
            completedAt: 0,
            evaluator: evaluator,
            evaluatorFee: evaluatorFee
        });
        agentRequesterJobs[msg.sender].push(jobId);
        agentProviderJobs[s.owner].push(jobId);
        jobByTaskHash[taskHash] = jobId; // PD-003: O(1) dedup lookup
        emit JobCreated(jobId, msg.sender, skillId, s.pricePerCall, jobs[jobId].deadline);
    }

    function deliverResult(uint256 jobId, bytes32 resultHash) external {
        Job storage j = jobs[jobId];
        require(j.provider == msg.sender, "not provider");
        require(j.status == JobStatus.Open, "job not open");
        j.status = JobStatus.Delivered;
        j.resultHash = resultHash;
        // Repurpose `deadline` as the review-by time (the original create deadline is moot once
        // delivered; claimRefund's status==Open guard prevents any cross-talk — see audit FM1).
        j.deadline = block.timestamp + REVIEW_WINDOW;
        emit ResultDelivered(jobId, resultHash);
    }

    function confirmCompletion(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.requester == msg.sender, "not requester");
        require(j.status == JobStatus.Delivered, "job not delivered");
        // Allowed at ANY time while Delivered — a good-faith requester is never forced to wait out
        // the review window (no `block.timestamp <= deadline` guard here, by design).
        // Evaluator fee refund: requester acted directly, evaluator didn't — fee returns to requester.
        if (j.evaluatorFee > 0) {
            pendingWithdrawals[j.requester] += j.evaluatorFee;
        }
        _settleCompletion(j, jobId);
    }

    /// @notice Provider claims payment if the requester neither confirmed nor disputed in the window.
    ///         Resolves the ghosting-requester deadlock (Claim 3) — no permanent fund lock.
    ///         Evaluator fee (if any) is refunded to the requester (evaluator didn't act either).
    function claimAfterReview(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.provider == msg.sender, "not provider");
        require(j.status == JobStatus.Delivered, "job not delivered");
        require(block.timestamp > j.deadline, "review window open");
        if (j.evaluatorFee > 0) {
            pendingWithdrawals[j.requester] += j.evaluatorFee;
        }
        _settleCompletion(j, jobId);
    }

    /// @notice Requester disputes a delivered result within the review window.
    ///         P1-A: bond-backed — requester must lock a dispute bond proportional to escrow.
    ///         Escrow is held until resolution; evaluator fee (if any) returned immediately.
    function disputeResult(uint256 jobId) external payable nonReentrant {
        Job storage j = jobs[jobId];
        require(j.requester == msg.sender, "not requester");
        require(j.status == JobStatus.Delivered, "job not delivered");
        require(block.timestamp <= j.deadline, "review window closed");

        uint256 requiredBond = (disputeBondBps * j.escrowAmount) / 10_000;
        if (requiredBond < MIN_DISPUTE_BOND) requiredBond = MIN_DISPUTE_BOND;
        require(msg.value == requiredBond, "wrong dispute bond");

        j.status = JobStatus.Disputed;
        disputes[jobId] = DisputeInfo({disputeBond: msg.value, providerBond: 0, disputedAt: block.timestamp});
        if (j.evaluatorFee > 0) {
            pendingWithdrawals[msg.sender] += j.evaluatorFee;
        }
        emit DisputeBondPosted(jobId, msg.sender, msg.value);
        emit ResultDisputed(jobId, msg.sender, j.escrowAmount);
    }

    /// @notice Provider matches the dispute bond to contest (enter arbitration).
    function respondToDispute(uint256 jobId) external payable nonReentrant {
        Job storage j = jobs[jobId];
        require(j.provider == msg.sender, "not provider");
        require(j.status == JobStatus.Disputed, "not disputed");
        DisputeInfo storage d = disputes[jobId];
        require(d.disputeBond > 0, "not a bonded dispute");
        require(d.providerBond == 0, "already responded");
        require(block.timestamp <= d.disputedAt + RESPONSE_WINDOW, "response window closed");
        require(msg.value == d.disputeBond, "bond must match dispute bond");

        d.providerBond = msg.value;
        emit DisputeResponsePosted(jobId, msg.sender, msg.value);
    }

    /// @notice Provider concedes the dispute. Escrow + requester bond returned; provider rep slashed.
    function concedeDispute(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.provider == msg.sender, "not provider");
        require(j.status == JobStatus.Disputed, "not disputed");
        DisputeInfo storage d = disputes[jobId];
        require(d.disputeBond > 0, "not a bonded dispute");
        require(d.providerBond == 0, "already responded");

        j.status = JobStatus.Refunded;
        pendingWithdrawals[j.requester] += j.escrowAmount + d.disputeBond;
        _slashAgentRep(j.provider);
        _slashSkillRep(j.skillId);
        emit DisputeConceded(jobId, msg.sender);
        emit JobRefunded(jobId, j.requester, j.escrowAmount);
    }

    /// @notice Anyone can trigger default concede if provider doesn't respond within RESPONSE_WINDOW.
    function resolveDefaultConcede(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.status == JobStatus.Disputed, "not disputed");
        DisputeInfo storage d = disputes[jobId];
        require(d.disputeBond > 0, "not a bonded dispute");
        require(d.providerBond == 0, "provider already responded");
        require(block.timestamp > d.disputedAt + RESPONSE_WINDOW, "response window open");

        j.status = JobStatus.Refunded;
        pendingWithdrawals[j.requester] += j.escrowAmount + d.disputeBond;
        _slashAgentRep(j.provider);
        _slashSkillRep(j.skillId);
        emit DisputeConceded(jobId, j.provider);
        emit JobRefunded(jobId, j.requester, j.escrowAmount);
    }

    /// @notice Arbiter adjudicates a contested dispute (both sides bonded). Loser-pays.
    function arbitrate(uint256 jobId, Verdict verdict) external nonReentrant {
        require(msg.sender == arbiter, "not arbiter");
        Job storage j = jobs[jobId];
        require(j.status == JobStatus.Disputed, "not disputed");
        DisputeInfo storage d = disputes[jobId];
        require(d.disputeBond > 0, "not a bonded dispute");
        require(d.providerBond > 0, "provider has not responded");

        if (verdict == Verdict.ProviderAtFault) {
            j.status = JobStatus.Refunded;
            pendingWithdrawals[j.requester] += j.escrowAmount + d.disputeBond + d.providerBond;
            _slashAgentRep(j.provider);
            _slashSkillRep(j.skillId);
            emit JobRefunded(jobId, j.requester, j.escrowAmount);
        } else {
            j.status = JobStatus.Completed;
            j.completedAt = block.timestamp;
            pendingWithdrawals[j.provider] += j.escrowAmount + d.providerBond + d.disputeBond;
            Skill storage s = skills[j.skillId];
            if (j.requester != j.provider) {
                s.totalInvocations += 1;
                uint256 rep = s.reputationScore + REPUTATION_STEP;
                s.reputationScore = rep > MAX_REPUTATION ? MAX_REPUTATION : rep;
                _bumpAgentRep(j.provider);
            }
            emit JobCompleted(jobId, j.provider, j.escrowAmount, s.reputationScore);
        }
        emit DisputeArbitrated(jobId, verdict, msg.sender);
    }

    /// @notice Neutral evaluator approves or rejects a delivered result (P0-A).
    ///         Only callable by the job's designated evaluator within the review window.
    ///         approved=true settles like confirmCompletion; approved=false settles like disputeResult.
    ///         The evaluator fee is released to the evaluator regardless of verdict (they did the work).
    function evaluateResult(uint256 jobId, bool approved) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.evaluator == msg.sender, "not evaluator");
        require(j.status == JobStatus.Delivered, "job not delivered");
        require(block.timestamp <= j.deadline, "review window closed");

        if (j.evaluatorFee > 0) {
            pendingWithdrawals[j.evaluator] += j.evaluatorFee;
        }
        emit JobEvaluated(jobId, msg.sender, approved, j.evaluatorFee);

        if (approved) {
            _settleCompletion(j, jobId);
        } else {
            j.status = JobStatus.Disputed;
            pendingWithdrawals[j.requester] += j.escrowAmount;
            emit ResultDisputed(jobId, j.requester, j.escrowAmount);
        }
    }

    /// @dev Shared completion effects for confirmCompletion + claimAfterReview + evaluateResult(approved).
    ///      When called from confirmCompletion/claimAfterReview the evaluator fee (if any) is refunded
    ///      to the requester (evaluator didn't act). When called from evaluateResult the fee is already
    ///      credited to the evaluator before this function runs — no double credit.
    function _settleCompletion(Job storage j, uint256 jobId) private {
        // Escrow ALWAYS settles — money must move to the provider regardless of counterparties.
        j.status = JobStatus.Completed;
        j.completedAt = block.timestamp;
        pendingWithdrawals[j.provider] += j.escrowAmount;

        Skill storage s = skills[j.skillId];

        // Self-deal guard (audit Abductive-2; widened in Tier-0). A self-dealt job (requester ==
        // provider) settles escrow but earns ZERO trust signals — NOT the skill reputationScore,
        // NOT the invocation count, NOT agent reputation. Originally only agent reputation was
        // guarded while reputationScore + totalInvocations bumped unconditionally; because the skill
        // reputationScore drives the off-chain BM25 discovery boost (1.0..2.0x), a SINGLE wallet
        // could self-deal price-0 jobs on its own skill to inflate its rank and drown real skills —
        // strictly cheaper than the 2-wallet Trust-Gate farm. All earned signals are now gated
        // identically, on BOTH completion paths because both call this function.
        if (j.requester != j.provider) {
            s.totalInvocations += 1;
            uint256 rep = s.reputationScore + REPUTATION_STEP;
            s.reputationScore = rep > MAX_REPUTATION ? MAX_REPUTATION : rep;
            _bumpAgentRep(j.provider);
            _bumpAgentRep(j.requester);
        }

        emit JobCompleted(jobId, j.provider, j.escrowAmount, s.reputationScore);
    }

    /// @notice Requester reclaims escrow + evaluator fee if the provider never delivered past the deadline.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.requester == msg.sender, "not requester");
        require(j.status == JobStatus.Open, "not refundable");
        require(block.timestamp > j.deadline, "before deadline");

        j.status = JobStatus.Refunded;
        pendingWithdrawals[msg.sender] += j.escrowAmount + j.evaluatorFee;
        emit JobRefunded(jobId, msg.sender, j.escrowAmount);
    }

    // ── Pull-payment withdrawal (CEI + nonReentrant) ───────────
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0; // effects before interaction
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ── Sybil-resistance bond (Tier-2, PD-007) ─────────────────
    /// @notice Seed-eligible bond for an agent — `bondedAmount` while active, 0 while cooling down.
    ///         Off-chain flow reputation reads this (log-capped) as the agent's trust seed.
    function seedEligibleBond(address agent) external view returns (uint256) {
        return bondUnlockAt[agent] == 0 ? bondedAmount[agent] : 0;
    }

    /// @notice Lock additional bond to seed your discovery reputation. Depositing re-activates a
    ///         cooling-down bond (re-commits it as a seed).
    function depositBond() external payable {
        require(msg.value > 0, "no bond");
        uint256 bonded = bondedAmount[msg.sender] + msg.value;
        bondedAmount[msg.sender] = bonded;
        bondUnlockAt[msg.sender] = 0; // active again
        emit BondUpdated(msg.sender, bonded, bonded);
    }

    /// @notice Begin the unlock cooldown. The bond stops seeding immediately (seedEligible → 0).
    function requestBondUnlock() external {
        require(bondedAmount[msg.sender] > 0, "no bond");
        require(bondUnlockAt[msg.sender] == 0, "already unlocking");
        bondUnlockAt[msg.sender] = block.timestamp + BOND_UNLOCK_COOLDOWN;
        emit BondUpdated(msg.sender, bondedAmount[msg.sender], 0);
    }

    /// @notice Cancel a pending unlock and re-activate the bond as a seed.
    function cancelBondUnlock() external {
        require(bondUnlockAt[msg.sender] != 0, "not unlocking");
        bondUnlockAt[msg.sender] = 0;
        emit BondUpdated(msg.sender, bondedAmount[msg.sender], bondedAmount[msg.sender]);
    }

    /// @notice After the cooldown, credit the full bond back to the pull-payment ledger (then call
    ///         withdraw() to pull it). nonReentrant for defense-in-depth: consistent with all other
    ///         fund-state-modifying functions and guards against future extensions.
    function withdrawBond() external nonReentrant {
        uint256 unlockAt = bondUnlockAt[msg.sender];
        require(unlockAt != 0, "not unlocking");
        require(block.timestamp >= unlockAt, "cooldown active");
        uint256 amount = bondedAmount[msg.sender];
        bondedAmount[msg.sender] = 0;
        bondUnlockAt[msg.sender] = 0;
        pendingWithdrawals[msg.sender] += amount; // reuse the audited pull-payment path
        emit BondUpdated(msg.sender, 0, 0);
    }

    // ── Cross-chain reputation (P0-B / P0.1) ────────────────────
    /// @notice Set an agent's cross-chain reputation. Owner-only — in production, owner is a
    ///         KarmaTimelock (multisig + 48h delay), so no single EOA can unilaterally set scores.
    function setCrossChainRep(address agent, uint256 score, string calldata sourceChain) external onlyOwner {
        require(score <= MAX_REPUTATION, "bad threshold");
        crossChainRep[agent] = score;
        emit CrossChainRepUpdated(agent, score, sourceChain);
    }

    /// @notice Owner sets the dispute bond percentage (P1-A). 10_000 = 1× escrow (default).
    function setDisputeBondBps(uint256 bps) external onlyOwner {
        uint256 old = disputeBondBps;
        disputeBondBps = bps;
        emit DisputeBondBpsUpdated(old, bps);
    }

    /// @notice Owner sets the arbiter address for dispute resolution (P1-A).
    function setArbiter(address newArbiter) external onlyOwner {
        require(newArbiter != address(0), "zero arbiter");
        address old = arbiter;
        arbiter = newArbiter;
        emit ArbiterUpdated(old, newArbiter);
    }

    // ── Views for evaluator (P0-A) ──────────────────────────────
    function getJobEvaluator(uint256 jobId) external view returns (address, uint256) {
        Job storage j = jobs[jobId];
        return (j.evaluator, j.evaluatorFee);
    }

    // ── Views for social graph / reputation ────────────────────
    function getProviderJobs(address agent) external view returns (uint256[] memory) {
        return agentProviderJobs[agent];
    }

    function getRequesterJobs(address agent) external view returns (uint256[] memory) {
        return agentRequesterJobs[agent];
    }

    function getAgentSkills(address agent) external view returns (uint256[] memory) {
        return agentSkills[agent];
    }

    function skillCount() external view returns (uint256) {
        return _skillIdCounter;
    }

    function jobCount() external view returns (uint256) {
        return _jobIdCounter;
    }
}
