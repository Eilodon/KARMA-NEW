/**
 * Autonomous economic loop (T5.1) — falsifiable public proof that KARMA's primitives
 * are enough for an agent to act economically without a human in the loop.
 *
 * Design split:
 *   • THIS MODULE is pure + deterministic given an injected `LoopAdapter`. Same
 *     inputs (state, adapter) ⇒ same outputs (action, next state). Tests can drive
 *     it through 24h of simulated ticks in microseconds.
 *   • The `run_autonomous_loop.ts` script (T5.1 follow-on) wires real adapters:
 *     `discover_skills` against the live KARMA index, x402 plugins for the
 *     invocation legs, dashboard JSON writer for visualization.
 *
 * Safety primitives (DP-3 — "$10 is the budget, not the floor"):
 *   • `LoopBudget.maxPerTxUsdc` — single-action upper bound; rejected at decision time.
 *   • `LoopBudget.maxHourlyUsdc` — sliding-window cap; rejected at decision time.
 *   • `LoopBudget.circuitBreakerPaused` — operator flag; loop emits a paused
 *     `noop` until cleared (the adapter polls this from a dashboard file).
 *
 * The loop's goal is "maximize earnings". That's expressed as the simple decision:
 *   pick the skill with the best `expectedReturn - cost` ratio that fits the safety caps.
 *   If nothing fits, sleep until the next tick. Iterations log to the dashboard.
 */

export interface LoopBudget {
  /** Hard cap on a single invocation in USDC stroops (1e7 = $1). */
  maxPerTxUsdc: bigint;
  /** Hard cap on rolling-1h spend in USDC stroops. */
  maxHourlyUsdc: bigint;
  /** Operator pause — when true, the loop emits noop ticks until cleared. */
  circuitBreakerPaused: boolean;
}

export interface SkillCandidate {
  skillId: string;
  name: string;
  /** Cost per invocation in USDC stroops. */
  pricePerCallUsdc: bigint;
  /** Agent's expected return from invoking this skill (in USDC stroops). Adapter-derived. */
  expectedReturnUsdc: bigint;
  /** Skill reputation 0..100; used as a soft tie-breaker. */
  reputation: number;
  /** Payment payee for x402 routing. */
  payee: string;
  /** Network for IPaymentPlugin lookup (e.g. "stellar:testnet"). */
  network: string;
}

export interface SpendRecord {
  /** Unix ms when the spend was committed. */
  at: number;
  /** USDC stroops debited. */
  amountUsdc: bigint;
  /** Skill id. */
  skillId: string;
}

export interface EarningRecord {
  at: number;
  amountUsdc: bigint;
  source: string;
}

export interface LoopState {
  /** Loop start wall-clock time (unix ms). */
  startedAt: number;
  /** Current wall-clock time (unix ms). */
  now: number;
  /** Remaining budget (USDC stroops). */
  budgetUsdc: bigint;
  /** Spend ledger (latest first). */
  spends: SpendRecord[];
  /** Earning ledger (latest first). */
  earnings: EarningRecord[];
  /** Total iteration counter. */
  iterations: number;
}

export interface LoopAction {
  kind: "invoke" | "noop";
  skill?: SkillCandidate;
  reason: string;
  /** When kind="noop", how long the caller should sleep before next tick (ms). */
  sleepMs?: number;
}

export interface LoopAdapter {
  /** Adapter returns candidate skills sorted by the adapter's own ranking. */
  discoverCandidates(): Promise<SkillCandidate[]>;
  /** Adapter actually invokes the skill (real x402 settle in production). Returns earnings. */
  invokeSkill(skill: SkillCandidate, state: LoopState): Promise<EarningRecord>;
  /** Adapter publishes the latest state to the dashboard (file/HTTP/etc.). */
  publish(state: LoopState): Promise<void>;
  /** Operator pause channel — adapter checks this on every tick. */
  isCircuitBreakerPaused(): Promise<boolean>;
}

/** Sum of all spends in the last `windowMs` from `now`. */
export function rollingSpend(state: LoopState, windowMs: number): bigint {
  let total = 0n;
  for (const s of state.spends) {
    if (state.now - s.at <= windowMs) total += s.amountUsdc;
    else break; // spends list is latest-first; we can stop once we drop out of window.
  }
  return total;
}

/** Result of the hard safety-rail filter (DP-3 caps) — shared by the deterministic
 *  `decide()` below and by `decideWithReasoning` in `llm_strategy.ts`. Keeping this as
 *  its own exported step means an LLM (or any other "brain") only ever gets to choose
 *  *among* candidates that already cleared the caps — it can never widen them. */
export type EligibilityResult =
  | { ok: true; eligible: SkillCandidate[] }
  | { ok: false; action: LoopAction };

/** Steps 1-3 of the selection rule: circuit breaker → hourly cap → per-candidate caps.
 *  Pure, and identical to what `decide()` used inline before this was extracted. */
export function filterEligible(
  state: LoopState,
  budget: LoopBudget,
  candidates: readonly SkillCandidate[],
  nextTickMs: number = 60_000,
): EligibilityResult {
  if (budget.circuitBreakerPaused) {
    return {
      ok: false,
      action: { kind: "noop", reason: "circuit_breaker_paused", sleepMs: nextTickMs },
    };
  }
  const hour = 60 * 60 * 1_000;
  const spent1h = rollingSpend(state, hour);
  const remainingHourly = budget.maxHourlyUsdc - spent1h;
  if (remainingHourly <= 0n) {
    return {
      ok: false,
      action: { kind: "noop", reason: "hourly_cap_exhausted", sleepMs: nextTickMs },
    };
  }
  const eligible = candidates.filter(
    (c) =>
      c.pricePerCallUsdc > 0n &&
      c.pricePerCallUsdc <= state.budgetUsdc &&
      c.pricePerCallUsdc <= budget.maxPerTxUsdc &&
      c.pricePerCallUsdc <= remainingHourly &&
      c.expectedReturnUsdc > c.pricePerCallUsdc,
  );
  if (eligible.length === 0) {
    return {
      ok: false,
      action: { kind: "noop", reason: "no_profitable_skill_within_caps", sleepMs: nextTickMs },
    };
  }
  return { ok: true, eligible };
}

/** Greedy tie-break rule used by `decide()`: highest `expectedReturn - price`, then
 *  highest reputation, then lowest price. Exported so `llm_strategy.ts` can report
 *  "what the deterministic loop would have picked" alongside an LLM's reasoned pick. */
export function pickGreedyBest(eligible: readonly SkillCandidate[]): SkillCandidate {
  return [...eligible].sort((a, b) => {
    const da = a.expectedReturnUsdc - a.pricePerCallUsdc;
    const db = b.expectedReturnUsdc - b.pricePerCallUsdc;
    if (db !== da) return db > da ? 1 : -1;
    if (b.reputation !== a.reputation) return b.reputation - a.reputation;
    return a.pricePerCallUsdc > b.pricePerCallUsdc
      ? 1
      : a.pricePerCallUsdc < b.pricePerCallUsdc
        ? -1
        : 0;
  })[0];
}

/** Pure decision: given the current state + budget + candidates, pick the best action.
 *  Selection rule:
 *    1. Filter to candidates priced at ≤ budgetUsdc AND ≤ maxPerTxUsdc.
 *    2. Filter to candidates whose price + rolling-1h spend ≤ maxHourlyUsdc.
 *    3. Filter to candidates with expectedReturn > price (positive expected profit).
 *    4. Among survivors, pick the highest `expectedReturn - price`, breaking ties on
 *       reputation, then on lowest price (cheaper = more iterations per budget).
 *    5. If no candidate survives, emit noop with `sleepMs = nextTickMs`. */
export function decide(
  state: LoopState,
  budget: LoopBudget,
  candidates: readonly SkillCandidate[],
  nextTickMs: number = 60_000,
): LoopAction {
  const filtered = filterEligible(state, budget, candidates, nextTickMs);
  if (!filtered.ok) return filtered.action;
  const best = pickGreedyBest(filtered.eligible);
  return {
    kind: "invoke",
    skill: best,
    reason: `expected_profit=${best.expectedReturnUsdc - best.pricePerCallUsdc}`,
  };
}

/** Apply the result of an `invoke` action to the state. Pure. */
export function applyInvocation(
  state: LoopState,
  skill: SkillCandidate,
  earning: EarningRecord,
): LoopState {
  return {
    ...state,
    budgetUsdc: state.budgetUsdc - skill.pricePerCallUsdc + earning.amountUsdc,
    spends: [{ at: state.now, amountUsdc: skill.pricePerCallUsdc, skillId: skill.skillId }, ...state.spends],
    earnings: [earning, ...state.earnings],
    iterations: state.iterations + 1,
  };
}

/** Advance the clock without doing any work (used for the noop path). */
export function applyNoop(state: LoopState, nowMs: number): LoopState {
  return { ...state, now: nowMs, iterations: state.iterations + 1 };
}

/** Total realized earnings since loop start (USDC stroops). */
export function totalEarnings(state: LoopState): bigint {
  let total = 0n;
  for (const e of state.earnings) total += e.amountUsdc;
  return total;
}

/** Total spend since loop start (USDC stroops). */
export function totalSpend(state: LoopState): bigint {
  let total = 0n;
  for (const s of state.spends) total += s.amountUsdc;
  return total;
}

/** Net P&L since loop start: budgetUsdc - startingBudget = earnings - spend. */
export function netPnl(state: LoopState, startingBudgetUsdc: bigint): bigint {
  return state.budgetUsdc - startingBudgetUsdc;
}

/** One iteration of the loop: pull adapter's candidate list, decide, optionally invoke,
 *  publish state. Returns { action, state } so the caller can observe both. */
export async function tick(
  state: LoopState,
  budget: LoopBudget,
  adapter: LoopAdapter,
  nowMs: number,
  nextTickMs: number = 60_000,
): Promise<{ action: LoopAction; state: LoopState }> {
  const paused = await adapter.isCircuitBreakerPaused();
  const liveBudget: LoopBudget = { ...budget, circuitBreakerPaused: paused };
  const tickedState: LoopState = { ...state, now: nowMs };

  const candidates = await adapter.discoverCandidates();
  const action = decide(tickedState, liveBudget, candidates, nextTickMs);

  let nextState: LoopState;
  if (action.kind === "invoke" && action.skill) {
    const earning = await adapter.invokeSkill(action.skill, tickedState);
    nextState = applyInvocation(tickedState, action.skill, earning);
  } else {
    nextState = applyNoop(tickedState, nowMs);
  }
  await adapter.publish(nextState);
  return { action, state: nextState };
}
