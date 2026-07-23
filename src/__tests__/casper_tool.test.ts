import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { markTrustedRuntime, resetTrustedRuntimeForTest } from "../core/runtime_identity.js";
import { deriveCasperPrivateKey, casperAccountHash } from "../lib/casper/keypair.js";
import type { CasperClientLike } from "../plugins/casper.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { casperSkillIndex } from "../lib/casper_indexer_runtime.js";

const SIGNER = deriveCasperPrivateKey(new Uint8Array(32).fill(0x44));

vi.mock("../lib/keystore.js", () => ({
  keystoreManager: {
    has: vi.fn((id: string) => id === "agent-alpha"),
    getCasperKeypair: vi.fn(() => SIGNER),
  },
}));

// Dynamic import AFTER mocks are registered (same convention as t3_tool.test.ts).
const { createCasperTools } = await import("../plugins/casper.tool.js");

function fakeClient(over: Partial<CasperClientLike> = {}): CasperClientLike {
  return {
    registerSkill: vi.fn(async () => ({ txHash: "tx-register" })),
    depositBond: vi.fn(async () => ({ txHash: "tx-bond" })),
    createJob: vi.fn(async () => ({ txHash: "tx-createjob" })),
    deliverResult: vi.fn(async () => ({ txHash: "tx-deliver" })),
    confirmCompletion: vi.fn(async () => ({ txHash: "tx-confirm" })),
    claimAfterReview: vi.fn(async () => ({ txHash: "tx-claim-after-review" })),
    claimRefund: vi.fn(async () => ({ txHash: "tx-claim-refund" })),
    withdraw: vi.fn(async () => ({ txHash: "tx-withdraw" })),
    pendingWithdrawalsOf: vi.fn(async () => "1000000"),
    agentReputationOf: vi.fn(async () => 55),
    bondedOf: vi.fn(async () => "2000000000"),
    getSkill: vi.fn(async () => undefined),
    getJob: vi.fn(async () => undefined),
    isComposite: vi.fn(async () => false),
    registerComposition: vi.fn(async () => ({ txHash: "tx-composition" })),
    getComposition: vi.fn(async () => undefined),
    createJobWithEvaluator: vi.fn(async () => ({ txHash: "tx-createjob-eval" })),
    evaluateResult: vi.fn(async () => ({ txHash: "tx-evaluate" })),
    disputeResult: vi.fn(async () => ({ txHash: "tx-dispute" })),
    respondToDispute: vi.fn(async () => ({ txHash: "tx-respond" })),
    concedeDispute: vi.fn(async () => ({ txHash: "tx-concede" })),
    resolveDefaultConcede: vi.fn(async () => ({ txHash: "tx-default-concede" })),
    arbitrate: vi.fn(async () => ({ txHash: "tx-arbitrate" })),
    getCrossChainRep: vi.fn(async () => 0),
    proposeSetCrossChainRep: vi.fn(async () => ({ txHash: "tx-propose-rep" })),
    proposeSetArbiter: vi.fn(async () => ({ txHash: "tx-propose-arbiter" })),
    proposeSetDisputeBondBps: vi.fn(async () => ({ txHash: "tx-propose-bps" })),
    approveProposal: vi.fn(async () => ({ txHash: "tx-approve" })),
    executeProposal: vi.fn(async () => ({ txHash: "tx-execute" })),
    cancelProposal: vi.fn(async () => ({ txHash: "tx-cancel" })),
    attestRationale: vi.fn(async () => ({ txHash: "tx-attest-rationale" })),
    getRationaleHash: vi.fn(async () => undefined),
    getArbiter: vi.fn(async () => ({ kind: "Account" as const, hashHex: "aa".repeat(32) })),
    getGovernanceSigners: vi.fn(async () => [{ kind: "Account" as const, hashHex: "bb".repeat(32) }]),
    getGovernanceThreshold: vi.fn(async () => 1),
    getTimelockDelayMs: vi.fn(async () => 172_800_000n),
    deactivateSkill: vi.fn(async () => ({ txHash: "tx-deactivate-skill" })),
    setMinReputation: vi.fn(async () => ({ txHash: "tx-set-min-reputation" })),
    setIdentityPolicy: vi.fn(async () => ({ txHash: "tx-set-identity-policy" })),
    getProviderJobs: vi.fn(async () => []),
    getRequesterJobs: vi.fn(async () => []),
    getAgentSkills: vi.fn(async () => []),
    getDisputeInfo: vi.fn(async () => undefined),
    getProposal: vi.fn(async () => undefined),
    proposeSetArbiterPanel: vi.fn(async () => ({ txHash: "tx-propose-panel" })),
    proposeSetPanelArbiterFee: vi.fn(async () => ({ txHash: "tx-propose-panel-fee" })),
    disputeResultViaPanel: vi.fn(async () => ({ txHash: "tx-dispute-panel" })),
    castPanelVote: vi.fn(async () => ({ txHash: "tx-panel-vote" })),
    resolvePanelDefault: vi.fn(async () => ({ txHash: "tx-panel-default" })),
    getArbiterPanel: vi.fn(async () => []),
    getPanelThreshold: vi.fn(async () => 0),
    ...over,
  };
}

function find(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe("createCasperTools (T13-live MCP surface)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    markTrustedRuntime();
    delete process.env.CASPER_RPC_URL;
    delete process.env.CASPER_CONTRACT_HASH;
    delete process.env.KARMA_ODRA_REGISTRY;
    delete process.env.CASPER_CHAIN_NAME;
  });

  afterEach(() => {
    resetTrustedRuntimeForTest();
    process.env = { ...ORIGINAL_ENV };
  });

  it("registers exactly the 46 documented tools", () => {
    const names = createCasperTools(() => fakeClient()).map((t) => t.name);
    expect(names).toEqual([
      "casper_health",
      "casper_register_skill",
      "casper_deposit_bond",
      "casper_create_job",
      "casper_deliver_result",
      "casper_confirm_completion",
      "casper_claim_after_review",
      "casper_claim_refund",
      "casper_withdraw",
      "casper_get_account_state",
      "casper_get_skill",
      "casper_get_job",
      "casper_discover_skills",
      "casper_register_composition",
      "casper_get_composition",
      "casper_create_job_with_evaluator",
      "casper_evaluate_result",
      "casper_dispute_result",
      "casper_respond_to_dispute",
      "casper_concede_dispute",
      "casper_resolve_default_concede",
      "casper_arbitrate",
      "casper_dispute_result_via_panel",
      "casper_cast_panel_vote",
      "casper_resolve_panel_default",
      "casper_get_cross_chain_rep",
      "casper_get_governance_state",
      "casper_propose_set_cross_chain_rep",
      "casper_propose_set_arbiter",
      "casper_propose_set_dispute_bond_bps",
      "casper_propose_set_arbiter_panel",
      "casper_propose_set_panel_arbiter_fee",
      "casper_approve_proposal",
      "casper_execute_proposal",
      "casper_cancel_proposal",
      "casper_attest_rationale",
      "casper_get_rationale_hash",
      "casper_get_x402_settlement_status",
      "casper_deactivate_skill",
      "casper_set_min_reputation",
      "casper_set_identity_policy",
      "casper_get_provider_jobs",
      "casper_get_requester_jobs",
      "casper_get_agent_skills",
      "casper_get_dispute_info",
      "casper_get_proposal",
    ]);
  });

  describe("casper_health", () => {
    it("reports configured=false when CASPER_RPC_URL/KARMA_ODRA_REGISTRY are unset", async () => {
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_health").handler({}, {} as never);
      expect(result.structuredContent).toMatchObject({ configured: false });
    });

    it("reports configured=true once both env vars are set", async () => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "11".repeat(32);
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_health").handler({}, {} as never);
      expect(result.structuredContent).toMatchObject({ configured: true });
    });

    it("surfaces the Casper event indexer's health alongside config status", async () => {
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_health").handler({}, {} as never);
      expect(result.structuredContent).toMatchObject({
        indexer: { running: false, lastSeenEventIndex: 0, reconcileErrors: 0 },
      });
    });
  });

  describe("casper_discover_skills", () => {
    it("finds a skill upserted into casperSkillIndex by the event indexer", async () => {
      const tools = createCasperTools(() => fakeClient());
      casperSkillIndex.upsert({
        id: 101,
        skill_id: 101,
        name: "rwa_price_oracle",
        description: "signed RWA price feed",
        mcp_endpoint: "casper-mcp://providers/rwa_price_oracle",
        price_per_call_wei: "10000000",
        reputation_score: 60,
        owner_address: "0x" + "11".repeat(32),
        active: true,
        payment_options: [],
      });
      const result = await find(tools, "casper_discover_skills").handler({ query: "rwa price" }, {} as never);
      expect(result.structuredContent).toMatchObject({ count: 1 });
      const skills = (result.structuredContent as { skills: Array<{ skill_id: number }> }).skills;
      expect(skills[0].skill_id).toBe(101);
      casperSkillIndex.discard(101);
    });
  });

  describe("write tools — fail closed when Casper isn't configured", () => {
    it.each([
      ["casper_register_skill", { agentId: "agent-alpha", name: "x", pricePerCallMotes: "1" }],
      ["casper_deposit_bond", { agentId: "agent-alpha", amountMotes: "1" }],
      ["casper_withdraw", { agentId: "agent-alpha" }],
    ] as const)("%s throws a clear 'not configured' error", async (name, args) => {
      const tools = createCasperTools(() => fakeClient());
      await expect(find(tools, name).handler(args, {} as never)).rejects.toThrow(/Casper not configured/);
    });
  });

  describe("write tools — happy path once configured", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "22".repeat(32);
    });

    it("casper_register_skill signs with the resolved agent key and returns the real tx hash", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_register_skill").handler(
        { agentId: "agent-alpha", name: "rwa_price_oracle", pricePerCallMotes: "10000000" },
        {} as never,
      );
      expect(client.registerSkill).toHaveBeenCalledWith(
        SIGNER,
        expect.objectContaining({ name: "rwa_price_oracle", pricePerCallMotes: 10_000_000n }),
      );
      expect(result.structuredContent).toMatchObject({ txHash: "tx-register" });
    });

    it("casper_create_job rejects a malformed task hash before ever touching the client", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await expect(
        find(tools, "casper_create_job").handler(
          { agentId: "agent-alpha", skillId: "1", taskHashHex: "not-hex", deadlineSecs: "60", escrowMotes: "1" },
          {} as never,
        ),
      ).rejects.toThrow();
      expect(client.createJob).not.toHaveBeenCalled();
    });

    it("rejects an unknown agentId before constructing a client", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await expect(
        find(tools, "casper_withdraw").handler({ agentId: "nobody" }, {} as never),
      ).rejects.toThrow(/not found in keystore/);
      expect(client.withdraw).not.toHaveBeenCalled();
    });
  });

  describe("casper_get_account_state", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "33".repeat(32);
    });

    it("resolves the account hash from agentId and reads all three fields", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_account_state").handler({ agentId: "agent-alpha" }, {} as never);
      expect(result.structuredContent).toMatchObject({
        accountHash: casperAccountHash(SIGNER),
        pendingWithdrawalsMotes: "1000000",
        reputation: 55,
        bondedMotes: "2000000000",
      });
    });

    it("accepts a raw accountHash for reading an agent outside this keystore", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const foreignHash = "account-hash-" + "99".repeat(32);
      const result = await find(tools, "casper_get_account_state").handler({ accountHash: foreignHash }, {} as never);
      expect(result.structuredContent).toMatchObject({ accountHash: foreignHash });
    });

    it("throws if neither agentId nor accountHash is given", async () => {
      const tools = createCasperTools(() => fakeClient());
      await expect(find(tools, "casper_get_account_state").handler({}, {} as never)).rejects.toThrow(
        /needs agentId or accountHash/,
      );
    });
  });

  describe("casper_get_skill", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "44".repeat(32);
    });

    it("reports found=false with a null skill for an unregistered id", async () => {
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_get_skill").handler({ skillId: "999" }, {} as never);
      expect(result.structuredContent).toMatchObject({ skillId: "999", found: false, skill: null });
    });

    it("decodes the full skill record plus the isComposite flag from a single round trip", async () => {
      const client = fakeClient({
        getSkill: vi.fn(async () => ({
          owner: { kind: "Account" as const, hashHex: "aa".repeat(32) },
          name: "rwa_price_oracle",
          description: "desc",
          mcpEndpoint: "casper-mcp://providers/rwa_price_oracle",
          pricePerCallMotes: 10_000_000n,
          reputationScore: 75,
          totalInvocations: 42n,
          active: true,
          registeredAt: 1_700_000_000n,
          minReputationToInvoke: 10,
          identityPolicy: 2,
        })),
        isComposite: vi.fn(async () => true),
      });
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_skill").handler({ skillId: "3" }, {} as never);
      expect(client.getSkill).toHaveBeenCalledWith(3n);
      expect(client.isComposite).toHaveBeenCalledWith(3n);
      expect(result.structuredContent).toMatchObject({
        skillId: "3",
        found: true,
        skill: {
          owner: "account-hash-" + "aa".repeat(32),
          name: "rwa_price_oracle",
          pricePerCallMotes: "10000000",
          reputationScore: 75,
          totalInvocations: "42",
          active: true,
          registeredAt: "1700000000",
          minReputationToInvoke: 10,
          identityPolicy: 2,
          isComposite: true,
        },
      });
    });
  });

  describe("casper_get_job", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "45".repeat(32);
    });

    it("reports found=false with a null job for an uncreated id", async () => {
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_get_job").handler({ jobId: "999" }, {} as never);
      expect(result.structuredContent).toMatchObject({ jobId: "999", found: false, job: null });
    });

    it("decodes the full job record, hex-encoding task/result hashes and formatting addresses", async () => {
      const client = fakeClient({
        getJob: vi.fn(async () => ({
          requester: { kind: "Account" as const, hashHex: "11".repeat(32) },
          provider: { kind: "Account" as const, hashHex: "22".repeat(32) },
          skillId: 1n,
          taskHash: Buffer.from("ab".repeat(32), "hex"),
          escrowAmountMotes: 10_000_000n,
          deadline: 259_200n,
          status: "Delivered" as const,
          resultHash: Buffer.from("cd".repeat(32), "hex"),
          createdAt: 1_700_000_000n,
          completedAt: 0n,
          evaluator: undefined,
          evaluatorFeeMotes: 0n,
        })),
      });
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_job").handler({ jobId: "1" }, {} as never);
      expect(result.structuredContent).toMatchObject({
        jobId: "1",
        found: true,
        job: {
          requester: "account-hash-" + "11".repeat(32),
          provider: "account-hash-" + "22".repeat(32),
          skillId: "1",
          taskHashHex: "ab".repeat(32),
          escrowAmountMotes: "10000000",
          deadline: "259200",
          status: "Delivered",
          resultHashHex: "cd".repeat(32),
          evaluator: null,
          evaluatorFeeMotes: "0",
        },
      });
    });
  });

  describe("casper_claim_refund", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "46".repeat(32);
    });

    it("signs with the requester's resolved agent key and returns the real tx hash", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_claim_refund").handler({ agentId: "agent-alpha", jobId: "1" }, {} as never);
      expect(client.claimRefund).toHaveBeenCalledWith(SIGNER, 1n);
      expect(result.structuredContent).toMatchObject({ txHash: "tx-claim-refund" });
    });

    it("fails closed when Casper isn't configured", async () => {
      delete process.env.CASPER_RPC_URL;
      delete process.env.KARMA_ODRA_REGISTRY;
      const tools = createCasperTools(() => fakeClient());
      await expect(
        find(tools, "casper_claim_refund").handler({ agentId: "agent-alpha", jobId: "1" }, {} as never),
      ).rejects.toThrow(/Casper not configured/);
    });
  });

  describe("casper_register_composition", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "55".repeat(32);
    });

    it("forwards leaf ids/weights to the client and returns the broadcast tx hash", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_register_composition").handler(
        {
          agentId: "agent-alpha",
          name: "bundle",
          pricePerCallMotes: "10000000",
          leafSkillIds: ["1", "2"],
          weightsBps: [6000, 4000],
        },
        {} as never,
      );
      expect(client.registerComposition).toHaveBeenCalledWith(
        SIGNER,
        expect.objectContaining({
          name: "bundle",
          pricePerCallMotes: 10_000_000n,
          leafSkillIds: [1n, 2n],
          weightsBps: [6000, 4000],
        }),
      );
      expect(result.structuredContent).toMatchObject({ txHash: "tx-composition" });
    });

    it("rejects more than 8 leaves before ever touching the client", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const eight = Array.from({ length: 9 }, (_, i) => String(i + 1));
      await expect(
        find(tools, "casper_register_composition").handler(
          { agentId: "agent-alpha", name: "bundle", pricePerCallMotes: "1", leafSkillIds: eight, weightsBps: eight.map(() => 1) },
          {} as never,
        ),
      ).rejects.toThrow();
      expect(client.registerComposition).not.toHaveBeenCalled();
    });
  });

  describe("casper_get_composition", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "66".repeat(32);
    });

    it("reports isComposite=false with a null composition for a primitive skill", async () => {
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_get_composition").handler({ skillId: "1" }, {} as never);
      expect(result.structuredContent).toMatchObject({ isComposite: false, composition: null });
    });

    it("stringifies leaf skill ids and surfaces weights for a composite skill", async () => {
      const client = fakeClient({
        getComposition: vi.fn(async () => ({ leafSkillIds: [1n, 2n], weightsBps: [6000, 4000] })),
      });
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_composition").handler({ skillId: "3" }, {} as never);
      expect(result.structuredContent).toMatchObject({
        isComposite: true,
        composition: { leafSkillIds: ["1", "2"], weightsBps: [6000, 4000] },
      });
    });
  });

  describe("evaluator/dispute/arbitrate lifecycle (P0-A/P1-A)", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "77".repeat(32);
    });

    it("casper_create_job_with_evaluator forwards the evaluator account hash + fee to the client", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_create_job_with_evaluator").handler(
        {
          agentId: "agent-alpha",
          skillId: "1",
          taskHashHex: "aa".repeat(32),
          deadlineSecs: "259200",
          evaluatorAccountHash: "account-hash-" + "bb".repeat(32),
          evaluatorFeeMotes: "1000",
          escrowMotes: "10001000",
        },
        {} as never,
      );
      expect(client.createJobWithEvaluator).toHaveBeenCalledWith(
        SIGNER,
        expect.objectContaining({ evaluatorAccountHash: "account-hash-" + "bb".repeat(32), evaluatorFeeMotes: 1000n }),
      );
      expect(result.structuredContent).toMatchObject({ txHash: "tx-createjob-eval" });
    });

    it("casper_evaluate_result forwards the approved flag", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_evaluate_result").handler({ agentId: "agent-alpha", jobId: "1", approved: false }, {} as never);
      expect(client.evaluateResult).toHaveBeenCalledWith(SIGNER, 1n, false);
    });

    it("casper_dispute_result / casper_respond_to_dispute forward the exact bond amount", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_dispute_result").handler({ agentId: "agent-alpha", jobId: "1", bondMotes: "5000000" }, {} as never);
      expect(client.disputeResult).toHaveBeenCalledWith(SIGNER, 1n, 5_000_000n);

      await find(tools, "casper_respond_to_dispute").handler({ agentId: "agent-alpha", jobId: "1", bondMotes: "5000000" }, {} as never);
      expect(client.respondToDispute).toHaveBeenCalledWith(SIGNER, 1n, 5_000_000n);
    });

    it("casper_concede_dispute and casper_resolve_default_concede hit the right entry points", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_concede_dispute").handler({ agentId: "agent-alpha", jobId: "1" }, {} as never);
      expect(client.concedeDispute).toHaveBeenCalledWith(SIGNER, 1n);

      await find(tools, "casper_resolve_default_concede").handler({ callerAgentId: "agent-alpha", jobId: "1" }, {} as never);
      expect(client.resolveDefaultConcede).toHaveBeenCalledWith(SIGNER, 1n);
    });

    it("casper_claim_after_review hits the right entry point", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_claim_after_review").handler({ agentId: "agent-alpha", jobId: "1" }, {} as never);
      expect(client.claimAfterReview).toHaveBeenCalledWith(SIGNER, 1n);
    });

    it("casper_arbitrate forwards a valid verdict and rejects an invalid one before touching the client", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_arbitrate").handler({ agentId: "agent-alpha", jobId: "1", verdict: "RequesterAtFault" }, {} as never);
      expect(client.arbitrate).toHaveBeenCalledWith(SIGNER, 1n, "RequesterAtFault");

      await expect(
        find(tools, "casper_arbitrate").handler({ agentId: "agent-alpha", jobId: "1", verdict: "Tie" }, {} as never),
      ).rejects.toThrow();
    });

    it("casper_dispute_result_via_panel forwards the combined bond+fee amount", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_dispute_result_via_panel").handler(
        { agentId: "agent-alpha", jobId: "1", bondPlusFeeMotes: "5500000" },
        {} as never,
      );
      expect(client.disputeResultViaPanel).toHaveBeenCalledWith(SIGNER, 1n, 5_500_000n);
    });

    it("casper_cast_panel_vote forwards jobId + verdict and rejects an invalid verdict", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_cast_panel_vote").handler(
        { agentId: "agent-alpha", jobId: "1", verdict: "ProviderAtFault" },
        {} as never,
      );
      expect(client.castPanelVote).toHaveBeenCalledWith(SIGNER, 1n, "ProviderAtFault");

      await expect(
        find(tools, "casper_cast_panel_vote").handler({ agentId: "agent-alpha", jobId: "1", verdict: "Tie" }, {} as never),
      ).rejects.toThrow();
    });

    it("casper_resolve_panel_default hits the right entry point, no access control beyond the window", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_resolve_panel_default").handler({ callerAgentId: "agent-alpha", jobId: "1" }, {} as never);
      expect(client.resolvePanelDefault).toHaveBeenCalledWith(SIGNER, 1n);
    });
  });

  describe("casper_get_governance_state", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "89".repeat(32);
    });

    it("reads signers/threshold/timelock/arbiter/panel in a single call and formats addresses", async () => {
      const client = fakeClient({
        getGovernanceSigners: vi.fn(async () => [
          { kind: "Account" as const, hashHex: "11".repeat(32) },
          { kind: "Account" as const, hashHex: "22".repeat(32) },
        ]),
        getGovernanceThreshold: vi.fn(async () => 2),
        getTimelockDelayMs: vi.fn(async () => 172_800_000n),
        getArbiter: vi.fn(async () => ({ kind: "Account" as const, hashHex: "11".repeat(32) })),
        getArbiterPanel: vi.fn(async () => [
          { kind: "Account" as const, hashHex: "33".repeat(32) },
          { kind: "Account" as const, hashHex: "44".repeat(32) },
          { kind: "Account" as const, hashHex: "55".repeat(32) },
        ]),
        getPanelThreshold: vi.fn(async () => 2),
      });
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_governance_state").handler({}, {} as never);
      expect(result.structuredContent).toMatchObject({
        signers: ["account-hash-" + "11".repeat(32), "account-hash-" + "22".repeat(32)],
        threshold: 2,
        timelockDelayMs: "172800000",
        arbiter: "account-hash-" + "11".repeat(32),
        panel: [
          "account-hash-" + "33".repeat(32),
          "account-hash-" + "44".repeat(32),
          "account-hash-" + "55".repeat(32),
        ],
        panelThreshold: 2,
      });
    });

    it("fails closed when Casper isn't configured", async () => {
      delete process.env.CASPER_RPC_URL;
      delete process.env.KARMA_ODRA_REGISTRY;
      const tools = createCasperTools(() => fakeClient());
      await expect(find(tools, "casper_get_governance_state").handler({}, {} as never)).rejects.toThrow(
        /Casper not configured/,
      );
    });
  });

  describe("cross-chain-rep governance (P0-B)", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "88".repeat(32);
    });

    it("casper_get_cross_chain_rep reads the score for a raw account hash", async () => {
      const client = fakeClient({ getCrossChainRep: vi.fn(async () => 85) });
      const tools = createCasperTools(() => client);
      const foreignHash = "account-hash-" + "cc".repeat(32);
      const result = await find(tools, "casper_get_cross_chain_rep").handler({ accountHash: foreignHash }, {} as never);
      expect(client.getCrossChainRep).toHaveBeenCalledWith(foreignHash);
      expect(result.structuredContent).toMatchObject({ accountHash: foreignHash, score: 85 });
    });

    it("casper_propose_set_cross_chain_rep forwards target/score/sourceChain", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const targetHash = "account-hash-" + "dd".repeat(32);
      await find(tools, "casper_propose_set_cross_chain_rep").handler(
        { agentId: "agent-alpha", targetAccountHash: targetHash, score: 85, sourceChain: "stellar" },
        {} as never,
      );
      expect(client.proposeSetCrossChainRep).toHaveBeenCalledWith(SIGNER, targetHash, 85, "stellar");
    });

    it("casper_propose_set_arbiter / casper_propose_set_dispute_bond_bps forward their single argument", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const newArbiter = "account-hash-" + "ee".repeat(32);
      await find(tools, "casper_propose_set_arbiter").handler({ agentId: "agent-alpha", newArbiterAccountHash: newArbiter }, {} as never);
      expect(client.proposeSetArbiter).toHaveBeenCalledWith(SIGNER, newArbiter);

      await find(tools, "casper_propose_set_dispute_bond_bps").handler({ agentId: "agent-alpha", bps: 5000 }, {} as never);
      expect(client.proposeSetDisputeBondBps).toHaveBeenCalledWith(SIGNER, 5000);
    });

    it("casper_propose_set_arbiter_panel forwards panel + threshold", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const panel = ["account-hash-" + "aa".repeat(32), "account-hash-" + "bb".repeat(32), "account-hash-" + "cc".repeat(32)];
      await find(tools, "casper_propose_set_arbiter_panel").handler({ agentId: "agent-alpha", panel, threshold: 2 }, {} as never);
      expect(client.proposeSetArbiterPanel).toHaveBeenCalledWith(SIGNER, panel, 2);
    });

    it("casper_propose_set_panel_arbiter_fee forwards the fee amount", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_propose_set_panel_arbiter_fee").handler({ agentId: "agent-alpha", feeMotes: "2500000" }, {} as never);
      expect(client.proposeSetPanelArbiterFee).toHaveBeenCalledWith(SIGNER, 2_500_000n);
    });

    it("casper_approve_proposal / casper_execute_proposal / casper_cancel_proposal forward the proposal id", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_approve_proposal").handler({ agentId: "agent-alpha", proposalId: "1" }, {} as never);
      expect(client.approveProposal).toHaveBeenCalledWith(SIGNER, 1n);

      await find(tools, "casper_execute_proposal").handler({ agentId: "agent-alpha", proposalId: "1" }, {} as never);
      expect(client.executeProposal).toHaveBeenCalledWith(SIGNER, 1n);

      await find(tools, "casper_cancel_proposal").handler({ agentId: "agent-alpha", proposalId: "1" }, {} as never);
      expect(client.cancelProposal).toHaveBeenCalledWith(SIGNER, 1n);
    });

    it("casper_attest_rationale forwards jobId + rationale hash bytes and returns the real tx hash", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const rationaleHashHex = "ab".repeat(32);
      const result = await find(tools, "casper_attest_rationale").handler(
        { agentId: "agent-alpha", jobId: "7", rationaleHashHex },
        {} as never,
      );
      expect(client.attestRationale).toHaveBeenCalledWith(SIGNER, 7n, Buffer.from(rationaleHashHex, "hex"));
      expect(result.structuredContent).toMatchObject({ txHash: "tx-attest-rationale" });
    });

    it("casper_attest_rationale rejects a non-32-byte hash before ever calling the client", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await expect(
        find(tools, "casper_attest_rationale").handler(
          { agentId: "agent-alpha", jobId: "7", rationaleHashHex: "ab" },
          {} as never,
        ),
      ).rejects.toThrow();
      expect(client.attestRationale).not.toHaveBeenCalled();
    });

    it("casper_get_rationale_hash reports null for a job that was never attested", async () => {
      const client = fakeClient({ getRationaleHash: vi.fn(async () => undefined) });
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_rationale_hash").handler({ jobId: "3" }, {} as never);
      expect(client.getRationaleHash).toHaveBeenCalledWith(3n);
      expect(result.structuredContent).toMatchObject({ jobId: "3", rationaleHashHex: null });
    });

    it("casper_get_rationale_hash surfaces the attested hash once set", async () => {
      const stored = "cd".repeat(32);
      const client = fakeClient({ getRationaleHash: vi.fn(async () => stored) });
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_rationale_hash").handler({ jobId: "3" }, {} as never);
      expect(result.structuredContent).toMatchObject({ jobId: "3", rationaleHashHex: stored });
    });
  });

  describe("casper_get_x402_settlement_status", () => {
    afterEach(() => {
      delete process.env.CASPER_RPC_URL;
    });

    it("throws a clear error when CASPER_RPC_URL isn't set (independent of KARMA_ODRA_REGISTRY)", async () => {
      const tools = createCasperTools(() => fakeClient());
      await expect(
        find(tools, "casper_get_x402_settlement_status").handler({ txHash: "ab".repeat(32) }, {} as never),
      ).rejects.toThrow(/CASPER_RPC_URL/);
    });
  });

  describe("casper_deactivate_skill / casper_set_min_reputation / casper_set_identity_policy", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "99".repeat(32);
    });

    it("casper_deactivate_skill signs with the owner's resolved agent key and returns the real tx hash", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_deactivate_skill").handler({ agentId: "agent-alpha", skillId: "3" }, {} as never);
      expect(client.deactivateSkill).toHaveBeenCalledWith(SIGNER, 3n);
      expect(result.structuredContent).toMatchObject({ txHash: "tx-deactivate-skill" });
    });

    it("casper_set_min_reputation forwards skillId + minReputation", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_set_min_reputation").handler(
        { agentId: "agent-alpha", skillId: "3", minReputation: 60 },
        {} as never,
      );
      expect(client.setMinReputation).toHaveBeenCalledWith(SIGNER, 3n, 60);
    });

    it("casper_set_identity_policy forwards skillId + policy", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await find(tools, "casper_set_identity_policy").handler(
        { agentId: "agent-alpha", skillId: "3", policy: 2 },
        {} as never,
      );
      expect(client.setIdentityPolicy).toHaveBeenCalledWith(SIGNER, 3n, 2);
    });
  });

  describe("casper_get_provider_jobs / casper_get_requester_jobs / casper_get_agent_skills", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "77".repeat(32);
    });

    it("casper_get_provider_jobs reads the job list for a raw account hash", async () => {
      const client = fakeClient({ getProviderJobs: vi.fn(async () => [1n, 2n, 5n]) });
      const tools = createCasperTools(() => client);
      const foreignHash = "account-hash-" + "aa".repeat(32);
      const result = await find(tools, "casper_get_provider_jobs").handler({ accountHash: foreignHash }, {} as never);
      expect(client.getProviderJobs).toHaveBeenCalledWith(foreignHash);
      expect(result.structuredContent).toMatchObject({ accountHash: foreignHash, jobIds: ["1", "2", "5"] });
    });

    it("casper_get_requester_jobs resolves agentId to an account hash", async () => {
      const client = fakeClient({ getRequesterJobs: vi.fn(async () => [7n]) });
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_requester_jobs").handler({ agentId: "agent-alpha" }, {} as never);
      const expectedHash = casperAccountHash(SIGNER);
      expect(client.getRequesterJobs).toHaveBeenCalledWith(expectedHash);
      expect(result.structuredContent).toMatchObject({ accountHash: expectedHash, jobIds: ["7"] });
    });

    it("casper_get_agent_skills returns an empty list when the agent owns nothing", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const foreignHash = "account-hash-" + "bb".repeat(32);
      const result = await find(tools, "casper_get_agent_skills").handler({ accountHash: foreignHash }, {} as never);
      expect(result.structuredContent).toMatchObject({ accountHash: foreignHash, skillIds: [] });
    });

    it("casper_get_provider_jobs rejects when neither agentId nor accountHash is given", async () => {
      const tools = createCasperTools(() => fakeClient());
      await expect(find(tools, "casper_get_provider_jobs").handler({}, {} as never)).rejects.toThrow(
        /needs agentId or accountHash/,
      );
    });
  });

  describe("casper_get_dispute_info", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "66".repeat(32);
    });

    it("reports found=false when the job has no active dispute", async () => {
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_get_dispute_info").handler({ jobId: "4" }, {} as never);
      expect(result.structuredContent).toMatchObject({ jobId: "4", found: false, dispute: null });
    });

    it("surfaces bond amounts + timestamp once a dispute is active", async () => {
      const client = fakeClient({
        getDisputeInfo: vi.fn(async () => ({
          disputeBondMotes: 500_000n,
          providerBondMotes: 500_000n,
          disputedAt: 1_700_000_000n,
        })),
      });
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_dispute_info").handler({ jobId: "4" }, {} as never);
      expect(result.structuredContent).toMatchObject({
        jobId: "4",
        found: true,
        dispute: { disputeBondMotes: "500000", providerBondMotes: "500000", disputedAt: "1700000000" },
      });
    });
  });

  describe("casper_get_proposal", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "33".repeat(32);
    });

    it("reports found=false for a nonexistent proposal id", async () => {
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_get_proposal").handler({ proposalId: "9" }, {} as never);
      expect(result.structuredContent).toMatchObject({ proposalId: "9", found: false, proposal: null });
    });

    it("decodes a SetArbiter proposal and formats the nested address", async () => {
      const newArbiterHash = "ff".repeat(32);
      const client = fakeClient({
        getProposal: vi.fn(async () => ({
          action: { kind: "SetArbiter" as const, newArbiter: { kind: "Account" as const, hashHex: newArbiterHash } },
          proposer: { kind: "Account" as const, hashHex: "11".repeat(32) },
          proposedAt: 1_700_000_000n,
          executed: false,
          cancelled: false,
        })),
      });
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_proposal").handler({ proposalId: "2" }, {} as never);
      expect(result.structuredContent).toMatchObject({
        proposalId: "2",
        found: true,
        proposal: {
          action: { kind: "SetArbiter", newArbiter: "account-hash-" + newArbiterHash },
          executed: false,
          cancelled: false,
        },
      });
    });
  });
});
