/* eslint-disable @typescript-eslint/unbound-method -- svc.* are vi.fn() mocks; `this` binding is irrelevant */
import { describe, expect, it, vi } from "vitest";
import { createKarmaResourceTemplates, indexedEventToResourceUris } from "../plugins/karma.resources.js";
import type { KarmaService } from "../lib/karma_service.js";
import type { IndexedEvent } from "../lib/contract.js";

const ALPHA = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" as const;
const BETA = "0x1111111111111111111111111111111111111111" as const;

describe("karma.resources — indexedEventToResourceUris (DEBT-008 Phase 2)", () => {
  it("SkillRegistered → the owner's reputation resource (owner is on the event)", () => {
    const e: IndexedEvent = { type: "SkillRegistered", blockNumber: 1n, skillId: 7n, owner: ALPHA, name: "x", pricePerCall: 1000n };
    expect(indexedEventToResourceUris(e)).toEqual([`karma://pharos/agents/${ALPHA}/reputation`]);
  });

  it("JobCompleted → the job resource plus the provider's reputation/social-graph/balance (no extra RPC needed — provider is on the event)", () => {
    const e: IndexedEvent = { type: "JobCompleted", blockNumber: 1n, jobId: 42n, provider: ALPHA, payout: 100n, newReputation: 60n };
    expect(indexedEventToResourceUris(e)).toEqual([
      "karma://pharos/jobs/42",
      `karma://pharos/agents/${ALPHA}/reputation`,
      `karma://pharos/agents/${ALPHA}/social-graph`,
      `karma://pharos/agents/${ALPHA}/balance`,
    ]);
  });

  it("ResultDisputed → the job resource and its dispute facet", () => {
    const e: IndexedEvent = { type: "ResultDisputed", blockNumber: 1n, jobId: 42n, requester: ALPHA, amount: 5n };
    expect(indexedEventToResourceUris(e)).toEqual(["karma://pharos/jobs/42", "karma://pharos/jobs/42/dispute"]);
  });

  it("DisputeBondPosted / DisputeResponsePosted / DisputeArbitrated → job + dispute facet", () => {
    const bondPosted: IndexedEvent = { type: "DisputeBondPosted", blockNumber: 1n, jobId: 5n, requester: ALPHA, bond: 1n };
    const responsePosted: IndexedEvent = { type: "DisputeResponsePosted", blockNumber: 1n, jobId: 5n, provider: ALPHA, bond: 1n };
    const arbitrated: IndexedEvent = { type: "DisputeArbitrated", blockNumber: 1n, jobId: 5n, verdict: 0, arbiter: ALPHA };
    for (const e of [bondPosted, responsePosted, arbitrated]) {
      expect(indexedEventToResourceUris(e)).toEqual(["karma://pharos/jobs/5", "karma://pharos/jobs/5/dispute"]);
    }
  });

  it("DisputeConceded → job + dispute facet + the conceding provider's reputation/balance", () => {
    const e: IndexedEvent = { type: "DisputeConceded", blockNumber: 1n, jobId: 9n, provider: BETA };
    expect(indexedEventToResourceUris(e)).toEqual([
      "karma://pharos/jobs/9",
      "karma://pharos/jobs/9/dispute",
      `karma://pharos/agents/${BETA}/reputation`,
      `karma://pharos/agents/${BETA}/balance`,
    ]);
  });

  it("JobEvaluated → just the job resource", () => {
    const e: IndexedEvent = { type: "JobEvaluated", blockNumber: 1n, jobId: 3n, evaluator: ALPHA, approved: true, evaluatorPayout: 1n };
    expect(indexedEventToResourceUris(e)).toEqual(["karma://pharos/jobs/3"]);
  });

  it("CrossChainRepUpdated → the agent's cross-chain-rep resource", () => {
    const e: IndexedEvent = { type: "CrossChainRepUpdated", blockNumber: 1n, agent: ALPHA, score: 80n, sourceChain: "casper" };
    expect(indexedEventToResourceUris(e)).toEqual([`karma://pharos/agents/${ALPHA}/cross-chain-rep`]);
  });

  it("SkillDeactivated / BondUpdated / MinReputationSet / ArbiterUpdated / DisputeBondBpsUpdated → no cheap mapping, empty array (documented, not a bug)", () => {
    const events: IndexedEvent[] = [
      { type: "SkillDeactivated", blockNumber: 1n, skillId: 1n },
      { type: "BondUpdated", blockNumber: 1n, agent: ALPHA, bondedAmount: 1n, seedEligible: 1n },
      { type: "MinReputationSet", blockNumber: 1n, skillId: 1n, minReputation: 10n },
      { type: "ArbiterUpdated", blockNumber: 1n, oldArbiter: ALPHA, newArbiter: BETA },
      { type: "DisputeBondBpsUpdated", blockNumber: 1n, oldBps: 100n, newBps: 200n },
    ];
    for (const e of events) expect(indexedEventToResourceUris(e)).toEqual([]);
  });
});

describe("karma.resources — pharos_agent_cross_chain_rep resource template", () => {
  it("reads via svc.getCrossChainRep, mirroring casper_get_cross_chain_rep's shape", async () => {
    const svc = { getCrossChainRep: vi.fn(async () => 42n) } as unknown as KarmaService;
    const templates = createKarmaResourceTemplates(svc);
    const def = templates.find(t => t.name === "pharos_agent_cross_chain_rep")!;
    const result = await def.read({ address: ALPHA }, {} as never);
    expect(svc.getCrossChainRep).toHaveBeenCalledWith(ALPHA);
    expect(result).toEqual({ address: ALPHA, score: 42n });
  });
});
