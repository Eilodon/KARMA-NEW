/**
 * KARMA self-hosting demo (T5.4) — the recursive moment.
 *
 * Premise: agent economies become real when the protocol's own services are themselves
 * discoverable + payable as skills. This script makes the loop visible end-to-end:
 *
 *   ┌── KARMA-MCP (this server) ────────────────────────────────────────────────┐
 *   │  Tool: discover_skills          ──────────────►  returns matching skills │
 *   │  Tool: create_job (x402 rail)   ──────────────►  routes through plugin   │
 *   │  Skill: karma_marketplace_oracle  ──registered──►  responds with stats   │
 *   └────────────────────────────────────────────────────────────────────────────┘
 *                                  ▲                                ▲
 *                                  │                                │
 *                  discover ───────┘                                │
 *                  pay+invoke ─────────────────────────────────────┘
 *
 *   The orchestrator agent uses KARMA's OWN tools to pay KARMA's OWN skill via the
 *   IPaymentPlugin layer. Recursion is the point — judges + community see "KARMA's
 *   services are themselves on the marketplace they implement." Dogfooding made literal.
 *
 *   pnpm exec tsx src/scripts/demo_self_hosting.ts
 */

import { StellarX402Plugin } from "../plugins/x402_stellar.js";
import { PaymentPluginRegistry } from "../lib/payment/registry.js";
import { deriveStellarKeypair } from "../lib/stellar/keypair.js";

// ── In-process MCP-shaped tool registry (mirrors src/scripts/demo_casper_composability) ──
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
interface ToolDef {
  name: string;
  description: string;
  price_per_call?: string;
  handler: ToolHandler;
}
class ToolRegistry {
  private byName = new Map<string, ToolDef>();
  register(t: ToolDef): void {
    this.byName.set(t.name, t);
  }
  get(name: string): ToolDef | undefined {
    return this.byName.get(name);
  }
  list(): ToolDef[] {
    return [...this.byName.values()];
  }
}

// ── In-process Pharos-shaped skill registry (the recursive surface) ──────────────────────
interface SkillRow {
  skill_id: number;
  name: string;
  description: string;
  owner: string;
  price_per_call: string;
  reputation: number;
  payment_options: Array<{ rail: string; network: string; asset: string }>;
}
class SkillRegistry {
  private skills = new Map<number, SkillRow>();
  private nextId = 0;
  register(row: Omit<SkillRow, "skill_id" | "reputation">): number {
    this.nextId += 1;
    this.skills.set(this.nextId, { ...row, skill_id: this.nextId, reputation: 50 });
    return this.nextId;
  }
  search(query: string): SkillRow[] {
    // Word-AND matcher (cheap stand-in for BM25 in the in-process demo).
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.skills.values()]
      .filter((s) => {
        const hay = `${s.name} ${s.description}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .sort((a, b) => b.reputation - a.reputation);
  }
  get(id: number): SkillRow | undefined {
    return this.skills.get(id);
  }
}

// ── Pretty-printing ──────────────────────────────────────────────────────────────────────
function box(label: string, lines: string[]): void {
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}
function short(s: string, head = 14): string {
  return s.length > head + 6 ? `${s.slice(0, head)}...${s.slice(-6)}` : s;
}

// ── The recursive moment ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("=".repeat(80));
  console.log("KARMA self-hosting demo — KARMA's services on KARMA's marketplace (T5.4)");
  console.log("=".repeat(80));

  // Two deterministic agents (orchestrator + KARMA's own marketplace-oracle skill owner).
  const orchestratorKp = deriveStellarKeypair(new Uint8Array(32).fill(0x33));
  const karmaOwnerKp = deriveStellarKeypair(new Uint8Array(32).fill(0x44));
  const karmaOwnerAddr = karmaOwnerKp.publicKey();

  // ── Step 1 — KARMA's `karma_marketplace_oracle` is registered as a paid skill ────────
  const tools = new ToolRegistry();
  const skills = new SkillRegistry();

  // The recursive primitive: a KARMA tool that reports on the KARMA marketplace itself.
  tools.register({
    name: "karma_marketplace_oracle",
    description:
      "Returns live marketplace stats: registered skills count, recent jobs, top earners " +
      "by flow reputation, indexer health. Useful for skill developers + orchestrators " +
      "to spot growing categories + saturation.",
    price_per_call: "100000", // 0.01 USDC in 7-decimal smallest units
    handler: async () => ({
      skills_registered: skills["skills"]?.size ?? 0,
      recent_jobs_24h: 47,                                  // illustrative — live indexer in production
      top_skills_by_rep: [
        { skill_id: 1, name: "karma_marketplace_oracle", reputation: 50 },
      ],
      indexer_health: { watching: true, lastIndexedBlock: "12345678" },
      timestamp_ms: Date.now(),
    }),
  });

  const skillId = skills.register({
    name: "karma_marketplace_oracle",
    description:
      "KARMA's own marketplace stats oracle — discoverable + payable like any other skill.",
    owner: karmaOwnerAddr,
    price_per_call: "100000",
    payment_options: [{ rail: "x402", network: "stellar:testnet", asset: "USDC" }],
  });

  box("Step 1 — KARMA registers a tool as a SKILL on its own registry", [
    `tool name           = karma_marketplace_oracle`,
    `registered skill_id = ${skillId}`,
    `price_per_call      = 100000 (0.01 USDC, 7-decimal smallest units)`,
    `owner (skill)       = ${short(karmaOwnerAddr)}`,
    `payment_options[0]  = { rail: x402, network: stellar:testnet, asset: USDC }`,
  ]);

  // ── Step 2 — Boot an x402 plugin into the registry (env-style) ───────────────────────
  const registry = new PaymentPluginRegistry();
  registry.register(new StellarX402Plugin(
    "https://www.x402.org/facilitator",
    () => orchestratorKp,
  ));
  box("Step 2 — boot x402 IPaymentPlugin into the payment registry", [
    "plugin id    = x402-stellar",
    "rail         = x402",
    "networks     = [stellar:testnet, stellar:pubnet]",
    `resolve("x402","stellar:testnet") → ${registry.resolve("x402", "stellar:testnet")?.id}`,
  ]);

  // ── Step 3 — Orchestrator discovers the skill (calling KARMA on KARMA) ───────────────
  const hits = skills.search("marketplace oracle");
  box("Step 3 — orchestrator calls discover_skills('marketplace oracle')", [
    `hit count           = ${hits.length}`,
    `top hit             = skill_id ${hits[0]?.skill_id} (${hits[0]?.name})`,
    `top hit description = ${(hits[0]?.description ?? "").slice(0, 60)}…`,
    `top hit rep         = ${hits[0]?.reputation}/100`,
  ]);

  // ── Step 4 — Orchestrator pays the skill via x402 (KARMA paying KARMA) ───────────────
  if (hits.length === 0) throw new Error("no skill matched the discovery query");
  const hit = hits[0];
  const x402Option = hit.payment_options[0];
  if (!x402Option) throw new Error("skill carries no payment_options");
  const plugin = registry.resolve(x402Option.rail as "x402", x402Option.network);
  if (!plugin) throw new Error("no plugin for advertised payment option");
  const receipt = await plugin.pay(
    {
      skillId: String(hit.skill_id),
      price: hit.price_per_call,
      asset: x402Option.asset,
      payTo: hit.owner,
      network: x402Option.network,
    },
    { agentId: "orchestrator-self" },
  );
  if (!(await plugin.verify(receipt))) throw new Error("plugin verify rejected its own receipt");
  box("Step 4 — create_job(settlement_rail: x402) — orchestrator pays the marketplace oracle", [
    `plugin id          = ${plugin.id}`,
    `rail               = ${receipt.rail}`,
    `network            = ${receipt.network}`,
    `payer              = ${short(receipt.payer)}`,
    `payee              = ${short(receipt.payee)}`,
    `amount             = ${receipt.amount} (smallest-unit USDC)`,
    `facilitatorRef     = ${receipt.facilitatorRef}`,
  ]);

  // ── Step 5 — KARMA's own tool executes + returns stats (the recursive loop closes) ───
  const tool = tools.get(hit.name);
  if (!tool) throw new Error(`internal: tool '${hit.name}' missing — registration drift`);
  const result = (await tool.handler({})) as Record<string, unknown>;
  box("Step 5 — karma_marketplace_oracle responds (KARMA called KARMA, paid in USDC)", [
    `skills_registered  = ${String(result.skills_registered)}`,
    `recent_jobs_24h    = ${String(result.recent_jobs_24h)}`,
    `top_skills_by_rep  = ${JSON.stringify(result.top_skills_by_rep).slice(0, 60)}…`,
    `indexer_health     = ${JSON.stringify(result.indexer_health)}`,
    `timestamp_ms       = ${String(result.timestamp_ms)}`,
  ]);

  console.log("\n┌── Why this is the recursive moment ───────────────────────────────");
  console.log("│ • KARMA's marketplace oracle is registered on KARMA's own registry.");
  console.log("│ • The orchestrator discovers it via KARMA's discover_skills.");
  console.log("│ • Payment routes through IPaymentPlugin (no in-process bypass).");
  console.log("│ • The skill execution returns stats ABOUT KARMA — a feedback loop.");
  console.log("│ • Every protocol primitive (discover, x402 pay, plugin resolve, skill");
  console.log("│   execution) is exercised by KARMA itself, no special-case path.");
  console.log("│");
  console.log("│ This is what 'agent economies' looks like at protocol maturity: even");
  console.log("│ the marketplace's own services are marketplace participants.");
  console.log("└────────────────────────────────────────────────────────────────────");

  console.log("\n[demo] self-hosting PASS");
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
