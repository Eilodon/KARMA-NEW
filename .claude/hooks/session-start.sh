#!/bin/bash
#
# SessionStart hook — bootstraps the dev tooling the JS + Rust + Solidity test suites need
# in a fresh remote container (Claude Code on the web). Idempotent: every step skips
# cleanly when its artefact already exists, so re-runs cost only the existence checks.
#
# Bootstraps:
#   1. pnpm install (node_modules)
#   2. Foundry 1.7.1 (forge + anvil + cast + chisel) → $HOME/.foundry/bin
#   3. solc 0.8.24 → $HOME/.svm/0.8.24/solc-0.8.24 (Foundry's svm layout)
#   4. forge-std (Foundry test helpers) → lib/forge-std
#   5. forge build → out/AgentSkillRegistry.sol/AgentSkillRegistry.json (un-skips the
#      P4.1 ABI drift guard + the 4 realKarmaService ↔ anvil integration tests in
#      `pnpm test`)
#   6. Rust nightly (optional but recommended) — needed for the contracts-odra/ Odra
#      TDD loop (`cargo +nightly test`) because odra-macros 2.x uses
#      `#![feature(box_patterns)]`.
#   7. calm MCP server binary + rust-analyzer — powers the "calm" server in
#      .mcp.json (call graph, semantic search, edit-safety gates over this repo).
#      rust-analyzer upgrades Rust call edges (contracts-odra/, contracts-soroban/)
#      from syntactic to SCIP-verified "formal" confidence; calm still works
#      without it, just at lower confidence for Rust. See docs/calm-mcp-setup.md.
#
# Only activates inside Claude Code on the web (`$CLAUDE_CODE_REMOTE == true`) so a
# local dev box that already has a different Foundry / Rust setup is left alone.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Make Foundry visible to every subsequent shell launched during this session.
echo 'export PATH="$HOME/.foundry/bin:$PATH"' >> "$CLAUDE_ENV_FILE"

# ── 1. pnpm deps ──────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "[hook] pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
fi

# ── 2. Foundry binaries (forge + anvil + cast + chisel) ───────────────────────
FOUNDRY_BIN="$HOME/.foundry/bin"
if [ ! -x "$FOUNDRY_BIN/forge" ]; then
  echo "[hook] downloading Foundry v1.7.1"
  mkdir -p "$FOUNDRY_BIN"
  curl -sL https://github.com/foundry-rs/foundry/releases/download/v1.7.1/foundry_v1.7.1_linux_amd64.tar.gz \
    -o /tmp/foundry.tgz
  tar -xzf /tmp/foundry.tgz -C "$FOUNDRY_BIN"
  chmod +x "$FOUNDRY_BIN"/*
  rm -f /tmp/foundry.tgz
fi
export PATH="$FOUNDRY_BIN:$PATH"

# ── 3. solc 0.8.24 (Foundry's svm layout; `binaries.soliditylang.org` is blocked) ──
SOLC="$HOME/.svm/0.8.24/solc-0.8.24"
if [ ! -x "$SOLC" ]; then
  echo "[hook] downloading solc 0.8.24"
  mkdir -p "$(dirname "$SOLC")"
  curl -sL https://github.com/ethereum/solidity/releases/download/v0.8.24/solc-static-linux -o "$SOLC"
  chmod +x "$SOLC"
fi

# ── 4. forge-std (Foundry test helpers) ───────────────────────────────────────
if [ ! -d lib/forge-std ]; then
  echo "[hook] forge install foundry-rs/forge-std --no-git"
  forge install foundry-rs/forge-std --no-git
fi

# ── 5. forge build → un-skips the 5 dev-tooling-gated tests in `pnpm test` ────
if [ ! -f out/AgentSkillRegistry.sol/AgentSkillRegistry.json ]; then
  echo "[hook] forge build --use 0.8.24"
  forge build --use 0.8.24
fi

# ── 6. Rust nightly for the contracts-odra/ Odra TDD loop ─────────────────────
# odra-macros 2.x uses `#![feature(box_patterns)]` (nightly-only).
if command -v rustup >/dev/null 2>&1; then
  if ! rustup toolchain list 2>/dev/null | grep -q nightly; then
    echo "[hook] installing Rust nightly for the Odra TDD loop"
    rustup toolchain install nightly --profile minimal
  fi
fi

# ── 7. calm MCP server binary + rust-analyzer ─────────────────────────────────
# script/calm-mcp-launcher.sh also self-installs calm on first connect if this
# step is somehow skipped — this just avoids paying that cold-start cost on the
# MCP client's short initial-connection timeout. See docs/calm-mcp-setup.md.
if ! command -v calm >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/calm" ]; then
  echo "[hook] installing calm MCP server binary"
  curl -fsSL https://raw.githubusercontent.com/Eilodon/CALM/main/scripts/install.sh | sh || true
fi
export PATH="$HOME/.local/bin:$PATH"
# Fallback: as of 2026-07, the latest tagged CALM release still ships assets
# under the pre-rename `ci-*` name while the installer looks for `calm-*`
# (tracked in CALM's own docs/rename-checklist.md, Tier 2 — needs a fresh
# tagged release upstream to fix). Until that's cut, build from source instead
# — slower, but this hook only reruns when the ~7-day environment cache
# expires, so it's a one-time cost, not a per-session one.
if ! command -v calm >/dev/null 2>&1; then
  echo "[hook] calm installer had no matching release asset — building from source instead"
  CALM_SRC="$(mktemp -d)"
  if git clone --depth 1 https://github.com/Eilodon/CALM.git "$CALM_SRC" 2>&1; then
    (
      cd "$CALM_SRC"
      if command -v git-lfs >/dev/null 2>&1; then
        git lfs pull >/dev/null 2>&1 || true
      fi
      cargo build --release -p calm-cli --features embeddings,tier0-5,scip-overlay
    ) || true
    if [ -x "$CALM_SRC/target/release/calm" ]; then
      mkdir -p "$HOME/.local/bin"
      cp "$CALM_SRC/target/release/calm" "$HOME/.local/bin/calm"
    fi
  fi
  rm -rf "$CALM_SRC"
fi
if command -v rustup >/dev/null 2>&1 && ! rustup component list --installed 2>/dev/null | grep -q rust-analyzer; then
  echo "[hook] installing rust-analyzer (for calm's SCIP overlay on Rust)"
  rustup component add rust-analyzer >/dev/null 2>&1 || true
fi
if command -v calm >/dev/null 2>&1; then
  calm init  --project-root "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1 || true
  calm index --project-root "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1 || true
fi

echo "[hook] session bootstrap complete"
