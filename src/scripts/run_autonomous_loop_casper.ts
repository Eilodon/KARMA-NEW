/**
 * Live/testnet runner for the autonomous economic loop, Casper side (T5.1 follow-on).
 *
 * Mirrors `run_autonomous_loop.ts` (Stellar) exactly — same `tick()` core, same
 * `buildDryRunAdapter`/`buildLiveAdapter` from `runner.ts` (both chain-agnostic already) — but
 * wires the live invoke leg through `CasperX402Plugin` instead of `StellarX402Plugin`, and fixes
 * a bug the Stellar version still has: `keystoreManager.load()` must run BEFORE the plugin is
 * constructed, or its `pay()` call throws "Agent not found in keystore" the first time it tries
 * to sign. See `run_autonomous_loop.ts`'s own doc comment ("Known gap") for the original bug.
 *
 *   pnpm exec tsx src/scripts/run_autonomous_loop_casper.ts [--ticks N] [--budget USD] [--live]
 *
 *   • default (dry-run): deterministic, network-free. Drives the real `tick()` core against the
 *     dry-run adapter, writes the live dashboard JSON + replay ndjson. Fully verifiable offline.
 *   • --live: wires `CasperX402Plugin` for the x402 invoke leg. Requires testnet env (DP-3:
 *     CASPER_RPC_URL=*testnet* + KARMA_ODRA_REGISTRY). Owner-driven — needs a funded keystore.
 *
 * Live mode env vars (all required for --live unless marked optional):
 *   CASPER_RPC_URL                  — must contain "testnet" (e.g. "https://node.testnet.cspr.cloud"); mainnet rejected by DP-3 guard
 *   KARMA_ODRA_REGISTRY             — deployed AgentSkillRegistry contract package hash
 *   KARMA_X402_CASPER_FACILITATOR_URL — x402 facilitator URL (same var `src/lib/payment/boot.ts` uses)
 *   KARMA_X402_CASPER_SETTLEMENT_TOKEN — optional: X402SettlementToken package hash, for real EIP-712/CEP-18 settlement (see docs/rfc/2026-07-21-x402-casper-eip712-interop.md)
 *   KEYSTORE_PATH                   — path to the KARMA keystore JSON (default: ./keystore.json)
 *   KEYSTORE_PASSWORD               — password to decrypt the keystore
 *   KARMA_AGENT_ID                  — agent identity in the keystore (default: "agent-alpha")
 *
 * Safety: per-tx + hourly USD caps + a dashboard control file (`{ "paused": true }`) that pauses
 * the loop on the next tick. The $-budget is the cap, not the floor (DP-3) — same as Stellar.
 */

import {
  tick,
  totalEarnings,
  totalSpend,
  netPnl,
  type LoopBudget,
  type LoopState,
  type SkillCandidate,
  type EarningRecord,
} from "../lib/autonomous_loop/loop.js";
import {
  buildDryRunAdapter,
  buildLiveAdapter,
  requireCasperTestnetEnv,
  type LiveInvoke,
  type DashboardSink,
} from "../lib/autonomous_loop/runner.js";
import { CasperX402Plugin } from "../plugins/x402_casper.js";
import { keystoreManager } from "../lib/keystore.js";
import type { PaymentRequest } from "../lib/payment/plugin.js";

const USDC = 10_000_000n; // 1e7 stroops-equivalent = $1 (same unit convention as the Stellar script)

function flag(name: string): boolean {
  return process.argv.includes(name);
}
function opt(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
function box(label: string, lines: string[]): void {
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}
function usd(stroops: bigint): string {
  return `$${(Number(stroops) / 1e7).toFixed(4)}`;
}

// Canned marketplace candidates — same acknowledged scope limitation as the Stellar script: in
// --live these are the discovery seed (live discover_skills wiring is a follow-on), the x402
// invoke leg is real on testnet. `rwa_price_oracle` matches the real skill name registered by
// `register_rwa_oracle_skill.ts`; the other two are illustrative competing candidates so the
// greedy-best / LLM-reasoning selection actually has something to weigh (mirrors
// `demo_llm_agent_reasoning.ts`'s deliberately-adversarial market shape).
const CANDIDATES: SkillCandidate[] = [
  { skillId: "rwa_price_oracle", name: "rwa_price_oracle", pricePerCallUsdc: 1_000_000n, expectedReturnUsdc: 1_400_000n, reputation: 82, payee: "account-hash-0000000000000000000000000000000000000000000000000000000000000000", network: "casper:testnet" },
  { skillId: "unaudited_yield_signal", name: "unaudited_yield_signal", pricePerCallUsdc: 1_000_000n, expectedReturnUsdc: 1_600_000n, reputation: 12, payee: "account-hash-1111111111111111111111111111111111111111111111111111111111111111", network: "casper:testnet" },
  { skillId: "doc_summary", name: "doc_summary", pricePerCallUsdc: 500_000n, expectedReturnUsdc: 650_000n, reputation: 91, payee: "account-hash-2222222222222222222222222222222222222222222222222222222222222222", network: "casper:testnet" },
];

async function main(): Promise<void> {
  const ticks = opt("--ticks", 20);
  const budgetUsd = opt("--budget", 10);
  const live = flag("--live");
  const startingBudget = BigInt(Math.round(budgetUsd)) * USDC;

  const sink: DashboardSink = {
    jsonPath: "dashboard/autonomous_loop_casper.json",
    ndjsonPath: "dashboard/autonomous_loop_casper.ndjson",
    controlPath: "dashboard/control.json",
  };
  const budget: LoopBudget = {
    maxPerTxUsdc: 2_000_000n, // $0.20 per tx
    maxHourlyUsdc: 20_000_000n, // $2.00 / rolling hour
    circuitBreakerPaused: false,
  };

  const adapter = live
    ? buildLiveAdapter(
        { discover: async () => CANDIDATES, invoke: await makeLiveInvoke() },
        sink,
        startingBudget,
      )
    : buildDryRunAdapter({ candidates: CANDIDATES, returnBps: 12_000 }, sink, startingBudget);

  console.log("=".repeat(80));
  console.log(`KARMA autonomous economic loop (T5.1, Casper) — ${live ? "LIVE (testnet)" : "DRY-RUN"}`);
  console.log(`Budget cap ${usd(startingBudget)} · ticks ${ticks} · per-tx ${usd(budget.maxPerTxUsdc)} · hourly ${usd(budget.maxHourlyUsdc)}`);
  console.log("=".repeat(80));

  const now0 = Date.now();
  let state: LoopState = { startedAt: now0, now: now0, budgetUsdc: startingBudget, spends: [], earnings: [], iterations: 0 };

  for (let i = 0; i < ticks; i++) {
    const now = state.now + 60_000; // 1 simulated minute per tick
    const { action, state: next } = await tick(state, budget, adapter, now, 60_000);
    if (action.kind === "invoke" && action.skill) {
      console.log(`[tick ${String(i + 1).padStart(3)}] INVOKE ${action.skill.name.padEnd(24)} budget=${usd(next.budgetUsdc)} pnl=${usd(netPnl(next, startingBudget))}`);
    } else {
      console.log(`[tick ${String(i + 1).padStart(3)}] noop   ${action.reason}`);
    }
    state = next;
  }

  box("Autonomous loop result (Casper)", [
    `iterations       = ${state.iterations}`,
    `gross earnings   = ${usd(totalEarnings(state))}`,
    `gross spend      = ${usd(totalSpend(state))}`,
    `net P&L          = ${usd(netPnl(state, startingBudget))}`,
    `ending budget    = ${usd(state.budgetUsdc)}`,
    `dashboard        = ${sink.jsonPath} (+ ${sink.ndjsonPath})`,
    `viewer           = docs/media/autonomous-loop-dashboard.html (open locally, points at the JSON above)`,
  ]);
  console.log(`\n[loop] ${live ? "LIVE" : "DRY-RUN"} complete — net ${netPnl(state, startingBudget) >= 0n ? "PROFIT" : "LOSS"} ${usd(netPnl(state, startingBudget))}`);
}

async function makeLiveInvoke(): Promise<LiveInvoke> {
  // Validates CASPER_RPC_URL / KARMA_ODRA_REGISTRY are set and testnet (DP-3) — called for that
  // guard, not for its return value (the facilitator URL below is a separate service; see the
  // comment on KARMA_X402_CASPER_FACILITATOR_URL further down for why they're not conflated).
  requireCasperTestnetEnv(process.env);
  const keystorePath = process.env.KEYSTORE_PATH ?? "./keystore.json";
  const keystorePassword = process.env.KEYSTORE_PASSWORD;
  if (!keystorePassword) throw new Error("[loop] KEYSTORE_PASSWORD not set");

  // Fix for the bug `run_autonomous_loop.ts` (Stellar) still has: load the keystore BEFORE
  // constructing the plugin. CasperX402Plugin's default `lookup` calls
  // `keystoreManager.getCasperKeypair(agentId)` the first time `pay()` runs — if `load()` hasn't
  // happened yet, that throws "Agent not found in keystore" on the very first invoke.
  await keystoreManager.load(keystorePath, keystorePassword);

  // Same env var `src/lib/payment/boot.ts` already uses to register this plugin elsewhere in the
  // repo — not invented here. CASPER_RPC_URL (validated above) is a Casper node RPC endpoint, not
  // a facilitator URL; the two are unrelated services and must not be conflated.
  const facilitatorUrl = process.env.KARMA_X402_CASPER_FACILITATOR_URL;
  if (!facilitatorUrl) throw new Error("[loop] KARMA_X402_CASPER_FACILITATOR_URL not set");
  const plugin = new CasperX402Plugin(facilitatorUrl, undefined, {
    settlementTokenPackageHash: process.env.KARMA_X402_CASPER_SETTLEMENT_TOKEN,
  });
  const agentId = process.env.KARMA_AGENT_ID ?? "agent-alpha";
  return async (skill, state): Promise<EarningRecord> => {
    const req: PaymentRequest = {
      skillId: skill.skillId,
      price: skill.pricePerCallUsdc.toString(),
      asset: "CSPR",
      payTo: skill.payee,
      network: skill.network,
    };
    const receipt = await plugin.pay(req, { agentId });
    // Spend leg is real on testnet; the realized return is the measured/oracle expectation —
    // same acknowledged simplification as the Stellar script (refine with a real downstream
    // resale endpoint once one exists).
    return { at: state.now, amountUsdc: skill.expectedReturnUsdc, source: `x402:${receipt.facilitatorRef ?? "settled"}` };
  };
}

main().catch((e: unknown) => {
  console.error(`[loop] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
