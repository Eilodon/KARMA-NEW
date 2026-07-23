#!/usr/bin/env bash
# Builds a real, deployable wasm — a working replacement for `cargo odra build`, which (as of
# cargo-odra 0.1.7 against odra 2.8.1) shells out to a bin-target invocation that doesn't match
# odra-build's actual API. See contracts-odra/README.md for the full diagnosis.
#
# Usage: ./build-wasm.sh [MODULE] [OUTPUT_FILE]
#   MODULE      the contract's `HasIdent::ident()` value — the bare type name, not the full path
#               from Odra.toml's `fqn`. Defaults to AgentSkillRegistry (this script's original,
#               sole contract) for backward compatibility.
#   OUTPUT_FILE where to copy the built wasm. Defaults to wasm/karma_odra.wasm, same as before.
#
# ODRA_BACKEND=casper selects the wasm-target host-function glue. --import-undefined tells the
# linker that casper_revert / casper_get_named_arg / etc. are real Casper host functions supplied
# at execution time, not missing symbols.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

MODULE="${1:-AgentSkillRegistry}"
OUTPUT_FILE="${2:-wasm/karma_odra.wasm}"

rustup target add wasm32-unknown-unknown --toolchain nightly >/dev/null

# target-cpu=mvp: recent rustc/LLVM defaults wasm32-unknown-unknown codegen to the bulk-memory
# proposal (LLVM lowers memcpy/memset-style copies straight to `memory.copy`/`memory.fill`), but
# Casper's on-chain wasm engine only accepts the original MVP instruction set and rejects it at
# preprocessing ("Bulk memory operations are not supported"). Disabling the single
# target-feature=-bulk-memory flag is NOT enough — LLVM's memcpy-lowering heuristic still emits
# `memory.copy` regardless of that flag; target-cpu=mvp pins the whole codegen subtarget to the
# base spec, and -Z build-std rebuilds core/alloc (rustc's prebuilt sysroot) under the same
# subtarget instead of the prebuilt-with-bulk-memory default (nightly-only; needs rust-src).
RUSTFLAGS="-C link-arg=--import-undefined -C target-cpu=mvp" \
ODRA_MODULE="$MODULE" \
ODRA_BACKEND=casper \
cargo +nightly build -Z build-std=core,alloc -Z build-std-features=compiler-builtins-mem \
  --target wasm32-unknown-unknown --release --lib

mkdir -p "$(dirname "$OUTPUT_FILE")"
cp target/wasm32-unknown-unknown/release/karma_odra.wasm "$OUTPUT_FILE"
echo "wrote $OUTPUT_FILE ($(wc -c < "$OUTPUT_FILE") bytes) for module $MODULE"
