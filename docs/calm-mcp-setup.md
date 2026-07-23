# calm MCP server setup (Claude Code, local + web)

This repo wires up [`calm`](https://github.com/Eilodon/CALM) — Coding Agent
Liveness Map — as a project-scoped MCP server (`.mcp.json`, server name
`calm`). It gives an AI agent a real call graph, semantic + full-text search,
and pre-edit/pre-commit safety gates over this codebase, instead of grepping
in the dark.

## What's wired up

- `.mcp.json` — the `calm` server entry, spawned via `bash
  script/calm-mcp-launcher.sh`.
- `script/calm-mcp-launcher.sh` — self-contained launcher. Resolution order:
  `calm` on `PATH` → `$HOME/.local/bin/calm` → last-resort self-install via
  the official installer. Never references any path outside this repo, so
  the same script works locally and on a fresh Claude Code on-the-web clone.
- `.claude/hooks/session-start.sh` (step 7) — on Claude Code on the web only
  (`$CLAUDE_CODE_REMOTE=true`), installs the `calm` binary + `rust-analyzer`
  and pre-builds the index (`calm init` + `calm index`) so the server has
  something to serve immediately instead of indexing cold on first use.
- `.gitignore` — `.calm/` (the local index DB) is excluded from version
  control, same as `.codeindex/` was for the old tool this replaces.

## Why a Setup Script is still worth adding (cloud only)

Claude Code's MCP client dials configured servers **concurrently with**
`SessionStart` hooks, not after them — a cold install racing that dial can
lose (see [code.claude.com/docs/en/claude-code-on-the-web](https://code.claude.com/docs/en/claude-code-on-the-web)
and [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp)).
The `SessionStart` hook above is a real, working fallback (and the *only*
mechanism for local, non-cloud Claude Code), but a **cloud environment Setup
Script** runs once, *before* Claude Code launches at all, and its output is
cached (~7 days) — so it structurally can't race the dial. It's not stored
in this repo (it's environment-level config in the Claude Code web UI), so
it's written down here instead.

Unlike CALM's own dogfood setup (which has to `cargo build` its own ~59s Rust
binary), this repo only needs to *install* a prebuilt `calm` release — a
few-second download, not a compile — so the race window would be much
smaller here even without the Setup Script, **once the prebuilt binary
actually installs** (see the known gap below). Add the Setup Script anyway
for the first cold session after a ~7-day cache expiry.

### Known gap: the prebuilt installer 404s today (as of 2026-07-07)

CALM was renamed from `ci`/Code-Intelligence in early July 2026.
`scripts/install.sh` (current `main`) looks for a release asset named
`calm-<target>.tar.gz`, but the latest tagged release published at the time
this was written (`v0.1.3`, 2026-07-05) still ships assets under the
pre-rename name (`ci-<target>.tar.gz`) — tracked in CALM's own
`docs/rename-checklist.md` under "Tier 2 — published artifacts... NOT DONE:
Release binaries... just needs an actual tagged release to produce them
under the new name." Until CALM cuts that release, `curl ... install.sh | sh`
404s on every platform. The Setup Script below tries it first anyway (so
this repo needs zero changes once upstream fixes it) and falls back to
building from source when it fails.

### What to paste in

Open the environment settings dialog (cloud icon → environment selector →
settings icon) for the environment used to run sessions against this repo,
and paste this into the **Setup script** field:

```bash
#!/bin/bash
curl -fsSL https://raw.githubusercontent.com/Eilodon/CALM/main/scripts/install.sh | sh || true
export PATH="$HOME/.local/bin:$PATH"

# Fallback while the prebuilt release asset name is out of sync with the
# installer (see "Known gap" above) — clone and build from source instead.
if ! command -v calm >/dev/null 2>&1; then
  CALM_SRC="$(mktemp -d)"
  if git clone --depth 1 https://github.com/Eilodon/CALM.git "$CALM_SRC"; then
    (
      cd "$CALM_SRC"
      if command -v git-lfs >/dev/null 2>&1; then
        git lfs pull >/dev/null 2>&1 || true
      fi
      cargo build --release -p calm-cli --features embeddings,tier0-5,scip-overlay
    ) || true
    [ -x "$CALM_SRC/target/release/calm" ] && \
      mkdir -p "$HOME/.local/bin" && cp "$CALM_SRC/target/release/calm" "$HOME/.local/bin/calm"
  fi
  rm -rf "$CALM_SRC"
fi

if command -v rustup >/dev/null 2>&1; then
  rustup component add rust-analyzer || true
fi

if command -v calm >/dev/null 2>&1; then
  calm init  --project-root . || true
  calm index --project-root . || true
fi
```

**Why `|| true` on the risky steps:** a Setup Script that exits non-zero
prevents the whole session from starting. A failed calm install/build/index
here is recoverable (the MCP server just won't connect, or connects with a
cold index); a dead session is not. The from-source build adds a couple of
minutes the first time (well within the ~5 minute Setup Script budget) but
only runs when the fast installer fails, and its output is cached same as
everything else here.

Optional extra margin: add `MCP_TIMEOUT=120000` as an **environment
variable** (not a `.mcp.json` field) in the same settings dialog — raises
the MCP client's own initial connection timeout, mainly useful for the very
first session before any cache exists.

### Network access

The default **Trusted** network access level already allows everything this
needs: `github.com` / `raw.githubusercontent.com` / `release-assets.
githubusercontent.com` (the installer + release download) and `crates.io` /
`static.rust-lang.org` (rustup component install). No custom allowlist
changes needed unless this environment is set to **None** or a restrictive
**Custom** list.

### How to verify it worked

At the start of a session:

```
mcp__calm__repo_overview()
```

If this resolves (rather than the tool being entirely absent from the tool
list), the connection succeeded.

## Language coverage — what calm actually indexes here

calm's full AST + call-graph tier covers **TypeScript/JavaScript** (`src/`,
159 files) and **Rust** (`contracts-odra/`, `contracts-soroban/` — plus the
SCIP overlay via `rust-analyzer` upgrades these to type-checked "formal"
confidence), and Python (tooling scripts).

**Solidity (`contracts/*.sol`) and Circom (`circuits/*.circom`) are not
supported by calm at any tier.** Those files are only reachable through
`search(kind="grep")` (plain regex/glob over disk, no symbol index, no call
graph) — the same as any file the indexer doesn't parse (`.toml`, `.md`,
etc). Keep that in mind when asking an agent to trace something through the
Solidity contracts or ZK circuits: it'll need to fall back to grep-based
search and manual reading there, not `callers`/`callees`/`edit_context`.

## Local development

First connection on a machine without `calm` installed yet triggers
`script/calm-mcp-launcher.sh`'s self-install fallback (a checksum-verified
download from CALM's GitHub releases, same as the Setup Script above) — this
makes the very first `calm` tool call slower but requires no manual step,
**once the "Known gap" above is fixed upstream**. Until then that download
404s and the launcher just fails with an error pointing here — pre-install
by building from source instead (same fallback the Setup Script uses):

```bash
git clone --depth 1 https://github.com/Eilodon/CALM.git /tmp/CALM-src
cd /tmp/CALM-src && cargo build --release -p calm-cli --features embeddings,tier0-5,scip-overlay
mkdir -p ~/.local/bin && cp target/release/calm ~/.local/bin/calm
rustup component add rust-analyzer   # optional, upgrades Rust call edges to "formal"
```

Once CALM cuts a release with correctly-named assets, the one-liner below
starts working instead and this workaround is no longer needed:

```bash
curl -fsSL https://raw.githubusercontent.com/Eilodon/CALM/main/scripts/install.sh | sh
```
