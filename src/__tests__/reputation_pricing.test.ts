import { describe, it, expect } from "vitest";
import {
  applyReputationPricing,
  DEFAULT_REPUTATION_PRICING_TIERS,
  ReputationPricingError,
  type ReputationPricingTier,
} from "../lib/payment/reputation_pricing.js";

describe("applyReputationPricing", () => {
  it("charges full price at the floor tier (default ladder)", () => {
    expect(applyReputationPricing("1000000", 0)).toBe("1000000");
    expect(applyReputationPricing("1000000", 59)).toBe("1000000");
  });

  it("applies the 5% tier at reputation 60", () => {
    expect(applyReputationPricing("1000000", 60)).toBe("950000");
  });

  it("applies the 15% tier at reputation 75", () => {
    expect(applyReputationPricing("1000000", 75)).toBe("850000");
  });

  it("applies the 30% tier at reputation 90 and above", () => {
    expect(applyReputationPricing("1000000", 90)).toBe("700000");
    expect(applyReputationPricing("1000000", 100)).toBe("700000");
  });

  it("floor-divides — never charges a fractional smallest unit", () => {
    // 7 motes at 15% off = 5.95 -> floors to 5, never rounds up past basePrice either.
    expect(applyReputationPricing("7", 75)).toBe("5");
  });

  it("result is always within [0, basePrice] for any valid tier configuration", () => {
    const tiers: ReputationPricingTier[] = [
      { minReputation: 0, discountBps: 0 },
      { minReputation: 50, discountBps: 10_000 }, // free above 50
    ];
    expect(applyReputationPricing("42", 49, tiers)).toBe("42");
    expect(applyReputationPricing("42", 50, tiers)).toBe("0");
  });

  it("clamps an out-of-range discountBps instead of producing a negative or oversized price", () => {
    const tiers: ReputationPricingTier[] = [{ minReputation: 0, discountBps: 999_999 }];
    expect(applyReputationPricing("1000", 0, tiers)).toBe("0"); // clamped to 10_000 bps = free
  });

  it("tier order in the input array doesn't matter — picks the richest qualifying tier", () => {
    const shuffled: ReputationPricingTier[] = [
      { minReputation: 90, discountBps: 3_000 },
      { minReputation: 0, discountBps: 0 },
      { minReputation: 60, discountBps: 500 },
    ];
    expect(applyReputationPricing("1000000", 65, shuffled)).toBe("950000");
  });

  it("throws ReputationPricingError when no tier covers the given reputation", () => {
    const tiers: ReputationPricingTier[] = [{ minReputation: 50, discountBps: 500 }];
    expect(() => applyReputationPricing("1000", 10, tiers)).toThrow(ReputationPricingError);
  });

  it("throws on a negative basePrice", () => {
    expect(() => applyReputationPricing("-1", 100)).toThrow(ReputationPricingError);
  });

  it("throws on an empty tier ladder", () => {
    expect(() => applyReputationPricing("1000", 100, [])).toThrow(ReputationPricingError);
  });

  it("default export ladder is exported and usable directly", () => {
    expect(DEFAULT_REPUTATION_PRICING_TIERS.length).toBeGreaterThan(0);
    expect(DEFAULT_REPUTATION_PRICING_TIERS.some((t) => t.minReputation === 0)).toBe(true);
  });
});
