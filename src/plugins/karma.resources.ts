import type { Address } from "viem";
import { realKarmaService, type KarmaService } from "../lib/karma_service.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";
import type { IndexedEvent } from "../lib/contract.js";
import type { ResourceDefinition, ResourceTemplateDefinition, ResourceVariables } from "../mcp/adapter/resource_runtime.js";

/**
 * Pharos-side Resources (DEBT-008) — read-only URI views over the same KarmaService calls
 * get_agent_reputation/query_social_graph/get_pending_balance/read_job already use. Templates are
 * keyed by a public on-chain address/jobId, never a tenant-scoped agentId — see resource_runtime.ts.
 *
 * MUST run in-process, same reasoning as karma.tool.ts: relies on module-level singletons that
 * only survive in-process (see isTrustedBuiltInPlugin / spec D-1).
 */
function assertInProcess(): void {
  if (!isTrustedRuntime() || process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] karma.resources.ts must run in the trusted in-process runtime (trusted built-in), not " +
        "the external worker.",
    );
  }
}

function singleVar(variables: ResourceVariables, name: string): string {
  const raw = variables[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error(`[KARMA] resource template variable '${name}' is required`);
  return value;
}

export function createKarmaResourceTemplates(svc: KarmaService): ResourceTemplateDefinition[] {
  return [
    {
      name: "pharos_agent_reputation",
      uriTemplate: "karma://pharos/agents/{address}/reputation",
      title: "Pharos agent reputation",
      description:
        "An agent's registered skills with reputation scores/invocation counts, plus its aggregate " +
        "agentReputation (max owned-skill reputation) — the value the Trust Gate checks against. " +
        "Mirrors the get_agent_reputation tool.",
      assertInProcess,
      read: async (variables) => {
        const address = singleVar(variables, "address") as Address;
        const skillIds = await svc.getAgentSkills(address);
        const skills = await Promise.all(
          skillIds.map(async (id) => {
            const s = await svc.readSkill(id);
            return {
              skillId: id,
              name: s.name,
              reputation: Number(s.reputationScore),
              totalInvocations: s.totalInvocations,
              active: s.active,
            };
          }),
        );
        const agentReputation = await svc.getAgentReputation(address);
        return { address, agentReputation, skills };
      },
    },
    {
      name: "pharos_agent_social_graph",
      uriTemplate: "karma://pharos/agents/{address}/social-graph",
      title: "Pharos agent social graph",
      description:
        "Job-id edges for an agent: jobs it provided and jobs it requested (\"ids\" format — fast, " +
        "matches query_social_graph's default). Mirrors the query_social_graph tool.",
      assertInProcess,
      read: async (variables) => {
        const address = singleVar(variables, "address") as Address;
        const [asProvider, asRequester] = await Promise.all([
          svc.getProviderJobs(address),
          svc.getRequesterJobs(address),
        ]);
        return { address, asProvider, asRequester };
      },
    },
    {
      name: "pharos_agent_balance",
      uriTemplate: "karma://pharos/agents/{address}/balance",
      title: "Pharos agent withdrawable balance",
      description:
        "Escrow released by complete_job that is awaiting pull-payment withdrawal. Mirrors the " +
        "get_pending_balance tool.",
      assertInProcess,
      read: async (variables) => {
        const address = singleVar(variables, "address") as Address;
        const withdrawableWei = await svc.getPendingWithdrawal(address);
        return { address, withdrawableWei };
      },
    },
    {
      name: "pharos_job",
      uriTemplate: "karma://pharos/jobs/{jobId}",
      title: "Pharos job state",
      description:
        "A single job's on-chain state: parties, skill, escrow, deadline, lifecycle status, and " +
        "result hash. Mirrors the read_job tool.",
      assertInProcess,
      read: async (variables) => {
        const jobId = BigInt(singleVar(variables, "jobId"));
        const job = await svc.readJob(jobId);
        return { jobId, ...job };
      },
    },
    {
      name: "pharos_job_dispute",
      uriTemplate: "karma://pharos/jobs/{jobId}/dispute",
      title: "Pharos job dispute info",
      description:
        "Dispute bond amounts and dispute timestamp for a job (KarmaService.getDisputeInfo) — a " +
        "read the service layer already supports but no existing tool exposes.",
      assertInProcess,
      read: async (variables) => {
        const jobId = BigInt(singleVar(variables, "jobId"));
        const info = await svc.getDisputeInfo(jobId);
        return { jobId, ...info };
      },
    },
    {
      name: "pharos_agent_cross_chain_rep",
      uriTemplate: "karma://pharos/agents/{address}/cross-chain-rep",
      title: "Pharos agent cross-chain reputation",
      description:
        "An agent's cross-chain reputation attestation (0-100, or 0 if never set) — the P0-B bridge " +
        "value. KarmaService.getCrossChainRep has no existing tool wrapper on the Pharos side (only " +
        "casper_get_cross_chain_rep exists today); found during Phase 2 planning.",
      assertInProcess,
      read: async (variables) => {
        const address = singleVar(variables, "address") as Address;
        const score = await svc.getCrossChainRep(address);
        return { address, score };
      },
    },
  ];
}

/**
 * Maps an indexer event to the resource URIs it affects — DEBT-008 Phase 2. Deliberately uses
 * ONLY fields already present on the event, making zero extra RPC calls: startKarmaIndexer's
 * onResourceEvent hook fires alongside (not inside) the existing BM25/flow-rep reconcile chain,
 * fire-and-forget, and must stay cheap/synchronous to preserve that "smallest viable change"
 * guarantee — an extra readJob/readSkill here would be a second, unawaited RPC call racing the
 * indexer's own serialized reconciliation.
 *
 * Exhaustive over every IndexedEvent variant (no default branch) so a future addition to the
 * union in contract.ts fails this file's typecheck instead of silently notifying nothing.
 *
 * Five event types resolve to no URIs, each for a specific, documented reason (not an oversight):
 *   - SkillDeactivated / MinReputationSet: carry only `skillId`, not the owner address, so there
 *     is no cheap way to know which agent's karma://pharos/agents/{address}/reputation to notify.
 *   - BondUpdated: Pharos exposes no "bonded amount" resource (that concept only has a Casper-side
 *     resource today, karma://casper/accounts/{accountHash}/state).
 *   - ArbiterUpdated / DisputeBondBpsUpdated: governance-parameter changes with no corresponding
 *     resource in this design.
 */
export function indexedEventToResourceUris(e: IndexedEvent): string[] {
  switch (e.type) {
    case "SkillRegistered":
      return [`karma://pharos/agents/${e.owner}/reputation`];
    case "JobCompleted":
      return [
        `karma://pharos/jobs/${e.jobId}`,
        `karma://pharos/agents/${e.provider}/reputation`,
        `karma://pharos/agents/${e.provider}/social-graph`,
        `karma://pharos/agents/${e.provider}/balance`,
      ];
    case "ResultDisputed":
    case "DisputeBondPosted":
    case "DisputeResponsePosted":
    case "DisputeArbitrated":
      return [`karma://pharos/jobs/${e.jobId}`, `karma://pharos/jobs/${e.jobId}/dispute`];
    case "DisputeConceded":
      return [
        `karma://pharos/jobs/${e.jobId}`,
        `karma://pharos/jobs/${e.jobId}/dispute`,
        `karma://pharos/agents/${e.provider}/reputation`,
        `karma://pharos/agents/${e.provider}/balance`,
      ];
    case "JobEvaluated":
      return [`karma://pharos/jobs/${e.jobId}`];
    case "CrossChainRepUpdated":
      return [`karma://pharos/agents/${e.agent}/cross-chain-rep`];
    case "SkillDeactivated":
    case "BondUpdated":
    case "MinReputationSet":
    case "ArbiterUpdated":
    case "DisputeBondBpsUpdated":
      return [];
  }
}

export function createKarmaResources(svc: KarmaService = realKarmaService): {
  resources: ResourceDefinition[];
  templates: ResourceTemplateDefinition[];
} {
  return { resources: [], templates: createKarmaResourceTemplates(svc) };
}

const karmaResources = createKarmaResources();
export default karmaResources;
