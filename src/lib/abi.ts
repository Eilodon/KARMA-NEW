/**
 * Typed ABI for AgentSkillRegistry.sol, transcribed from the compiled forge artifact
 * (out/AgentSkillRegistry.sol/AgentSkillRegistry.json). `as const` gives viem full type
 * inference on read/write/event calls. A structural drift-guard test
 * (src/__tests__/karma_contract.test.ts) re-reads the artifact and fails if the .sol
 * surface changes without a matching update here.
 */
export const agentSkillRegistryAbi = [
  // ── constructor (review window + initial owner — P0-B: Ownable2Step) ──
  { type: "constructor", stateMutability: "nonpayable", inputs: [{ name: "reviewWindowSecs", type: "uint256" }, { name: "initialOwner", type: "address" }] },

  // ── constants ──
  { type: "function", name: "BASE_REPUTATION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "DEFAULT_REVIEW_WINDOW", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_REPUTATION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_REVIEW_WINDOW", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MIN_REVIEW_WINDOW", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "REPUTATION_STEP", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "REVIEW_WINDOW", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "BOND_UNLOCK_COOLDOWN", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "IDENTITY_POLICY_NONE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "IDENTITY_POLICY_T3N", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "IDENTITY_POLICY_T3N_FRESH", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },

  // ── public array-mapping getters (index access) ──
  { type: "function", name: "agentProviderJobs", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "agentRequesterJobs", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "agentSkills", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },

  // ── job lifecycle ──
  { type: "function", name: "claimRefund", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "confirmCompletion", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "createJob", stateMutability: "payable", inputs: [{ name: "skillId", type: "uint256" }, { name: "taskHash", type: "bytes32" }, { name: "deadlineSecs", type: "uint256" }], outputs: [{ name: "jobId", type: "uint256" }] },
  { type: "function", name: "deliverResult", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "resultHash", type: "bytes32" }], outputs: [] },

  // ── skill lifecycle ──
  { type: "function", name: "deactivateSkill", stateMutability: "nonpayable", inputs: [{ name: "skillId", type: "uint256" }], outputs: [] },
  { type: "function", name: "registerSkill", stateMutability: "nonpayable", inputs: [{ name: "name", type: "string" }, { name: "description", type: "string" }, { name: "mcpEndpoint", type: "string" }, { name: "pricePerCall", type: "uint256" }, { name: "minReputationToInvoke", type: "uint256" }, { name: "identityPolicy", type: "uint8" }], outputs: [{ name: "skillId", type: "uint256" }] },
  { type: "function", name: "setMinReputation", stateMutability: "nonpayable", inputs: [{ name: "skillId", type: "uint256" }, { name: "minReputation", type: "uint256" }], outputs: [] },
  { type: "function", name: "setIdentityPolicy", stateMutability: "nonpayable", inputs: [{ name: "skillId", type: "uint256" }, { name: "policy", type: "uint8" }], outputs: [] },

  // ── job resolution (v2) ──
  { type: "function", name: "claimAfterReview", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "disputeResult", stateMutability: "payable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },

  // ── P1-A: Symmetric dispute bond ──
  { type: "function", name: "respondToDispute", stateMutability: "payable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "concedeDispute", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "resolveDefaultConcede", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "arbitrate", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "verdict", type: "uint8" }], outputs: [] },
  { type: "function", name: "setDisputeBondBps", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint256" }], outputs: [] },
  { type: "function", name: "setArbiter", stateMutability: "nonpayable", inputs: [{ name: "newArbiter", type: "address" }], outputs: [] },
  { type: "function", name: "disputeBondBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "arbiter", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function", name: "disputes", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "disputeBond", type: "uint256" },
      { name: "providerBond", type: "uint256" },
      { name: "disputedAt", type: "uint256" },
    ],
  },
  { type: "function", name: "REP_SLASH_STEP", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "REP_FLOOR", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MIN_DISPUTE_BOND", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "RESPONSE_WINDOW", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },

  // ── P0-A: evaluator agent ──
  { type: "function", name: "createJobWithEvaluator", stateMutability: "payable", inputs: [{ name: "skillId", type: "uint256" }, { name: "taskHash", type: "bytes32" }, { name: "deadlineSecs", type: "uint256" }, { name: "evaluator", type: "address" }, { name: "evaluatorFee", type: "uint256" }], outputs: [{ name: "jobId", type: "uint256" }] },
  { type: "function", name: "evaluateResult", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "approved", type: "bool" }], outputs: [] },
  { type: "function", name: "getJobEvaluator", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }] },

  // ── views ──
  { type: "function", name: "agentReputation", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "jobByTaskHash", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getAgentSkills", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256[]" }] },
  { type: "function", name: "getProviderJobs", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256[]" }] },
  { type: "function", name: "getRequesterJobs", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256[]" }] },
  { type: "function", name: "jobCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "skillCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "pendingWithdrawals", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "jobs", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "requester", type: "address" },
      { name: "provider", type: "address" },
      { name: "skillId", type: "uint256" },
      { name: "taskHash", type: "bytes32" },
      { name: "escrowAmount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "resultHash", type: "bytes32" },
      { name: "createdAt", type: "uint256" },
      { name: "completedAt", type: "uint256" },
      { name: "evaluator", type: "address" },
      { name: "evaluatorFee", type: "uint256" },
    ],
  },
  {
    type: "function", name: "skills", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "name", type: "string" },
      { name: "description", type: "string" },
      { name: "mcpEndpoint", type: "string" },
      { name: "pricePerCall", type: "uint256" },
      { name: "reputationScore", type: "uint256" },
      { name: "totalInvocations", type: "uint256" },
      { name: "active", type: "bool" },
      { name: "registeredAt", type: "uint256" },
      { name: "minReputationToInvoke", type: "uint256" },
      { name: "identityPolicy", type: "uint8" },
    ],
  },

  // ── Sybil-resistance bond (Tier-2) ──
  { type: "function", name: "bondedAmount", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "bondUnlockAt", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "seedEligibleBond", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "depositBond", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "requestBondUnlock", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "cancelBondUnlock", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "withdrawBond", stateMutability: "nonpayable", inputs: [], outputs: [] },

  // ── pull-payment ──
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [], outputs: [] },

  // ── P0-B: cross-chain reputation + ownership (Ownable2Step) ──
  { type: "function", name: "setCrossChainRep", stateMutability: "nonpayable", inputs: [{ name: "agent", type: "address" }, { name: "score", type: "uint256" }, { name: "sourceChain", type: "string" }], outputs: [] },
  { type: "function", name: "crossChainRep", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "pendingOwner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
  { type: "function", name: "acceptOwnership", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "renounceOwnership", stateMutability: "nonpayable", inputs: [], outputs: [] },

  // ── events ──
  { type: "event", name: "SkillRegistered", inputs: [{ name: "skillId", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true }, { name: "name", type: "string", indexed: false }, { name: "pricePerCall", type: "uint256", indexed: false }] },
  { type: "event", name: "SkillDeactivated", inputs: [{ name: "skillId", type: "uint256", indexed: true }] },
  { type: "event", name: "JobCreated", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "skillId", type: "uint256", indexed: true }, { name: "escrow", type: "uint256", indexed: false }, { name: "deadline", type: "uint256", indexed: false }] },
  { type: "event", name: "ResultDelivered", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "resultHash", type: "bytes32", indexed: false }] },
  { type: "event", name: "JobCompleted", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "provider", type: "address", indexed: true }, { name: "payout", type: "uint256", indexed: false }, { name: "newReputation", type: "uint256", indexed: false }] },
  { type: "event", name: "JobRefunded", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "ResultDisputed", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "JobEvaluated", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "evaluator", type: "address", indexed: true }, { name: "approved", type: "bool", indexed: false }, { name: "evaluatorPayout", type: "uint256", indexed: false }] },
  { type: "event", name: "MinReputationSet", inputs: [{ name: "skillId", type: "uint256", indexed: true }, { name: "minReputation", type: "uint256", indexed: false }] },
  { type: "event", name: "IdentityPolicySet", inputs: [{ name: "skillId", type: "uint256", indexed: true }, { name: "policy", type: "uint8", indexed: false }] },
  { type: "event", name: "Withdrawn", inputs: [{ name: "who", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "BondUpdated", inputs: [{ name: "agent", type: "address", indexed: true }, { name: "bondedAmount", type: "uint256", indexed: false }, { name: "seedEligible", type: "uint256", indexed: false }] },
  // ── P1-A events ──
  { type: "event", name: "DisputeBondPosted", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "bond", type: "uint256", indexed: false }] },
  { type: "event", name: "DisputeResponsePosted", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "provider", type: "address", indexed: true }, { name: "bond", type: "uint256", indexed: false }] },
  { type: "event", name: "DisputeConceded", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "provider", type: "address", indexed: true }] },
  { type: "event", name: "DisputeArbitrated", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "verdict", type: "uint8", indexed: false }, { name: "arbiter", type: "address", indexed: true }] },
  { type: "event", name: "ArbiterUpdated", inputs: [{ name: "oldArbiter", type: "address", indexed: true }, { name: "newArbiter", type: "address", indexed: true }] },
  { type: "event", name: "DisputeBondBpsUpdated", inputs: [{ name: "oldBps", type: "uint256", indexed: false }, { name: "newBps", type: "uint256", indexed: false }] },
  // ── P0-B events ──
  { type: "event", name: "CrossChainRepUpdated", inputs: [{ name: "agent", type: "address", indexed: true }, { name: "score", type: "uint256", indexed: false }, { name: "sourceChain", type: "string", indexed: false }] },
  { type: "event", name: "OwnershipTransferred", inputs: [{ name: "previousOwner", type: "address", indexed: true }, { name: "newOwner", type: "address", indexed: true }] },
  { type: "event", name: "OwnershipTransferStarted", inputs: [{ name: "previousOwner", type: "address", indexed: true }, { name: "newOwner", type: "address", indexed: true }] },
] as const;

/**
 * Typed ABI for RationaleAttestation.sol — a standalone sidecar next to AgentSkillRegistry
 * (P2-A, ported from Casper's attest_rationale/get_rationale_hash). Kept in its own const,
 * separate from agentSkillRegistryAbi above, since it's a different deployed contract at a
 * different address (XLAYER_RATIONALE_ATTESTATION_ADDRESS) — never merge the two ABIs.
 */
export const rationaleAttestationAbi = [
  { type: "constructor", stateMutability: "nonpayable", inputs: [{ name: "registryAddress", type: "address" }] },
  { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "attestRationale", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "hash", type: "bytes32" }], outputs: [] },
  { type: "function", name: "getRationaleHash", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "rationaleHash", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "attested", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "event", name: "RationaleAttested", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "rationaleHash", type: "bytes32", indexed: false }] },
  { type: "error", name: "JobNotFound", inputs: [{ name: "jobId", type: "uint256" }] },
  { type: "error", name: "NotRequester", inputs: [{ name: "jobId", type: "uint256" }, { name: "caller", type: "address" }] },
  { type: "error", name: "RationaleAlreadyAttested", inputs: [{ name: "jobId", type: "uint256" }] },
] as const;
