import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../mcp/adapter/tool_registry.js";
import { jsonSafe } from "../lib/serialize.js";
import { realKarmaService } from "../lib/karma_service.js";
import { xLayerReads } from "../lib/xlayer.js";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";

/**
 * KARMA Cross-Chain Trust Oracle — the A2MCP ASP built for the OKX.AI Genesis Hackathon.
 *
 * The product: given an agent's address on one or more KARMA-conformant chains, return its
 * on-chain reputation + job history from every chain that has it, aggregated into one risk
 * read — evidence, not a single opaque number. This is the same reputation kernel every other
 * KARMA chain adapter already reads from (docs/standards/reference-implementations.md); this
 * tool is the first thing that *composes* the four live deployments (Pharos, X Layer, Casper,
 * Stellar) into a single answer instead of reporting one chain at a time.
 *
 * Monetization: register this as a skill via `register_skill` (mcpEndpoint = this tool's name,
 * settlement via the x402-xlayer IPaymentPlugin) so a caller pays per lookup through the normal
 * KARMA job flow — no bespoke payment code, reuses the escrow/x402 machinery every other skill
 * already goes through. This tool call itself stays free/direct for demoing and for judges.
 *
 * MUST run in-process (same reasoning as karma.tool.ts/casper.tool.ts): reads PHAROS_*, XLAYER_*,
 * and CASPER_* from process.env and touches the Pharos/X Layer viem client singletons, neither
 * of which survive the external child-process plugin worker.
 */
function assertInProcess(): void {
  if (!isTrustedRuntime() || process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] trust_oracle.tool.ts must run in the trusted in-process runtime, not the external " +
        "worker. Add it to isTrustedBuiltInPlugin() and MCP_PLUGIN_ALLOWLIST, and keep " +
        "MCP_PLUGIN_ISOLATION_MODE=policy.",
    );
  }
}

const PHASES = ["intake", "execution", "review", "completed"] as const;

function reply(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: jsonSafe(structured) };
}

export interface ChainReputationRead {
  chain: "pharos" | "xlayer" | "casper" | "stellar";
  address: string;
  reputation: number | null;
  crossChainRep?: string;
  jobsAsProvider?: number;
  jobsAsRequester?: number;
  note?: string;
}

async function readPharos(address: `0x${string}`): Promise<ChainReputationRead> {
  if (!process.env.PHAROS_CONTRACT_ADDRESS) {
    return { chain: "pharos", address, reputation: null, note: "PHAROS_CONTRACT_ADDRESS not configured" };
  }
  const [reputation, crossChainRep, providerJobs, requesterJobs] = await Promise.all([
    realKarmaService.getAgentReputation(address),
    realKarmaService.getCrossChainRep(address),
    realKarmaService.getProviderJobs(address),
    realKarmaService.getRequesterJobs(address),
  ]);
  return {
    chain: "pharos",
    address,
    reputation,
    crossChainRep: crossChainRep.toString(),
    jobsAsProvider: providerJobs.length,
    jobsAsRequester: requesterJobs.length,
  };
}

async function readXLayer(address: `0x${string}`): Promise<ChainReputationRead> {
  if (!process.env.XLAYER_CONTRACT_ADDRESS) {
    return { chain: "xlayer", address, reputation: null, note: "XLAYER_CONTRACT_ADDRESS not configured" };
  }
  const [reputation, crossChainRep, providerJobs, requesterJobs] = await Promise.all([
    xLayerReads.getAgentReputation(address),
    xLayerReads.getCrossChainRep(address),
    xLayerReads.getProviderJobs(address),
    xLayerReads.getRequesterJobs(address),
  ]);
  return {
    chain: "xlayer",
    address,
    reputation,
    crossChainRep: crossChainRep.toString(),
    jobsAsProvider: providerJobs.length,
    jobsAsRequester: requesterJobs.length,
  };
}

/** Soft Casper config check — deliberately not `requireCasperEnv()` (casper.tool.ts), which
 *  throws; a missing chain here degrades to a `note`, it never fails the whole lookup. */
async function readCasper(accountHashHex: string): Promise<ChainReputationRead> {
  const rpcUrl = process.env.CASPER_RPC_URL;
  const contractHash = process.env.KARMA_ODRA_REGISTRY ?? process.env.CASPER_CONTRACT_HASH;
  const normalized = accountHashHex.replace(/^account-hash-/, "");
  if (!rpcUrl || !contractHash) {
    return { chain: "casper", address: accountHashHex, reputation: null, note: "CASPER_RPC_URL/KARMA_ODRA_REGISTRY not configured" };
  }
  const client = new CasperLiveClient({
    rpcUrl,
    rpcHeaders: process.env.CASPER_RPC_API_KEY ? { Authorization: process.env.CASPER_RPC_API_KEY } : undefined,
    chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test",
    contractHash,
  });
  const reputation = await client.agentReputationOf(normalized);
  return { chain: "casper", address: accountHashHex, reputation };
}

/** Stellar reputation is deliberately NOT a public number — it's Groth16/BN254 ZK-gated
 *  (DEMO_STELLAR.md): the score, job history, and credential secret never leave the agent's
 *  machine. So this leg of the oracle is informational (how to ask, not an answer), not a live
 *  RPC call — reporting a fabricated public score would misrepresent what the primitive does. */
function stellarNote(address: string): ChainReputationRead {
  return {
    chain: "stellar",
    address,
    reputation: null,
    note:
      "Stellar reputation is ZK-gated by design (Groth16/BN254 verified on-chain via Soroban CAP-0074) " +
      "— not a public number. Ask the agent to prove a specific threshold claim instead of requesting a score.",
  };
}

function aggregateScore(results: ChainReputationRead[]): { score: number | null; chainsCounted: number } {
  const nums = results.map((r) => r.reputation).filter((n): n is number => typeof n === "number");
  if (nums.length === 0) return { score: null, chainsCounted: 0 };
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return { score: Math.round(avg * 100) / 100, chainsCounted: nums.length };
}

const trustOracleTools: ToolDefinition[] = [
  {
    name: "get_cross_chain_trust_score",
    description:
      "KARMA Cross-Chain Trust Oracle: aggregate an agent's on-chain reputation + job/dispute history " +
      "across every KARMA-conformant chain (Pharos, X Layer, Casper — plus a Stellar note, since " +
      "Stellar reputation is intentionally ZK-gated, not a public number) into one evidence-backed risk " +
      "read. Built for OKX.AI's ASP marketplace: before an A2A/A2MCP job pays another agent, ask KARMA " +
      "whether that agent kept its word last time. Provide at least one of evm_address (Pharos + X " +
      "Layer share the same secp256k1 address) or casper_account_hash.",
    inputSchema: {
      evm_address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .optional()
        .describe("0x... address — shared by Pharos and X Layer (same secp256k1 key, chain-independent)."),
      casper_account_hash: z
        .string()
        .optional()
        .describe("Casper account-hash hex, with or without the 'account-hash-' prefix."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z
        .object({
          evm_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
          casper_account_hash: z.string().optional(),
        })
        .parse(args);
      if (!a.evm_address && !a.casper_account_hash) {
        throw new Error("[KARMA] provide evm_address and/or casper_account_hash");
      }

      const reads: Promise<ChainReputationRead>[] = [];
      if (a.evm_address) {
        reads.push(readPharos(a.evm_address as `0x${string}`));
        reads.push(readXLayer(a.evm_address as `0x${string}`));
      }
      if (a.casper_account_hash) reads.push(readCasper(a.casper_account_hash));

      const results = await Promise.all(reads);
      if (a.evm_address) results.push(stellarNote(a.evm_address));
      const { score, chainsCounted } = aggregateScore(results);

      const subject = a.evm_address ?? a.casper_account_hash ?? "unknown";
      return reply(
        chainsCounted > 0
          ? `[KARMA Trust Oracle] ${subject}: aggregate reputation ${score} across ${chainsCounted} chain(s)`
          : `[KARMA Trust Oracle] ${subject}: no configured chain returned a reputation (see notes)`,
        { subject, aggregateScore: score, chainsCounted, chains: results },
      );
    },
  },
];

export default trustOracleTools;
