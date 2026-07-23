/**
 * IPaymentPlugin — chain-agnostic payment plugin interface (Phase 0 of the Stellar/Casper roadmap).
 *
 * Two settlement rails are recognized: `x402` (one-shot HTTP-native, e.g. Coinbase x402 facilitator
 * on Stellar/Casper) and `escrow` (multi-step on-chain, e.g. AgentSkillRegistry on Pharos). Plugins
 * implement EXACTLY ONE rail for a defined set of networks. The registry resolves a (rail, network)
 * pair to a unique plugin — see `src/lib/payment/registry.ts`.
 *
 * Surface is deliberately narrow (quote / pay / verify) — the synthesis doc warns against premature
 * abstraction and the plan keeps the interface tight so Stellar and Casper plugins land without
 * cross-track refactoring. Chain-specific concerns (wallet derivation, facilitator URL, asset
 * parsing) live INSIDE each plugin, not in this contract.
 */

export type SettlementRail = "x402" | "escrow";

/** Per-skill advertised payment option — surfaced by `discover_skills` so requesters can pick a rail. */
export interface PaymentOption {
  rail: SettlementRail;
  network: string;
  asset: string;
}

/** Verifiable receipt returned by `pay`. Re-checked by `verify` (server-side gate on the provider). */
export interface PaymentReceipt {
  rail: SettlementRail;
  /** Chain-native tx or operation hash (settlement-specific). Optional for x402 receipts that carry
   *  only a facilitator settlement reference until the chain confirms. */
  txHash?: string;
  /** Facilitator-side settlement id (x402 only). */
  facilitatorRef?: string;
  /** Payer + payee in the chain's native address format — caller validates, this interface does not. */
  payer: string;
  payee: string;
  /** Amount as a base-10 string (D-6 BigInt-safe at the boundary). */
  amount: string;
  /** Symbolic asset name (e.g. "USDC", "CSPR", "PHRS"). Not parsed here. */
  asset: string;
  /** CAIP-2-ish network identifier (e.g. "stellar:testnet", "casper:testnet", "pharos:atlantic"). */
  network: string;
  /** Off-chain payment-authorization signature (hex), present when the rail signs before it
   *  settles (e.g. an EIP-712/CEP-3009-style authorization). Superseded by `txHash` once real
   *  on-chain settlement confirms — a receipt with `signature` set but no `txHash` means "signed,
   *  not yet settled on-chain," never treat `signature` as a chain hash. */
  signature?: string;
  /** Set when the rail attempted real on-chain settlement and it failed (network error, reverted
   *  tx, etc) — the payment authorization itself (`signature`) may still be valid and relayable
   *  later. Absent on success or when settlement wasn't attempted at all. */
  settlementError?: string;
}

/** Quote returned by `quote` — informational, no commitment to pay. */
export interface PaymentQuote {
  rail: SettlementRail;
  network: string;
  asset: string;
  price: string;
  /** x402 only — facilitator settlement endpoint. Surfaced so callers can stamp it on the request. */
  facilitatorUrl?: string;
}

/** Inputs to `quote` / `pay`. Skill-id is logical (decoupled from any one chain's id space). */
export interface PaymentRequest {
  skillId: string;
  price: string;
  asset: string;
  payTo: string;
  network: string;
}

export interface IPaymentPlugin {
  /** Stable id, e.g. "x402-stellar", "x402-casper", "escrow-pharos". Used as the registry key. */
  readonly id: string;
  /** Settlement rail this plugin implements (exactly one). */
  readonly rail: SettlementRail;
  /** CAIP-2-ish networks this plugin handles. Resolution is exact-string match. */
  readonly networks: readonly string[];
  /** Quote the cost of invoking via this rail. Read-only — must not commit any payment. */
  quote(req: PaymentRequest): Promise<PaymentQuote>;
  /** Pay and return a verifiable receipt. Signing happens inside the plugin, not by callers. */
  pay(req: PaymentRequest, opts: { agentId: string }): Promise<PaymentReceipt>;
  /** Verify a receipt server-side. Pure — must not sign or call out. */
  verify(receipt: PaymentReceipt): Promise<boolean>;
}
