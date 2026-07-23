/**
 * RWA price feed (T13-live) — a real quote from a public price API, not the hardcoded
 * "BTC/USD = 42000.50" stub the offline demos use. Best-effort: falls back to a fixed value
 * (clearly logged, never silent) if the network call fails, so a demo run never hard-crashes
 * on a flaky connection.
 */

const FALLBACK_PRICE_USD = "42000.50";
const FALLBACK_UST_BILL_YIELD_PCT = "4.25";

export interface RwaPriceQuote {
  feed: string;
  price: string;
  timestamp: number;
  source: "coingecko" | "ustreasury" | "fallback";
}

/** Real BTC/USD spot price from CoinGecko's public API (no key required). */
export async function fetchBtcUsdPrice(fetchImpl: typeof fetch = fetch): Promise<RwaPriceQuote> {
  try {
    const res = await fetchImpl("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`CoinGecko returned HTTP ${res.status}`);
    const body = (await res.json()) as { bitcoin?: { usd?: number } };
    const usd = body.bitcoin?.usd;
    if (typeof usd !== "number") throw new Error("CoinGecko response missing bitcoin.usd");
    return { feed: "BTC/USD", price: usd.toFixed(2), timestamp: Date.now(), source: "coingecko" };
  } catch (e) {
    console.warn(
      `[rwa-price-feed] live CoinGecko fetch failed (${e instanceof Error ? e.message : String(e)}), ` +
      `using fallback price — this demo run is NOT reflecting a real live quote.`,
    );
    return { feed: "BTC/USD", price: FALLBACK_PRICE_USD, timestamp: Date.now(), source: "fallback" };
  }
}

/**
 * Real average interest rate on outstanding U.S. Treasury Bills from the U.S. Treasury's
 * public Fiscal Data API (no key required) — a genuine real-world-asset benchmark: T-Bill
 * yields are the reference rate underlying most on-chain RWA tokenization today (e.g.
 * tokenized T-Bill / money-market funds), unlike a crypto-native price. Falls back to a
 * fixed value (clearly logged, never silent) if the network call fails.
 */
export async function fetchUsTreasuryYield(fetchImpl: typeof fetch = fetch): Promise<RwaPriceQuote> {
  try {
    const res = await fetchImpl(
      "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates" +
      "?filter=security_desc:eq:Treasury%20Bills&sort=-record_date&page%5Bsize%5D=1",
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`US Treasury Fiscal Data API returned HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ avg_interest_rate_amt?: string }> };
    const raw = body.data?.[0]?.avg_interest_rate_amt;
    const pct = typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isNaN(pct)) throw new Error("US Treasury response missing avg_interest_rate_amt");
    return { feed: "UST-BILLS/AVG-YIELD", price: pct.toFixed(2), timestamp: Date.now(), source: "ustreasury" };
  } catch (e) {
    console.warn(
      `[rwa-price-feed] live US Treasury fetch failed (${e instanceof Error ? e.message : String(e)}), ` +
      `using fallback yield — this demo run is NOT reflecting a real live quote.`,
    );
    return { feed: "UST-BILLS/AVG-YIELD", price: FALLBACK_UST_BILL_YIELD_PCT, timestamp: Date.now(), source: "fallback" };
  }
}
