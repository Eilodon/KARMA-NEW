import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireTestnetEnv,
  requireCasperTestnetEnv,
  RunnerConfigError,
  buildDryRunAdapter,
} from "../lib/autonomous_loop/runner.js";
import { tick, type LoopBudget, type LoopState, type SkillCandidate } from "../lib/autonomous_loop/loop.js";

// T5.1 follow-on: the live/testnet runner. The network-free pieces (env gating, dry-run adapter,
// dashboard writes, circuit breaker) are fully verifiable here; the --live x402 leg is owner-driven.

const STARTING = 100_000_000n; // $10 in USDC stroops (1e7 = $1)
const candidate: SkillCandidate = {
  skillId: "s1",
  name: "oracle",
  pricePerCallUsdc: 1_000_000n, // $0.10
  expectedReturnUsdc: 1_500_000n, // $0.15
  reputation: 80,
  payee: "GPAYEE",
  network: "stellar:testnet",
};
const budget: LoopBudget = {
  maxPerTxUsdc: 5_000_000n,
  maxHourlyUsdc: 50_000_000n,
  circuitBreakerPaused: false,
};
function freshState(): LoopState {
  return { startedAt: 0, now: 0, budgetUsdc: STARTING, spends: [], earnings: [], iterations: 0 };
}

describe("runner — requireTestnetEnv (DP-3 testnet-only gate)", () => {
  it("throws RunnerConfigError listing the missing vars", () => {
    expect(() => requireTestnetEnv({})).toThrow(RunnerConfigError);
    expect(() => requireTestnetEnv({})).toThrow(/STELLAR_NETWORK/);
  });

  it("rejects mainnet — the autonomous loop is testnet-only", () => {
    expect(() =>
      requireTestnetEnv({ STELLAR_NETWORK: "stellar:pubnet", STELLAR_X402_FACILITATOR_URL: "https://f" }),
    ).toThrow(/testnet-only/);
  });

  it("returns the config for a valid testnet env", () => {
    expect(
      requireTestnetEnv({ STELLAR_NETWORK: "stellar:testnet", STELLAR_X402_FACILITATOR_URL: "https://f" }),
    ).toEqual({ network: "stellar:testnet", facilitatorUrl: "https://f" });
  });
});

describe("runner — requireCasperTestnetEnv (DP-3 testnet-only gate, Casper side)", () => {
  it("throws RunnerConfigError listing the missing vars", () => {
    expect(() => requireCasperTestnetEnv({})).toThrow(RunnerConfigError);
    expect(() => requireCasperTestnetEnv({})).toThrow(/CASPER_RPC_URL/);
    expect(() => requireCasperTestnetEnv({})).toThrow(/KARMA_ODRA_REGISTRY/);
  });

  it("rejects a non-testnet RPC URL — the autonomous loop is testnet-only", () => {
    expect(() =>
      requireCasperTestnetEnv({
        CASPER_RPC_URL: "https://node.mainnet.cspr.cloud",
        KARMA_ODRA_REGISTRY: "hash-abc",
      }),
    ).toThrow(/testnet-only/);
  });

  it("returns the config for a valid testnet env", () => {
    expect(
      requireCasperTestnetEnv({
        CASPER_RPC_URL: "https://node.testnet.cspr.cloud",
        KARMA_ODRA_REGISTRY: "hash-abc",
      }),
    ).toEqual({ rpcUrl: "https://node.testnet.cspr.cloud", contractHash: "hash-abc" });
  });
});

describe("runner — dry-run adapter drives the loop + writes the dashboard", () => {
  const tmp = mkdtempSync(join(tmpdir(), "karma-loop-"));
  const jsonPath = join(tmp, "dash.json");
  const ndjsonPath = join(tmp, "dash.ndjson");

  it("invokes the profitable candidate, grows the budget, and snapshots earnings", async () => {
    const adapter = buildDryRunAdapter(
      { candidates: [candidate], returnBps: 12_000 }, // 1.2x gross return
      { jsonPath, ndjsonPath },
      STARTING,
    );
    const { action, state } = await tick(freshState(), budget, adapter, 60_000);
    expect(action.kind).toBe("invoke");
    // earning = price * 1.2 = 1_200_000; net per tick = -1_000_000 + 1_200_000 = +200_000
    expect(state.budgetUsdc).toBe(STARTING - 1_000_000n + 1_200_000n);
    expect(existsSync(jsonPath)).toBe(true);
    const rec = JSON.parse(readFileSync(jsonPath, "utf8")) as { totals: { earningsUsdcStroops: string } };
    expect(rec.totals.earningsUsdcStroops).toBe("1200000");
  });

  it("honors the circuit-breaker control file (paused → noop)", async () => {
    const controlPath = join(tmp, "control.json");
    writeFileSync(controlPath, JSON.stringify({ paused: true }));
    const adapter = buildDryRunAdapter(
      { candidates: [candidate], returnBps: 12_000 },
      { jsonPath, ndjsonPath, controlPath },
      STARTING,
    );
    const { action } = await tick(freshState(), budget, adapter, 120_000);
    expect(action.kind).toBe("noop");
    expect(action.reason).toBe("circuit_breaker_paused");
  });

  it("treats an absent control file as not-paused", async () => {
    const adapter = buildDryRunAdapter(
      { candidates: [candidate], returnBps: 12_000 },
      { jsonPath, ndjsonPath, controlPath: join(tmp, "does-not-exist.json") },
      STARTING,
    );
    const { action } = await tick(freshState(), budget, adapter, 180_000);
    expect(action.kind).toBe("invoke");
  });
});
