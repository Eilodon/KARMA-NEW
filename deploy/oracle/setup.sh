#!/usr/bin/env bash
# KARMA — one-shot deploy of the free get_cross_chain_trust_score endpoint on an
# Oracle Cloud Always Free VM. See deploy/oracle/README.md for the manual OCI-console
# prerequisites (account, VM, Security List 80/443) this script assumes are already done.
#
# Usage (run on the VM, over SSH):
#   PUBLIC_IP=<your-vm-public-ip> ./setup.sh
set -euo pipefail

PUBLIC_IP="${PUBLIC_IP:?Usage: PUBLIC_IP=<your-vm-public-ip> ./setup.sh}"
REPO_URL="${REPO_URL:-https://github.com/Eilodon/KARMA-NEW.git}"
APP_DIR="${APP_DIR:-$HOME/karma-new}"
PUBLIC_HOST="$(echo "$PUBLIC_IP" | tr '.' '-').sslip.io"

echo "==> Public endpoint will be: https://${PUBLIC_HOST}"

echo "==> Installing Docker..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi

echo "==> Opening OS-level firewall for 80/443 (separate from the OCI Security List)..."
if command -v firewall-cmd >/dev/null 2>&1; then
  sudo firewall-cmd --permanent --add-port=80/tcp
  sudo firewall-cmd --permanent --add-port=443/tcp
  sudo firewall-cmd --reload
elif command -v iptables >/dev/null 2>&1; then
  sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
  sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save 2>/dev/null || (sudo mkdir -p /etc/iptables && sudo iptables-save | sudo tee /etc/iptables/rules.v4 >/dev/null) || true
fi

echo "==> Fetching KARMA source..."
if [ ! -d "$APP_DIR" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi

DEPLOY_DIR="$APP_DIR/deploy/oracle"
cd "$DEPLOY_DIR"

if [ ! -f .env ]; then
  echo "==> Generating .env with fresh secrets..."
  MCP_API_KEY="$(openssl rand -hex 32)"
  # MCP_SAFE_MODE=false + PHAROS_CONTRACT_ADDRESS auto-starts the on-chain skill indexer, which
  # get_cross_chain_trust_score doesn't need (it reads chain state live per call). Left at its
  # default of 0, it backfills from genesis -- tens of millions of blocks, thousands of RPC
  # calls -- burning CPU/network for no benefit here. Pin it to the current head instead.
  PHAROS_HEAD_HEX="$(curl -fsS -X POST https://atlantic.dplabs-internal.com -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
  KARMA_INDEXER_FROM_BLOCK="$([ -n "$PHAROS_HEAD_HEX" ] && printf "%d" "$PHAROS_HEAD_HEX" || echo 0)"
  cat > .env <<EOF
PUBLIC_HOST=${PUBLIC_HOST}

NODE_ENV=development
TRANSPORT_DRIVER=http
HTTP_HOST=0.0.0.0
HTTP_PORT=3333
STORAGE_DRIVER=fs
TELEMETRY_DRIVER=stdout
MCP_PROJECT_ID=KARMA
MCP_TENANT_ID=tenant_public

MCP_AUTH_MODE=api_key
MCP_API_KEY=${MCP_API_KEY}

ALLOWED_HOSTS=${PUBLIC_HOST}
ALLOWED_ORIGINS=https://${PUBLIC_HOST}

MCP_SAFE_MODE=false
MCP_PLUGIN_ISOLATION_MODE=policy
MCP_PLUGIN_ALLOWLIST=system.tool.js,trust_oracle.tool.js

ENABLE_RATE_LIMIT=true
RATE_LIMIT_MAX_REQUESTS=60
RATE_LIMIT_WINDOW_MS=60000
ENABLE_QUOTA=true
QUOTA_DAILY_LIMIT=2000

PHAROS_RPC_URL=https://atlantic.dplabs-internal.com
PHAROS_CHAIN_ID=688689
PHAROS_CONTRACT_ADDRESS=0xc6d5c146209e0833634bd33fafb9e65081b905ae
KARMA_INDEXER_FROM_BLOCK=${KARMA_INDEXER_FROM_BLOCK}

XLAYER_RPC_URL=https://testrpc.xlayer.tech
XLAYER_CHAIN_ID=1952
XLAYER_CONTRACT_ADDRESS=0xBF285628869c2EFaf6731F8503B39B7130474Cd2
EOF
  echo "==> MCP_API_KEY generated (also saved in .env): ${MCP_API_KEY}"
else
  echo "==> .env already exists, leaving it as-is."
fi

echo "==> Building and starting containers (this pulls/builds the image, can take a few minutes)..."
sudo docker compose up -d --build

echo "==> Waiting for the app to come up..."
sleep 5
if curl -fsS "http://127.0.0.1:3333/health/liveness" >/dev/null 2>&1; then
  echo "==> Local health check OK."
else
  echo "==> WARNING: local health check failed. Check: sudo docker compose logs -f mcp-server"
fi

cat <<EOF

Done. Public endpoint (Caddy needs ~30-60s on the very first request to issue the TLS cert):

  https://${PUBLIC_HOST}/mcp
  https://${PUBLIC_HOST}/health/liveness

Verify from your own machine (not this VM):
  curl https://${PUBLIC_HOST}/health/liveness
EOF
