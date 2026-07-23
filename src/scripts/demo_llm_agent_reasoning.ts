/**
 * LLM-driven agent reasoning demo (T5.2) — the autonomous loop's greedy `decide()` is
 * real and tested, but it is a formula, not a judgment call. This script puts an
 * actual LLM in the same seat, choosing among the exact same safety-checked
 * candidates, and prints its reasoning verbatim next to what the formula alone would
 * have picked.
 *
 * Offline by default — no chain, no keystore. Set ANTHROPIC_API_KEY to see a real
 * Anthropic call reason over the marketplace below; without it, this prints the
 * deterministic pick only and explains how to turn the LLM leg on.
 *
 *   pnpm demo:llm-agent
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm demo:llm-agent
 */

import {
  decide,
  pickGreedyBest,
  filterEligible,
  type LoopBudget,
  type LoopState,
  type SkillCandidate,
} from "../lib/autonomous_loop/loop.js";
import {
  decideWithReasoning,
  buildAnthropicReasoningProvider,
  type ReasoningProvider,
} from "../lib/autonomous_loop/llm_strategy.js";

const STROOPS = 10_000_000n; // 1 USDC = 1e7 stroops

function usd(v: bigint): string {
  return `$${(Number(v) / 1e7).toFixed(3)}`;
}

function box(label: string, lines: string[]): void {
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}

/** A deliberately non-obvious marketplace: the highest-EV skill also carries the
 *  weakest reputation of the three, brand new with no track record. The greedy
 *  formula cannot see that risk (reputation is only a tie-breaker); a reasoning
 *  agent can talk about it explicitly — that gap is the whole point of this demo. */
function marketplace(): SkillCandidate[] {
  return [
    {
      skillId: "rwa_price_oracle",
      name: "rwa_price_oracle (BTC/USD feed)",
      pricePerCallUsdc: 100_000n, // $0.01
      expectedReturnUsdc: 180_000n, // $0.018 — solid, unremarkable EV
      reputation: 88,
      payee: "account-hash-c863d5...6234",
      network: "casper:testnet",
    },
    {
      skillId: "unaudited_yield_signal",
      name: "unaudited_yield_signal (new provider)",
      pricePerCallUsdc: 100_000n, // same price
      expectedReturnUsdc: 260_000n, // $0.026 — the greedy-best pick by raw EV
      reputation: 12, // brand new, no completed jobs yet
      payee: "account-hash-9a41f2...77c1",
      network: "casper:testnet",
    },
    {
      skillId: "doc_summary",
      name: "doc_summary (established)",
      pricePerCallUsdc: 50_000n, // $0.005
      expectedReturnUsdc: 90_000n, // $0.009
      reputation: 91,
      payee: "account-hash-4372145f...2ffd9",
      network: "casper:testnet",
    },
  ];
}

function freshState(): LoopState {
  const now = Date.now();
  return { startedAt: now, now, budgetUsdc: 10n * STROOPS, spends: [], earnings: [], iterations: 0 };
}

function freshBudget(): LoopBudget {
  return { maxPerTxUsdc: STROOPS, maxHourlyUsdc: 5n * STROOPS, circuitBreakerPaused: false };
}

async function main(): Promise<void> {
  console.log("=".repeat(78));
  console.log("KARMA autonomous loop — LLM reasoning vs. deterministic greedy pick (T5.2)");
  console.log("=".repeat(78));

  const state = freshState();
  const budget = freshBudget();
  const candidates = marketplace();

  const filtered = filterEligible(state, budget, candidates);
  const eligible = filtered.ok ? filtered.eligible : [];
  console.log(`\n[market] ${candidates.length} skills discovered, ${eligible.length} cleared the hard safety caps:`);
  for (const c of eligible) {
    const profit = c.expectedReturnUsdc - c.pricePerCallUsdc;
    console.log(
      `  - ${c.skillId.padEnd(24)} price=${usd(c.pricePerCallUsdc)}  profit=${usd(profit)}  reputation=${c.reputation}`,
    );
  }

  const greedy = decide(state, budget, candidates);
  box("Deterministic pick (decide(), unchanged formula)", [
    `chosen  = ${greedy.kind === "invoke" ? greedy.skill?.skillId : "(noop)"}`,
    `reason  = ${greedy.reason}`,
    `rationale = none — a formula does not explain itself`,
  ]);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      "\n[llm] ANTHROPIC_API_KEY is not set — skipping the live reasoning call.\n" +
        "      Re-run with:  ANTHROPIC_API_KEY=sk-ant-... pnpm demo:llm-agent\n" +
        "      to see an actual Claude call choose among the same candidates and explain why —\n" +
        "      the wiring (decideWithReasoning + buildAnthropicReasoningProvider) is real code,\n" +
        "      unit-tested with a fake provider in src/__tests__/llm_strategy.test.ts; this is\n" +
        "      just the network leg gated behind a key nobody should hardcode.",
    );
    console.log("\n[demo] deterministic leg PASS (offline)");
    return;
  }

  const reasoning: ReasoningProvider = buildAnthropicReasoningProvider({ apiKey });
  const reasoned = await decideWithReasoning(state, budget, candidates, reasoning);

  const chosenId = reasoned.action.kind === "invoke" ? reasoned.action.skill?.skillId : "(noop)";
  box(`LLM pick (source=${reasoned.source})`, [
    `chosen    = ${chosenId}`,
    `greedy would've picked = ${pickGreedyBest(eligible).skillId}`,
    `agreement = ${chosenId === pickGreedyBest(eligible).skillId ? "same as formula" : "LLM DIVERGED from the formula"}`,
  ]);
  console.log(`\n[llm] rationale:\n  "${reasoned.rationale}"`);

  console.log(
    "\n┌── Falsifiable claim ──────────────────────────────────────────────────────",
  );
  console.log("│ The LLM never saw a candidate the safety filter had already rejected — it");
  console.log("│ chose only among skills that already cleared the per-tx and per-hour caps");
  console.log("│ (filterEligible in loop.ts, unchanged, still covered by autonomous_loop.test.ts).");
  console.log("│ If the model had named a skillId outside that set, or the API call had failed,");
  console.log("│ decideWithReasoning falls back to the exact same deterministic pick above —");
  console.log("│ see the llm_fallback branch covered in llm_strategy.test.ts.");
  console.log(
    "└──────────────────────────────────────────────────────────────────────────",
  );
  console.log("\n[demo] LLM reasoning leg PASS (live Anthropic call)");
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
