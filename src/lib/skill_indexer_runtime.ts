import {
  startSkillIndexer,
  type IndexedEvent,
  type IndexerHealth,
  type SkillEventIndexer,
} from "./contract.js";
import { realKarmaService, type KarmaService, type OnchainSkill } from "./karma_service.js";

/** The only slice of `KarmaService` event reconciliation actually touches — narrowed so a
 *  chain-specific service (e.g. Casper's, backed by `CasperLiveClient` instead of viem) can
 *  reuse `applyIndexedEvent`/`applyWithRetry` without implementing all ~30 Pharos-write methods
 *  `KarmaService` also carries. Any real `KarmaService` still satisfies this structurally. */
export type SkillIndexService = Pick<KarmaService, "readSkill" | "readJob" | "indexUpsert" | "indexDiscard" | "indexSetMinReputation">;
import { skillIndex, legacyReputationBoost, DEFAULT_PAYMENT_OPTIONS, type SkillBoost } from "./bm25_index.js";
import { FlowBoostSource, type FlowEdge } from "./flow_reputation.js";
import type { SkillDocument } from "./types.js";

/**
 * Production wiring that connects the on-chain SkillEventIndexer to the in-process BM25 index,
 * and holds the live indexer so its health() can be surfaced through karma_health.
 *
 * This is the runtime that closes the gap the README maintainer notes flagged (PD-002): the
 * indexer state machine exists in contract.ts, but nothing started it or reconciled its events
 * into the discovery index. Started explicitly from index.ts main() — NOT at module import — so
 * unit tests that import karma.tool never trigger network I/O. Singleton + in-process only (D-1).
 *
 * Event reconciliation (chain → index):
 *   - SkillRegistered   → hydrate the full skill (readSkill) and upsert (event lacks
 *                         description/endpoint, which the BM25 doc needs).
 *   - SkillDeactivated  → discard from the index.
 *   - JobCompleted      → reputation bumped on-chain for the job's skill; the event carries no
 *                         skillId, so resolve jobId → skillId (readJob) and re-hydrate that skill.
 */

/** Build a BM25 SkillDocument from on-chain skill state. All uint256s become D-6-safe strings/numbers.
 *  `repOverride` lets the caller supply the authoritative reputation value from an event (e.g.
 *  JobCompleted.newReputation) instead of trusting a potentially-stale RPC re-read. */
export function skillDocFromChain(skillId: bigint, s: OnchainSkill, repOverride?: bigint): SkillDocument {
  return {
    id: Number(skillId),
    skill_id: Number(skillId),
    name: s.name,
    description: s.description,
    mcp_endpoint: s.mcpEndpoint,
    price_per_call_wei: String(s.pricePerCall),
    reputation_score: Number(repOverride ?? s.reputationScore),
    owner_address: s.owner,
    active: s.active,
    identity_policy: s.identityPolicy,
    // Phase 0: every chain-hydrated skill defaults to the Pharos escrow rail. x402 fast-lane options
    // are added by register_skill (T2) once an owner declares them; chain-only metadata stays minimal.
    payment_options: [...DEFAULT_PAYMENT_OPTIONS],
  };
}

/**
 * Reconcile one indexed event into the discovery index. Pure over the KarmaService seam (testable).
 * `flow`, when provided, also captures the JobCompleted endorsement edge for Tier-1 flow reputation —
 * passed only when KARMA_DISCOVERY_RANK=flow (see startKarmaIndexer), so default behavior is unchanged.
 */
export async function applyIndexedEvent(
  svc: SkillIndexService,
  e: IndexedEvent,
  flow?: {
    record(edge: FlowEdge): void;
    setBondSeed(agent: string, bondWei: bigint): void;
    recordDispute(provider: string, timestamp: number): void;
  },
): Promise<void> {
  switch (e.type) {
    case "SkillRegistered": {
      const s = await svc.readSkill(e.skillId);
      svc.indexUpsert(skillDocFromChain(e.skillId, s));
      return;
    }
    case "SkillDeactivated":
      svc.indexDiscard(Number(e.skillId));
      return;
    case "JobCompleted": {
      const job = await svc.readJob(e.jobId);
      // Self-deal guard (mirrors Tier-0): on-chain didn't change reputationScore/totalInvocations,
      // so there is no BM25 state to update and no flow edge to record — skip both RPC calls.
      if (job.requester.toLowerCase() === job.provider.toLowerCase()) return;
      const s = await svc.readSkill(job.skillId);
      // H1 fix: use e.newReputation (authoritative — carried in the event) instead of trusting
      // s.reputationScore which can be one block behind on a lagging RPC node.
      svc.indexUpsert(skillDocFromChain(job.skillId, s, e.newReputation));
      // Tier-1: record the arm's-length endorsement (requester paid provider) into the flow graph.
      flow?.record({
        from: job.requester,
        to: job.provider,
        valueWei: job.escrowAmount,
        timestamp: Number(job.completedAt),
      });
      return;
    }
    case "BondUpdated":
      // Tier-2: mirror an agent's on-chain seed-eligible bond into the flow-rep seed (0 ⇒ removed).
      // No BM25 doc change — bonds seed trust origination, not the skill text/price/active state.
      flow?.setBondSeed(e.agent, e.seedEligible);
      return;
    case "ResultDisputed": {
      // T0.1 P3-lite: dispute → soft penalty to provider's flow rep (ranking only, never funds).
      // The on-chain event indexes only the requester; resolve provider via readJob. If `flow` is
      // not wired (KARMA_DISCOVERY_RANK != "flow") this is a no-op apart from the cheap RPC read,
      // so gate the readJob on flow being present.
      if (!flow) return;
      const job = await svc.readJob(e.jobId);
      // Time anchor: the dispute window starts at delivery. completedAt is 0 for unsettled jobs,
      // so use createdAt as a stable lower bound (the actual dispute happened later, but decay
      // half-life is days — sub-day error is negligible for ranking).
      const ts = Number(job.completedAt > 0n ? job.completedAt : job.createdAt);
      flow.recordDispute(job.provider, ts);
      return;
    }
    case "MinReputationSet":
      // H2 fix: persist the on-chain Trust Gate threshold without a full skill re-read, so
      // replaying this event after restart restores every skill's threshold — closes the Phase-1 gap.
      svc.indexSetMinReputation(Number(e.skillId), Number(e.minReputation));
      return;
  }
}

/** Hybrid boost for flow mode (M3): returns max(legacyReputationBoost, flowBoost) so agents with
 *  no flow-graph history still get the on-chain-rep floor (1.5 for base-50 rep) instead of the
 *  neutral 1.0. Exported as a pure function so it can be unit-tested without starting the indexer. */
export function makeFlowHybridBoost(flowSrc: { boostFor(addr: string): number }): SkillBoost {
  return (doc) => Math.max(legacyReputationBoost(doc), flowSrc.boostFor(doc.owner_address));
}

const MAX_RECONCILE_RETRIES = 3;
const RECONCILE_RETRY_BASE_MS = 200;

/** Retry wrapper for applyIndexedEvent: retries up to maxRetries times on any thrown error
 *  (transient RPC failures — 429, timeout, brief outage) with exponential backoff.
 *  Exported so it can be unit-tested independently of the indexer singleton. */
export async function applyWithRetry(
  svc: SkillIndexService,
  e: IndexedEvent,
  flow?: {
    record(edge: FlowEdge): void;
    setBondSeed(agent: string, bondWei: bigint): void;
    recordDispute(provider: string, timestamp: number): void;
  },
  maxRetries = MAX_RECONCILE_RETRIES,
  baseDelayMs = RECONCILE_RETRY_BASE_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await applyIndexedEvent(svc, e, flow);
      return;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await new Promise<void>((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
}

let indexer: SkillEventIndexer | undefined;
/** Cumulative count of events that exhausted all retries and were dropped this session.
 *  Surfaced via getKarmaIndexerHealth() so operators can detect in-session BM25 drift. */
let reconcileErrors = 0;
/** Tier-1 flow-reputation source, created only when KARMA_DISCOVERY_RANK=flow. Holds the live edge
 *  graph + cached boosts; wired into skillIndex.setBoost so discovery ranks by propagated trust. */
let flowBoost: FlowBoostSource | undefined;

/**
 * Start the live skill indexer once (idempotent). Backfills from `fromBlock` then watches.
 * Index-apply errors are logged, never thrown into the watcher loop. Returns the singleton.
 *
 * Events are applied STRICTLY in arrival order via a serial promise chain. `applyIndexedEvent`
 * mixes async (readSkill/readJob then upsert) and sync (discard) work; firing them concurrently
 * could let a later SkillDeactivated.discard run before an earlier SkillRegistered.upsert resolves,
 * leaving a deactivated skill in the index. Serializing keeps the index consistent with chain order.
 */
export function startKarmaIndexer(
  svc: KarmaService = realKarmaService,
  fromBlock: bigint = BigInt(process.env.KARMA_INDEXER_FROM_BLOCK ?? 0),
  // DEBT-008 Phase 2: fired alongside (never inside) the reconcile chain below — synchronous,
  // fire-and-forget, and MUST NOT throw into the watcher. A throwing/slow onResourceEvent should
  // never be able to delay or break BM25/flow-rep reconciliation, so it is wrapped defensively
  // here rather than trusting every caller to guarantee that themselves.
  onResourceEvent?: (e: IndexedEvent) => void,
): SkillEventIndexer {
  if (indexer) return indexer;
  // M1 fix: read env at call time (not module load) so tests can set it before calling this function.
  if (process.env.KARMA_DISCOVERY_RANK === "flow") {
    flowBoost = new FlowBoostSource();
    // H3+M3 fix: hybrid boost gives new agents the legacy floor; ?. guards against shutdown race.
    skillIndex.setBoost(makeFlowHybridBoost({ boostFor: (addr) => flowBoost?.boostFor(addr) ?? 1 }));
    console.error("[KARMA] discovery ranking: Tier-1 flow reputation (KARMA_DISCOVERY_RANK=flow)");
  }
  let chain: Promise<void> = Promise.resolve();
  indexer = startSkillIndexer((e) => {
    chain = chain.then(() => applyWithRetry(svc, e, flowBoost)).catch((err) => {
      reconcileErrors++;
      console.error(`[KARMA] skill-index reconcile failed for ${e.type} (after ${MAX_RECONCILE_RETRIES} retries):`, err);
    });
    try {
      onResourceEvent?.(e);
    } catch (err) {
      console.error(`[KARMA] onResourceEvent hook failed for ${e.type} (ignored, reconciliation unaffected):`, err);
    }
  }, fromBlock);
  return indexer;
}

/** Indexer health for karma_health, or a not-started marker when the indexer was never wired.
 *  `reconcileErrors` counts events that exhausted all retries this session — non-zero means
 *  in-session BM25 drift; a restart (full backfill) recovers the missed events. */
export function getKarmaIndexerHealth(): (IndexerHealth & { reconcileErrors: number }) | { started: false } {
  if (!indexer) return { started: false };
  return { ...indexer.health(), reconcileErrors };
}

/** Stop and clear the indexer (graceful shutdown / test reset). Restores the legacy boost. */
export function stopKarmaIndexer(): void {
  indexer?.stop();
  indexer = undefined;
  reconcileErrors = 0;
  if (flowBoost) {
    skillIndex.setBoost(null);
    flowBoost = undefined;
  }
}
