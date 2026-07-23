#!/usr/bin/env bash
# Portable stdio launcher for the "calm" MCP server (github.com/Eilodon/CALM —
# Coding Agent Liveness Map: call-graph-aware search/edit tools for AI agents).
# Self-contained on purpose — does NOT assume CALM's own source tree is
# checked out anywhere on this machine, so the exact same script works on a
# local dev box and on a fresh Claude Code on-the-web clone of just this repo
# (see docs/calm-mcp-setup.md for the full setup, including the cloud
# environment Setup Script that pre-installs the binary before this ever
# needs to fall through to tier 3 below).
#
# Resolution order (first usable binary wins):
#   1. `calm` already on PATH.
#   2. $HOME/.local/bin/calm — where scripts/install.sh (upstream) and the
#      Setup Script documented in docs/calm-mcp-setup.md both install it.
#   3. Last resort: install now via the official installer, then exec. This
#      is a real network fetch + checksum-verified download — expected to be
#      a no-op fallback in practice once the Setup Script has run once, but
#      keeps a fresh local clone usable on the very first connection attempt
#      too (at the cost of that first connection being slower).
set -uo pipefail

log() { printf '[calm-mcp-launcher] %s\n' "$*" >&2; }

serve_args=(serve --project-root "$PWD" "$@")
for arg in "$@"; do
  case "$arg" in
    --project-root|--project-root=*) serve_args=(serve "$@"); break ;;
  esac
done

try_exec() {
  [ -x "$1" ] && exec "$1" "${serve_args[@]}"
}

command -v calm >/dev/null 2>&1 && exec calm "${serve_args[@]}"
try_exec "$HOME/.local/bin/calm"

log "calm binary not found on PATH or at \$HOME/.local/bin/calm — trying the official installer (one-time; see docs/calm-mcp-setup.md to avoid this by pre-installing via a cloud Setup Script)"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL https://raw.githubusercontent.com/Eilodon/CALM/main/scripts/install.sh | sh 1>&2
  try_exec "$HOME/.local/bin/calm"
fi

# Deliberately NOT falling back to a from-source build here: this script runs
# on every MCP dial, which has a short (~7s) connection timeout budget — a
# multi-minute `cargo build` would just make the failure slower, not fix it.
# That heavier fallback belongs in a context with a real time budget instead:
# the cloud environment Setup Script or .claude/hooks/session-start.sh (see
# docs/calm-mcp-setup.md), both of which build the binary before this launcher
# is ever asked to find it.
log "could not locate or install the calm binary. If the installer above failed (e.g. no matching release asset yet), add the Setup Script from docs/calm-mcp-setup.md, or run it locally once — the calm MCP server cannot start without it."
exit 1
