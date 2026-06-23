# IPaymentPlugin v1 — Specification

> **Status:** DRAFT / v1.0 reference. Maintainer: KARMA.
> **Purpose:** Define a chain-agnostic settlement plugin interface for agent skill economies.
> Implementations register with `paymentPlugins` and are resolved by `(rail, network)` pair.

## Why this spec exists

Agent skill economies span multiple settlement chains by necessity — micropayment rails
(Stellar / Coinbase x402), enterprise-compliance rails (Casper), and AI-native L1s (Pharos)
each have different cost / privacy / latency profiles. A KARMA-style marketplace must let
skill owners and requesters pick a rail per call without locking the protocol to one chain.

`IPaymentPlugin` is the minimal interface that makes this possible. **Three methods only**
(`quote` / `pay` / `verify`) — narrow on purpose. Every additional method is one more
implementer dropout. The reference implementations (Stellar, Casper, Pharos escrow) all
fit inside this surface.

## Conformance levels

A plugin is **conformant v1** if it:

1. Implements the `IPaymentPlugin` interface verbatim (TypeScript signature below).
2. Returns `PaymentReceipt` values that round-trip through `verify` without state.
3. Fails loud on `pay()` errors (no silent fallback to a different rail).
4. Declares a stable, unique `id` and a fixed list of `networks` it handles.
5. Honors the `(rail, network)` exact-match contract — `resolve(rail, network)` must
   return the same plugin instance across calls in one process.

## Interface (canonical TypeScript)

```ts
export type SettlementRail = "x402" | "escrow";

export interface PaymentOption {
  rail: SettlementRail;
  network: string;  // CAIP-2-ish: "stellar:testnet", "casper:mainnet", "pharos:atlantic"
  asset: string;    // symbolic — "USDC" | "CSPR" | "PHRS" | contract address
}

export interface PaymentRequest {
  skillId: string;  // logical skill id (chain-agnostic)
  price: string;    // decimal OR base-10 smallest-unit string (BigInt-safe; spec D-6)
  asset: string;    // overrides plugin default when non-empty
  payTo: string;    // chain-native payee address (G…, account-hash-…, 0x…)
  network: string;  // matched exactly against IPaymentPlugin.networks
}

export interface PaymentQuote {
  rail: SettlementRail;
  network: string;
  asset: string;
  price: string;            // smallest-unit normalized
  facilitatorUrl?: string;  // x402 only; included so callers can stamp it on the request
}

export interface PaymentReceipt {
  rail: SettlementRail;
  txHash?: string;           // chain-native tx/op hash
  facilitatorRef?: string;   // x402 facilitator settlement id
  payer: string;             // chain-native
  payee: string;
  amount: string;            // base-10 smallest-unit (BigInt-safe)
  asset: string;             // symbolic
  network: string;           // CAIP-2-ish
}

export interface IPaymentPlugin {
  /** Stable id, e.g. "x402-stellar", "x402-casper", "escrow-pharos". Used as the registry key. */
  readonly id: string;
  /** Settlement rail this plugin implements (exactly one). */
  readonly rail: SettlementRail;
  /** CAIP-2-ish networks this plugin handles. Resolution is exact-string match. */
  readonly networks: readonly string[];
  /** Quote the cost of invoking via this rail. Read-only — MUST NOT commit any payment. */
  quote(req: PaymentRequest): Promise<PaymentQuote>;
  /** Pay and return a verifiable receipt. Signing happens inside the plugin, not by callers. */
  pay(req: PaymentRequest, opts: { agentId: string }): Promise<PaymentReceipt>;
  /** Verify a receipt server-side. Pure — MUST NOT sign or call out. */
  verify(receipt: PaymentReceipt): Promise<boolean>;
}
```

## Registry contract

```ts
class PaymentPluginRegistry {
  register(p: IPaymentPlugin): void;                      // throws on duplicate id
  byRail(rail: SettlementRail): IPaymentPlugin[];         // all impls for a rail
  resolve(rail: SettlementRail, network: string): IPaymentPlugin | null;  // exact-match
  list(): IPaymentPlugin[];
  clear(): void;
}

export const paymentPlugins = new PaymentPluginRegistry();
```

Behavioral invariants:
- `register` MUST throw on duplicate id (no silent overwrite — boot-order swap is a security regression).
- `resolve` MUST return `null` (not throw) for an unregistered `(rail, network)`.
- The registry is **single-process** (matches the in-process `identitySessions` pattern).
  Multi-replica deployments are responsible for synchronizing plugin sets at boot.

## Network identifier convention

The `network` field is a **CAIP-2-ish** string of the form `"<chain-namespace>:<chain-reference>"`.
Reserved namespaces (v1):

| Namespace | Examples | Notes |
|---|---|---|
| `stellar` | `stellar:testnet`, `stellar:pubnet` | Stellar core network passphrases mapped per `@stellar/stellar-sdk` |
| `casper` | `casper:testnet`, `casper:mainnet` | Casper Network mainnet + testnet |
| `pharos` | `pharos:atlantic` | Pharos Atlantic L1 (chainId 688689) |
| `ethereum` | `ethereum:1`, `ethereum:11155111` | Standard CAIP-2 (chainId-based) |

A plugin MAY advertise additional chain namespaces; namespaces collide unless they share
a network reference. The registry does NOT validate the namespace — only exact-match between
`PaymentRequest.network` and `IPaymentPlugin.networks[*]`.

## Amount + asset semantics

- `price` and `amount` are base-10 strings to preserve `BigInt` precision (spec D-6).
- A `price` containing a `.` (e.g. `"0.01"`) is a human-readable decimal — the plugin MUST
  convert to the rail's smallest unit (USDC = 7 decimals on Stellar, CSPR = 9 decimals on
  Casper, PHRS = 18 decimals on Pharos) and return the converted value in the receipt.
- A `price` without `.` is treated as already-smallest-unit and passes through unchanged.
- `asset` is symbolic (`"USDC"`, `"CSPR"`) OR a chain-native asset/contract reference
  (e.g. Stellar SEP-41 contract address). Empty string ⇒ use plugin default.

## x402 wire-format compatibility

For `rail = "x402"` plugins, the receipt's `txHash` MAY carry a signed payment envelope
(hex-encoded canonical-JSON + signature) rather than a settled chain hash, until the
facilitator confirms settlement. Callers stamp this on the HTTP `X-PAYMENT` header
per the Coinbase x402 "exact" scheme.

## Test vectors

### `quote` round-trip

```ts
// Stellar testnet, 0.01 USDC
const q = await plugin.quote({
  skillId: "1", price: "0.01", asset: "",
  payTo: "GD…", network: "stellar:testnet",
});
// expected:
// q.rail            === "x402"
// q.network         === "stellar:testnet"
// q.asset           === "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"  // USDC testnet
// q.price           === "100000"            // 0.01 × 10^7
// q.facilitatorUrl  === "https://www.x402.org/facilitator"
```

### `pay` receipt shape

```ts
const r = await plugin.pay({…}, { agentId: "agent-alpha" });
// r.rail        === "x402"
// r.network     === "stellar:testnet"
// r.payer       === keypair.publicKey()       // G-account
// r.amount      === "100000"
// r.facilitatorRef === "https://www.x402.org/facilitator"
```

### `verify` MUST be pure (no side effects, no network)

```ts
expect(await plugin.verify(receipt)).toBe(true);   // well-formed receipt
expect(await plugin.verify({ …receipt, rail: "escrow" })).toBe(false);   // rail mismatch
expect(await plugin.verify({ …receipt, network: "ethereum:1" })).toBe(false);  // network mismatch
```

## Reference implementations (v1.0)

| Implementation | Network | Code | Status |
|---|---|---|---|
| `StellarX402Plugin` | `stellar:testnet`, `stellar:pubnet` | [`src/plugins/x402_stellar.ts`](../../src/plugins/x402_stellar.ts) | Shipped (T7) |
| `CasperX402Plugin` | `casper:testnet`, `casper:mainnet` | [`src/plugins/x402_casper.ts`](../../src/plugins/x402_casper.ts) | Shipped (T11) |
| `paymentPlugins` registry + boot | env-gated `KARMA_X402_*_FACILITATOR_URL` | [`src/lib/payment/`](../../src/lib/payment/) | Shipped |

Pharos escrow (the original on-chain settlement rail) is NOT a `IPaymentPlugin` — it lives
in the contract's `createJob` path. Wrapping it as a plugin is a v2 cleanup; the current
`settlement_rail = "escrow"` branch in `create_job` is the canonical escrow path.

## Versioning

This spec uses semantic versioning at the interface level:
- **v1.x** — backwards-compatible additions (new optional methods, new chain namespaces).
- **v2.x** — breaking change to `IPaymentPlugin` (e.g. async `verify` becomes streaming).

A plugin SHOULD expose its target spec version through the `id` (e.g. `x402-stellar-v1`)
or a separate constant. The registry does not enforce versioning yet.

## Open questions (v1 → v2)

- Should `verify` get a "settle-back" mode that confirms on-chain settlement after the
  facilitator's signed verdict? (Currently caller's responsibility.)
- Multi-hop revenue split: should a `pay()` accept `payTo: { addr, share }[]` for
  composition rails? (Currently single payee; multi-hop lives at the orchestration layer.)
- Subscription rail: separate `IPaymentPlugin` sub-interface for time-windowed unlocks?
  (Currently per-call only; subscription is a v2 extension.)
- Streaming: chunked `pay()` for long-running tasks (heartbeat-gated)?

Discussion: open a PR or issue against this file.

## Relation to adjacent standards

- **Coinbase x402** (the HTTP-native payment scheme) — this spec wraps x402 facilitators
  as one possible rail; it is NOT an x402 alternative.
- **CAIP-2** (chain agnostic identifier protocol) — the `network` field uses a CAIP-2-ish
  string; full CAIP-2 strict compatibility is not required (some chains use simplified ids).
- **ERC-8004** (agent registry / reputation) — orthogonal; ERC-8004 covers identity +
  reputation pointers, this spec covers settlement.
- **MCP** (Model Context Protocol) — orthogonal; MCP is the wire format, this spec is
  the settlement extension that makes MCP commercially viable.
