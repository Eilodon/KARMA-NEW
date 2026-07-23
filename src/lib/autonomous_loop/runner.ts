/**
 * Live/testnet runner wiring for the autonomous economic loop (T5.1 follow-on).
 *
 * The pure decision core lives in `loop.ts`. This module supplies the `LoopAdapter`
 * implementations + the testnet env gate, keeping ALL network code out of the lib (the live
 * x402 invoke leg is injected by `src/scripts/run_autonomous_loop.ts`). Everything here is
 * therefore deterministic + verifiable in CI; only the injected live invoke touches a chain.
 *
 * DP-3: the loop is testnet-only. `requireTestnetEnv` refuses anything but a `*testnet*` network.
 */

import { existsSync, readFileSync } from "node:fs";
import type { LoopAdapter, LoopState, SkillCandidate, EarningRecord } from "./loop.js";
import { snapshot, writeJsonSnapshot, appendNdjsonSnapshot } from "./dashboard.js";

export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerConfigError";
  }
}

export interface TestnetEnv {
  network: string;
  facilitatorUrl: string;
}

/** Validate the env required for a `--live` run. Throws listing what's missing; rejects mainnet. */
export function requireTestnetEnv(env: Record<string, string | undefined>): TestnetEnv {
  const network = env.STELLAR_NETWORK;
  const facilitatorUrl = env.STELLAR_X402_FACILITATOR_URL;
  const missing: string[] = [];
  if (!network) missing.push("STELLAR_NETWORK");
  if (!facilitatorUrl) missing.push("STELLAR_X402_FACILITATOR_URL");
  if (missing.length > 0) {
    throw new RunnerConfigError(`--live requires testnet env: ${missing.join(", ")}`);
  }
  if (!network!.includes("testnet")) {
    throw new RunnerConfigError(
      `autonomous loop is testnet-only (DP-3); STELLAR_NETWORK="${network!}" rejected`,
    );
  }
  return { network: network!, facilitatorUrl: facilitatorUrl! };
}

export interface CasperTestnetEnv {
  rpcUrl: string;
  contractHash: string;
}

/** Casper sibling of `requireTestnetEnv` — same DP-3 shape, Casper's own env var names
 *  (`CASPER_RPC_URL` + `KARMA_ODRA_REGISTRY`, matching every other Casper live script in this
 *  repo, e.g. `register_rwa_oracle_skill.ts`). Throws listing what's missing; rejects mainnet. */
export function requireCasperTestnetEnv(env: Record<string, string | undefined>): CasperTestnetEnv {
  const rpcUrl = env.CASPER_RPC_URL;
  const contractHash = env.KARMA_ODRA_REGISTRY;
  const missing: string[] = [];
  if (!rpcUrl) missing.push("CASPER_RPC_URL");
  if (!contractHash) missing.push("KARMA_ODRA_REGISTRY");
  if (missing.length > 0) {
    throw new RunnerConfigError(`--live requires testnet env: ${missing.join(", ")}`);
  }
  if (!rpcUrl!.includes("testnet")) {
    throw new RunnerConfigError(
      `autonomous loop is testnet-only (DP-3); CASPER_RPC_URL="${rpcUrl!}" rejected`,
    );
  }
  return { rpcUrl: rpcUrl!, contractHash: contractHash! };
}

export interface DashboardSink {
  jsonPath: string;
  ndjsonPath: string;
  /** Optional circuit-breaker file: a JSON `{ "paused": true }` pauses the loop. */
  controlPath?: string;
}

/** Shared publish hook: overwrite the live JSON snapshot + append to the replay ndjson stream. */
function makePublisher(sink: DashboardSink, startingBudgetUsdc: bigint) {
  return async (state: LoopState): Promise<void> => {
    const record = snapshot(state, { kind: "noop", reason: "post-tick" }, startingBudgetUsdc);
    writeJsonSnapshot(sink.jsonPath, record);
    appendNdjsonSnapshot(sink.ndjsonPath, record);
  };
}

/** Shared circuit-breaker reader: absent/unreadable control file never blocks the loop. */
function makePausedReader(sink: DashboardSink) {
  return async (): Promise<boolean> => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-controlled dashboard path
    if (!sink.controlPath || !existsSync(sink.controlPath)) return false;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-controlled dashboard path
      const parsed = JSON.parse(readFileSync(sink.controlPath, "utf8")) as { paused?: boolean };
      return parsed.paused === true;
    } catch {
      return false;
    }
  };
}

export interface DryRunOptions {
  candidates: SkillCandidate[];
  /** Deterministic gross return as basis points of price (e.g. 12000 = 1.2x). */
  returnBps: number;
}

/** Network-free adapter: fixed candidate list, deterministic earnings, real dashboard writes. */
export function buildDryRunAdapter(
  opts: DryRunOptions,
  sink: DashboardSink,
  startingBudgetUsdc: bigint,
): LoopAdapter {
  return {
    discoverCandidates: async () => opts.candidates,
    invokeSkill: async (skill, state): Promise<EarningRecord> => ({
      at: state.now,
      amountUsdc: (skill.pricePerCallUsdc * BigInt(opts.returnBps)) / 10_000n,
      source: `dry-run:${skill.skillId}`,
    }),
    publish: makePublisher(sink, startingBudgetUsdc),
    isCircuitBreakerPaused: makePausedReader(sink),
  };
}

/** The injected live invoke leg — constructed in the script from StellarX402Plugin (testnet). */
export type LiveInvoke = (skill: SkillCandidate, state: LoopState) => Promise<EarningRecord>;

export interface LiveOptions {
  discover: () => Promise<SkillCandidate[]>;
  invoke: LiveInvoke;
}

/** Live adapter: discovery + the real x402 invoke leg are injected; dashboard/pause are shared. */
export function buildLiveAdapter(
  opts: LiveOptions,
  sink: DashboardSink,
  startingBudgetUsdc: bigint,
): LoopAdapter {
  return {
    discoverCandidates: opts.discover,
    invokeSkill: opts.invoke,
    publish: makePublisher(sink, startingBudgetUsdc),
    isCircuitBreakerPaused: makePausedReader(sink),
  };
}
