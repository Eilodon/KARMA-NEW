import { describe, it, expect, vi } from "vitest";
import type { LoopBudget, LoopState, SkillCandidate } from "../lib/autonomous_loop/loop.js";
import {
  decideWithReasoning,
  describeEligibleForPrompt,
  type ReasoningProvider,
} from "../lib/autonomous_loop/llm_strategy.js";

const ONE_USDC = 10_000_000n;
const START_BUDGET = 10n * ONE_USDC;

function freshState(now: number = 1_700_000_000_000): LoopState {
  return { startedAt: now, now, budgetUsdc: START_BUDGET, spends: [], earnings: [], iterations: 0 };
}

function freshBudget(): LoopBudget {
  return { maxPerTxUsdc: ONE_USDC, maxHourlyUsdc: 2n * ONE_USDC, circuitBreakerPaused: false };
}

function cand(id: string, price: bigint, expected: bigint, rep: number = 75): SkillCandidate {
  return {
    skillId: id,
    name: `skill-${id}`,
    pricePerCallUsdc: price,
    expectedReturnUsdc: expected,
    reputation: rep,
    payee: "account-hash-" + "0".repeat(64),
    network: "casper:testnet",
  };
}

describe("decideWithReasoning", () => {
  it("never calls the reasoning provider when nothing is eligible", async () => {
    const reasoning = vi.fn<ReasoningProvider>();
    const result = await decideWithReasoning(
      freshState(),
      { ...freshBudget(), circuitBreakerPaused: true },
      [cand("a", ONE_USDC / 10n, ONE_USDC)],
      reasoning,
    );
    expect(result.source).toBe("no_candidates");
    expect(result.action.kind).toBe("noop");
    expect(reasoning).not.toHaveBeenCalled();
  });

  it("honors a valid LLM pick and carries its rationale", async () => {
    const candidates = [
      cand("low_profit", ONE_USDC / 10n, ONE_USDC / 5n),
      cand("risky_high_profit", ONE_USDC / 10n, 5n * ONE_USDC / 10n, 10),
    ];
    const reasoning: ReasoningProvider = async ({ eligible }) => {
      expect(eligible).toHaveLength(2);
      return { skillId: "low_profit", rationale: "Reputation 10 is too thin to trust despite higher EV." };
    };
    const result = await decideWithReasoning(freshState(), freshBudget(), candidates, reasoning);
    expect(result.source).toBe("llm");
    expect(result.action.kind).toBe("invoke");
    expect(result.action.skill?.skillId).toBe("low_profit");
    expect(result.rationale).toMatch(/Reputation 10/);
    expect(result.greedyPick?.skillId).toBe("risky_high_profit"); // formula would've picked the other one
  });

  it("falls back to the deterministic pick when the LLM hallucinates a skillId", async () => {
    const candidates = [cand("a", ONE_USDC / 10n, ONE_USDC / 5n)];
    const reasoning: ReasoningProvider = async () => ({
      skillId: "does_not_exist",
      rationale: "hallucinated",
    });
    const result = await decideWithReasoning(freshState(), freshBudget(), candidates, reasoning);
    expect(result.source).toBe("llm_fallback");
    expect(result.action.kind).toBe("invoke");
    expect(result.action.skill?.skillId).toBe("a");
    expect(result.rationale).toMatch(/not in the eligible set/);
  });

  it("falls back to the deterministic pick when the provider throws", async () => {
    const candidates = [cand("a", ONE_USDC / 10n, ONE_USDC / 5n)];
    const reasoning: ReasoningProvider = async () => {
      throw new Error("network timeout");
    };
    const result = await decideWithReasoning(freshState(), freshBudget(), candidates, reasoning);
    expect(result.source).toBe("llm_fallback");
    expect(result.action.skill?.skillId).toBe("a");
    expect(result.rationale).toMatch(/network timeout/);
  });
});

describe("describeEligibleForPrompt", () => {
  it("includes budget caps and every eligible candidate's fields", () => {
    const text = describeEligibleForPrompt({
      state: freshState(),
      budget: freshBudget(),
      eligible: [cand("a", ONE_USDC / 10n, ONE_USDC / 5n, 88)],
    });
    expect(text).toContain("skillId=a");
    expect(text).toContain("reputation=88");
    expect(text).toContain(`max ${freshBudget().maxPerTxUsdc}`);
  });
});
