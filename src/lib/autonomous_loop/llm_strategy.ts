/**
 * LLM-driven decision layer for the autonomous loop (T5.2).
 *
 * `loop.ts`'s `decide()` is a deterministic greedy formula — real, tested, and a fine
 * default, but it cannot explain *why* a choice is a good idea, and it can't weigh
 * anything the formula doesn't encode (e.g. "this candidate is cheap and high-EV but
 * its reputation is suspiciously low for a brand-new skill — worth a second look").
 *
 * This module keeps the hard safety rails from `loop.ts` completely unchanged —
 * `filterEligible()` still runs first and is the only thing allowed to reject a
 * candidate on budget/cap grounds — and adds a `ReasoningProvider` that gets to
 * choose *among* whatever survives that filter, plus explain its choice in plain
 * English. An LLM is one such provider (`buildAnthropicReasoningProvider` below);
 * tests inject a fake one so the decision logic itself never needs network access.
 *
 * Trust but verify: a `ReasoningProvider` is untrusted input. If it names a skill
 * that isn't in the eligible set (hallucination) or throws (API error, bad JSON),
 * `decideWithReasoning` falls back to the same deterministic pick `decide()` would
 * have made — an LLM can upgrade the decision, never bypass the safety kernel.
 */

import {
  filterEligible,
  pickGreedyBest,
  type LoopAction,
  type LoopBudget,
  type LoopState,
  type SkillCandidate,
} from "./loop.js";

export interface ReasoningResult {
  /** Must be one of the eligible candidates' `skillId` — validated by the caller. */
  skillId: string;
  /** Plain-English justification, shown verbatim to a judge/operator. */
  rationale: string;
}

export interface ReasoningInput {
  state: LoopState;
  budget: LoopBudget;
  eligible: SkillCandidate[];
}

/** Anything that can look at the eligible candidates and pick one, with a reason.
 *  An LLM call is the interesting case; a fixed-answer fake is what tests inject. */
export type ReasoningProvider = (input: ReasoningInput) => Promise<ReasoningResult>;

export type ReasoningSource = "llm" | "llm_fallback" | "no_candidates";

export interface ReasonedAction {
  action: LoopAction;
  /** Present only when kind === "invoke": the provider's own words, or the fallback note. */
  rationale?: string;
  source: ReasoningSource;
  /** What the deterministic loop alone would have picked — for judge-facing A/B display. */
  greedyPick?: SkillCandidate;
}

/** Same five-step safety filter as `decide()`, but the "which one" step is delegated
 *  to `reasoning` instead of the fixed greedy formula. Never calls `reasoning` when
 *  there's nothing eligible to choose from (saves an API call, and is why this stays
 *  cheaply testable: the no-candidates path needs no fake provider at all). */
export async function decideWithReasoning(
  state: LoopState,
  budget: LoopBudget,
  candidates: readonly SkillCandidate[],
  reasoning: ReasoningProvider,
  nextTickMs: number = 60_000,
): Promise<ReasonedAction> {
  const filtered = filterEligible(state, budget, candidates, nextTickMs);
  if (!filtered.ok) {
    return { action: filtered.action, source: "no_candidates" };
  }
  const { eligible } = filtered;
  const greedyPick = pickGreedyBest(eligible);

  let result: ReasoningResult;
  try {
    result = await reasoning({ state, budget, eligible });
  } catch (err) {
    return {
      action: {
        kind: "invoke",
        skill: greedyPick,
        reason: `expected_profit=${greedyPick.expectedReturnUsdc - greedyPick.pricePerCallUsdc}`,
      },
      rationale: `LLM reasoning unavailable (${(err as Error).message}); fell back to the deterministic greedy pick.`,
      source: "llm_fallback",
      greedyPick,
    };
  }

  const chosen = eligible.find((c) => c.skillId === result.skillId);
  if (!chosen) {
    return {
      action: {
        kind: "invoke",
        skill: greedyPick,
        reason: `expected_profit=${greedyPick.expectedReturnUsdc - greedyPick.pricePerCallUsdc}`,
      },
      rationale:
        `LLM named skillId "${result.skillId}", which is not in the eligible set ` +
        `(hallucination or stale reference); fell back to the deterministic greedy pick.`,
      source: "llm_fallback",
      greedyPick,
    };
  }

  return {
    action: { kind: "invoke", skill: chosen, reason: result.rationale },
    rationale: result.rationale,
    source: "llm",
    greedyPick,
  };
}

/** Renders the eligible set + budget context into the data an LLM reasons over.
 *  Kept separate from the Anthropic call itself so the prompt shape is unit-testable. */
export function describeEligibleForPrompt(input: ReasoningInput): string {
  const { state, budget, eligible } = input;
  const lines = eligible.map((c) => {
    const profit = c.expectedReturnUsdc - c.pricePerCallUsdc;
    return (
      `- skillId=${c.skillId} name=${c.name} price=${c.pricePerCallUsdc} ` +
      `expectedReturn=${c.expectedReturnUsdc} profit=${profit} reputation=${c.reputation} network=${c.network}`
    );
  });
  return [
    `Remaining budget: ${state.budgetUsdc} USDC stroops (1e7 = $1).`,
    `Hard caps: max ${budget.maxPerTxUsdc} per call, ${budget.maxHourlyUsdc} per rolling hour — already enforced, do not re-check them.`,
    `Eligible skills (already cleared every hard cap):`,
    ...lines,
  ].join("\n");
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
}

const REASONING_TOOL_NAME = "choose_skill";

/** A real LLM as the ReasoningProvider — one Anthropic Messages API call, forced
 *  through a tool call so the reply is structured `{ skillId, rationale }` rather
 *  than free text that would need fragile parsing. Requires `@anthropic-ai/sdk`
 *  and a real `ANTHROPIC_API_KEY`; nothing in this repo's test suite calls this
 *  function — it's exercised by `src/scripts/demo_llm_agent_reasoning.ts` only. */
export function buildAnthropicReasoningProvider(
  opts: AnthropicProviderOptions,
): ReasoningProvider {
  return async ({ state, budget, eligible }) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: opts.apiKey });

    const response = await client.messages.create({
      model: opts.model ?? "claude-sonnet-5",
      max_tokens: 512,
      system:
        "You are the decision-making core of an autonomous economic agent. You are shown a " +
        "shortlist of skills that already passed every hard safety cap (budget, per-tx, " +
        "per-hour) — you are only choosing WHICH one to buy, not whether spending is allowed. " +
        "Weigh expected profit against reputation as a risk signal: a high-profit skill from a " +
        "low-reputation provider is not automatically the best pick. Always call the " +
        `${REASONING_TOOL_NAME} tool with your choice — never answer in plain text.`,
      messages: [
        {
          role: "user",
          content: describeEligibleForPrompt({ state, budget, eligible }),
        },
      ],
      tools: [
        {
          name: REASONING_TOOL_NAME,
          description: "Record which eligible skill to invoke next, and why.",
          input_schema: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "Must exactly match one skillId from the eligible list.",
              },
              rationale: {
                type: "string",
                description: "2-3 plain-English sentences justifying the pick.",
              },
            },
            required: ["skillId", "rationale"],
          },
        },
      ],
      tool_choice: { type: "tool", name: REASONING_TOOL_NAME },
    });

    const toolUse = response.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("Anthropic response contained no tool_use block");
    }
    const input = toolUse.input as { skillId?: unknown; rationale?: unknown };
    if (typeof input.skillId !== "string" || typeof input.rationale !== "string") {
      throw new Error("Anthropic tool_use input missing skillId/rationale");
    }
    return { skillId: input.skillId, rationale: input.rationale };
  };
}
