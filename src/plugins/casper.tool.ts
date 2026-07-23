import { z } from "zod/v4";
import casperSdk from "casper-js-sdk";
import type { ToolDefinition, ToolResult } from "../mcp/adapter/tool_registry.js";
import { jsonSafe } from "../lib/serialize.js";
import { keystoreManager } from "../lib/keystore.js";
import { casperAccountHash } from "../lib/casper/keypair.js";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import type { CasperAddress } from "../lib/casper/odra_codec.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";
import { casperSkillIndex, getCasperIndexerHealth } from "../lib/casper_indexer_runtime.js";

const { HttpHandler, RpcClient } = casperSdk;

/**
 * Casper skill-registry plugin (T13-live) — makes the Odra `AgentSkillRegistry` reachable
 * through KARMA's MCP tool surface, the same way `karma.tool.ts` exposes Pharos. Before this,
 * every Casper on-chain action (register_skill, create_job, …) only existed as a standalone
 * script (`register_rwa_oracle_skill.ts`, `demo_casper_e2e.ts`) — invisible to an MCP-connected
 * agent, and a poor fit for a project whose whole pitch is "a real, full MCP server". These
 * tools wrap `CasperLiveClient` 1:1 so any MCP client can drive the RWA-oracle flow directly.
 *
 * MUST run in-process, same reasoning as karma.tool.ts / t3.tool.ts: relies on the in-process
 * keystore singleton and CASPER_* env vars, neither of which survive the external child-process
 * plugin worker.
 */
function assertInProcess(): void {
  if (!isTrustedRuntime() || process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] casper.tool.ts must run in the trusted in-process runtime, not the external worker. " +
        "Add it to isTrustedBuiltInPlugin() and MCP_PLUGIN_ALLOWLIST, and keep MCP_PLUGIN_ISOLATION_MODE=policy.",
    );
  }
}

const PHASES = ["intake", "execution", "review", "completed"] as const;
const HEX32 = z.string().regex(/^[0-9a-fA-F]{64}$/, "expected 32 bytes as 64 hex chars");
const MOTES = z.string().regex(/^[0-9]+$/, "expected a base-10 motes string");

function reply(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: jsonSafe(structured) };
}

/** Formats a decoded `CasperAddress` (see `odra_codec.ts`) as the same prefixed-string
 *  convention every other tool here already accepts as input (`"account-hash-<hex>"` for a
 *  user/agent account, `"hash-<hex>"` for a contract) — round-trips through `accountAddressToBytes`
 *  and the `"account-hash-..."` / `"hash-..."` args documented across this file. */
function formatCasperAddress(addr: CasperAddress): string {
  return addr.kind === "Account" ? `account-hash-${addr.hashHex}` : `hash-${addr.hashHex}`;
}

/** CASPER_RPC_URL / CASPER_CONTRACT_HASH follow the same direct-process.env convention as
 *  `odra_registry.ts` and `register_rwa_oracle_skill.ts` (not the central `ENV` module — Casper
 *  wiring is opt-in and off by default, unlike Pharos's always-validated env block). */
function requireCasperEnv(): { rpcUrl: string; contractHash: string; chainName: string } {
  const rpcUrl = process.env.CASPER_RPC_URL;
  const contractHash = process.env.KARMA_ODRA_REGISTRY ?? process.env.CASPER_CONTRACT_HASH;
  if (!rpcUrl || !contractHash) {
    throw new Error(
      "[KARMA] Casper not configured — set CASPER_RPC_URL and KARMA_ODRA_REGISTRY (the deployed " +
        "contract package hash) to enable these tools. See DEMO_CASPER.md §Live run.",
    );
  }
  return { rpcUrl, contractHash, chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test" };
}

function requireSigner(agentId: string) {
  if (!keystoreManager.has(agentId)) {
    throw new Error(`[KARMA] Agent '${agentId}' not found in keystore. Run setup:keystore first.`);
  }
  return keystoreManager.getCasperKeypair(agentId);
}

/** The exact `CasperLiveClient` surface these tools call — narrowed to a type so tests can
 *  inject a fake without a real RPC endpoint, mirroring `createKarmaTools(svc: KarmaService)`. */
export type CasperClientLike = Pick<
  CasperLiveClient,
  | "registerSkill"
  | "depositBond"
  | "createJob"
  | "deliverResult"
  | "confirmCompletion"
  | "claimAfterReview"
  | "claimRefund"
  | "withdraw"
  | "pendingWithdrawalsOf"
  | "agentReputationOf"
  | "bondedOf"
  | "getSkill"
  | "getJob"
  | "isComposite"
  | "registerComposition"
  | "getComposition"
  | "createJobWithEvaluator"
  | "evaluateResult"
  | "disputeResult"
  | "respondToDispute"
  | "concedeDispute"
  | "resolveDefaultConcede"
  | "arbitrate"
  | "getCrossChainRep"
  | "proposeSetCrossChainRep"
  | "proposeSetArbiter"
  | "proposeSetDisputeBondBps"
  | "approveProposal"
  | "executeProposal"
  | "cancelProposal"
  | "attestRationale"
  | "getRationaleHash"
  | "getArbiter"
  | "getGovernanceSigners"
  | "getGovernanceThreshold"
  | "getTimelockDelayMs"
  | "deactivateSkill"
  | "setMinReputation"
  | "setIdentityPolicy"
  | "getProviderJobs"
  | "getRequesterJobs"
  | "getAgentSkills"
  | "getDisputeInfo"
  | "getProposal"
  | "proposeSetArbiterPanel"
  | "proposeSetPanelArbiterFee"
  | "disputeResultViaPanel"
  | "castPanelVote"
  | "resolvePanelDefault"
  | "getArbiterPanel"
  | "getPanelThreshold"
>;

export function createCasperTools(
  makeClient: (env: { rpcUrl: string; contractHash: string; chainName: string }) => CasperClientLike = (env) =>
    new CasperLiveClient(env),
): ToolDefinition[] {
  const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  const casperHealth: ToolDefinition = {
    name: "casper_health",
    description:
      "Report whether the Casper Odra AgentSkillRegistry rail is configured (CASPER_RPC_URL + " +
      "KARMA_ODRA_REGISTRY). Run first — the other casper_* tools throw a clear error otherwise.",
    inputSchema: {},
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async () => {
      assertInProcess();
      const rpcUrl = process.env.CASPER_RPC_URL;
      const contractHash = process.env.KARMA_ODRA_REGISTRY ?? process.env.CASPER_CONTRACT_HASH;
      const configured = Boolean(rpcUrl && contractHash);
      const indexer = getCasperIndexerHealth();
      return reply(`[KARMA] Casper: configured=${configured}` + (configured ? ` contract=${contractHash}` : ""), {
        configured,
        rpcUrl: rpcUrl ?? null,
        contractHash: contractHash ?? null,
        chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test",
        indexer,
      });
    },
  };

  const casperDiscoverSkills: ToolDefinition = {
    name: "casper_discover_skills",
    description:
      "Search Casper's discovery index by free text, ranked by relevance and reputation " +
      "(same BM25 engine as Pharos's discover_skills, backed by a SEPARATE index — Casper skill " +
      "ids are chain-local, not merged with Pharos's). Populated by the Casper event indexer " +
      "(casper_indexer_runtime.ts); empty until it has backfilled at least once.",
    inputSchema: {
      query: z.string(),
      maxPriceMotes: MOTES.optional(),
      minReputation: z.number().int().min(0).max(100).optional(),
      limit: z.number().int().positive().max(50).optional(),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: { ...readAnnotations, openWorldHint: false },
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        query: z.string(),
        maxPriceMotes: MOTES.optional(),
        minReputation: z.number().int().min(0).max(100).optional(),
        limit: z.number().int().positive().max(50).optional(),
      }).parse(args);
      const skills = casperSkillIndex.search(a.query, {
        maxPriceWei: a.maxPriceMotes != null ? BigInt(a.maxPriceMotes) : undefined,
        minReputation: a.minReputation,
        limit: a.limit,
      });
      return reply(`[KARMA] casper_discover_skills found ${skills.length} match(es)`, { count: skills.length, skills });
    },
  };

  const casperRegisterSkill: ToolDefinition = {
    name: "casper_register_skill",
    description:
      "Register a skill on Casper's Odra AgentSkillRegistry — a real signed casper-js-sdk " +
      "transaction, not a simulation. Mirrors the Solidity/Pharos register_skill, with the RWA-" +
      "oracle's identityPolicy gate. Returns the real transaction hash once broadcast.",
    inputSchema: {
      agentId: z.string().describe("Keystore agent id that owns/signs this skill."),
      name: z.string().min(1),
      description: z.string().default(""),
      mcpEndpoint: z.string().default(""),
      pricePerCallMotes: MOTES.describe("Price per call in CSPR motes (9 decimals), as a base-10 string."),
      minReputationToInvoke: z.number().int().min(0).max(100).default(0),
      identityPolicy: z.number().int().min(0).max(255).default(0)
        .describe("0 = open, 1 = require a verified did:t3n, 2 = require a FRESH did:t3n."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        name: z.string().min(1),
        description: z.string().default(""),
        mcpEndpoint: z.string().default(""),
        pricePerCallMotes: MOTES,
        minReputationToInvoke: z.number().int().min(0).max(100).default(0),
        identityPolicy: z.number().int().min(0).max(255).default(0),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.registerSkill(signer, {
        name: a.name,
        description: a.description,
        mcpEndpoint: a.mcpEndpoint,
        pricePerCallMotes: BigInt(a.pricePerCallMotes),
        minReputationToInvoke: a.minReputationToInvoke,
        identityPolicy: a.identityPolicy,
      });
      return reply(`[KARMA] casper_register_skill broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperDepositBond: ToolDefinition = {
    name: "casper_deposit_bond",
    description:
      "Deposit a Tier-2 Sybil-resistance bond (PD-007) for the given agent on the Odra registry " +
      "— a real payable casper-js-sdk transaction. Required before a provider's reputation seeds " +
      "into flow_reputation's off-chain trust graph.",
    inputSchema: {
      agentId: z.string(),
      amountMotes: MOTES.describe("Bond amount in CSPR motes, as a base-10 string."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), amountMotes: MOTES }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.depositBond(signer, BigInt(a.amountMotes));
      return reply(`[KARMA] casper_deposit_bond broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperCreateJob: ToolDefinition = {
    name: "casper_create_job",
    description:
      "Create a job against a skill on the Odra registry, escrowing CSPR in the same payable " +
      "transaction (create_job's `amount` arg must equal the skill's price_per_call). Pair with " +
      "an x402 envelope (x402_casper.ts) for the fast-lane payment-intent leg off-chain.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id — signs and pays the escrow."),
      skillId: z.string().regex(/^[0-9]+$/).describe("Skill id (u64) from casper_register_skill."),
      taskHashHex: HEX32.describe("32-byte task hash (hex, no 0x prefix) binding this job to its off-chain parameters."),
      deadlineSecs: z.string().regex(/^[0-9]+$/).describe("Review-window deadline, seconds from now."),
      escrowMotes: MOTES.describe("Must equal the skill's price_per_call, in motes."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        skillId: z.string().regex(/^[0-9]+$/),
        taskHashHex: HEX32,
        deadlineSecs: z.string().regex(/^[0-9]+$/),
        escrowMotes: MOTES,
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.createJob(signer, {
        skillId: BigInt(a.skillId),
        taskHashHex: a.taskHashHex,
        deadlineSecs: BigInt(a.deadlineSecs),
        escrowMotes: BigInt(a.escrowMotes),
      });
      return reply(`[KARMA] casper_create_job broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperDeliverResult: ToolDefinition = {
    name: "casper_deliver_result",
    description: "Provider records a result hash for a job, opening the review window (deliver_result).",
    inputSchema: {
      agentId: z.string().describe("Provider's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      resultHashHex: HEX32,
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        jobId: z.string().regex(/^[0-9]+$/),
        resultHashHex: HEX32,
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.deliverResult(signer, { jobId: BigInt(a.jobId), resultHashHex: a.resultHashHex });
      return reply(`[KARMA] casper_deliver_result broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperConfirmCompletion: ToolDefinition = {
    name: "casper_confirm_completion",
    description: "Requester confirms a delivered job — releases escrow to the provider's pull-payment ledger and bumps reputation (arm's-length only).",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.confirmCompletion(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_confirm_completion broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperClaimAfterReview: ToolDefinition = {
    name: "casper_claim_after_review",
    description:
      "Anti-deadlock path: the provider claims escrow once the review window has elapsed with " +
      "no casper_confirm_completion or casper_dispute_result from the requester. Reverts " +
      "ReviewWindowOpen while the window is still open, NotProvider for anyone else.",
    inputSchema: {
      agentId: z.string().describe("Provider's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.claimAfterReview(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_claim_after_review broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperWithdraw: ToolDefinition = {
    name: "casper_withdraw",
    description: "Pull the caller's full released-escrow balance from the Odra registry's pull-payment ledger (CEI — zeroed on-chain before transfer).",
    inputSchema: { agentId: z.string() },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.withdraw(signer);
      return reply(`[KARMA] casper_withdraw broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperGetAccountState: ToolDefinition = {
    name: "casper_get_account_state",
    description:
      "Read an agent's on-chain state on the Odra registry directly from the 'state' dictionary " +
      "(pending withdrawable balance, reputation 0-100, bonded Sybil-resistance amount) — a real " +
      "global-state query, not a cached/off-chain estimate.",
    inputSchema: {
      agentId: z.string().optional().describe("Keystore agent id — resolves its Casper account hash. Provide this OR accountHash."),
      accountHash: z.string().optional().describe("Raw 'account-hash-...' string, for reading an agent not in this keystore."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), accountHash: z.string().optional() }).parse(args);
      if (!a.agentId && !a.accountHash) throw new Error("[KARMA] casper_get_account_state needs agentId or accountHash");
      const env = requireCasperEnv();
      const accountHash = a.accountHash ?? casperAccountHash(requireSigner(a.agentId!));
      const client = makeClient(env);
      const [pendingWithdrawalsMotes, reputation, bondedMotes] = await Promise.all([
        client.pendingWithdrawalsOf(accountHash),
        client.agentReputationOf(accountHash),
        client.bondedOf(accountHash),
      ]);
      return reply(
        `[KARMA] ${accountHash}: pending=${pendingWithdrawalsMotes} motes rep=${reputation}/100 bonded=${bondedMotes} motes`,
        { accountHash, pendingWithdrawalsMotes, reputation, bondedMotes },
      );
    },
  };

  const casperGetSkill: ToolDefinition = {
    name: "casper_get_skill",
    description:
      "Read a skill's full on-chain record directly from the Odra registry's 'state' dictionary " +
      "(owner, name/description/mcpEndpoint, price, reputation, active flag, registeredAt, trust " +
      "gates) plus whether it's a composite (has a Composition record) — a real global-state " +
      "query, not a cached/off-chain estimate.",
    inputSchema: { skillId: z.string().regex(/^[0-9]+$/).describe("Skill id (u64) from casper_register_skill.") },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ skillId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const client = makeClient(env);
      const skillId = BigInt(a.skillId);
      const [skill, isComposite] = await Promise.all([client.getSkill(skillId), client.isComposite(skillId)]);
      if (!skill) {
        return reply(`[KARMA] skill ${a.skillId} is not registered`, { skillId: a.skillId, found: false, skill: null });
      }
      return reply(
        `[KARMA] skill ${a.skillId}: ${skill.name} (active=${skill.active}, rep=${skill.reputationScore}/100)`,
        {
          skillId: a.skillId,
          found: true,
          skill: {
            owner: formatCasperAddress(skill.owner),
            name: skill.name,
            description: skill.description,
            mcpEndpoint: skill.mcpEndpoint,
            pricePerCallMotes: skill.pricePerCallMotes.toString(),
            reputationScore: skill.reputationScore,
            totalInvocations: skill.totalInvocations.toString(),
            active: skill.active,
            registeredAt: skill.registeredAt.toString(),
            minReputationToInvoke: skill.minReputationToInvoke,
            identityPolicy: skill.identityPolicy,
            isComposite,
          },
        },
      );
    },
  };

  const casperGetJob: ToolDefinition = {
    name: "casper_get_job",
    description:
      "Read a job's full on-chain record directly from the Odra registry's 'state' dictionary " +
      "(requester/provider, skill id, escrow, deadline/status, result hash, evaluator) — a real " +
      "global-state query, not a cached/off-chain estimate.",
    inputSchema: { jobId: z.string().regex(/^[0-9]+$/).describe("Job id (u64) from casper_create_job.") },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ jobId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const client = makeClient(env);
      const job = await client.getJob(BigInt(a.jobId));
      if (!job) {
        return reply(`[KARMA] job ${a.jobId} does not exist`, { jobId: a.jobId, found: false, job: null });
      }
      return reply(`[KARMA] job ${a.jobId}: status=${job.status} escrow=${job.escrowAmountMotes} motes`, {
        jobId: a.jobId,
        found: true,
        job: {
          requester: formatCasperAddress(job.requester),
          provider: formatCasperAddress(job.provider),
          skillId: job.skillId.toString(),
          taskHashHex: Buffer.from(job.taskHash).toString("hex"),
          escrowAmountMotes: job.escrowAmountMotes.toString(),
          deadline: job.deadline.toString(),
          status: job.status,
          resultHashHex: Buffer.from(job.resultHash).toString("hex"),
          createdAt: job.createdAt.toString(),
          completedAt: job.completedAt.toString(),
          evaluator: job.evaluator ? formatCasperAddress(job.evaluator) : null,
          evaluatorFeeMotes: job.evaluatorFeeMotes.toString(),
        },
      });
    },
  };

  const casperClaimRefund: ToolDefinition = {
    name: "casper_claim_refund",
    description:
      "Requester reclaims escrow (+ evaluator fee, if the job had one) for a job whose provider " +
      "never delivered before the deadline (claim_refund) — a real signed transaction. Reverts " +
      "NotRequester if the caller isn't the job's requester, NotRefundable unless the job is " +
      "still Open (a delivered/disputed job can't be refunded this way — see " +
      "casper_dispute_result instead), and BeforeDeadline until the deadline has actually passed.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.claimRefund(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_claim_refund broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperRegisterComposition: ToolDefinition = {
    name: "casper_register_composition",
    description:
      "Register a composite skill on the Odra registry: a wrapper that fans one job's escrow " +
      "out across 1-8 existing leaf skills by a basis-points weight vector (Σ = 10000). A real " +
      "signed transaction — the wrapper is stored as a normal skill (same id space) plus a " +
      "Composition record. On-chain checks reject a mismatched weight length/sum, an inactive or " +
      "already-composite leaf, or more than 8 leaves. Returns the composite's skill id.",
    inputSchema: {
      agentId: z.string().describe("Keystore agent id that owns/signs this composite skill."),
      name: z.string().min(1),
      description: z.string().default(""),
      mcpEndpoint: z.string().default(""),
      pricePerCallMotes: MOTES.describe("Price per call in CSPR motes, as a base-10 string."),
      minReputationToInvoke: z.number().int().min(0).max(100).default(0),
      identityPolicy: z.number().int().min(0).max(255).default(0),
      leafSkillIds: z.array(z.string().regex(/^[0-9]+$/)).min(1).max(8)
        .describe("Existing, active, non-composite skill ids (u64 strings) this composite pays out to."),
      weightsBps: z.array(z.number().int().min(0).max(10_000)).min(1).max(8)
        .describe("Basis-points weights, same length/order as leafSkillIds; must sum to exactly 10000."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        name: z.string().min(1),
        description: z.string().default(""),
        mcpEndpoint: z.string().default(""),
        pricePerCallMotes: MOTES,
        minReputationToInvoke: z.number().int().min(0).max(100).default(0),
        identityPolicy: z.number().int().min(0).max(255).default(0),
        leafSkillIds: z.array(z.string().regex(/^[0-9]+$/)).min(1).max(8),
        weightsBps: z.array(z.number().int().min(0).max(10_000)).min(1).max(8),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.registerComposition(signer, {
        name: a.name,
        description: a.description,
        mcpEndpoint: a.mcpEndpoint,
        pricePerCallMotes: BigInt(a.pricePerCallMotes),
        minReputationToInvoke: a.minReputationToInvoke,
        identityPolicy: a.identityPolicy,
        leafSkillIds: a.leafSkillIds.map((id) => BigInt(id)),
        weightsBps: a.weightsBps,
      });
      return reply(`[KARMA] casper_register_composition broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperGetComposition: ToolDefinition = {
    name: "casper_get_composition",
    description:
      "Read a skill's composition manifest directly from the Odra registry's 'state' dictionary " +
      "— leaf skill ids + basis-points weights, or isComposite=false if the id is a primitive " +
      "skill (no Composition record).",
    inputSchema: { skillId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ skillId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const client = makeClient(env);
      const composition = await client.getComposition(BigInt(a.skillId));
      if (!composition) {
        return reply(`[KARMA] skill ${a.skillId} is a primitive skill (no composition record)`, {
          skillId: a.skillId,
          isComposite: false,
          composition: null,
        });
      }
      return reply(
        `[KARMA] skill ${a.skillId} is composite: ${composition.leafSkillIds.length} leaves`,
        {
          skillId: a.skillId,
          isComposite: true,
          composition: {
            leafSkillIds: composition.leafSkillIds.map(String),
            weightsBps: composition.weightsBps,
          },
        },
      );
    },
  };

  const casperCreateJobWithEvaluator: ToolDefinition = {
    name: "casper_create_job_with_evaluator",
    description:
      "Create a job with a neutral third-party evaluator (P0-A) instead of the requester " +
      "reviewing directly — a real payable transaction. escrowMotes must equal exactly the " +
      "skill's price_per_call + evaluatorFeeMotes; the evaluator fee releases to the evaluator " +
      "once they call casper_evaluate_result, regardless of verdict.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id — signs and pays the escrow + evaluator fee."),
      skillId: z.string().regex(/^[0-9]+$/),
      taskHashHex: HEX32,
      deadlineSecs: z.string().regex(/^[0-9]+$/),
      evaluatorAccountHash: z.string().describe("The evaluator's 'account-hash-<hex>' — must differ from the requester."),
      evaluatorFeeMotes: MOTES,
      escrowMotes: MOTES.describe("Must equal exactly price_per_call + evaluatorFeeMotes."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        skillId: z.string().regex(/^[0-9]+$/),
        taskHashHex: HEX32,
        deadlineSecs: z.string().regex(/^[0-9]+$/),
        evaluatorAccountHash: z.string(),
        evaluatorFeeMotes: MOTES,
        escrowMotes: MOTES,
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.createJobWithEvaluator(signer, {
        skillId: BigInt(a.skillId),
        taskHashHex: a.taskHashHex,
        deadlineSecs: BigInt(a.deadlineSecs),
        evaluatorAccountHash: a.evaluatorAccountHash,
        evaluatorFeeMotes: BigInt(a.evaluatorFeeMotes),
        escrowMotes: BigInt(a.escrowMotes),
      });
      return reply(`[KARMA] casper_create_job_with_evaluator broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperEvaluateResult: ToolDefinition = {
    name: "casper_evaluate_result",
    description:
      "The job's designated evaluator approves or rejects a delivered result within the review " +
      "window. Approve settles like confirm_completion; reject settles like a dispute loss for " +
      "the provider. The evaluator's fee releases either way.",
    inputSchema: {
      agentId: z.string().describe("Evaluator's keystore agent id — must match the job's designated evaluator."),
      jobId: z.string().regex(/^[0-9]+$/),
      approved: z.boolean(),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/), approved: z.boolean() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.evaluateResult(signer, BigInt(a.jobId), a.approved);
      return reply(`[KARMA] casper_evaluate_result broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperDisputeResult: ToolDefinition = {
    name: "casper_dispute_result",
    description:
      "P1-A: requester contests a delivered result within the review window by posting a bond " +
      "(basis points of escrow, per casper_get_account_state's dispute-bond-bps view, floored at " +
      "the contract's MIN_DISPUTE_BOND_MOTES) — a real payable transaction. bondMotes must equal " +
      "the required amount exactly or the call reverts with WrongDisputeBond.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      bondMotes: MOTES.describe("Must equal the exact required dispute bond, in motes."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/), bondMotes: MOTES }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.disputeResult(signer, BigInt(a.jobId), BigInt(a.bondMotes));
      return reply(`[KARMA] casper_dispute_result broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperRespondToDispute: ToolDefinition = {
    name: "casper_respond_to_dispute",
    description:
      "P1-A: provider matches the requester's dispute bond exactly to contest (enter " +
      "arbitration), within RESPONSE_WINDOW of the dispute — a real payable transaction. If the " +
      "provider never responds, anyone can call casper_resolve_default_concede instead.",
    inputSchema: {
      agentId: z.string().describe("Provider's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      bondMotes: MOTES.describe("Must equal the requester's posted dispute bond exactly, in motes."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/), bondMotes: MOTES }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.respondToDispute(signer, BigInt(a.jobId), BigInt(a.bondMotes));
      return reply(`[KARMA] casper_respond_to_dispute broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperConcedeDispute: ToolDefinition = {
    name: "casper_concede_dispute",
    description: "Provider concedes a dispute — forfeits both bonds + escrow to the requester, and freezes reputation (no rep bump/slash).",
    inputSchema: { agentId: z.string().describe("Provider's keystore agent id."), jobId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.concedeDispute(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_concede_dispute broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperResolveDefaultConcede: ToolDefinition = {
    name: "casper_resolve_default_concede",
    description:
      "Anyone may call this once the provider's RESPONSE_WINDOW elapses with no " +
      "casper_respond_to_dispute call — resolves identically to the provider conceding.",
    inputSchema: { jobId: z.string().regex(/^[0-9]+$/), callerAgentId: z.string().describe("Any keystore agent id — this call has no access-control beyond the elapsed window.") },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ jobId: z.string().regex(/^[0-9]+$/), callerAgentId: z.string() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.callerAgentId);
      const client = makeClient(env);
      const { txHash } = await client.resolveDefaultConcede(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_resolve_default_concede broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperArbitrate: ToolDefinition = {
    name: "casper_arbitrate",
    description:
      "Arbiter-only: adjudicates a contested dispute (both sides bonded via " +
      "casper_dispute_result + casper_respond_to_dispute) — loser pays both bonds + escrow to " +
      "the winner. Reverts NotArbiter if the caller isn't the contract's current arbiter.",
    inputSchema: {
      agentId: z.string().describe("Arbiter's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      verdict: z.enum(["ProviderAtFault", "RequesterAtFault"]),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        jobId: z.string().regex(/^[0-9]+$/),
        verdict: z.enum(["ProviderAtFault", "RequesterAtFault"]),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.arbitrate(signer, BigInt(a.jobId), a.verdict);
      return reply(`[KARMA] casper_arbitrate broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperDisputeResultViaPanel: ToolDefinition = {
    name: "casper_dispute_result_via_panel",
    description:
      "P4-A: like casper_dispute_result, but flags the job for N-of-M panel arbitration instead " +
      "of the single arbiter — a real payable transaction. bondPlusFeeMotes must equal the " +
      "required dispute bond PLUS the flat panel-arbiter fee, combined (NOT just the bond alone " +
      "— the contract attaches both in one transfer). Reverts PanelNotConfigured if governance " +
      "hasn't set a panel yet, WrongPanelDisputeAmount on a mismatch.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      bondPlusFeeMotes: MOTES.describe("Required dispute bond + panel_arbiter_fee, combined, in motes."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        jobId: z.string().regex(/^[0-9]+$/),
        bondPlusFeeMotes: MOTES,
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.disputeResultViaPanel(signer, BigInt(a.jobId), BigInt(a.bondPlusFeeMotes));
      return reply(`[KARMA] casper_dispute_result_via_panel broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperCastPanelVote: ToolDefinition = {
    name: "casper_cast_panel_vote",
    description:
      "P4-A: panel-member only — cast one vote on a panel-mode dispute (membership checked " +
      "against the dispute's own snapshot, not the live governance panel). Settles automatically " +
      "and pays every voter once enough votes agree on one verdict — no separate 'execute' call. " +
      "Reverts NotPanelArbiter, AlreadyVotedOnPanel, or WrongArbitrationMode as appropriate.",
    inputSchema: {
      agentId: z.string().describe("Panel arbiter's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      verdict: z.enum(["ProviderAtFault", "RequesterAtFault"]),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        jobId: z.string().regex(/^[0-9]+$/),
        verdict: z.enum(["ProviderAtFault", "RequesterAtFault"]),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.castPanelVote(signer, BigInt(a.jobId), a.verdict);
      return reply(`[KARMA] casper_cast_panel_vote broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperResolvePanelDefault: ToolDefinition = {
    name: "casper_resolve_panel_default",
    description:
      "P4-A: anyone may call once PANEL_VOTE_WINDOW elapses without the panel reaching its " +
      "threshold — resolves ProviderAtFault (same default direction as " +
      "casper_resolve_default_concede) and still pays whichever arbiters DID vote.",
    inputSchema: {
      jobId: z.string().regex(/^[0-9]+$/),
      callerAgentId: z.string().describe("Any keystore agent id — no access control beyond the elapsed window."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ jobId: z.string().regex(/^[0-9]+$/), callerAgentId: z.string() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.callerAgentId);
      const client = makeClient(env);
      const { txHash } = await client.resolvePanelDefault(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_resolve_panel_default broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperGetCrossChainRep: ToolDefinition = {
    name: "casper_get_cross_chain_rep",
    description:
      "Read an agent's cross-chain reputation attestation (0-100, or 0 if never set) directly " +
      "from the Odra registry's 'state' dictionary — the P0.1 bridge value set through the " +
      "propose/approve/execute governance lifecycle below.",
    inputSchema: {
      agentId: z.string().optional().describe("Keystore agent id — resolves its Casper account hash. Provide this OR accountHash."),
      accountHash: z.string().optional().describe("Raw 'account-hash-...' string, for reading an agent not in this keystore."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), accountHash: z.string().optional() }).parse(args);
      if (!a.agentId && !a.accountHash) throw new Error("[KARMA] casper_get_cross_chain_rep needs agentId or accountHash");
      const env = requireCasperEnv();
      const accountHash = a.accountHash ?? casperAccountHash(requireSigner(a.agentId!));
      const client = makeClient(env);
      const score = await client.getCrossChainRep(accountHash);
      return reply(`[KARMA] ${accountHash}: cross_chain_rep=${score}/100`, { accountHash, score });
    },
  };

  const casperGetGovernanceState: ToolDefinition = {
    name: "casper_get_governance_state",
    description:
      "Read the Odra registry's full governance configuration in one round trip — multisig " +
      "signers, approval threshold, timelock delay (ms), the current dispute arbiter, and the " +
      "N-of-M panel (P4-A: arbiterPanel + panelThreshold, empty/0 if governance hasn't set one) " +
      "— directly from the 'state' dictionary's Var fields (mirrors get_governance_signers/" +
      "get_governance_threshold/get_timelock_delay/get_arbiter/get_arbiter_panel/" +
      "get_panel_threshold), instead of six separate casper_* round-trips.",
    inputSchema: {},
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async () => {
      assertInProcess();
      const env = requireCasperEnv();
      const client = makeClient(env);
      const [signers, threshold, timelockDelayMs, arbiter, panel, panelThreshold] = await Promise.all([
        client.getGovernanceSigners(),
        client.getGovernanceThreshold(),
        client.getTimelockDelayMs(),
        client.getArbiter(),
        client.getArbiterPanel(),
        client.getPanelThreshold(),
      ]);
      return reply(
        `[KARMA] governance: ${signers.length} signer(s), threshold=${threshold}, ` +
          `timelock=${timelockDelayMs}ms, arbiter=${arbiter ? formatCasperAddress(arbiter) : "unset"}, ` +
          `panel=${panel.length} member(s) (threshold=${panelThreshold})`,
        {
          signers: signers.map(formatCasperAddress),
          threshold,
          timelockDelayMs: timelockDelayMs.toString(),
          arbiter: arbiter ? formatCasperAddress(arbiter) : null,
          panel: panel.map(formatCasperAddress),
          panelThreshold,
        },
      );
    },
  };

  const casperProposeSetCrossChainRep: ToolDefinition = {
    name: "casper_propose_set_cross_chain_rep",
    description:
      "P0-B: propose a cross-chain reputation attestation for an agent (e.g. bridged from a " +
      "Stellar ZK credential or a Pharos history). Governance-signer only; the proposer's own " +
      "approval counts automatically. Takes effect only after casper_approve_proposal reaches " +
      "the configured threshold AND casper_execute_proposal is called once the timelock elapses " +
      "— no single-signer immediate-effect path.",
    inputSchema: {
      agentId: z.string().describe("A governance-signer's keystore agent id."),
      targetAccountHash: z.string().describe("The 'account-hash-<hex>' of the agent being attested."),
      score: z.number().int().min(0).max(100),
      sourceChain: z.string().describe("Free-form origin label, e.g. 'stellar' or 'pharos'."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        targetAccountHash: z.string(),
        score: z.number().int().min(0).max(100),
        sourceChain: z.string(),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.proposeSetCrossChainRep(signer, a.targetAccountHash, a.score, a.sourceChain);
      return reply(`[KARMA] casper_propose_set_cross_chain_rep broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperProposeSetArbiter: ToolDefinition = {
    name: "casper_propose_set_arbiter",
    description:
      "P0-B: propose a new arbiter address. Governance-signer only; same propose/approve/execute " +
      "+ timelock lifecycle as casper_propose_set_cross_chain_rep — no single-signer bypass.",
    inputSchema: {
      agentId: z.string().describe("A governance-signer's keystore agent id."),
      newArbiterAccountHash: z.string().describe("The 'account-hash-<hex>' of the proposed new arbiter."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), newArbiterAccountHash: z.string() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.proposeSetArbiter(signer, a.newArbiterAccountHash);
      return reply(`[KARMA] casper_propose_set_arbiter broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperProposeSetDisputeBondBps: ToolDefinition = {
    name: "casper_propose_set_dispute_bond_bps",
    description:
      "P0-B: propose a new dispute-bond basis-points value (10000 = 1x escrow). Governance-signer " +
      "only; same propose/approve/execute + timelock lifecycle as the other propose_* tools.",
    inputSchema: {
      agentId: z.string().describe("A governance-signer's keystore agent id."),
      bps: z.number().int().min(0),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), bps: z.number().int().min(0) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.proposeSetDisputeBondBps(signer, a.bps);
      return reply(`[KARMA] casper_propose_set_dispute_bond_bps broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperProposeSetArbiterPanel: ToolDefinition = {
    name: "casper_propose_set_arbiter_panel",
    description:
      "P4-A: propose a new N-of-M arbiter panel (odd size, MIN_ARBITER_PANEL_SIZE..=" +
      "MAX_ARBITER_PANEL_SIZE, threshold must be a strict majority — panel.length / 2 + 1). " +
      "Governance-signer only; same propose/approve/execute + timelock lifecycle as " +
      "casper_propose_set_arbiter — no single-signer bypass.",
    inputSchema: {
      agentId: z.string().describe("A governance-signer's keystore agent id."),
      panel: z.array(z.string()).describe("Arbiter 'account-hash-<hex>' addresses — length must be odd, >= 3, no duplicates."),
      threshold: z.number().int().min(1).describe("Must equal panel.length / 2 + 1 (strict majority)."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        panel: z.array(z.string()),
        threshold: z.number().int().min(1),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.proposeSetArbiterPanel(signer, a.panel, a.threshold);
      return reply(`[KARMA] casper_propose_set_arbiter_panel broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperProposeSetPanelArbiterFee: ToolDefinition = {
    name: "casper_propose_set_panel_arbiter_fee",
    description:
      "P4-A: propose a new flat panel-arbiter fee (motes) — paid to every panel member who " +
      "votes on a panel-mode dispute before PANEL_VOTE_WINDOW elapses, on top of the dispute " +
      "bond. Governance-signer only; same propose/approve/execute + timelock lifecycle as the " +
      "other propose_* tools.",
    inputSchema: {
      agentId: z.string().describe("A governance-signer's keystore agent id."),
      feeMotes: MOTES,
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), feeMotes: MOTES }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.proposeSetPanelArbiterFee(signer, BigInt(a.feeMotes));
      return reply(`[KARMA] casper_propose_set_panel_arbiter_fee broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperApproveProposal: ToolDefinition = {
    name: "casper_approve_proposal",
    description: "Approve a pending governance proposal. Governance-signer only; each signer may approve once.",
    inputSchema: { agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.approveProposal(signer, BigInt(a.proposalId));
      return reply(`[KARMA] casper_approve_proposal broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperExecuteProposal: ToolDefinition = {
    name: "casper_execute_proposal",
    description:
      "Execute a governance proposal once the approval threshold is met AND the timelock delay " +
      "has elapsed since it was created. Anyone may call this — the gating is entirely on-chain.",
    inputSchema: { agentId: z.string().describe("Any keystore agent id — pays gas, no access-control beyond threshold+timelock."), proposalId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.executeProposal(signer, BigInt(a.proposalId));
      return reply(`[KARMA] casper_execute_proposal broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperCancelProposal: ToolDefinition = {
    name: "casper_cancel_proposal",
    description: "Cancel a pending (not yet executed) governance proposal. Governance-signer only.",
    inputSchema: { agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.cancelProposal(signer, BigInt(a.proposalId));
      return reply(`[KARMA] casper_cancel_proposal broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperAttestRationale: ToolDefinition = {
    name: "casper_attest_rationale",
    description:
      "P2-A: commit a 32-byte hash of the (typically LLM-generated) decision rationale for why " +
      "this job was created, on-chain — an immutable, independently-checkable anchor without " +
      "KARMA storing (or paying gas for) the plaintext rationale itself. Requester-only " +
      "(matching the job's requester), set-once (re-attesting the same job reverts). Callers " +
      "hash their own rationale text (e.g. blake2b/keccak256) before calling this.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id — must match the job's requester."),
      jobId: z.string().regex(/^[0-9]+$/).describe("Job id returned by casper_create_job / casper_create_job_with_evaluator."),
      rationaleHashHex: HEX32.describe("32-byte hash (hex, no 0x prefix) of the plaintext decision rationale."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        jobId: z.string().regex(/^[0-9]+$/),
        rationaleHashHex: HEX32,
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.attestRationale(signer, BigInt(a.jobId), Buffer.from(a.rationaleHashHex, "hex"));
      return reply(`[KARMA] casper_attest_rationale broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperGetRationaleHash: ToolDefinition = {
    name: "casper_get_rationale_hash",
    description:
      "Read the attested decision-rationale hash for a job directly from the Odra registry's " +
      "'state' dictionary. null when the requester never called casper_attest_rationale for it " +
      "(most jobs — attestation is opt-in, e.g. only agent-reasoning-driven jobs use it).",
    inputSchema: {
      jobId: z.string().regex(/^[0-9]+$/).describe("Job id to look up."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ jobId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const client = makeClient(env);
      const rationaleHashHex = await client.getRationaleHash(BigInt(a.jobId));
      return reply(
        rationaleHashHex
          ? `[KARMA] job #${a.jobId} rationale_hash=${rationaleHashHex}`
          : `[KARMA] job #${a.jobId} has no attested rationale`,
        { jobId: a.jobId, rationaleHashHex: rationaleHashHex ?? null },
      );
    },
  };

  const casperGetX402SettlementStatus: ToolDefinition = {
    name: "casper_get_x402_settlement_status",
    description:
      "Poll a Casper x402 settlement transaction — the real on-chain txHash create_job returns " +
      "once CasperX402Plugin actually broadcasts transfer_with_authorization (distinct from the " +
      "pre-settlement signature it returns when rpcUrl isn't configured) — for its execution " +
      "result. Casper transactions confirm within a handful of blocks, not instantly; 'pending' " +
      "means not yet included, not failed.",
    inputSchema: {
      txHash: HEX32.describe("Transaction hash, as returned in create_job's x402 receipt.txHash once settled."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ txHash: HEX32 }).parse(args);
      const rpcUrl = process.env.CASPER_RPC_URL;
      if (!rpcUrl) {
        throw new Error("[KARMA] casper_get_x402_settlement_status needs CASPER_RPC_URL set.");
      }
      const handler = new HttpHandler(rpcUrl);
      const apiKey = process.env.CASPER_RPC_API_KEY;
      if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
      const rpc = new RpcClient(handler);
      const info = await rpc.getTransactionByTransactionHash(a.txHash);
      const exec = info.executionInfo;
      if (!exec) {
        return reply(`[KARMA] tx ${a.txHash} not yet included in a block`, {
          txHash: a.txHash,
          status: "pending",
        });
      }
      // `errorMessage` lives under `executionResult`, NOT on `exec` directly — confirmed the hard
      // way in demo_casper_x402_settlement_live.ts's own waitForExecution() (a first version read
      // exec.errorMessage, always undefined, silently treating a real on-chain revert as success).
      const errorMessage = (exec as { executionResult?: { errorMessage?: string | null } }).executionResult
        ?.errorMessage ?? null;
      return reply(
        errorMessage ? `[KARMA] tx ${a.txHash} reverted: ${errorMessage}` : `[KARMA] tx ${a.txHash} succeeded`,
        {
          txHash: a.txHash,
          status: errorMessage ? "reverted" : "confirmed",
          blockHeight: (exec as { blockHeight?: number }).blockHeight ?? null,
          errorMessage,
        },
      );
    },
  };

  const casperDeactivateSkill: ToolDefinition = {
    name: "casper_deactivate_skill",
    description:
      "Skill owner deactivates one of their own skills (deactivate_skill) — a real signed " +
      "transaction. An inactive skill still exists (get_skill/get_job history is untouched) but " +
      "create_job/create_job_with_evaluator reject new jobs against it. Reverts if the caller " +
      "isn't the skill's registered owner.",
    inputSchema: {
      agentId: z.string().describe("Skill owner's keystore agent id."),
      skillId: z.string().regex(/^[0-9]+$/),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), skillId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.deactivateSkill(signer, BigInt(a.skillId));
      return reply(`[KARMA] casper_deactivate_skill broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperSetMinReputation: ToolDefinition = {
    name: "casper_set_min_reputation",
    description:
      "Skill owner changes the minimum agent reputation required to invoke one of their own " +
      "skills (set_min_reputation) — a real signed transaction. Reverts if the caller isn't the " +
      "skill's registered owner.",
    inputSchema: {
      agentId: z.string().describe("Skill owner's keystore agent id."),
      skillId: z.string().regex(/^[0-9]+$/),
      minReputation: z.number().int().min(0).max(100),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z
        .object({
          agentId: z.string(),
          skillId: z.string().regex(/^[0-9]+$/),
          minReputation: z.number().int().min(0).max(100),
        })
        .parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.setMinReputation(signer, BigInt(a.skillId), a.minReputation);
      return reply(`[KARMA] casper_set_min_reputation broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperSetIdentityPolicy: ToolDefinition = {
    name: "casper_set_identity_policy",
    description:
      "Skill owner changes the identity-policy id required to invoke one of their own skills " +
      "(set_identity_policy) — a real signed transaction. Same policy-id space as " +
      "casper_register_skill's identityPolicy arg (see docs/standards/IdentityPolicy-registry.md). " +
      "Reverts if the caller isn't the skill's registered owner.",
    inputSchema: {
      agentId: z.string().describe("Skill owner's keystore agent id."),
      skillId: z.string().regex(/^[0-9]+$/),
      policy: z.number().int().min(0).max(255),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z
        .object({
          agentId: z.string(),
          skillId: z.string().regex(/^[0-9]+$/),
          policy: z.number().int().min(0).max(255),
        })
        .parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.setIdentityPolicy(signer, BigInt(a.skillId), a.policy);
      return reply(`[KARMA] casper_set_identity_policy broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperGetProviderJobs: ToolDefinition = {
    name: "casper_get_provider_jobs",
    description:
      "List every job id an agent has ever been the provider on, read directly from the Odra " +
      "registry's 'state' dictionary (agent_provider_jobs).",
    inputSchema: {
      agentId: z.string().optional().describe("Keystore agent id — resolves its Casper account hash. Provide this OR accountHash."),
      accountHash: z.string().optional().describe("Raw 'account-hash-...' string, for reading an agent not in this keystore."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), accountHash: z.string().optional() }).parse(args);
      if (!a.agentId && !a.accountHash) throw new Error("[KARMA] casper_get_provider_jobs needs agentId or accountHash");
      const env = requireCasperEnv();
      const accountHash = a.accountHash ?? casperAccountHash(requireSigner(a.agentId!));
      const client = makeClient(env);
      const jobIds = await client.getProviderJobs(accountHash);
      return reply(`[KARMA] ${accountHash}: ${jobIds.length} provider job(s)`, {
        accountHash,
        jobIds: jobIds.map((id) => id.toString()),
      });
    },
  };

  const casperGetRequesterJobs: ToolDefinition = {
    name: "casper_get_requester_jobs",
    description:
      "List every job id an agent has ever been the requester on, read directly from the Odra " +
      "registry's 'state' dictionary (agent_requester_jobs).",
    inputSchema: {
      agentId: z.string().optional().describe("Keystore agent id — resolves its Casper account hash. Provide this OR accountHash."),
      accountHash: z.string().optional().describe("Raw 'account-hash-...' string, for reading an agent not in this keystore."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), accountHash: z.string().optional() }).parse(args);
      if (!a.agentId && !a.accountHash) throw new Error("[KARMA] casper_get_requester_jobs needs agentId or accountHash");
      const env = requireCasperEnv();
      const accountHash = a.accountHash ?? casperAccountHash(requireSigner(a.agentId!));
      const client = makeClient(env);
      const jobIds = await client.getRequesterJobs(accountHash);
      return reply(`[KARMA] ${accountHash}: ${jobIds.length} requester job(s)`, {
        accountHash,
        jobIds: jobIds.map((id) => id.toString()),
      });
    },
  };

  const casperGetAgentSkills: ToolDefinition = {
    name: "casper_get_agent_skills",
    description:
      "List every skill id an agent owns, read directly from the Odra registry's 'state' " +
      "dictionary (agent_skills).",
    inputSchema: {
      agentId: z.string().optional().describe("Keystore agent id — resolves its Casper account hash. Provide this OR accountHash."),
      accountHash: z.string().optional().describe("Raw 'account-hash-...' string, for reading an agent not in this keystore."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), accountHash: z.string().optional() }).parse(args);
      if (!a.agentId && !a.accountHash) throw new Error("[KARMA] casper_get_agent_skills needs agentId or accountHash");
      const env = requireCasperEnv();
      const accountHash = a.accountHash ?? casperAccountHash(requireSigner(a.agentId!));
      const client = makeClient(env);
      const skillIds = await client.getAgentSkills(accountHash);
      return reply(`[KARMA] ${accountHash}: ${skillIds.length} skill(s) owned`, {
        accountHash,
        skillIds: skillIds.map((id) => id.toString()),
      });
    },
  };

  const casperGetDisputeInfo: ToolDefinition = {
    name: "casper_get_dispute_info",
    description:
      "Read a job's active dispute record (bond amounts + dispute timestamp) directly from the " +
      "Odra registry's 'state' dictionary (disputes) — P1-A. Returns found=false once the " +
      "dispute resolves (concede_dispute/resolve_default_concede/arbitrate); the entry isn't " +
      "kept forever.",
    inputSchema: { jobId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ jobId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const client = makeClient(env);
      const info = await client.getDisputeInfo(BigInt(a.jobId));
      if (!info) {
        return reply(`[KARMA] job ${a.jobId} has no active dispute`, { jobId: a.jobId, found: false, dispute: null });
      }
      return reply(
        `[KARMA] job ${a.jobId} dispute: bond=${info.disputeBondMotes} provider_bond=${info.providerBondMotes} motes`,
        {
          jobId: a.jobId,
          found: true,
          dispute: {
            disputeBondMotes: info.disputeBondMotes.toString(),
            providerBondMotes: info.providerBondMotes.toString(),
            disputedAt: info.disputedAt.toString(),
          },
        },
      );
    },
  };

  const casperGetProposal: ToolDefinition = {
    name: "casper_get_proposal",
    description:
      "Read a governance proposal's full record (action, proposer, timestamp, executed/cancelled " +
      "flags) directly from the Odra registry's 'state' dictionary (proposals) — P0-B. Pairs with " +
      "casper_approve_proposal/casper_execute_proposal/casper_cancel_proposal for browsing a " +
      "proposal before acting on it.",
    inputSchema: { proposalId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ proposalId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const client = makeClient(env);
      const proposal = await client.getProposal(BigInt(a.proposalId));
      if (!proposal) {
        return reply(`[KARMA] proposal ${a.proposalId} does not exist`, {
          proposalId: a.proposalId,
          found: false,
          proposal: null,
        });
      }
      const action =
        proposal.action.kind === "SetCrossChainRep"
          ? {
              kind: proposal.action.kind,
              agent: formatCasperAddress(proposal.action.agent),
              score: proposal.action.score,
              sourceChain: proposal.action.sourceChain,
            }
          : proposal.action.kind === "SetArbiter"
            ? { kind: proposal.action.kind, newArbiter: formatCasperAddress(proposal.action.newArbiter) }
            : { kind: proposal.action.kind, bps: proposal.action.bps };
      return reply(
        `[KARMA] proposal ${a.proposalId}: ${proposal.action.kind}, executed=${proposal.executed}, cancelled=${proposal.cancelled}`,
        {
          proposalId: a.proposalId,
          found: true,
          proposal: {
            action,
            proposer: formatCasperAddress(proposal.proposer),
            proposedAt: proposal.proposedAt.toString(),
            executed: proposal.executed,
            cancelled: proposal.cancelled,
          },
        },
      );
    },
  };

  return [
    casperHealth,
    casperRegisterSkill,
    casperDepositBond,
    casperCreateJob,
    casperDeliverResult,
    casperConfirmCompletion,
    casperClaimAfterReview,
    casperClaimRefund,
    casperWithdraw,
    casperGetAccountState,
    casperGetSkill,
    casperGetJob,
    casperDiscoverSkills,
    casperRegisterComposition,
    casperGetComposition,
    casperCreateJobWithEvaluator,
    casperEvaluateResult,
    casperDisputeResult,
    casperRespondToDispute,
    casperConcedeDispute,
    casperResolveDefaultConcede,
    casperArbitrate,
    casperDisputeResultViaPanel,
    casperCastPanelVote,
    casperResolvePanelDefault,
    casperGetCrossChainRep,
    casperGetGovernanceState,
    casperProposeSetCrossChainRep,
    casperProposeSetArbiter,
    casperProposeSetDisputeBondBps,
    casperProposeSetArbiterPanel,
    casperProposeSetPanelArbiterFee,
    casperApproveProposal,
    casperExecuteProposal,
    casperCancelProposal,
    casperAttestRationale,
    casperGetRationaleHash,
    casperGetX402SettlementStatus,
    casperDeactivateSkill,
    casperSetMinReputation,
    casperSetIdentityPolicy,
    casperGetProviderJobs,
    casperGetRequesterJobs,
    casperGetAgentSkills,
    casperGetDisputeInfo,
    casperGetProposal,
  ];
}

const tools: ToolDefinition[] = createCasperTools();
export default tools;
