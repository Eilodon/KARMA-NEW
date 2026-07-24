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
5. **No secret to set.** `fly.toml` runs `MCP_AUTH_MODE = "none"` — the endpoint really is
   unauthenticated, matching the README's "No signup, no payment, one call." An earlier version of
   this config used `MCP_AUTH_MODE = "api_key"` with a `flyctl secrets set MCP_API_KEY=...` step;
   that 401'd every real caller (including OKX.AI's own review — there's no field in ASP
   registration to hand it a key), so it's gone. If you fork this for a tool that *does* need auth,
   switch back to `api_key`/`jwt`/`oidc_jwks` — `none` is only safe when every tool in
   `MCP_PLUGIN_ALLOWLIST` has zero `requiredScopes` (see `src/security/context.ts`'s
   `resolvePublicRequestContext`), which is true here since this deploy only serves
   `get_cross_chain_trust_score` + the system tool.
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

**Confirmed live:** `https://karma-trust-oracle.fly.dev/health/liveness` returns
`{"status":"alive","version":"1.0.0"}`, and `/.well-known/mcp-server-card` lists
`get_cross_chain_trust_score` correctly.

**Known gap, fixed in code but not yet redeployed:** the machine currently running still has the
old `MCP_AUTH_MODE = "api_key"` config baked in — `curl -X POST .../mcp -d
'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` returns `401 {"error":"Unauthorized"}` until
someone with `flyctl` access runs `flyctl deploy` again to pick up this file's current
`MCP_AUTH_MODE = "none"`. **Do this before registering the ASP** — OKX's review will call the tool
directly, and a "free" listing that 401s isn't reviewable.

## If the health check never goes green

Two non-obvious platform-specific fixes are already baked into this config/codebase — if you're
retracing this on a fork or a different app, here's why they're needed:

1. **Bind `HTTP_HOST` to `"::"`, not `"0.0.0.0"`.** Fly machines are reachable over private IPv6
   (6PN) as their primary network — a machine typically has no private IPv4 address at all
   (`flyctl machine list` shows only an `fdaa:...` address). Node's `net.Server` binds IPv4-only on
   `"0.0.0.0"`, so Fly's health checker connecting over IPv6 gets `connect: connection refused` even
   though the app is up and reachable via IPv4 loopback. `"::"` binds dual-stack on Linux by
   default, covering both — already set in `fly.toml`.
2. **`createMcpExpressApp()` needs `{ host: ENV.HTTP_HOST }` passed explicitly.** Called with no
   options, the `@modelcontextprotocol/express` SDK defaults `host` to `"127.0.0.1"` and — since
   that's on its localhost list — silently adds its own DNS-rebinding-protection middleware that
   403s any request whose Host header isn't literally `localhost`/`127.0.0.1`/`::1`. This runs
   *before* every route KARMA registers (including `/health/liveness`), independent of and earlier
   than KARMA's own `isAllowedHost`/`ALLOWED_HOSTS` check — so no amount of fixing KARMA's own Host
   allowlist helps until this is fixed too. Already fixed in `src/index.ts`
   (`createMcpExpressApp({ host: ENV.HTTP_HOST })`); if you're seeing `403` (not `connection
   refused`) from `flyctl ssh console` + `wget` against the machine's own private IPv6 address, this
   is almost certainly why.

Diagnosing this took `flyctl ssh console` + manual `wget` calls against 127.0.0.1 vs. the machine's
own `fdaa:...` address to tell "app isn't running" apart from "app is running but something in front
of it is rejecting the request" — `flyctl checks list`'s cached status can go stale/stuck for a long
time after a failed deploy and stop reflecting reality, so don't trust it alone once you're this deep
into debugging; re-verify directly.

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
- `min_machines_running = 1` without `auto_stop_machines` off would normally create a second
  standby machine for HA on top of the primary — both currently run for the ~$2-4/month range
  quoted above; drop to a single machine (`flyctl machine list`, then `flyctl machine destroy` the
  extra one) if you'd rather minimize cost over redundancy for a free demo tool.
