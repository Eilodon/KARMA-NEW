import { describe, it, expect, beforeEach, afterEach } from "vitest";
import rationaleAttestationTools from "../plugins/rationale_attestation.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";

const find = (tools: ToolDefinition[], name: string) => tools.find((t) => t.name === name)!;

const ENV_KEYS = ["XLAYER_CONTRACT_ADDRESS", "XLAYER_RATIONALE_ATTESTATION_ADDRESS"] as const;

describe("attest_rationale / get_rationale_hash (P2-A, X Layer port of Casper's rationale attestation)", () => {
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

  it("registers both tools with the expected metadata", () => {
    expect(rationaleAttestationTools.map((t) => t.name).sort()).toEqual([
      "attest_rationale",
      "get_rationale_hash",
    ]);
    const attest = find(rationaleAttestationTools, "attest_rationale");
    expect(attest.annotations.readOnlyHint).toBe(false);
    expect(attest.capabilities).toContain("network");
    const read = find(rationaleAttestationTools, "get_rationale_hash");
    expect(read.annotations.readOnlyHint).toBe(true);
  });

  it("get_rationale_hash throws a clear 'not set' error when XLAYER_RATIONALE_ATTESTATION_ADDRESS is unconfigured", async () => {
    await expect(
      find(rationaleAttestationTools, "get_rationale_hash").handler({ jobId: "1" }, {} as never),
    ).rejects.toThrow(/XLAYER_RATIONALE_ATTESTATION_ADDRESS not set/);
  });

  it("attest_rationale rejects an unknown agentId before touching the network", async () => {
    process.env.XLAYER_RATIONALE_ATTESTATION_ADDRESS = "0x0000000000000000000000000000000000dEaD";
    await expect(
      find(rationaleAttestationTools, "attest_rationale").handler(
        { agentId: "nobody", jobId: "1", rationaleHashHex: "ab".repeat(32) },
        {} as never,
      ),
    ).rejects.toThrow(/not found in keystore/);
  });

  it("attest_rationale rejects a non-32-byte hash before touching the network or keystore", async () => {
    await expect(
      find(rationaleAttestationTools, "attest_rationale").handler(
        { agentId: "nobody", jobId: "1", rationaleHashHex: "ab" },
        {} as never,
      ),
    ).rejects.toThrow();
  });
});
