import fs from "node:fs";
import path from "node:path";
import trustOracleTools from "../plugins/trust_oracle.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";
import { banner, step, kv, ok, C, short } from "./_demo_format.js";

/**
 * KARMA x Onchain OS composability demo.
 *
 * Ground truth this script is built on (verified in-session, not assumed): `okx/onchainos-skills`
 * is NOT an MCP server exposing typed tools the way `demo_casper_composability.ts` models the
 * published Casper MCP servers (Tairon-ai/casper-network-mcp, msanlisavas/casper-mcp — both real
 * MCP servers with a name/inputSchema/handler shape). It is a Claude Skill bundle: `SKILL.md`
 * routing files (installed for real into `.claude/skills/`, see `skills-lock.json`) that teach an
 * LLM agent when and how to shell out to a bundled Rust CLI binary (`onchainos`), gated behind a
 * mandatory "preflight" step (OKX Agentic Wallet login / API key) before ANY command — including
 * read-only ones like `agent search`.
 *
 * That means the honest version of this demo has two different kinds of steps:
 *   • Step 1-2 (discovery): DOCUMENTED, not executed. The exact command syntax below is copied
 *     verbatim from the real installed skill (`.claude/skills/okx-ai/references/identity-discover.md`),
 *     not invented. Actually running it needs the operator's own OKX wallet/API credentials
 *     (docs/OKX_HACKATHON_CHECKLIST.md §2) — out of scope to fabricate or request here, since a
 *     fake "preflight" result would misrepresent what the real integration does.
 *   • Step 3-4 (trust + decision): LIVE. `get_cross_chain_trust_score` is KARMA's real, no-auth
 *     ASP — this part of the script actually calls the production tool handler, no mocking.
 *
 * A candidate agent's EVM address is passed on the command line (standing in for the `ownerAddress`
 * field `onchainos agent search` / `agent get-agents` would have returned — see the discovery
 * step's real output shape below) so the trust-score half of the pipeline is fully reproducible by
 * a reviewer without any OKX credentials.
 *
 *   pnpm demo:onchainos <candidateEvmAddress> [minTrustScore=50]
 */

const HIRE_THRESHOLD_DEFAULT = 50;

interface SkillLockEntry {
  source: string;
  sourceType: string;
  skillPath: string;
  computedHash: string;
}

function readInstalledSkills(): Record<string, SkillLockEntry> {
  const lockPath = path.resolve(process.cwd(), "skills-lock.json");
  if (!fs.existsSync(lockPath)) {
    throw new Error(
      "[KARMA] skills-lock.json not found — run `npx skills add okx/onchainos-skills --yes -a claude-code --skill '*'` first.",
    );
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { skills: Record<string, SkillLockEntry> };
  return lock.skills;
}

function tool(name: string): ToolDefinition {
  const t = trustOracleTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

async function main(): Promise<void> {
  markTrustedRuntime();
  const [candidateAddress, minScoreArg] = process.argv.slice(2);
  if (!candidateAddress) {
    throw new Error("usage: pnpm demo:onchainos <candidateEvmAddress> [minTrustScore=50]");
  }
  const minScore = minScoreArg ? Number(minScoreArg) : HIRE_THRESHOLD_DEFAULT;

  console.log(banner("KARMA x Onchain OS composability — \"should my agent pay this provider?\""));
  console.log(
    C.dim(
      "  okx/onchainos-skills is a Claude Skill bundle (CLI-routing), not an MCP tool server — see this\n" +
        "  file's header for the real architecture. Steps 1-2 are documented from the real installed\n" +
        "  skill, not executed (needs OKX wallet login). Steps 3-4 call KARMA's real, no-auth ASP.",
    ),
  );

  console.log(step(1, 4, "Confirm the real install (skills-lock.json, not a mock)"));
  const skills = readInstalledSkills();
  for (const [name, entry] of Object.entries(skills)) {
    console.log(kv(name, `${entry.skillPath}  sha=${short(entry.computedHash, 8, 6)}`));
  }
  ok(`${Object.keys(skills).length} onchainos-skills installed from ${skills["okx-ai"]?.source ?? "okx/onchainos-skills"}`);

  console.log(step(2, 4, "Discovery — the real CLI a judge/agent would run (documented, not executed here)"));
  console.log(
    C.gray(
      '  $ onchainos agent search --query "on-chain reputation oracle for agent payments"\n' +
        "    -> table of candidate ASPs: Agent ID | Name | Rating | Min price | Top service\n" +
        "  $ onchainos agent get-agents --agent-ids <N>\n" +
        "    -> card[] including `ownerAddress` (the EVM address get_cross_chain_trust_score reads)\n" +
        "  Source: .claude/skills/okx-ai/references/identity-discover.md (installed verbatim, see step 1)",
    ),
  );
  console.log(kv("candidate", `${candidateAddress}  (standing in for that ownerAddress field)`));

  console.log(step(3, 4, "LIVE — get_cross_chain_trust_score against the candidate"));
  const result = await tool("get_cross_chain_trust_score").handler({ evm_address: candidateAddress }, {} as never);
  const s = result.structuredContent as {
    aggregateScore: number | null;
    chainsCounted: number;
    chains: Array<{ chain: string; reputation: number | null; note?: string }>;
  };
  for (const c of s.chains) {
    const rep = c.reputation === null ? C.dim("no read") : String(c.reputation);
    const note = c.note ? C.dim(` (${c.note})`) : "";
    console.log(`      ${C.gray(c.chain.padEnd(8))} rep=${rep}${note}`);
  }
  console.log(kv("aggregate", `${s.aggregateScore ?? "n/a"} across ${s.chainsCounted} chain(s)`));

  console.log(step(4, 4, `Decision — hire if aggregate >= ${minScore}`));
  if (s.aggregateScore === null) {
    console.log(C.yellow(`  SKIP — no configured chain returned a reputation for ${short(candidateAddress)}.`));
    return;
  }
  if (s.aggregateScore >= minScore) {
    console.log(ok(`HIRE — ${s.aggregateScore} >= ${minScore}, evidence-backed track record across ${s.chainsCounted} chain(s).`));
  } else {
    console.log(C.yellow(`  SKIP — ${s.aggregateScore} < ${minScore}, insufficient evidence-backed track record.`));
  }
}

main().catch((err) => {
  console.error(C.red(`\nOnchain OS composability demo failed: ${(err as Error).message}`));
  process.exitCode = 1;
});
