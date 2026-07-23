import { toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import type { LocalAccount } from "viem";
import { keystoreManager } from "../lib/keystore.js";
import type {
  IPaymentPlugin,
  PaymentOption,
  PaymentQuote,
  PaymentReceipt,
  PaymentRequest,
} from "../lib/payment/plugin.js";

/** Account-lookup seam — defaults to the real keystore, overridden in tests. Reuses the same
 *  secp256k1 account Pharos uses: an EVM address is chain-independent, so one agent identity
 *  is valid on Pharos AND X Layer without a second key. */
export type XLayerAccountLookup = (agentId: string) => LocalAccount;

const XLAYER_TESTNET_CAIP2 = "eip155:1952";
const XLAYER_MAINNET_CAIP2 = "eip155:196";
const XLAYER_NETWORKS: readonly string[] = [XLAYER_TESTNET_CAIP2, XLAYER_MAINNET_CAIP2];

/** Marketplace-level messaging (okx.com/learn/okx-ai) says OKX AI settles ASP payments in "USDT
 *  or USDG"; OKX's own x402 facilitator SDK (github.com/okx/payments/go, FACILITATOR.md) is more
 *  specific for this chain: X Layer (eip155:196, MAINNET only) settles in USD₮0 — Tether's
 *  LayerZero omnichain OFT, not plain USDT — at 0x779Ded0c9e1022225f8E0630b35a9b54bE713736.
 *  USDG is also live on X Layer mainnet (github.com/okx/xlayer-tokenlist:
 *  0x4ae46a509F6b1D9056937BA4500cb143933D2dc8). Both verified on-chain in-session (symbol/decimals
 *  match). Neither address has bytecode on X Layer TESTNET (eip155:1952) — verified in-session —
 *  and no official OKX source (tokenlist or facilitator SDK) documents a testnet settlement asset
 *  or testnet facilitator for X Layer at all; the paid tier appears to be a mainnet-only path
 *  today. This stays asset-agnostic and env-var-driven rather than hardcoding one of the above,
 *  since which asset a given facilitator actually expects can still vary; fail loud rather than
 *  guess a contract address that would silently misdirect a real payment. */
function defaultAssetForNetwork(network: string): string {
  const envVar =
    network === XLAYER_TESTNET_CAIP2 ? "XLAYER_SETTLEMENT_ASSET_TESTNET_ADDRESS" : "XLAYER_SETTLEMENT_ASSET_ADDRESS";
  const addr = process.env[envVar];
  if (!addr) {
    throw new Error(`[x402-xlayer] ${envVar} not set — see github.com/okx/xlayer-tokenlist for the real address`);
  }
  return addr;
}

const DEFAULT_DECIMALS = Number(process.env.XLAYER_SETTLEMENT_ASSET_DECIMALS ?? 6); // USDT/USDG both use 6

/** Convert a human "$0.01"-style decimal string to a base-10 smallest-unit string. Honours an
 *  already-smallest-units string (no ".") unchanged, matching the IPaymentPlugin v1 D-6 rule. */
function toSmallestUnits(price: string): string {
  if (!price.includes(".")) return price;
  const [whole, frac = ""] = price.split(".");
  const paddedFrac = (frac + "0".repeat(DEFAULT_DECIMALS)).slice(0, DEFAULT_DECIMALS);
  const combined = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, "");
  return combined;
}

/**
 * x402Plugin/X Layer (OKX.AI Genesis Hackathon) — IPaymentPlugin implementation for the A2MCP
 * Trust Oracle endpoint. Wraps `@x402/evm`'s ExactEvmClient/toClientEvmSigner so KARMA's
 * `create_job` can route an x402-tagged call through X Layer, the same way x402_stellar.ts and
 * x402_casper.ts do for their chains.
 *
 * Plugin shape per IPaymentPlugin (docs/standards/IPaymentPlugin-v1.md):
 *   • quote(req)  — synchronous, no network. Normalizes price to base units.
 *   • pay(req)    — builds a ClientEvmSigner from the agent's keystore account and returns a
 *                   pending receipt; the actual EIP-3009 signature is produced by the x402
 *                   client at the moment of HTTP request (it needs the resource server's
 *                   402-response PaymentRequirements first — same reason x402_stellar.ts defers
 *                   it).
 *   • verify(rec) — server-side structural sanity; full settlement verification is the
 *                   facilitator's job (OKX Payment SDK recommended per okx.ai/tutorial/asp).
 */
export class XLayerX402Plugin implements IPaymentPlugin {
  readonly id = "x402-xlayer";
  readonly rail = "x402" as const;
  readonly networks = XLAYER_NETWORKS;
  private readonly lookup: XLayerAccountLookup;

  constructor(
    private readonly facilitatorUrl: string,
    lookup: XLayerAccountLookup = (agentId) => keystoreManager.getAccount(agentId),
  ) {
    this.lookup = lookup;
  }

  async quote(req: PaymentRequest): Promise<PaymentQuote> {
    if (!this.networks.includes(req.network)) {
      throw new Error(`[x402-xlayer] unsupported network ${req.network}`);
    }
    return {
      rail: this.rail,
      network: req.network,
      asset: req.asset || defaultAssetForNetwork(req.network),
      price: toSmallestUnits(req.price),
      facilitatorUrl: this.facilitatorUrl,
    };
  }

  async pay(req: PaymentRequest, opts: { agentId: string }): Promise<PaymentReceipt> {
    if (!this.networks.includes(req.network)) {
      throw new Error(`[x402-xlayer] unsupported network ${req.network}`);
    }
    const account = this.lookup(opts.agentId);
    const signer: ClientEvmSigner = toClientEvmSigner(account);
    if (signer.address.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error("[x402-xlayer] signer address mismatch — account/signer disagree");
    }
    return {
      rail: this.rail,
      payer: account.address,
      payee: req.payTo,
      amount: toSmallestUnits(req.price),
      asset: req.asset || defaultAssetForNetwork(req.network),
      network: req.network,
      facilitatorRef: this.facilitatorUrl,
    };
  }

  async verify(receipt: PaymentReceipt): Promise<boolean> {
    if (receipt.rail !== this.rail) return false;
    if (!this.networks.includes(receipt.network)) return false;
    if (!/^0x[0-9a-fA-F]{40}$/.test(receipt.payer)) return false;
    if (!receipt.payee || !receipt.amount) return false;
    return true;
  }
}

/** Recommended payment option entry for a skill's `register_skill` payload (matches the
 *  SkillDocument.payment_options shape). */
export function xLayerX402PaymentOption(network: string = XLAYER_TESTNET_CAIP2): PaymentOption {
  return {
    rail: "x402",
    network,
    asset: defaultAssetForNetwork(network),
  };
}
