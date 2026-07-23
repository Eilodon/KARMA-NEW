import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { XLayerX402Plugin, xLayerX402PaymentOption } from "../plugins/x402_xlayer.js";

const FACILITATOR = "https://facilitator.okx.ai";
const TESTNET = "eip155:1952";
const MAINNET = "eip155:196";
const TEST_USDC = "0x1111111111111111111111111111111111111111";
const MAIN_USDC = "0x2222222222222222222222222222222222222222";

const TEST_ACCOUNT = privateKeyToAccount(`0x${"01".repeat(32)}` as `0x${string}`);

function newPlugin() {
  // Inject the account lookup so tests never touch the real keystore manager.
  return new XLayerX402Plugin(FACILITATOR, () => TEST_ACCOUNT);
}

describe("XLayerX402Plugin metadata (OKX.AI Genesis Hackathon)", () => {
  it("declares rail=x402 and the two X Layer networks", () => {
    const p = newPlugin();
    expect(p.rail).toBe("x402");
    expect(p.id).toBe("x402-xlayer");
    expect(p.networks).toEqual([TESTNET, MAINNET]);
  });
});

describe("XLayerX402Plugin.quote", () => {
  it("converts a decimal price into USDC smallest units (6 decimals)", async () => {
    const p = newPlugin();
    const q = await p.quote({ skillId: "1", price: "0.01", asset: TEST_USDC, payTo: "0xpayee", network: TESTNET });
    expect(q.rail).toBe("x402");
    expect(q.network).toBe(TESTNET);
    expect(q.price).toBe("10000"); // 0.01 USDC × 10^6
    expect(q.facilitatorUrl).toBe(FACILITATOR);
  });

  it("passes through a pre-formatted smallest-unit string unchanged", async () => {
    const p = newPlugin();
    const q = await p.quote({ skillId: "1", price: "250000", asset: TEST_USDC, payTo: "0xpayee", network: TESTNET });
    expect(q.price).toBe("250000");
  });

  it("rejects an unsupported network", async () => {
    const p = newPlugin();
    await expect(
      p.quote({ skillId: "1", price: "0.01", asset: TEST_USDC, payTo: "0xpayee", network: "stellar:testnet" }),
    ).rejects.toThrow(/unsupported network/);
  });

  describe("default asset resolution (env-gated, no hardcoded contract address)", () => {
    const ORIGINAL = { ...process.env };
    beforeEach(() => {
      process.env.XLAYER_USDC_TESTNET_ADDRESS = TEST_USDC;
      process.env.XLAYER_USDC_ADDRESS = MAIN_USDC;
    });
    afterEach(() => {
      process.env = { ...ORIGINAL };
    });

    it("resolves the per-network USDC address from env when asset is omitted", async () => {
      const p = newPlugin();
      const qTest = await p.quote({ skillId: "1", price: "0.01", asset: "", payTo: "0xpayee", network: TESTNET });
      const qMain = await p.quote({ skillId: "1", price: "0.01", asset: "", payTo: "0xpayee", network: MAINNET });
      expect(qTest.asset).toBe(TEST_USDC);
      expect(qMain.asset).toBe(MAIN_USDC);
    });

    it("throws instead of guessing when the env var is unset", async () => {
      delete process.env.XLAYER_USDC_TESTNET_ADDRESS;
      const p = newPlugin();
      await expect(
        p.quote({ skillId: "1", price: "0.01", asset: "", payTo: "0xpayee", network: TESTNET }),
      ).rejects.toThrow(/XLAYER_USDC_TESTNET_ADDRESS/);
    });
  });
});

describe("XLayerX402Plugin.pay", () => {
  it("uses the agent's viem account to build the signer and returns a receipt", async () => {
    const p = newPlugin();
    const receipt = await p.pay(
      { skillId: "1", price: "0.01", asset: TEST_USDC, payTo: "0xpayee0000000000000000000000000000000000", network: TESTNET },
      { agentId: "agent-alpha" },
    );
    expect(receipt.rail).toBe("x402");
    expect(receipt.network).toBe(TESTNET);
    expect(receipt.payer).toBe(TEST_ACCOUNT.address);
    expect(receipt.amount).toBe("10000");
    expect(receipt.facilitatorRef).toBe(FACILITATOR);
  });

  it("rejects an unsupported network before touching the keystore", async () => {
    let calls = 0;
    const p = new XLayerX402Plugin(FACILITATOR, () => {
      calls += 1;
      return TEST_ACCOUNT;
    });
    await expect(
      p.pay(
        { skillId: "1", price: "0.01", asset: TEST_USDC, payTo: "0xpayee", network: "stellar:testnet" },
        { agentId: "agent-alpha" },
      ),
    ).rejects.toThrow(/unsupported network/);
    expect(calls).toBe(0); // fail-fast — no keystore access
  });

  it("propagates a not-found agent error from the lookup", async () => {
    const p = new XLayerX402Plugin(FACILITATOR, () => {
      throw new Error("[KARMA] Agent not found in keystore: agent-zeta");
    });
    await expect(
      p.pay(
        { skillId: "1", price: "0.01", asset: TEST_USDC, payTo: "0xpayee", network: TESTNET },
        { agentId: "agent-zeta" },
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe("XLayerX402Plugin.verify", () => {
  const baseReceipt = {
    rail: "x402" as const,
    payer: TEST_ACCOUNT.address,
    payee: "0xpayee0000000000000000000000000000000000",
    amount: "10000",
    asset: TEST_USDC,
    network: TESTNET,
    facilitatorRef: FACILITATOR,
  };

  it("accepts a structurally well-formed receipt", async () => {
    const p = newPlugin();
    expect(await p.verify(baseReceipt)).toBe(true);
  });

  it("rejects a non-x402 rail", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, rail: "escrow" })).toBe(false);
  });

  it("rejects an unsupported network", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, network: "stellar:testnet" })).toBe(false);
  });

  it("rejects a malformed EVM payer address", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, payer: "not-an-address" })).toBe(false);
  });

  it("rejects empty amount or payee", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, amount: "" })).toBe(false);
    expect(await p.verify({ ...baseReceipt, payee: "" })).toBe(false);
  });
});

describe("xLayerX402PaymentOption", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env.XLAYER_USDC_TESTNET_ADDRESS = TEST_USDC;
    process.env.XLAYER_USDC_ADDRESS = MAIN_USDC;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("defaults to testnet/USDC", () => {
    const opt = xLayerX402PaymentOption();
    expect(opt).toEqual({ rail: "x402", network: TESTNET, asset: TEST_USDC });
  });

  it("respects the network override", () => {
    const opt = xLayerX402PaymentOption(MAINNET);
    expect(opt.network).toBe(MAINNET);
    expect(opt.asset).toBe(MAIN_USDC);
  });
});
