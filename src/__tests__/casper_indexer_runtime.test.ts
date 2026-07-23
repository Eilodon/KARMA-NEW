import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CasperEventClientLike } from "../lib/casper_indexer_runtime.js";
import {
  CasperSkillIndexService,
  casperSkillIndex,
  pollOnce,
  startCasperIndexer,
  stopCasperIndexer,
  getCasperIndexerHealth,
} from "../lib/casper_indexer_runtime.js";
import type { DecodedSkill, DecodedJob } from "../lib/casper/odra_codec.js";
import type { IndexedEvent } from "../lib/contract.js";

const OWNER_HASH = "11".repeat(32);
const PROVIDER_HASH = "22".repeat(32);
const REQUESTER_HASH = "33".repeat(32);

function decodedSkill(over: Partial<DecodedSkill> = {}): DecodedSkill {
  return {
    owner: { kind: "Account", hashHex: OWNER_HASH },
    name: "rwa_price_oracle",
    description: "desc",
    mcpEndpoint: "casper-mcp://providers/rwa_price_oracle",
    pricePerCallMotes: 10_000_000n,
    reputationScore: 60,
    totalInvocations: 3n,
    active: true,
    registeredAt: 1_700_000_000n,
    minReputationToInvoke: 0,
    identityPolicy: 0,
    ...over,
  };
}

function decodedJob(over: Partial<DecodedJob> = {}): DecodedJob {
  return {
    requester: { kind: "Account", hashHex: REQUESTER_HASH },
    provider: { kind: "Account", hashHex: PROVIDER_HASH },
    skillId: 1n,
    taskHash: new Uint8Array(32).fill(0xaa),
    escrowAmountMotes: 10_000_000n,
    deadline: 259_200n,
    status: "Completed",
    resultHash: new Uint8Array(32).fill(0xbb),
    createdAt: 1_700_000_000n,
    completedAt: 1_700_000_100n,
    evaluator: undefined,
    evaluatorFeeMotes: 0n,
    ...over,
  };
}

describe("CasperSkillIndexService", () => {
  it("readSkill maps a DecodedSkill into OnchainSkill (opaque-address-cast, bigint-widened)", async () => {
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => decodedSkill()),
      getJob: vi.fn(async () => undefined),
      getEventCount: vi.fn(async () => 0),
      getEvent: vi.fn(async () => undefined),
    };
    const svc = new CasperSkillIndexService(client);
    const skill = await svc.readSkill(1n);
    expect(skill).toMatchObject({
      owner: `0x${OWNER_HASH}`,
      name: "rwa_price_oracle",
      pricePerCall: 10_000_000n,
      reputationScore: 60n,
      active: true,
      minReputationToInvoke: 0n,
      identityPolicy: 0,
    });
  });

  it("readSkill throws for an unregistered skill instead of silently returning garbage", async () => {
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => undefined),
      getJob: vi.fn(async () => undefined),
      getEventCount: vi.fn(async () => 0),
      getEvent: vi.fn(async () => undefined),
    };
    const svc = new CasperSkillIndexService(client);
    await expect(svc.readSkill(999n)).rejects.toThrow(/not found/);
  });

  it("readJob maps a DecodedJob into OnchainJob, using the zero address when there's no evaluator", async () => {
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => undefined),
      getJob: vi.fn(async () => decodedJob()),
      getEventCount: vi.fn(async () => 0),
      getEvent: vi.fn(async () => undefined),
    };
    const svc = new CasperSkillIndexService(client);
    const job = await svc.readJob(1n);
    expect(job.requester).toBe(`0x${REQUESTER_HASH}`);
    expect(job.provider).toBe(`0x${PROVIDER_HASH}`);
    expect(job.status).toBe(2); // Completed
    expect(job.evaluator).toBe(`0x${"0".repeat(40)}`);
    expect(job.taskHash).toBe(`0x${"aa".repeat(32)}`);
  });

  it("readJob carries a real evaluator address through when one is set", async () => {
    const evaluatorHash = "44".repeat(32);
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => undefined),
      getJob: vi.fn(async () => decodedJob({ evaluator: { kind: "Account", hashHex: evaluatorHash }, evaluatorFeeMotes: 500n })),
      getEventCount: vi.fn(async () => 0),
      getEvent: vi.fn(async () => undefined),
    };
    const svc = new CasperSkillIndexService(client);
    const job = await svc.readJob(1n);
    expect(job.evaluator).toBe(`0x${evaluatorHash}`);
    expect(job.evaluatorFee).toBe(500n);
  });

  it("indexUpsert/indexDiscard/indexSetMinReputation delegate to the Casper-only BM25 index", async () => {
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => undefined),
      getJob: vi.fn(async () => undefined),
      getEventCount: vi.fn(async () => 0),
      getEvent: vi.fn(async () => undefined),
    };
    const svc = new CasperSkillIndexService(client);
    svc.indexUpsert({
      id: 55,
      skill_id: 55,
      name: "delegate-test",
      description: "",
      mcp_endpoint: "",
      price_per_call_wei: "1",
      reputation_score: 50,
      owner_address: `0x${OWNER_HASH}`,
      active: true,
      payment_options: [],
    });
    expect(casperSkillIndex.getById(55)).not.toBeNull();
    svc.indexSetMinReputation(55, 20);
    expect(casperSkillIndex.getById(55)?.min_reputation_to_invoke).toBe(20);
    svc.indexDiscard(55);
    expect(casperSkillIndex.getById(55)).toBeNull();
  });
});

describe("pollOnce", () => {
  // `lastSeenEventIndex`/`reconcileErrors` are module-level cursor state shared across tests —
  // reset between each so one test's advanced cursor doesn't starve the next test's loop.
  afterEach(() => {
    stopCasperIndexer();
  });

  it("replays every event since the cursor through applyWithRetry and advances it", async () => {
    const events: Array<IndexedEvent | undefined> = [
      { type: "SkillRegistered", blockNumber: 0n, skillId: 7n, owner: `0x${OWNER_HASH}` as never, name: "s7", pricePerCall: 1_000n },
      undefined, // an event type this indexer doesn't decode
      { type: "SkillDeactivated", blockNumber: 2n, skillId: 7n },
    ];
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => decodedSkill({ name: "s7" })),
      getJob: vi.fn(async () => undefined),
      getEventCount: vi.fn(async () => events.length),
      getEvent: vi.fn(async (i: number) => events[i]),
    };
    const svc = new CasperSkillIndexService(client);
    await pollOnce(client, svc);

    expect(client.getEvent).toHaveBeenCalledTimes(3);
    // SkillRegistered upserted then SkillDeactivated discarded it again — net: not indexed.
    expect(casperSkillIndex.getById(7)).toBeNull();

    // A second poll with no new events must not re-fetch anything already seen.
    await pollOnce(client, svc);
    expect(client.getEvent).toHaveBeenCalledTimes(3);
  });

  it("advances the cursor past a reconcile failure instead of retrying it forever", async () => {
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => {
        throw new Error("boom");
      }),
      getJob: vi.fn(async () => undefined),
      getEventCount: vi.fn(async () => 1),
      getEvent: vi.fn(
        async (): Promise<IndexedEvent> => ({
          type: "SkillRegistered",
          blockNumber: 0n,
          skillId: 1n,
          owner: "0x00" as never,
          name: "x",
          pricePerCall: 1n,
        }),
      ),
    };
    const svc = new CasperSkillIndexService(client);
    await pollOnce(client, svc);
    expect(getCasperIndexerHealth().reconcileErrors).toBeGreaterThan(0);

    // No further attempts on a second poll — the cursor moved past the failed event.
    const callsBefore = (client.getSkill as ReturnType<typeof vi.fn>).mock.calls.length;
    await pollOnce(client, svc);
    expect((client.getSkill as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });
});

describe("startCasperIndexer / stopCasperIndexer lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopCasperIndexer();
    vi.useRealTimers();
  });

  it("backfills immediately on start, then polls again on each interval tick", async () => {
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => decodedSkill()),
      getJob: vi.fn(async () => undefined),
      getEventCount: vi.fn(async () => 0),
      getEvent: vi.fn(async () => undefined),
    };
    startCasperIndexer(client, 1_000);
    await vi.waitFor(() => expect(client.getEventCount).toHaveBeenCalledTimes(1));
    expect(getCasperIndexerHealth().running).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getEventCount).toHaveBeenCalledTimes(2);
  });

  it("is idempotent — a second start() while already running is a no-op", async () => {
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => undefined),
      getJob: vi.fn(async () => undefined),
      getEventCount: vi.fn(async () => 0),
      getEvent: vi.fn(async () => undefined),
    };
    startCasperIndexer(client, 1_000);
    await vi.waitFor(() => expect(client.getEventCount).toHaveBeenCalledTimes(1));
    startCasperIndexer(client, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    // Exactly one poll from the interval, not two — a second timer was never started.
    expect(client.getEventCount).toHaveBeenCalledTimes(2);
  });

  it("stop() resets health back to the not-running defaults", async () => {
    const client: CasperEventClientLike = {
      getSkill: vi.fn(async () => undefined),
      getJob: vi.fn(async () => undefined),
      getEventCount: vi.fn(async () => 0),
      getEvent: vi.fn(async () => undefined),
    };
    startCasperIndexer(client, 1_000);
    await vi.waitFor(() => expect(client.getEventCount).toHaveBeenCalledTimes(1));
    stopCasperIndexer();
    expect(getCasperIndexerHealth()).toEqual({ running: false, lastSeenEventIndex: 0, reconcileErrors: 0 });
  });
});
