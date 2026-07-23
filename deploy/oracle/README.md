# Deploying KARMA's free trust-oracle endpoint on Oracle Cloud Always Free

This folder is a minimal, self-contained deploy for exposing `get_cross_chain_trust_score`
(`src/plugins/trust_oracle.tool.ts`) over public HTTPS from an Oracle Cloud Always Free VM — the
tool OKX.AI's A2MCP ASP listing needs a real `https://` endpoint for
(`.claude/skills/okx-ai/references/identity-register.md`). It does **not** enable the full KARMA
skill economy (`karma.tool.ts`), the on-chain indexer, or Redis — `get_cross_chain_trust_score`
reads chain state directly per call and needs none of that. See the main
[docs/RUNTIME.md](../../docs/RUNTIME.md) if you later want the full production stack instead.

## What you do by hand (Oracle Cloud Console — no shell access needed for this part)

1. **Create the account.** Needs a real credit/debit card (Visa/Mastercard/Amex-branded, not
   prepaid/virtual) — Oracle only places a temporary verification hold, it does not charge you
   unless you explicitly upgrade.
2. **Create the VM.** Always Free → Ampere A1 (ARM), e.g. 1 OCPU / 6 GB, Ubuntu image. Pick
   **Frankfurt (`eu-frankfurt-1`)** or **Singapore (`ap-singapore-1`)** as the region — these
   provision fast; US regions frequently return "Out of host capacity" for A1 shapes. If you hit
   that error, just retry, switch availability domain, or switch region.
3. **Open the firewall — Security List / NSG.** In the VM's subnet, add two ingress rules:
   `0.0.0.0/0` → TCP port `80`, and `0.0.0.0/0` → TCP port `443`. This step is easy to miss because
   it's separate from creating the VM itself, and it's the #1 reason people can't reach their
   Oracle box afterward.
4. **Note the VM's public IP** (shown on the instance detail page) and, if you're doing steps 4-6
   yourself, note SSH access (Oracle's default `ubuntu` user + the key pair you downloaded/created
   at VM creation).

Everything else — installing Docker, the OS-level firewall (a *second*, separate firewall Oracle's
images ship with on top of the Security List), cloning the repo, generating secrets, getting a
real HTTPS cert, and starting the server — is automated by `setup.sh` below.

## What `setup.sh` automates

- Installs Docker + Compose plugin (idempotent, skips if already installed).
- Opens the OS-level firewall (`firewalld` on Oracle Linux, `iptables` on Ubuntu) for 80/443 — the
  layer *underneath* the Security List that people forget about.
- Clones this repo (or pulls if already present).
- Generates `.env` with a fresh `MCP_API_KEY` and the minimal config to run just the free trust
  oracle tool (`system.tool.js,trust_oracle.tool.js`, `MCP_SAFE_MODE=false`,
  `MCP_PLUGIN_ISOLATION_MODE=policy` — same three settings the README's "Try it" quickstart uses),
  plus the already-deployed `PHAROS_CONTRACT_ADDRESS` / `XLAYER_CONTRACT_ADDRESS` from the main
  README's live-deployments table.
- Derives a public hostname from your VM's IP via [sslip.io](https://sslip.io) (a wildcard DNS
  service that resolves `<ip-with-dashes>.sslip.io` straight to that IP — no domain purchase, no
  DNS account needed).
- Starts `mcp-server` + `caddy` via `docker compose`. Caddy terminates TLS and gets a real Let's
  Encrypt certificate for the sslip.io hostname automatically, with no manual cert steps.

## Running it

SSH into the VM, then:

```bash
curl -fsSL https://raw.githubusercontent.com/Eilodon/KARMA-NEW/main/deploy/oracle/setup.sh -o setup.sh
chmod +x setup.sh
PUBLIC_IP=<your-vm-public-ip> ./setup.sh
```

(Or `git clone` the repo yourself and run `deploy/oracle/setup.sh` directly — the script clones
itself if `$APP_DIR` doesn't already exist, so either path works.)

At the end it prints your public endpoint, e.g.:

```
https://140-1-2-3.sslip.io/mcp
https://140-1-2-3.sslip.io/health/liveness
```

Give Caddy 30-60s on the very first request while it issues the certificate. Verify from your own
machine (not the VM) once it's up:

```bash
curl https://140-1-2-3.sslip.io/health/liveness
```

That URL is what goes into the OKX.AI ASP registration's endpoint field.

## Operational notes

- `MCP_API_KEY` is generated fresh into `.env` on first run and printed once at the end — save it.
  Whether callers need to send it depends on how you want the "free tool" framed: keep it and share
  it in the ASP listing description for a light abuse-deterrent, or if OKX's A2MCP gateway is
  expected to call it with its own auth layer in front, this is the value to give them.
- Both containers run with `restart: unless-stopped`; a VM reboot brings everything back without
  re-running `setup.sh`.
- Redeploying after a `git pull`: `cd deploy/oracle && sudo docker compose up -d --build`.
- Logs: `sudo docker compose logs -f mcp-server`.
- This intentionally skips Redis/JWT/production hardening (`docs/RUNTIME.md` production section) —
  fine for a read-only, unauthenticated-by-design demo tool with rate limiting on, not appropriate
  if you later add `karma.tool.ts` (which moves real value and needs the full posture).
