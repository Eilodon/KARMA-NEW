/**
 * Score the autonomous loop's reasoning layer against a hidden answer key (T5.2 rigor check).
 *
 * Modes:
 *   • DRY-RUN (default, no ANTHROPIC_API_KEY needed) — runs the eval against `greedy-only`
 *     (the deterministic formula with zero judgment layer, i.e. what `decideWithReasoning`
 *     falls back to) so you can see, concretely, which scenarios a judgment layer needs to
 *     exist for at all. This is what CI / a reviewer with no API key can always reproduce.
 *   • LIVE (`--live`, needs ANTHROPIC_API_KEY) — runs the exact same scenarios against the real
 *     `buildAnthropicReasoningProvider` and reports its actual score.
 *
 *   pnpm exec tsx src/scripts/eval_autonomous_loop_reasoning.ts            # dry-run
 *   pnpm exec tsx src/scripts/eval_autonomous_loop_reasoning.ts --live     # requires ANTHROPIC_API_KEY
 */

import { runEvalHarness, EVAL_SCENARIOS } from "../lib/autonomous_loop/eval_harness.js";
import { buildAnthropicReasoningProvider, type ReasoningProvider } from "../lib/autonomous_loop/llm_strategy.js";
import { pickGreedyBest } from "../lib/autonomous_loop/loop.js";

const greedyOnlyProvider: ReasoningProvider = async ({ eligible }) => {
  const best = pickGreedyBest(eligible);
  return { skillId: best.skillId, rationale: "greedy formula only — no judgment layer" };
};

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  let provider: ReasoningProvider;
  let label: string;

  if (live) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("[eval] --live requires ANTHROPIC_API_KEY");
    provider = buildAnthropicReasoningProvider({ apiKey });
    label = `anthropic (${process.env.ANTHROPIC_MODEL ?? "default model"})`;
  } else {
    provider = greedyOnlyProvider;
    label = "greedy-only (dry-run baseline, no API key needed)";
    console.log(
      "[eval] dry-run mode — scoring the deterministic greedy formula itself, which is what\n" +
        "        decideWithReasoning() falls back to whenever no reasoning layer is wired in.\n" +
        "        Pass --live with ANTHROPIC_API_KEY set to score the real LLM instead.\n",
    );
  }

  const report = await runEvalHarness(provider, label);

  console.log(`Provider: ${report.providerLabel}`);
  console.log(`Score: ${report.correct}/${report.total} (${(report.scoreFraction * 100).toFixed(0)}%)\n`);
  for (const r of report.results) {
    const mark = r.correct ? "PASS" : "FAIL";
    console.log(`[${mark}] ${r.scenarioId}`);
    console.log(`       ${r.description}`);
    console.log(`       chose=${r.chosenSkillId ?? "(none)"}  expected=${r.expectedSkillId}  greedy-would-pick=${r.greedyWouldHavePicked}`);
    if (r.rationale) console.log(`       provider said: "${r.rationale}"`);
    if (!r.correct) console.log(`       why expected wins: ${r.expectedReason}`);
    console.log("");
  }
  console.log(`${EVAL_SCENARIOS.length} scenarios total. See eval_harness.ts for the full answer key.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
