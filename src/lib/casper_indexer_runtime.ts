import type { Address, Hash } from "viem";
import type { CasperLiveClient } from "./casper/live_client.js";
import type { DecodedSkill, DecodedJob } from "./casper/odra_codec.js";
import { BM25SkillIndex } from "./bm25_index.js";
import { FlowBoostSource } from "./flow_reputation.js";
import { applyWithRetry, makeFlowHybridBoost, type SkillIndexService } from "./skill_indexer_runtime.js";
import type { OnchainSkill, OnchainJob } from "./karma_service.js";
import type { SkillDocument } from "./types.js";

/** The exact `CasperLiveClient` surface this module calls — narrowed to a type so tests can
 *  inject a fake without a real RPC endpoint, mirroring `casper.tool.ts`'s `CasperClientLike`. */
export type CasperEventClientLike = Pick<CasperLiveClient, "getSkill" | "getJob" | "getEventCount" | "getEvent">;

/**
 * Production wiring that connects Casper's Odra `AgentSkillRegistry` to its own BM25 discovery
 * index + Tier-1 flow-reputation graph — the Casper-side counterpart to
 * `skill_indexer_runtime.ts` (which does the same job for Pharos). Before this, Casper had zero
 * discovery/reputation data: `casper.tool.ts` could register/pay/dispute but nothing ever fed
 * `flow_reputation.ts`/a BM25 index, so a Casper skill was invisible to any "discover" flow.
 *
 * Deliberately a SEPARATE `BM25SkillIndex`/`FlowBoostSource` instance from Pharos's, not the same
 * shared singleton: skill ids are chain-local integers (Casper's skill #1 and Pharos's skill #1
 * are unrelated), so merging them into one `MiniSearch` index keyed by bare numeric id would
 * silently collide. Explicit cross-chain reputation portability already has its own path
 * (`get_cross_chain_rep`/the P0-B governance proposal lifecycle) — this module intentionally
 * doesn't try to implicitly blend the two chains' local reputation graphs.
 *
 * POLLING, not push-watch: Casper has no RPC equivalent of viem's `watchContractEvent` for CES
 * events (see `odra_events.ts`) — `getEventCount()`/`getEvent(i)` are point-in-time reads, so this
 * indexer polls on an interval instead of subscribing.
 */

export const casperSkillIndex = new BM25SkillIndex();

function toAddress(hashHex: string): Address {
  return `0x${hashHex}`;
}

function toHash(bytes: Uint8Array): Hash {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** Solidity has no `Option<Address>` — Pharos's ABI represents "no evaluator" as the zero
 *  address. Mirrored here so `OnchainJob.evaluator` (typed as a bare `Address`, never undefined)
 *  has a chain-agnostic-consistent "none" sentinel regardless of which chain hydrated it. */
const ZERO_ADDRESS: Address = toAddress("0".repeat(40));

const JOB_STATUS_TO_NUMBER: Record<DecodedJob["status"], number> = {
  Open: 0,
  Delivered: 1,
  Completed: 2,
  Refunded: 3,
  Disputed: 4,
};

function toOnchainSkill(s: DecodedSkill): OnchainSkill {
  return {
    owner: toAddress(s.owner.hashHex),
    name: s.name,
    description: s.description,
    mcpEndpoint: s.mcpEndpoint,
    pricePerCall: s.pricePerCallMotes,
    reputationScore: BigInt(s.reputationScore),
    totalInvocations: s.totalInvocations,
    active: s.active,
    registeredAt: s.registeredAt,
    minReputationToInvoke: BigInt(s.minReputationToInvoke),
    identityPolicy: s.identityPolicy,
  };
}

function toOnchainJob(j: DecodedJob): OnchainJob {
  return {
    requester: toAddress(j.requester.hashHex),
    provider: toAddress(j.provider.hashHex),
    skillId: j.skillId,
    taskHash: toHash(j.taskHash),
    escrowAmount: j.escrowAmountMotes,
    deadline: j.deadline,
    status: JOB_STATUS_TO_NUMBER[j.status],
    resultHash: toHash(j.resultHash),
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    evaluator: j.evaluator ? toAddress(j.evaluator.hashHex) : ZERO_ADDRESS,
    evaluatorFee: j.evaluatorFeeMotes,
  };
}

/** The seam `applyIndexedEvent`/`applyWithRetry` actually need, backed by `CasperLiveClient`
 *  reads instead of viem. `skillDocFromChain` (imported from `skill_indexer_runtime.ts`) already
 *  builds a `SkillDocument` from a plain `OnchainSkill`, so it's reused unmodified once the
 *  Casper→`OnchainSkill` mapping above is applied. */
export class CasperSkillIndexService implements SkillIndexService {
  constructor(private readonly client: CasperEventClientLike) {}

  async readSkill(skillId: bigint): Promise<OnchainSkill> {
    const s = await this.client.getSkill(skillId);
    if (!s) throw new Error(`[casper-indexer] skill ${skillId} not found`);
    return toOnchainSkill(s);
  }

  async readJob(jobId: bigint): Promise<OnchainJob> {
    const j = await this.client.getJob(jobId);
    if (!j) throw new Error(`[casper-indexer] job ${jobId} not found`);
    return toOnchainJob(j);
  }

  indexUpsert(doc: SkillDocument): void {
    casperSkillIndex.upsert(doc);
  }

  indexDiscard(skillId: number): void {
    casperSkillIndex.discard(skillId);
  }

  indexSetMinReputation(skillId: number, threshold: number): void {
    casperSkillIndex.setMinReputation(skillId, threshold);
  }
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface CasperIndexerHealth {
  running: boolean;
  lastSeenEventIndex: number;
  reconcileErrors: number;
}

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastSeenEventIndex = 0;
let reconcileErrors = 0;
let flowBoost: FlowBoostSource | undefined;
let running = false;

/** One poll tick: fetch the current event count, replay every event since the last-seen cursor
 *  through `applyWithRetry`, and advance the cursor regardless of decode/reconcile outcome (an
 *  event this indexer doesn't decode, or one that exhausts retries, must not be replayed forever
 *  on every subsequent tick — same "log and move on" philosophy as Pharos's own reconcile loop).
 *  Exported so it can be driven directly in tests, without fake timers. */
export async function pollOnce(client: CasperEventClientLike, svc: SkillIndexService): Promise<void> {
  const count = await client.getEventCount();
  for (let i = lastSeenEventIndex; i < count; i += 1) {
    try {
      const event = await client.getEvent(i);
      if (event) await applyWithRetry(svc, event, flowBoost);
    } catch (err) {
      reconcileErrors++;
      console.error(`[KARMA] casper-index reconcile failed for event ${i}:`, err);
    } finally {
      lastSeenEventIndex = i + 1;
    }
  }
}

/**
 * Start the Casper skill indexer once (idempotent) — polls `intervalMs` apart, backfilling from
 * event 0 on first start (no checkpoint persistence yet, same documented limitation as Pharos's
 * own indexer — PD-004 — a restart always replays from the beginning). Failures are logged, never
 * thrown into the poll loop.
 */
export function startCasperIndexer(client: CasperEventClientLike, intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
  if (running) return;
  running = true;
  if (process.env.KARMA_DISCOVERY_RANK === "flow") {
    flowBoost = new FlowBoostSource();
    const fb = flowBoost;
    casperSkillIndex.setBoost(makeFlowHybridBoost({ boostFor: (addr) => fb.boostFor(addr) }));
    console.error("[KARMA] Casper discovery ranking: Tier-1 flow reputation (KARMA_DISCOVERY_RANK=flow)");
  }
  const svc = new CasperSkillIndexService(client);
  const tick = () => {
    pollOnce(client, svc).catch((err) => console.error("[KARMA] casper-index poll failed:", err));
  };
  tick(); // don't wait a full interval for the first backfill
  pollTimer = setInterval(tick, intervalMs);
}

/** Stop and reset the indexer (graceful shutdown / test reset). Restores the legacy boost. */
export function stopCasperIndexer(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  running = false;
  lastSeenEventIndex = 0;
  reconcileErrors = 0;
  if (flowBoost) {
    casperSkillIndex.setBoost(null);
    flowBoost = undefined;
  }
}

export function getCasperIndexerHealth(): CasperIndexerHealth {
  return { running, lastSeenEventIndex, reconcileErrors };
}
