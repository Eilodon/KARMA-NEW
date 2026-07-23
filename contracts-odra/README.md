# `karma-odra` — AgentSkillRegistry on Casper

Odra 2.x port of `contracts/AgentSkillRegistry.sol` (v4) for the **Casper Agentic Buildathon**
(T9 of the internal stellar-casper-tracks build plan).

The port mirrors the Solidity surface 1-to-1: skill lifecycle, escrow + pull-payment jobs, the
on-chain `identityPolicy` (P0), the trust-gate `minReputationToInvoke`, and the Tier-2
Sybil-resistance bond (PD-007). All three audited invariants — CEI, pull-payment, self-deal
nullification — are preserved.

## Layout

```
contracts-odra/
├── Cargo.toml                          # odra 2.2 (resolves to 2.8 transitive); odra-test dev-dep
├── Odra.toml                           # contract registration (fqn) — cargo-odra config
├── build.rs                            # odra_build::build() — real wasm entry-point codegen hook
├── build-wasm.sh                       # working `cargo odra build` replacement (see below)
└── src/
    ├── lib.rs                          # crate root + invariant overview
    ├── agent_skill_registry.rs         # contract (~1330 LoC)
    └── agent_skill_registry/
        ├── tests.rs                    # 129 tests, mirror of test/AgentSkillRegistry.t.sol
        └── proptests.rs                # 2 property-based invariant tests (escrow conservation, reputation bounds)
```

## Test loop

`odra-macros` 2.x needs the nightly compiler (`#![feature(box_patterns)]`):

```bash
rustup toolchain install nightly --profile minimal
cargo +nightly test --manifest-path contracts-odra/Cargo.toml
```

Expected: **131 passed; 0 failed** (happy path, refund window, ghost-requester / dispute /
claim-after-review, double-complete guard, trust gate, identity policy, self-deal nullification,
duplicate task-hash exactly-once, constructor bounds, the seven Tier-2 bond cases, the P0-A
evaluator and P0-B governance/timelock mechanics, the P2-A rationale-attestation entry points, the
`X402SettlementToken` CEP-18/CEP-3009 composition, and 2 property-based invariant tests — escrow
conservation and reputation-bounds — randomized over 64 cases each, `proptests.rs`).

## Casper-specific deltas vs Solidity

- `U512` (CSPR motes) replaces `uint256` (wei).
- Block time is in **milliseconds**, so every duration constant is ms:
  - `MIN_REVIEW_WINDOW` = `1h`
  - `MAX_REVIEW_WINDOW` = `30d`
  - `DEFAULT_REVIEW_WINDOW` = `3d`
  - `BOND_UNLOCK_COOLDOWN` = `7d`
- `bytes32 taskHash` / `bytes32 resultHash` → `odra::casper_types::bytesrepr::Bytes` (the Casper
  bytes wrapper — `Vec<u8>` triggers a runtime efficiency assertion in bytesrepr).
- Reentrancy-guard is dropped: Casper's deploy-isolated execution model removes the Solidity
  cross-call vector. CEI ordering is preserved (`pending_withdrawals` is zeroed *before*
  `transfer_tokens`), so any future cross-contract extension stays safe by construction.
- `JobStatus` is a flat enum (no variant data). Rust's exhaustive `match` on every state-transition
  guard still gives the compile-time state-machine claim. Pattern-data-carrying variants are a
  cheap follow-on if we want to inline `result_hash` / `completed_at`.

## Deploy path (T13)

```bash
./build-wasm.sh   # writes wasm/karma_odra.wasm — a real, WebAssembly.validate()-clean module
```

Verified output: 533,873 bytes, 59 exports including every entry point (`register_skill`,
`create_job`, `deliver_result`, `confirm_completion`, `withdraw`, `deposit_bond`, `get_skill`,
`get_job`, …) plus the Odra dispatcher (`call`) and linear memory. Native `cargo test` stays
131/131 green throughout — `build-wasm.sh` only affects the wasm32 target (verified: the new
`proptest` dev-dependency does not appear in the release wasm build's dependency list, and export
count/wasm size are unchanged by it).

### wasm32 build — how this actually works (not `cargo odra build`)

`cargo-odra 0.1.7`'s `build` subcommand shells out to `cargo build --bin
<crate>_build_contract --target wasm32-unknown-unknown`, expecting a `[[bin]]` target — but
`odra-build 2.8.1`'s real API is `odra_build::build()` (no `_contract` suffix), designed to run
as a **build script**, not a compiled-to-wasm binary. The CLI tool and the pinned library version
don't line up (cargo-odra isn't version-pinned anywhere, unlike `odra`/`odra-test` at `=2.8.1`),
so `cargo odra build` doesn't work here. `build-wasm.sh` bypasses cargo-odra's CLI entirely and
drives `cargo build` directly with what it actually needs:

- **`build.rs`** calling `odra_build::build()` — a real Cargo build script (not `bin/`), which
  reads `ODRA_MODULE` / `ODRA_BACKEND` and emits the `cargo:rustc-cfg=odra_module=...` flag the
  `#[odra::module]` macro checks to decide whether to compile in the wasm entry-point glue
  (`#[no_mangle] extern "C" fn register_skill() { … }` etc.) for *this* contract.
- **`ODRA_MODULE=AgentSkillRegistry`** — must equal `HasIdent::ident()`'s value (the bare type
  name the macro generates, not the `fqn` path in `Odra.toml`).
- **`[lib] crate-type = ["cdylib", "rlib"]`** — a loadable wasm module needs `cdylib`; `rlib`
  alone (the pre-existing setting) can only ever produce a native-linkable Rust artifact.
- **`#![cfg_attr(target_arch = "wasm32", no_std)]`** in `src/lib.rs` — the wasm32 target has no
  std runtime; linking `std` alongside `odra-casper-wasm-env`'s own panic handler collided on the
  `panic_impl` lang item (`error[E0152]`) until this was added. `odra::prelude` already re-exports
  the `alloc`-backed `String`/`Vec` the contract uses, so no further `no_std` porting was needed.
- **`RUSTFLAGS="-C link-arg=--import-undefined"`** — without it, the linker treats the Casper
  host functions (`casper_revert`, `casper_get_named_arg`, `casper_dictionary_put`, …) as missing
  symbols and fails. They're real host imports the Casper node supplies at execution time, not
  actually undefined; this flag tells `rust-lld` to leave them as wasm imports instead of erroring.

`Odra.toml` also needed renaming from `odra.toml` — cargo-odra 0.1.7 looks for the capitalized
filename.
