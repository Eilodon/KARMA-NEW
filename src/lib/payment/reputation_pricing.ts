/**
 * Reputation-scaled pricing — an OPTIONAL pricing-policy helper, not a change to
 * `IPaymentPlugin` itself.
 *
 * Borrowed mechanism (buildathon competitor research, 2026-07-22): Verity prices its x402
 * oracle reads on the caller's accuracy/reputation score. `IPaymentPlugin`'s `price` field is
 * already caller-supplied (see `docs/standards/IPaymentPlugin-v1.md` — `PaymentRequest.price`,
 * not something the plugin computes from a stored skill price), so a discount policy belongs
 * ABOVE the plugin, at whatever call site builds a `PaymentRequest` from a skill's base price —
 * never inside `quote`/`pay`/`verify` themselves. Touching the plugin interface would be a
 * breaking spec change across every conformant implementation (Stellar, Casper, Pharos); this
 * module deliberately doesn't do that. It is a pure, standalone helper a skill owner can choose
 * to call before invoking `quote`/`pay` — nothing in the existing payment path calls it
 * automatically, so no existing quote/pay/verify round-trip behavior changes.
 *
 * `price` in and `price` out are both base-10, BigInt-safe smallest-unit strings — the same
 * convention `PaymentRequest.price` / `PaymentReceipt.amount` already use throughout this repo.
 */

export interface ReputationPricingTier {
  /** Inclusive lower bound of on-chain reputation this tier applies to. */
  minReputation: number;
  /** Discount in basis points (0 = full price, 10_000 = free). Clamped to [0, 10_000]. */
  discountBps: number;
}

/** A conservative default ladder: no discount below the network's base reputation (50), then
 *  discounts widen as an agent proves a track record. Callers are free to supply their own. */
export const DEFAULT_REPUTATION_PRICING_TIERS: readonly ReputationPricingTier[] = [
  { minReputation: 0, discountBps: 0 },
  { minReputation: 60, discountBps: 500 }, // 5% off once above the base-reputation floor
  { minReputation: 75, discountBps: 1_500 }, // 15% off for an established track record
  { minReputation: 90, discountBps: 3_000 }, // 30% off for a top-tier reputation
];

export class ReputationPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReputationPricingError";
  }
}

function clampBps(bps: number): number {
  if (!Number.isFinite(bps)) throw new ReputationPricingError(`non-finite discountBps: ${bps}`);
  return Math.max(0, Math.min(10_000, Math.trunc(bps)));
}

/** Picks the richest discount tier the given reputation qualifies for. Tiers need not be
 *  pre-sorted — this scans all of them and keeps the highest `minReputation` that still
 *  qualifies, so a caller-supplied ladder in any order behaves the same way. */
function selectTier(reputation: number, tiers: readonly ReputationPricingTier[]): ReputationPricingTier {
  let best: ReputationPricingTier | undefined;
  for (const tier of tiers) {
    if (reputation >= tier.minReputation && (best === undefined || tier.minReputation > best.minReputation)) {
      best = tier;
    }
  }
  if (best === undefined) {
    throw new ReputationPricingError(
      `no tier covers reputation ${reputation} — every ladder must include a minReputation: 0 floor`,
    );
  }
  return best;
}

/**
 * Applies a reputation-scaled discount to a base price. Pure — no chain reads, no I/O.
 * Floor-divides (BigInt) so the caller never pays a fraction of the smallest unit, and the
 * result is always in `[0, basePrice]` regardless of tier configuration.
 */
export function applyReputationPricing(
  basePrice: string,
  reputation: number,
  tiers: readonly ReputationPricingTier[] = DEFAULT_REPUTATION_PRICING_TIERS,
): string {
  const base = BigInt(basePrice);
  if (base < 0n) throw new ReputationPricingError(`basePrice must be non-negative: ${basePrice}`);
  if (tiers.length === 0) throw new ReputationPricingError("tiers must be non-empty");

  const tier = selectTier(reputation, tiers);
  const bps = clampBps(tier.discountBps);
  const discounted = (base * BigInt(10_000 - bps)) / 10_000n;
  return discounted.toString();
}
