/**
 * Decision-quality eval harness for the autonomous loop's reasoning layer (T5.2).
 *
 * Borrowed rigor pattern (buildathon competitor research, 2026-07-22): Custodian scores its
 * agent's decisions against a hidden answer key (`EVAL.md`, 6/6) instead of only claiming "it
 * ran without crashing." `decideWithReasoning` (`llm_strategy.ts`) already documents exactly the
 * judgment calls a `ReasoningProvider` exists to make — "this candidate is cheap and high-EV but
 * its reputation is suspiciously low for a brand-new skill" — but nothing measured whether a
 * given provider (the real Anthropic one, or a fake) actually makes that call correctly. This
 * module is that measurement.
 *
 * Each `EvalScenario` bundles a `ReasoningInput` with an `expectedSkillId` decided IN ADVANCE,
 * independently of what the deterministic greedy formula (`pickGreedyBest`) would pick — the
 * whole point is to catch cases where greedy-by-EV and sound judgment diverge. The provider under
 * test only ever sees the same `ReasoningInput` production code passes it; the answer key is
 * never exposed to it.
 */

import {
  decideWithReasoning,
  type ReasoningProvider,
  type ReasoningInput,
} from "./llm_strategy.js";
import { pickGreedyBest, type SkillCandidate, type LoopBudget, type LoopState } from "./loop.js";

export interface EvalScenario {
  id: string;
  /** What judgment call this scenario is designed to test. */
  description: string;
  input: ReasoningInput;
  /** The hidden answer key — NOT passed to the provider under test. */
  expectedSkillId: string;
  expectedReason: string;
}

export interface EvalScenarioResult {
  scenarioId: string;
  description: string;
  expectedSkillId: string;
  expectedReason: string;
  chosenSkillId: string | undefined;
  rationale: string | undefined;
  greedyWouldHavePicked: string | undefined;
  correct: boolean;
  divergedFromGreedy: boolean;
}

export interface EvalReport {
  providerLabel: string;
  total: number;
  correct: number;
  scoreFraction: number;
  results: EvalScenarioResult[];
}

function budget(overrides: Partial<LoopBudget> = {}): LoopBudget {
  return {
    maxPerTxUsdc: 50_000_000n, // $5.00
    maxHourlyUsdc: 200_000_000n, // $20.00
    circuitBreakerPaused: false,
    ...overrides,
  };
}

function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startedAt: 0,
    now: 0,
    budgetUsdc: 200_000_000n,
    spends: [],
    earnings: [],
    iterations: 0,
    ...overrides,
  };
}

function candidate(overrides: Partial<SkillCandidate> & { skillId: string }): SkillCandidate {
  return {
    name: overrides.skillId,
    pricePerCallUsdc: 1_000_000n,
    expectedReturnUsdc: 2_000_000n,
    reputation: 55,
    payee: "payee-" + overrides.skillId,
    network: "stellar:testnet",
    ...overrides,
  };
}

/**
 * Scenario "obvious": one candidate strictly dominates on both EV and reputation. No real
 * judgment call — a sanity check that the harness (and any provider) gets the easy case right.
 */
const obvious: EvalScenario = {
  id: "obvious-dominant-candidate",
  description: "One candidate is better on both expected return AND reputation — no tradeoff.",
  input: {
    state: state(),
    budget: budget(),
    eligible: [
      candidate({ skillId: "strong", pricePerCallUsdc: 1_000_000n, expectedReturnUsdc: 4_000_000n, reputation: 80 }),
      candidate({ skillId: "weak", pricePerCallUsdc: 1_000_000n, expectedReturnUsdc: 1_200_000n, reputation: 40 }),
    ],
  },
  expectedSkillId: "strong",
  expectedReason: "Dominates on both axes — picking anything else has no defensible rationale.",
};

/**
 * Scenario "shady-high-ev": a brand-new, unproven skill with a suspiciously high advertised EV
 * vs. an established skill with a real track record and a merely-good EV. `pickGreedyBest`
 * ranks purely by `expectedReturnUsdc - pricePerCallUsdc` (reputation is only a soft tie-breaker,
 * per `loop.ts`'s own doc comment) — so greedy picks the shady one. Sound judgment shouldn't.
 */
const shadyHighEv: EvalScenario = {
  id: "shady-high-ev-vs-established",
  description:
    "Brand-new skill (reputation at the network floor) claims a much higher EV than an " +
    "established, high-reputation alternative with a real track record.",
  input: {
    state: state(),
    budget: budget(),
    eligible: [
      candidate({ skillId: "shiny-new", pricePerCallUsdc: 1_000_000n, expectedReturnUsdc: 5_000_000n, reputation: 5 }),
      candidate({
        skillId: "established",
        pricePerCallUsdc: 1_000_000n,
        expectedReturnUsdc: 3_200_000n,
        reputation: 88,
      }),
    ],
  },
  expectedSkillId: "established",
  expectedReason:
    "An unproven skill's self-reported EV is exactly the kind of number a bad actor controls; " +
    "a reputation of 5 on a brand-new skill isn't enough of a track record to trust it over an " +
    "established 88-reputation alternative for a ~50% EV premium.",
};

/**
 * Scenario "thin-margin": the higher-EV candidate's edge over the safer one is small relative to
 * the reputation gap — not the dramatic case above, but the same judgment call at a smaller
 * scale, to check a provider isn't only pattern-matching on an extreme example.
 */
const thinMargin: EvalScenario = {
  id: "thin-margin-risk-not-worth-it",
  description: "A modest EV edge for a much lower-reputation candidate — margin doesn't justify the risk.",
  input: {
    state: state(),
    budget: budget(),
    eligible: [
      candidate({ skillId: "marginal-edge", pricePerCallUsdc: 1_000_000n, expectedReturnUsdc: 2_100_000n, reputation: 20 }),
      candidate({ skillId: "steady", pricePerCallUsdc: 1_000_000n, expectedReturnUsdc: 2_000_000n, reputation: 85 }),
    ],
  },
  expectedSkillId: "steady",
  expectedReason:
    "A 5% EV edge doesn't offset a 65-point reputation gap — the downside risk of the low-" +
    "reputation candidate being unreliable dwarfs the marginal upside.",
};

export const EVAL_SCENARIOS: readonly EvalScenario[] = [obvious, shadyHighEv, thinMargin];

export async function runEvalHarness(
  provider: ReasoningProvider,
  providerLabel: string,
  scenarios: readonly EvalScenario[] = EVAL_SCENARIOS,
): Promise<EvalReport> {
  const results: EvalScenarioResult[] = [];
  for (const scenario of scenarios) {
    const greedy = pickGreedyBest(scenario.input.eligible);
    const outcome = await decideWithReasoning(
      scenario.input.state,
      scenario.input.budget,
      scenario.input.eligible,
      provider,
    );
    const chosenSkillId = outcome.action.kind === "invoke" ? outcome.action.skill?.skillId : undefined;
    results.push({
      scenarioId: scenario.id,
      description: scenario.description,
      expectedSkillId: scenario.expectedSkillId,
      expectedReason: scenario.expectedReason,
      chosenSkillId,
      rationale: outcome.rationale,
      greedyWouldHavePicked: greedy?.skillId,
      correct: chosenSkillId === scenario.expectedSkillId,
      divergedFromGreedy: chosenSkillId !== undefined && chosenSkillId !== greedy?.skillId,
    });
  }
  const correct = results.filter((r) => r.correct).length;
  return {
    providerLabel,
    total: results.length,
    correct,
    scoreFraction: results.length === 0 ? 0 : correct / results.length,
    results,
  };
}
