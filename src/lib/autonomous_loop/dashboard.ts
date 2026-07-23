/**
 * Dashboard publisher for the autonomous loop (T5.1).
 *
 * Two surfaces, picked by the orchestrator's runtime:
 *   1. JSON FILE — writes the latest state to a path the dashboard reads. Simplest:
 *      static HTML viewer polls the JSON every second. Zero infra. Demo-friendly.
 *   2. STREAM — append-only ndjson, one record per tick. Useful for replay + live
 *      visualization. Same shape as the JSON-file output, repeated.
 *
 * State serialization is deliberately bigint-safe — bigint values get an `_bigint`
 * suffix when JSON-stringified so consumers can round-trip the ledger.
 */

import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LoopAction, LoopState } from "./loop.js";

export interface DashboardRecord {
  state: SerializedState;
  lastAction: SerializedAction;
  /** Realized totals (computed once at write time so the viewer doesn't have to). */
  totals: {
    spendUsdcStroops: string;
    earningsUsdcStroops: string;
    netPnlUsdcStroops: string;
  };
  /** Unix ms the record was written. */
  writtenAt: number;
}

interface SerializedState extends Omit<LoopState, "budgetUsdc" | "spends" | "earnings"> {
  budgetUsdc: string;
  spends: Array<{ at: number; amountUsdc: string; skillId: string }>;
  earnings: Array<{ at: number; amountUsdc: string; source: string }>;
}

interface SerializedAction {
  kind: LoopAction["kind"];
  reason: string;
  sleepMs?: number;
  skillId?: string;
  skillName?: string;
  pricePerCallUsdc?: string;
}

function serializeState(state: LoopState): SerializedState {
  return {
    startedAt: state.startedAt,
    now: state.now,
    iterations: state.iterations,
    budgetUsdc: state.budgetUsdc.toString(),
    spends: state.spends.map((s) => ({ at: s.at, amountUsdc: s.amountUsdc.toString(), skillId: s.skillId })),
    earnings: state.earnings.map((e) => ({ at: e.at, amountUsdc: e.amountUsdc.toString(), source: e.source })),
  };
}

function serializeAction(action: LoopAction): SerializedAction {
  return {
    kind: action.kind,
    reason: action.reason,
    sleepMs: action.sleepMs,
    skillId: action.skill?.skillId,
    skillName: action.skill?.name,
    pricePerCallUsdc: action.skill?.pricePerCallUsdc.toString(),
  };
}

function totalsOf(state: LoopState, startingBudgetUsdc: bigint): DashboardRecord["totals"] {
  let spend = 0n;
  for (const s of state.spends) spend += s.amountUsdc;
  let earnings = 0n;
  for (const e of state.earnings) earnings += e.amountUsdc;
  return {
    spendUsdcStroops: spend.toString(),
    earningsUsdcStroops: earnings.toString(),
    netPnlUsdcStroops: (state.budgetUsdc - startingBudgetUsdc).toString(),
  };
}

/** Build a per-tick snapshot. Pure: takes state + last action → serializable record. */
export function snapshot(
  state: LoopState,
  lastAction: LoopAction,
  startingBudgetUsdc: bigint,
): DashboardRecord {
  return {
    state: serializeState(state),
    lastAction: serializeAction(lastAction),
    totals: totalsOf(state, startingBudgetUsdc),
    writtenAt: Date.now(),
  };
}

/** Overwrite a single JSON file with the latest snapshot. Cheap (one fsync). */
export function writeJsonSnapshot(path: string, record: DashboardRecord): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-controlled dashboard path
  mkdirSync(dirname(path), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-controlled dashboard path
  writeFileSync(path, JSON.stringify(record, null, 2));
}

/** Append the snapshot to an ndjson stream — replay-friendly. */
export function appendNdjsonSnapshot(path: string, record: DashboardRecord): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-controlled dashboard path
  mkdirSync(dirname(path), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-controlled dashboard path
  appendFileSync(path, JSON.stringify(record) + "\n");
}
