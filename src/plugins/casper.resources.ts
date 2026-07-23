import { CasperLiveClient } from "../lib/casper/live_client.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";
import type { ResourceDefinition, ResourceTemplateDefinition, ResourceVariables } from "../mcp/adapter/resource_runtime.js";
import type { CasperClientLike } from "./casper.tool.js";

/**
 * Casper-side Resources (DEBT-008) — mirrors casper_get_account_state/casper_get_composition/
 * casper_get_cross_chain_rep. No dispute/governance-proposal resource exists here: CasperLiveClient
 * has no enumeration method for either, and odra_events.ts's decoder never decodes those event
 * types (verified during planning) — that is a contract-layer prerequisite, not an MCP-layer gap.
 *
 * MUST run in-process, same reasoning as casper.tool.ts.
 */
function assertInProcess(): void {
  if (!isTrustedRuntime() || process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] casper.resources.ts must run in the trusted in-process runtime, not the external worker.",
    );
  }
}

function requireCasperEnv(): { rpcUrl: string; contractHash: string; chainName: string } {
  const rpcUrl = process.env.CASPER_RPC_URL;
  const contractHash = process.env.KARMA_ODRA_REGISTRY ?? process.env.CASPER_CONTRACT_HASH;
  if (!rpcUrl || !contractHash) {
    throw new Error(
      "[KARMA] Casper not configured — set CASPER_RPC_URL and KARMA_ODRA_REGISTRY to enable these resources.",
    );
  }
  return { rpcUrl, contractHash, chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test" };
}

function singleVar(variables: ResourceVariables, name: string): string {
  const raw = variables[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error(`[KARMA] resource template variable '${name}' is required`);
  return value;
}

export function createCasperResourceTemplates(
  makeClient: (env: { rpcUrl: string; contractHash: string; chainName: string }) => CasperClientLike = (env) =>
    new CasperLiveClient(env),
): ResourceTemplateDefinition[] {
  return [
    {
      name: "casper_account_state",
      uriTemplate: "karma://casper/accounts/{accountHash}/state",
      title: "Casper account state",
      description:
        "An agent's on-chain state on the Odra registry (pending withdrawable balance, reputation " +
        "0-100, bonded Sybil-resistance amount) — mirrors the casper_get_account_state tool.",
      assertInProcess,
      read: async (variables) => {
        const accountHash = singleVar(variables, "accountHash");
        const client = makeClient(requireCasperEnv());
        const [pendingWithdrawalsMotes, reputation, bondedMotes] = await Promise.all([
          client.pendingWithdrawalsOf(accountHash),
          client.agentReputationOf(accountHash),
          client.bondedOf(accountHash),
        ]);
        return { accountHash, pendingWithdrawalsMotes, reputation, bondedMotes };
      },
    },
    {
      name: "casper_skill_composition",
      uriTemplate: "karma://casper/skills/{skillId}/composition",
      title: "Casper skill composition",
      description:
        "A skill's composition manifest (leaf skill ids + basis-points weights), or " +
        "isComposite=false for a primitive skill — mirrors the casper_get_composition tool.",
      assertInProcess,
      read: async (variables) => {
        const skillId = singleVar(variables, "skillId");
        const client = makeClient(requireCasperEnv());
        const composition = await client.getComposition(BigInt(skillId));
        if (!composition) return { skillId, isComposite: false, composition: null };
        return {
          skillId,
          isComposite: true,
          composition: {
            leafSkillIds: composition.leafSkillIds.map(String),
            weightsBps: composition.weightsBps,
          },
        };
      },
    },
    {
      name: "casper_cross_chain_rep",
      uriTemplate: "karma://casper/accounts/{accountHash}/cross-chain-rep",
      title: "Casper cross-chain reputation",
      description:
        "An agent's cross-chain reputation attestation (0-100, or 0 if never set), the P0.1 bridge " +
        "value set through the propose/approve/execute governance lifecycle — mirrors the " +
        "casper_get_cross_chain_rep tool. No subscribe: not backed by any decoded event today.",
      assertInProcess,
      read: async (variables) => {
        const accountHash = singleVar(variables, "accountHash");
        const client = makeClient(requireCasperEnv());
        const score = await client.getCrossChainRep(accountHash);
        return { accountHash, score };
      },
    },
  ];
}

export function createCasperResources(
  makeClient?: (env: { rpcUrl: string; contractHash: string; chainName: string }) => CasperClientLike,
): { resources: ResourceDefinition[]; templates: ResourceTemplateDefinition[] } {
  return { resources: [], templates: createCasperResourceTemplates(makeClient) };
}

const casperResources = createCasperResources();
export default casperResources;
