import { describe, it, expect } from "vitest";
import { registerConfiguredPaymentPlugins } from "../lib/payment/boot.js";
import { PaymentPluginRegistry } from "../lib/payment/registry.js";

/**
 * Boot-time IPaymentPlugin registration (T7/T11 wiring).
 *
 * `registerConfiguredPaymentPlugins` accepts injected env + registry so the suite never
 * touches `process.env` or the process-wide singleton — each scenario owns its own
 * `PaymentPluginRegistry` instance.
 */
describe("registerConfiguredPaymentPlugins (T7/T11 boot wiring)", () => {
  it("registers nothing when neither facilitator URL is set, but reports the skipped reasons", () => {
    const registry = new PaymentPluginRegistry();
    const report = registerConfiguredPaymentPlugins({ env: {}, registry });
    expect(report.registered).toEqual([]);
    expect(report.skipped.map((s) => s.id).sort()).toEqual(["x402-casper", "x402-stellar"]);
    expect(report.skipped.find((s) => s.id === "x402-stellar")?.reason).toMatch(/STELLAR_FACILITATOR_URL/);
    expect(report.skipped.find((s) => s.id === "x402-casper")?.reason).toMatch(/CASPER_FACILITATOR_URL/);
    expect(registry.list()).toEqual([]);
  });

  it("registers x402-stellar when KARMA_X402_STELLAR_FACILITATOR_URL is set", () => {
    const registry = new PaymentPluginRegistry();
    const report = registerConfiguredPaymentPlugins({
      env: { KARMA_X402_STELLAR_FACILITATOR_URL: "https://www.x402.org/facilitator" },
      registry,
    });
    expect(report.registered).toEqual(["x402-stellar"]);
    expect(registry.resolve("x402", "stellar:testnet")?.id).toBe("x402-stellar");
    expect(registry.resolve("x402", "stellar:pubnet")?.id).toBe("x402-stellar");
    expect(registry.resolve("x402", "casper:mainnet")).toBeNull();
  });

  it("registers x402-casper when KARMA_X402_CASPER_FACILITATOR_URL is set", () => {
    const registry = new PaymentPluginRegistry();
    const report = registerConfiguredPaymentPlugins({
      env: { KARMA_X402_CASPER_FACILITATOR_URL: "https://x402-facilitator.casper.network" },
      registry,
    });
    expect(report.registered).toEqual(["x402-casper"]);
    expect(registry.resolve("x402", "casper:casper-test")?.id).toBe("x402-casper");
    expect(registry.resolve("x402", "casper:casper")?.id).toBe("x402-casper");
  });

  it("registers BOTH plugins when both URLs are set", () => {
    const registry = new PaymentPluginRegistry();
    const report = registerConfiguredPaymentPlugins({
      env: {
        KARMA_X402_STELLAR_FACILITATOR_URL: "https://www.x402.org/facilitator",
        KARMA_X402_CASPER_FACILITATOR_URL: "https://x402-facilitator.casper.network",
      },
      registry,
    });
    expect(report.registered.sort()).toEqual(["x402-casper", "x402-stellar"]);
    expect(report.skipped).toEqual([]);
    expect(registry.list()).toHaveLength(2);
  });

  it("default reset=true makes a second call idempotent (no duplicate-id throw)", () => {
    const registry = new PaymentPluginRegistry();
    const env = { KARMA_X402_STELLAR_FACILITATOR_URL: "https://www.x402.org/facilitator" };
    registerConfiguredPaymentPlugins({ env, registry });
    registerConfiguredPaymentPlugins({ env, registry });
    expect(registry.list().map((p) => p.id)).toEqual(["x402-stellar"]);
  });

  it("reset=false throws on a duplicate-id second registration (registry safety net)", () => {
    const registry = new PaymentPluginRegistry();
    const env = { KARMA_X402_STELLAR_FACILITATOR_URL: "https://www.x402.org/facilitator" };
    registerConfiguredPaymentPlugins({ env, registry, reset: false });
    expect(() => registerConfiguredPaymentPlugins({ env, registry, reset: false }))
      .toThrow(/already registered/);
  });
});
