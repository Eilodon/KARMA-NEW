import trustOracleTools, { type ChainReputationRead } from "../plugins/trust_oracle.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";
import { banner, step, kv, ok, C, short } from "./_demo_format.js";

/**
 * OKX.AI Evaluator Skill — reference implementation. NOT registered, NOT staked, does not touch
 * any OKX.AI contract or arbitration flow.
 *
 * OKX.AI's Evaluator role (>=5 staked evaluators per dispute case, weighted-random selection,
 * majority vote, wrong/timed-out votes slashed — confirmed at okx.ai/tutorial) explicitly invites
 * "write your own [Evaluator Skill] to judge sharper." KARMA deliberately does not register or
 * stake into that role for this submission (docs/OKX_HACKATHON_CHECKLIST.md SS7 — it requires
 * >=100 OKB of real capital, out of scope for a zero-financial-risk hackathon entry).
 *
 * This script is what KARMA would contribute as that "sharper judgment" signal if/when someone
 * does register: given the two counterparties in a dispute, pull each one's
 * get_cross_chain_trust_score read and print a job-count-weighted comparison — evidence an
 * Evaluator could weigh alongside whatever OKX.AI-native signal it already has, not a vote by
 * itself. The weighting here intentionally differs from the shipped tool's aggregateScore (a
 * plain equal-weighted average, see the README self-audit): an agent with 1 job on one chain
 * should not count the same as one with 200, and this script is the illustration of that fix
 * without touching the production tool's output shape under deadline pressure.
 *
 *   pnpm demo:evaluator-skill-reference <requesterEvmAddress> <providerEvmAddress>
 */

function tool(name: string): ToolDefinition {
  const t = trustOracleTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

interface PartyRead {
  address: string;
  aggregateScore: number | null;
  chainsCounted: number;
  chains: ChainReputationRead[];
}

async function readParty(address: string): Promise<PartyRead> {
  const res = await tool("get_cross_chain_trust_score").handler({ evm_address: address }, {} as never);
  const s = res.structuredContent as {
    aggregateScore: number | null;
    chainsCounted: number;
    chains: ChainReputationRead[];
  };
  return { address, aggregateScore: s.aggregateScore, chainsCounted: s.chainsCounted, chains: s.chains };
}

/** Job-count-weighted score: an agent with more delivered history on a chain gets more say in
 *  the average from that chain. Falls back to the plain average (all weights 0) rather than
 *  dividing by zero — same graceful-degradation shape as the rest of trust_oracle.tool.ts. */
function weightedScore(chains: ChainReputationRead[]): number | null {
  const scored = chains.filter((c): c is ChainReputationRead & { reputation: number } => typeof c.reputation === "number");
  if (scored.length === 0) return null;
  const weights = scored.map((c) => (c.jobsAsProvider ?? 0) + (c.jobsAsRequester ?? 0));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) {
    const avg = scored.reduce((a, c) => a + c.reputation, 0) / scored.length;
    return Math.round(avg * 100) / 100;
  }
  const weighted = scored.reduce((a, c, i) => a + c.reputation * weights[i], 0) / totalWeight;
  return Math.round(weighted * 100) / 100;
}

function printParty(label: string, party: PartyRead): void {
  console.log(kv(label, `${short(party.address)}  (${party.chainsCounted} chain(s) with a reputation read)`));
  for (const c of party.chains) {
    const rep = c.reputation === null ? C.dim("no read") : String(c.reputation);
    const jobs = `provider=${c.jobsAsProvider ?? "-"} requester=${c.jobsAsRequester ?? "-"}`;
    const note = c.note ? C.dim(` (${c.note})`) : "";
    console.log(`      ${C.gray(c.chain.padEnd(8))} rep=${rep}  ${jobs}${note}`);
  }
}

async function main(): Promise<void> {
  markTrustedRuntime();
  const [requester, provider] = process.argv.slice(2);
  if (!requester || !provider) {
    throw new Error("usage: pnpm demo:evaluator-skill-reference <requesterEvmAddress> <providerEvmAddress>");
  }

  console.log(banner("OKX.AI Evaluator Skill — reference implementation (not registered, not staked)"));
  console.log(
    C.dim(
      "  Illustrative only: reads KARMA's own get_cross_chain_trust_score, computes a job-count-weighted\n" +
        "  comparison, and prints a suggested signal. Does not vote, submit, or call any OKX.AI contract.",
    ),
  );

  console.log(step(1, 2, "Pull cross-chain trust reads for both parties"));
  const [req, prov] = await Promise.all([readParty(requester), readParty(provider)]);
  printParty("requester", req);
  printParty("provider", prov);

  console.log(step(2, 2, "Job-count-weighted comparison (evidence for a human/Evaluator, not an automatic vote)"));
  const reqWeighted = weightedScore(req.chains);
  const provWeighted = weightedScore(prov.chains);
  console.log(kv("requester", `plain avg=${req.aggregateScore ?? "n/a"}  weighted=${reqWeighted ?? "n/a"}`));
  console.log(kv("provider", `plain avg=${prov.aggregateScore ?? "n/a"}  weighted=${provWeighted ?? "n/a"}`));

  if (reqWeighted === null && provWeighted === null) {
    console.log(C.yellow("  No configured chain returned a reputation for either party — no signal to offer."));
    return;
  }
  const stronger =
    (reqWeighted ?? -Infinity) === (provWeighted ?? -Infinity)
      ? "neither party — scores tie"
      : (reqWeighted ?? -Infinity) > (provWeighted ?? -Infinity)
        ? "requester"
        : "provider";
  console.log(ok(`Stronger evidence-backed track record: ${C.bold(stronger)} (weight this alongside OKX.AI-native signal)`));
}

main().catch((err) => {
  console.error(C.red(`\nEvaluator Skill reference failed: ${(err as Error).message}`));
  process.exitCode = 1;
});
