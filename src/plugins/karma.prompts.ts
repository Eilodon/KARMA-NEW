import { z } from "zod/v4";
import type { Address } from "viem";
import { realKarmaService, type KarmaService } from "../lib/karma_service.js";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";
import type { PromptDefinition } from "../mcp/adapter/prompt_runtime.js";
import type { CasperClientLike } from "./casper.tool.js";

/**
 * `agent_vetting` (DEBT-008) — the flagship Prompt: composes reputation + social-graph (Pharos)
 * and account-state + cross-chain-rep (Casper) into one guided vetting workflow for a human/LLM
 * evaluator, directly addressing the "evaluator has no vetting" narrative gap (see project notes
 * on the courtroom/dispute pillar). Reuses the exact same KarmaService/CasperLiveClient calls the
 * corresponding Resources/tools already use — it does not reimplement any read.
 *
 * MUST run in-process, same reasoning as karma.tool.ts / casper.tool.ts.
 */
function assertInProcess(): void {
  if (!isTrustedRuntime() || process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] karma.prompts.ts must run in the trusted in-process runtime, not the external worker.",
    );
  }
}

function requireCasperEnv(): { rpcUrl: string; contractHash: string; chainName: string } {
  const rpcUrl = process.env.CASPER_RPC_URL;
  const contractHash = process.env.KARMA_ODRA_REGISTRY ?? process.env.CASPER_CONTRACT_HASH;
  if (!rpcUrl || !contractHash) {
    throw new Error(
      "[KARMA] Casper not configured — set CASPER_RPC_URL and KARMA_ODRA_REGISTRY to vet a Casper account.",
    );
  }
  return { rpcUrl, contractHash, chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test" };
}

async function pharosDossier(svc: KarmaService, address: Address): Promise<Record<string, unknown>> {
  const [skillIds, agentReputation, asProvider, asRequester] = await Promise.all([
    svc.getAgentSkills(address),
    svc.getAgentReputation(address),
    svc.getProviderJobs(address),
    svc.getRequesterJobs(address),
  ]);
  return {
    chain: "pharos",
    address,
    agentReputation,
    skillCount: skillIds.length,
    jobsProvided: asProvider.length,
    jobsRequested: asRequester.length,
  };
}

async function casperDossier(
  makeClient: (env: { rpcUrl: string; contractHash: string; chainName: string }) => CasperClientLike,
  accountHash: string,
): Promise<Record<string, unknown>> {
  const client = makeClient(requireCasperEnv());
  const [reputation, bondedMotes, crossChainRep] = await Promise.all([
    client.agentReputationOf(accountHash),
    client.bondedOf(accountHash),
    client.getCrossChainRep(accountHash),
  ]);
  return { chain: "casper", accountHash, reputation, bondedMotes, crossChainRep };
}

export function createKarmaPrompts(
  svc: KarmaService = realKarmaService,
  makeCasperClient: (env: { rpcUrl: string; contractHash: string; chainName: string }) => CasperClientLike = (env) =>
    new CasperLiveClient(env),
): PromptDefinition[] {
  return [
    {
      name: "agent_vetting",
      title: "Vet an agent before entrusting it with a job",
      description:
        "Composes on-chain reputation, social-graph, account-state, and cross-chain-reputation data " +
        "for an agent across Pharos and/or Casper into one guided vetting workflow — for a human or " +
        "LLM evaluator deciding whether to hire/trust an agent.",
      argsSchema: {
        pharosAddress: z.string().optional().describe("Pharos (EVM) address to vet."),
        casperAccountHash: z.string().optional().describe("Casper 'account-hash-...' string to vet."),
      },
      assertInProcess,
      build: async (args) => {
        const { pharosAddress, casperAccountHash } = args as { pharosAddress?: string; casperAccountHash?: string };
        if (!pharosAddress && !casperAccountHash) {
          throw new Error("[KARMA] agent_vetting needs pharosAddress, casperAccountHash, or both");
        }

        const dossiers = await Promise.all([
          pharosAddress ? pharosDossier(svc, pharosAddress as Address) : null,
          casperAccountHash ? casperDossier(makeCasperClient, casperAccountHash) : null,
        ]);
        const evidence = dossiers.filter((d): d is Record<string, unknown> => d !== null);

        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text:
                  "You are vetting an agent before entrusting it with a job. Review the on-chain " +
                  "evidence below and produce: (1) a trust recommendation (hire / hire-with-caution / " +
                  "do-not-hire), (2) the strongest signal for that recommendation, (3) any red flag " +
                  "worth a human follow-up.\n\n" +
                  `Evidence:\n${JSON.stringify(evidence, null, 2)}`,
              },
            },
          ],
        };
      },
    },
  ];
}

const karmaPrompts = createKarmaPrompts();
export default karmaPrompts;
