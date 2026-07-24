# Deploying KARMA's free trust-oracle endpoint on Fly.io

This exposes `get_cross_chain_trust_score` (`src/plugins/trust_oracle.tool.ts`) over public HTTPS
on Fly.io — the endpoint OKX.AI's A2MCP ASP listing needs
(`.claude/skills/okx-ai/references/identity-register.md` requires a real, publicly reachable
`https://` URL). It does **not** enable `karma.tool.ts` (skill economy), the full on-chain indexer
backfill, or Redis — the trust oracle reads chain state directly per call and needs none of that.
For the full production stack, see [docs/RUNTIME.md](../../docs/RUNTIME.md) instead.

The config is `fly.toml` at the **repo root** (Fly's own convention — it must sit next to the
Dockerfile it builds, unlike Render's Blueprint which can point at a nested path).

## Not free, but no card-verification/capacity headaches

Fly.io dropped its free tier in 2024 — signup needs a real credit card, and an always-on
`shared-cpu-1x-256mb` machine runs roughly **$2/month**, billed by actual usage. In exchange you
get an explicit, debuggable config instead of a platform guessing at your port: `fly.toml` declares
`internal_port = 3333` and the exact health check path directly — no auto-detection black box like
the two issues hit on Render (port mismatch, then the health check window getting starved by the
on-chain indexer's genesis backfill). This config already has both of those fixes baked in from the
start.

## What you do by hand

1. **Sign up at [fly.io](https://fly.io)** (needs a card; the trial covers a couple hours of usage
   before billing kicks in for what you keep running).
2. **Install `flyctl`** (Fly's CLI) on your machine:
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```
3. **Log in:**
   ```bash
   flyctl auth login
   ```
4. **Check the app name is available.** `fly.toml` currently has `app = "karma-trust-oracle"` —
   Fly app names are globally unique across *all* Fly users, so this may already be taken. From the
   repo root:
   ```bash
   flyctl apps create karma-trust-oracle
   ```
   If it says the name's taken, pick another (e.g. `karma-trust-oracle-<yourname>`), then edit
   `fly.toml`: update `app = "..."` **and** `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` under `[env]` to
   match `<your-app-name>.fly.dev` — KARMA's HTTP layer 403s any request whose Host header isn't on
   that allowlist (`src/index.ts`'s `isAllowedHost`), so these three must always agree.
5. **Set the API key secret** (never put this in `fly.toml` — it's committed to the repo):
   ```bash
   flyctl secrets set MCP_API_KEY=$(openssl rand -hex 32)
   ```
6. **Deploy** from the repo root:
   ```bash
   flyctl deploy
   ```
   `flyctl` streams the build and deploy logs live in your terminal — you'll see the health check
   result directly, no dashboard hunting required.
7. **Verify:**
   ```bash
   curl https://karma-trust-oracle.fly.dev/health/liveness
   ```
   (swap in your actual app name if you had to rename it).

That URL is what goes into the OKX.AI ASP registration endpoint field.

## Refreshing `KARMA_INDEXER_FROM_BLOCK`

The pinned block number goes stale over time (harmlessly — it just means slightly more history gets
backfilled on next deploy, not a full genesis scan). Refresh it before a redeploy if you want:

```bash
curl -s -X POST https://atlantic.dplabs-internal.com \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
# result is hex, e.g. "0x19a17e1" -> printf "%d\n" 0x19a17e1
```

Update the value in `fly.toml`, then `flyctl deploy` again.

## Operational notes

- `min_machines_running = 1` in `fly.toml` keeps one machine always on (no cold starts) — that's
  most of the ~$2/month cost. To cut cost further and accept cold starts instead (similar trade-off
  to Render's free tier), set `auto_stop_machines = "stop"` and `min_machines_running = 0`.
- Redeploy after any change: `flyctl deploy` from the repo root.
- Logs: `flyctl logs`.
- Status: `flyctl status`.
- This intentionally skips Redis/JWT/production hardening (`docs/RUNTIME.md` production section) —
  fine for a read-only, unauthenticated-by-design demo tool with rate limiting on, not appropriate
  if you later add `karma.tool.ts` (which moves real value and needs the full posture).

## If you'd rather I drive the deploy directly

`flyctl` supports a scoped API token (`flyctl tokens create deploy`, or `flyctl auth token` for a
full-access one) via the `FLY_API_TOKEN` env var, instead of an interactive login. If you'd rather
hand me that than paste logs back and forth like we did on Render, I can run `flyctl deploy`/`flyctl
logs` myself from here. It's more scoped than SSH/root access (revocable anytime from the Fly
dashboard, API-only, no shell on the machine) — entirely your call.
