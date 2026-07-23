import { describe, it, expect, beforeEach, afterEach } from "vitest";
import trustOracleTools from "../plugins/trust_oracle.tool.js";
import type { ToolDefinition, ToolResult } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";

const call = (t: ToolDefinition, args: unknown) => t.handler(args, {} as never);

function structured(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

const EVM_ADDR = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec";
const CASPER_HASH = "account-hash-" + "ab".repeat(32);

const ENV_KEYS = [
  "PHAROS_CONTRACT_ADDRESS",
  "XLAYER_CONTRACT_ADDRESS",
  "CASPER_RPC_URL",
  "KARMA_ODRA_REGISTRY",
  "CASPER_CONTRACT_HASH",
] as const;

describe("get_cross_chain_trust_score (OKX.AI Genesis Hackathon Trust Oracle)", () => {
  const tool = trustOracleTools.find((t) => t.name === "get_cross_chain_trust_score")!;
  const ORIGINAL: Record<string, string | undefined> = {};

  beforeEach(() => {
    markTrustedRuntime();
    for (const k of ENV_KEYS) {
      ORIGINAL[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
  });

  it("is registered with the expected metadata", () => {
    expect(tool.name).toBe("get_cross_chain_trust_score");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.capabilities).toContain("network");
  });

  it("rejects a call with neither identifier", async () => {
    await expect(call(tool, {})).rejects.toThrow(/evm_address.*casper_account_hash/);
  });

  it("degrades gracefully when no chain is configured — every leg reports a note, no throw", async () => {
    const result = await call(tool, { evm_address: EVM_ADDR });
    const s = structured(result);
    expect(s.aggregateScore).toBeNull();
    expect(s.chainsCounted).toBe(0);
    const chains = s.chains as Array<{ chain: string; reputation: number | null; note?: string }>;
    expect(chains.map((c) => c.chain).sort()).toEqual(["pharos", "stellar", "xlayer"]);
    for (const c of chains) {
      expect(c.reputation).toBeNull();
      expect(c.note).toBeTruthy();
    }
  });

  it("reports Stellar as ZK-gated (not a public score), not a live RPC failure", async () => {
    const result = await call(tool, { evm_address: EVM_ADDR });
    const s = structured(result);
    const chains = s.chains as Array<{ chain: string; note?: string }>;
    const stellar = chains.find((c) => c.chain === "stellar")!;
    expect(stellar.note).toMatch(/ZK-gated/);
  });

  it("only queries Casper when casper_account_hash is provided", async () => {
    const result = await call(tool, { evm_address: EVM_ADDR });
    const s = structured(result);
    const chains = s.chains as Array<{ chain: string }>;
    expect(chains.some((c) => c.chain === "casper")).toBe(false);
  });

  it("includes a Casper leg (unconfigured note) when casper_account_hash is provided", async () => {
    const result = await call(tool, { casper_account_hash: CASPER_HASH });
    const s = structured(result);
    const chains = s.chains as Array<{ chain: string; address: string; note?: string }>;
    const casper = chains.find((c) => c.chain === "casper")!;
    expect(casper).toBeTruthy();
    expect(casper.address).toBe(CASPER_HASH);
    expect(casper.note).toMatch(/CASPER_RPC_URL/);
    // evm-only legs (pharos/xlayer/stellar) should be absent when no evm_address was given.
    expect(chains.some((c) => c.chain === "pharos")).toBe(false);
  });
});
