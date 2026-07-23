# RFC — x402 Casper: EIP-712 / CEP-18 interop with the official reference

> **Status (2026-07-21):** §5.0-§5.5 all done and proven for real, end-to-end. `X402SettlementToken`
> is live on Casper Testnet at `hash-b3387d595fa53045f42b350907a68f3a0b95cc983c056fd9d71d26f776c1d310`
> (install tx `f9656962176de5034accbaf5ee7e9aca03d792aa93bd67fb05b92ea85ab321db`, block `8574201`,
> `errorMessage: null`, verified independently via the deployer account's `named_keys`). The
> `x402_casper.ts` TypeScript rewrite (§5.1-§5.5) is done, unit-tested (30/30, including a
> byte-for-byte cross-check of the ERC-3009 typehash against `CEP3009`'s hardcoded Rust constant),
> and — critically — proven against the *actual deployed contract*: `demo_casper_x402_settlement_live.ts`
> deposits real CSPR into `X402SettlementToken`, signs a real EIP-712 `transfer_with_authorization`
> authorization with `CasperX402Plugin.payWithEnvelope`, and settles it on-chain via
> `settleTransferWithAuthorization` — `errorMessage: null`, `Transfer` event emitted. This caught
> two real bugs a unit test alone could not have: (1) `settleTransferWithAuthorization`'s call args
> used `amount` where the contract's real wire arg is `value` (reverted `MissingArg`, Odra code
> 64658); (2) the digest itself was built from the npm package's generic `TransferAuthorizationTypes`
> preset (wrong struct name, wrong field casing, wrong field types) instead of `CEP3009`'s actual
> hardcoded ERC-3009 typehash (reverted `InvalidSignature`, code 37003). Both are fixed; the digest
> now mirrors `CEP3009::build_authorization_message` field-for-field. Nothing left open in this RFC.

## 1. Problem

`src/plugins/x402_casper.ts` is a self-contained "exact" payment-scheme implementation, written
before this research and before the Casper AI Toolkit's own x402 reference was known. Casper's own
site (`casper.network/ai`) names [`make-software/casper-x402`](https://github.com/make-software/casper-x402)
**"the official reference implementation for the x402 protocol on Casper"** — production-ready,
backed by [`casper-ecosystem/casper-eip-712`](https://github.com/casper-ecosystem/casper-eip-712)
(published April 2026) for the typed-data layer. The Buildathon's prize pool earmarks
**$100,000 of $150,000 as "x402 Ecosystem Credits"** — the organizers structurally reward genuine
interop with this specific reference, not merely "an x402-shaped payment flow."

Today, KARMA's rail cannot talk to the official facilitator, client, or CEP-18 settlement path.
Every layer diverges: signing scheme, message schema, numeric units, signature encoding, HTTP
header name, and the underlying asset model. This is not a field-rename; it is two different
protocols that happen to share a scheme name (`"exact"`).

## 2. Goals / non-goals

**Goals:** pin every divergence to its exact source (cited, not assumed); size the real blocking
sub-problem (§4) honestly; produce an ordered, scoped migration plan a future session can execute
without re-deriving this research.

**Non-goals:** this RFC does not change `x402_casper.ts`'s runtime behavior. It is the decision
document the judge-fit playbook's "Phương án A vs B" branch asked for — implementation is a
separate, explicit go/no-go (§9).

## 3. Divergence, field by field

Sources: `js/packages/mechanisms/casper/src/{types,constants,signer}.ts` and
`exact/client/scheme.ts` in `make-software/casper-x402`; `go/docs/api-reference.md` in the same
repo; `js/README.md` in `casper-ecosystem/casper-eip-712`. KARMA side: `src/plugins/x402_casper.ts`
as of this commit.

| Aspect | KARMA today | Official reference |
|---|---|---|
| `x402Version` | `1` | `2` |
| Network id | `"casper:testnet"` / `"casper:mainnet"` — code comment admits "symbolic, not strict CAIP-2" | `"casper:casper-test"` / `"casper:casper"` / `"casper:casper-net-1"` — real CAIP-2 |
| Signing scheme | `canonicalize(payload)` (sorted-key JSON) → SHA-256 → secp256k1 sign → DER-encode | EIP-712 typed-data digest (`casper-eip-712`'s `hashTypedData(domain, types, "TransferWithAuthorization", message)`) → `keypair.signAndAddAlgorithmBytes(digest)` |
| Signature encoding | ASN.1 DER, variable length (`compactToDER`) | Casper-native: `[1 algorithm byte \| 64 raw bytes]`, fixed 65 bytes / 130 hex chars |
| Signed message fields | **Everything** — `scheme, network, payer, payee, amount, asset, validAfter, validBefore, nonce` all go into the hashed canonical JSON | Only `{from, to, value, validAfter, validBefore, nonce}` are in the signed struct (`ExactCasperAuthorization`). `scheme`/`network`/`asset`(as `verifyingContract`) live in the **EIP-712 domain**, not the message |
| `validAfter`/`validBefore` units | milliseconds (`Date.now()`) | **seconds** |
| Payer/payee field names | `payer` / `payee` / `amount` | `from` / `to` / `value` |
| `asset` | free string, `"CSPR"` (the native token symbol) | **must be a CEP-18 contract package hash** (64 hex chars) — the official scheme has no concept of paying in the native asset directly |
| Settlement | **none.** `pay()`/`payWithEnvelope()` never call a facilitator or submit a transaction; the receipt's `txHash` is literally the signature hex, per the code's own comment ("until a settlement tx is realised by the facilitator") | Facilitator submits a real `transfer_with_authorization` deploy against the CEP-18 contract (`from, to, amount: CLUInt256, valid_after: CLUInt64, valid_before: CLUInt64, nonce: 32B, public_key, signature: 65B`) — actual on-chain settlement |
| HTTP header | `X-PAYMENT` (per code comments, `DEMO_CASPER.md`) | `PAYMENT-SIGNATURE` |
| Public key format | secp256k1 hex via `casper-js-sdk`'s `PublicKey` | Algorithm-prefixed hex, curve-agnostic (signer defaults to `KeyAlgorithm.ED25519` but takes a configurable `KeyAlgorithmType` — **secp256k1 keys are not the blocker**, the envelope format is) |

Every row above is independently fixable except one, which sets the actual scope of this RFC.

## 4. The real blocking sub-problem — solved by composition, not by writing crypto

The signing-scheme and encoding rows in §3 are mechanical — swap SHA-256/DER for
`casper-eip-712`'s typed-data pipeline, rename fields, switch ms→s. The genuine blocker is
architectural: **the official `"exact"` scheme has no native-asset path.** `PaymentRequirements.asset`
is required to be a CEP-18 fungible-token contract package hash; settlement is a CEP-18
`transfer_with_authorization` call. KARMA's `AgentSkillRegistry` escrow, by contrast, is built
entirely on native CSPR motes (`#[odra(payable)]` entry points, `attached_value()`) — there is no
CEP-18 token anywhere in `contracts-odra/`.

The first draft of this RFC scoped two workarounds here (wrap CSPR from scratch, or point at an
unspecified "neutral test token"). Neither is necessary: **the Odra team already ships the exact
building blocks, officially, MIT-licensed, version-aligned with what KARMA already depends on.**

- **`odra-modules`** (crates.io, MIT license, published `2.5.0` through `2.9.0` — `2.8.2` matches
  KARMA's own `odra = "=2.8.2"` pin exactly) ships a **`CEP3009`** module: "an adaptation of
  ERC-3009 ('Transfer With Authorization') for the Casper Network" with exactly the entry points
  the official facilitator calls — `transfer_with_authorization`, `receive_with_authorization`,
  `cancel_authorization`, `authorization_state` — EIP-712-signed, replay-protected by nonce. It
  also ships the underlying `cep18_token::Cep18` module and a `wrapped_native::CsprDepositContractRef`
  helper for native-CSPR deposit/withdraw.
- **[`odradev/wcspr`](https://github.com/odradev/wcspr)** is the Odra team's own reference
  composition of those pieces into a real wrapped-CSPR CEP-18 token with gasless transfers —
  `WCSPRV1` (`Cep18` submodule + `deposit`/`withdraw`/`withdraw_to`, 1:1 backed by real attached
  CSPR) and `WCSPRV2` (adds a `CEP3009` submodule via Odra's `delegate!` macro for the
  authorization entry points). Read in full to confirm the pattern — not vendored: the eligibility
  rule requires original, newly-developed code, and the composition itself is genuinely small
  (§5.0 below is KARMA's own version of it, independently written against the same two upstream
  modules).

This closes the asset-model gap for real: agents wrap CSPR into a genuine 1:1-backed CEP-18 token
(no throwaway/meaningless test asset, no separate liquidity story), and that same token already
speaks the exact `transfer_with_authorization` entry point x402 settlement needs — zero hand-rolled
cryptography anywhere in the contract layer.

## 5. Concrete migration mechanism

### 5.0 Contract side — a wrapped-CSPR CEP-18 token with CEP-3009, composed not hand-rolled

New file, `contracts-odra/src/x402_settlement_token.rs`, following the shape confirmed by reading
`odradev/wcspr`'s `wcspr_v1.rs`/`wcspr_v2.rs` in full: an Odra `SubModule<Cep18>` for the CEP-18
ledger plus `deposit`/`withdraw`/`withdraw_to` against native CSPR (`#[odra(payable)]`,
`attached_value()`, `raw_mint`/`raw_burn` — the same primitives `AgentSkillRegistry` already uses
for its own payable entry points), and a second `SubModule<CEP3009>` delegated in via Odra's
`delegate!` macro for `transfer_with_authorization`/`receive_with_authorization`/
`cancel_authorization`/`authorization_state`. Registered in `Odra.toml` alongside
`AgentSkillRegistry`. New dependency: `odra-modules = "=2.8.2"` — matches the existing `odra` pin
exactly; do not let this drift to `2.9.0` without bumping `odra`/`odra-build`/`odra-test` together,
per the version-churn warning already in `contracts-odra/Cargo.toml`.

Build/test loop is identical to the existing contract: `cargo +nightly test --manifest-path
contracts-odra/Cargo.toml` (Odra's mock VM, no live node needed), then `build-wasm.sh` for the
deployable artifact — no new tooling, no new CI step.

### 5.1 New dependencies
- Rust: `odra-modules = "=2.8.2"` (§5.0).
- TypeScript: `@casper-ecosystem/casper-eip-712` (npm) — typed-data domain separator + `hashTypedData`.
- The `asset` field: `hash-b3387d595fa53045f42b350907a68f3a0b95cc983c056fd9d71d26f776c1d310` —
  live now (§0's status note). No external token dependency, no "find a test token" problem.
- Either point at a real `make-software/casper-x402` facilitator instance, or implement
  settlement against the same `transfer_with_authorization` entry point using the
  `submit`/`submitPayable` pattern `live_client.ts` already has for every other Odra call.

### 5.2 Payload shape (replaces `CasperExactPaymentPayload`)

```ts
interface ExactCasperAuthorization {
  from: string;          // payer account-hash, "00" prefix
  to: string;             // payee account-hash, "00" prefix
  value: string;          // atomic token amount, decimal string
  validAfter: string;     // unix SECONDS
  validBefore: string;    // unix SECONDS
  nonce: string;           // 32-byte hex
}
interface ExactCasperPayload {
  signature: string;       // 65-byte algo-prefixed hex (130 hex chars) — NOT DER
  publicKey: string;
  authorization: ExactCasperAuthorization;
}
```

`scheme`/`network`/`asset` move out of the signed struct and into the EIP-712 domain
(`{name, version, chain_name, contract_package_hash}` — the Casper-specific domain field set per
`casper-eip-712`'s README, chosen over the Ethereum-shaped `chainId`/`verifyingContract` pair).

### 5.3 Signing pipeline (replaces `canonicalize` → SHA-256 → `compactToDER`)

As implemented — NOT a generic `hashTypedData(domain, types, primaryType, message)` call. `CEP3009`
builds its digest from a **hardcoded typehash constant** plus **manually concatenated raw field
encodings** (`CEP3009::build_authorization_message`), not from a type-definitions object the way a
generic EIP-712 library derives a typehash from a struct's declared shape. Deriving the typehash
from a hand-written Casper-side type-definitions object (e.g. the npm package's
`TransferAuthorizationTypes` preset) produces a *different, wrong* typehash — confirmed the hard
way, via a live on-chain `InvalidSignature` (37003) revert against the real deployed contract. The
correct construction:

```
typehash = computeTypeHash(
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
)  // == CEP3009's own hardcoded TRANSFER_WITH_AUTHORIZATION_TYPEHASH — cross-checked byte-for-byte in
   // src/__tests__/x402_casper.test.ts, not just assumed equal from matching source strings.

encodedStruct = encodeAddress(from) ++ encodeAddress(to) ++ encodeUint256(value)
             ++ encodeUint64(validAfter) ++ encodeUint64(validBefore) ++ encodeBytes32(nonce)

domain   = { name, version: "1", chain_name: network, contract_package_hash: settlementTokenPackageHash }
digest    = hashTypedDataRaw(domain, typehash, encodedStruct, { domainTypes: CASPER_DOMAIN_TYPES })
signature = keypair.signAndAddAlgorithmBytes(digest)   // [1 algo byte | 64 raw bytes]
```

`compactToDER` and `canonicalize`'s role in signing both go away; `canonicalize` may still be
useful internally but is no longer the thing that gets hashed.

### 5.4 Settlement — done, proven on-chain

`settleTransferWithAuthorization()` builds and submits a real `transfer_with_authorization` call
against the deployed `X402SettlementToken` (args per §3's table — note the wire arg name is
`value`, not `amount`; a first cut got this wrong and reverted `MissingArg`, Odra code 64658), the
same `ContractCallBuilder` pattern `live_client.ts` uses for every other signed Odra call.
`demo_casper_x402_settlement_live.ts` proves the full path for real: deposits CSPR into the token,
signs a `transfer_with_authorization` authorization via `payWithEnvelope`, submits it via
`settleTransferWithAuthorization`, and confirms `errorMessage: null` + a `Transfer` event on Casper
Testnet.

### 5.5 Wire-level renames
`X-PAYMENT` → `PAYMENT-SIGNATURE` header; `x402Version: 1` → `2`; network id
`"casper:testnet"` → `"casper:casper-test"`.

## 6. Test impact

`src/__tests__/x402_casper.test.ts` and `casper_live_client.test.ts`'s x402-adjacent cases assert
today's scheme (DER length, `X-PAYMENT` framing, ms-based timestamps). A cutover to §5 is a
rewrite of that suite, not an extension — every fixture's expected bytes change shape.

## 7. Effort & risk estimate (revised — §4's discovery removes the biggest unknown)

| Task | Effort | Risk |
|---|---|---|
| §5.0: contract composition (`odra-modules`' `Cep18`+`CEP3009`) | Small–medium | **Low** — no hand-rolled cryptography; Odra mock-VM tests exercise it exactly like `AgentSkillRegistry` |
| Deploy §5.0's contract to Testnet | Small | Low–medium — mechanical given the existing `deploy_contract.ts`-style pattern; needs a funded deployer key (already required for everything else on this chain) |
| Add `casper-eip-712`, port domain/typed-data signing | Small–medium | Low — mechanical once the type strings are confirmed against a real test vector |
| Field/unit renames (§5.2, §5.5) | Small | Low |
| Real settlement call (§5.4) against §5.0's own contract | Medium | **Low–medium** — KARMA is settling against a contract it deployed and controls; no dependency on an external facilitator being live |
| Rewrite `x402_casper.test.ts` | Medium | Low — mechanical given §5 is nailed down |
| End-to-end proof against the *external* `make-software/casper-x402` facilitator specifically (as opposed to KARMA's own settlement call) | Medium–large | Medium — depends on that facilitator's live availability/config, outside this repo's control — **not required** to make a true, honest "speaks the real wire format and settles on-chain" claim |

## 8. Recommendation for the Buildathon window

With §4's discovery, the work that matters most — real EIP-712 signing, a real CEP-18 asset, real
on-chain `transfer_with_authorization` settlement — no longer depends on anything outside this
repo's control. Only the very last row of §7 (proving interop against `make-software/casper-x402`'s
*own hosted* facilitator, not just KARMA's own settlement path) has real external-dependency risk,
and it is not required for the interop claim to be true and verifiable end-to-end.

1. Build §5.0–§5.5 in full: contract composition, Testnet deploy, EIP-712 signing pipeline, real
   settlement against KARMA's own deployed token.
2. Update this RFC's status to "implemented" with the deployed package hash once live, and update
   `DEMO_CASPER.md`/README's x402 section from "self-contained scheme" to "real EIP-712 +
   CEP-18 settlement, wire-compatible with the official `casper-eip-712`/`casper-x402` reference."
3. Attempting proof against the *external* hosted facilitator is worth a time-boxed try afterward,
   not a blocking dependency — KARMA's own settlement path is already a true, judge-verifiable
   on-chain claim without it.

## 9. Decision request

- Confirmed by the user (2026-07-21): build §5.0–§5.5 in full — real contract composition, real
  Testnet deploy, real EIP-712 signing, real settlement.
- No existing CEP-18 test token was available on Testnet — resolved by §4: KARMA deploys its own
  wrapped-CSPR CEP-18 token (§5.0) instead of sourcing a third-party one.
- Remaining open call, not blocking: whether to also pursue proof against the *external* hosted
  `make-software/casper-x402` facilitator (§7's last row) once §5.0–§5.5 are live — time-boxed,
  attempted only after the self-contained path is verified end-to-end.
