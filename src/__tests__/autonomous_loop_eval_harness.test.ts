import { describe, it, expect } from "vitest";
import { runEvalHarness, EVAL_SCENARIOS } from "../lib/autonomous_loop/eval_harness.js";
import type { ReasoningProvider } from "../lib/autonomous_loop/llm_strategy.js";
import { pickGreedyBest } from "../lib/autonomous_loop/loop.js";

/** `filterEligible` returns a fresh array each call, so identify a scenario by the SET of
 *  skillIds it offers rather than array identity. Every scenario in EVAL_SCENARIOS uses a
 *  distinct skillId set, so this is unambiguous. */
function keyOf(candidates: readonly { skillId: string }[]): string {
  return candidates.map((c) => c.skillId).sort().join(",");
}
const ANSWER_KEY = new Map(EVAL_SCENARIOS.map((s) => [keyOf(s.input.eligible), s.expectedSkillId]));

/** Always answers correctly — a sanity check that the harness's own scoring math is right. */
const perfectProvider: ReasoningProvider = async ({ eligible }) => {
  const expected = ANSWER_KEY.get(keyOf(eligible));
  return { skillId: expected ?? eligible[0].skillId, rationale: "test double: always correct" };
};

/** Always picks the wrong one deliberately — proves the harness actually fails a bad provider
 *  instead of trivially passing everything. */
const alwaysWrongProvider: ReasoningProvider = async ({ eligible }) => {
  const expected = ANSWER_KEY.get(keyOf(eligible));
  const wrong = eligible.find((c) => c.skillId !== expected) ?? eligible[0];
  return { skillId: wrong.skillId, rationale: "test double: deliberately wrong" };
};

/** Mirrors the deterministic greedy formula exactly (no judgment layer at all) — this is what
 *  `decideWithReasoning` falls back to, and what the eval harness exists to catch failing on
 *  the judgment-call scenarios. */
const greedyOnlyProvider: ReasoningProvider = async ({ eligible }) => {
  const best = pickGreedyBest(eligible)!;
  return { skillId: best.skillId, rationale: "greedy: best expectedReturn - price" };
};

describe("autonomous-loop eval harness", () => {
  it("scores a perfect provider 100%", async () => {
    const report = await runEvalHarness(perfectProvider, "perfect-fake");
    expect(report.correct).toBe(report.total);
    expect(report.scoreFraction).toBe(1);
    expect(report.total).toBe(EVAL_SCENARIOS.length);
  });

  it("scores a deliberately-wrong provider below 100% — the harness actually discriminates", async () => {
    const report = await runEvalHarness(alwaysWrongProvider, "always-wrong-fake");
    expect(report.correct).toBe(0);
    expect(report.scoreFraction).toBe(0);
  });

  it("the 'obvious' scenario doesn't need judgment — greedy-only gets it right", async () => {
    const report = await runEvalHarness(greedyOnlyProvider, "greedy-only");
    const obvious = report.results.find((r) => r.scenarioId === "obvious-dominant-candidate")!;
    expect(obvious.correct).toBe(true);
  });

  it("greedy-only FAILS the shady-high-ev judgment call — this is the gap reasoning exists to close", async () => {
    const report = await runEvalHarness(greedyOnlyProvider, "greedy-only");
    const shady = report.results.find((r) => r.scenarioId === "shady-high-ev-vs-established")!;
    expect(shady.correct).toBe(false);
    expect(shady.chosenSkillId).toBe("shiny-new"); // greedy chases the unproven higher EV
    expect(shady.greedyWouldHavePicked).toBe("shiny-new");
    expect(shady.divergedFromGreedy).toBe(false); // it IS greedy, so no divergence by definition
  });

  it("greedy-only also fails the thin-margin scenario", async () => {
    const report = await runEvalHarness(greedyOnlyProvider, "greedy-only");
    const thin = report.results.find((r) => r.scenarioId === "thin-margin-risk-not-worth-it")!;
    expect(thin.correct).toBe(false);
    expect(thin.chosenSkillId).toBe("marginal-edge");
  });

  it("a provider that diverges from greedy toward the right answer is flagged as such", async () => {
    const report = await runEvalHarness(perfectProvider, "perfect-fake");
    const shady = report.results.find((r) => r.scenarioId === "shady-high-ev-vs-established")!;
    expect(shady.correct).toBe(true);
    expect(shady.chosenSkillId).toBe("established");
    expect(shady.greedyWouldHavePicked).toBe("shiny-new");
    expect(shady.divergedFromGreedy).toBe(true);
  });

  it("carries the hidden answer key's reasoning in the report for a human to read", async () => {
    const report = await runEvalHarness(perfectProvider, "perfect-fake");
    for (const r of report.results) {
      expect(r.expectedReason.length).toBeGreaterThan(0);
    }
  });
});
