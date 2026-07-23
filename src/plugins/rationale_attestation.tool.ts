import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../mcp/adapter/tool_registry.js";
import { jsonSafe } from "../lib/serialize.js";
import { keystoreManager } from "../lib/keystore.js";
import { attestRationale as xlayerAttestRationale, getRationaleHash as xlayerGetRationaleHash } from "../lib/xlayer_rationale.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";

/**
 * KARMA Rationale Attestation (P2-A) — X Layer port of Casper's attest_rationale/get_rationale_hash
 * (contracts-odra/src/agent_skill_registry.rs). Lets a job's requester commit an immutable,
 * once-only hash of their (typically LLM-generated) decision rationale for that job, on-chain —
 * a checkable anchor without KARMA storing, or paying gas for, the plaintext rationale itself.
 *
 * Backed by RationaleAttestation.sol, a standalone sidecar deployed next to the live
 * AgentSkillRegistry (0xBF28…4Cd2) rather than a change to it — see that contract's header for why.
 *
 * MUST run in-process (same reasoning as trust_oracle.tool.ts / karma.tool.ts): relies on the
 * in-process keystore singleton and the X Layer viem client singletons, neither of which survive
 * the external child-process plugin worker.
 */
function assertInProcess(): void {
  if (!isTrustedRuntime() || process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] rationale_attestation.tool.ts must run in the trusted in-process runtime, not the " +
        "external worker. Add it to isTrustedBuiltInPlugin() and MCP_PLUGIN_ALLOWLIST, and keep " +
        "MCP_PLUGIN_ISOLATION_MODE=policy.",
    );
  }
}

const PHASES = ["intake", "execution", "review", "completed"] as const;
const HEX32 = z.string().regex(/^[0-9a-fA-F]{64}$/, "expected 32 bytes as 64 hex chars");
const JOB_ID = z.string().regex(/^[0-9]+$/, "expected a base-10 job id");

const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function reply(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: jsonSafe(structured) };
}

function requireSigner(agentId: string) {
  if (!keystoreManager.has(agentId)) {
    throw new Error(`[KARMA] Agent '${agentId}' not found in keystore. Run setup:keystore first.`);
  }
  return keystoreManager.getAccount(agentId);
}

const attestRationaleTool: ToolDefinition = {
  name: "attest_rationale",
  description:
    "P2-A: commit a 32-byte hash of the (typically LLM-generated) decision rationale for why " +
    "this job was created, on-chain — an immutable, independently-checkable anchor without " +
    "KARMA storing (or paying gas for) the plaintext rationale itself. Requester-only (must match " +
    "the job's requester recorded in AgentSkillRegistry.jobs(jobId)), set-once (re-attesting the " +
    "same job reverts). Callers hash their own rationale text (e.g. keccak256) before calling this " +
    "— the plaintext never enters this tool call or this server. X Layer port of Casper's " +
    "casper_attest_rationale.",
  inputSchema: {
    agentId: z.string().describe("Requester's keystore agent id — must control the job's requester address."),
    jobId: JOB_ID.describe("Job id from AgentSkillRegistry.createJob / createJobWithEvaluator."),
    rationaleHashHex: HEX32.describe("32-byte hash (hex, no 0x prefix) of the plaintext decision rationale."),
  },
  capabilities: ["network"],
  allowedPhases: [...PHASES],
  annotations: writeAnnotations,
  execution: { taskSupport: "forbidden" },
  handler: async (args) => {
    assertInProcess();
    const a = z
      .object({ agentId: z.string(), jobId: JOB_ID, rationaleHashHex: HEX32 })
      .parse(args);
    const account = requireSigner(a.agentId);
    const outcome = await xlayerAttestRationale(account, {
      jobId: BigInt(a.jobId),
      rationaleHash: `0x${a.rationaleHashHex}`,
    });
    return reply(`[KARMA] attest_rationale broadcast; tx=${outcome.hash}`, { txHash: outcome.hash, status: outcome.status });
  },
};

const getRationaleHashTool: ToolDefinition = {
  name: "get_rationale_hash",
  description:
    "Read the attested decision-rationale hash for a job directly from RationaleAttestation.sol " +
    "on X Layer. Returns null when the requester never called attest_rationale for it (most jobs " +
    "— attestation is opt-in). X Layer port of Casper's casper_get_rationale_hash.",
  inputSchema: {
    jobId: JOB_ID.describe("Job id to look up."),
  },
  capabilities: ["network"],
  allowedPhases: [...PHASES],
  annotations: readAnnotations,
  execution: { taskSupport: "forbidden" },
  handler: async (args) => {
    assertInProcess();
    const a = z.object({ jobId: JOB_ID }).parse(args);
    const hash = await xlayerGetRationaleHash(BigInt(a.jobId));
    const attested = hash !== `0x${"0".repeat(64)}`;
    return reply(
      attested
        ? `[KARMA] job #${a.jobId} rationale_hash=${hash}`
        : `[KARMA] job #${a.jobId} has no attested rationale`,
      { jobId: a.jobId, rationaleHashHex: attested ? hash : null },
    );
  },
};

const rationaleAttestationTools: ToolDefinition[] = [attestRationaleTool, getRationaleHashTool];

export default rationaleAttestationTools;
