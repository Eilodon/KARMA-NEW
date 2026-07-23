#!/usr/bin/env bash
# Deploy AgentSkillRegistry to X Layer (OKX's EVM L2) — testnet by default.
#
# Same contract, same Deploy.s.sol used for Pharos (script/Deploy.s.sol is chain-agnostic;
# only --rpc-url and the funded deployer key change). Needs `forge` on PATH and a funded
# PRIVATE_KEY — whether that's available to the agent running this depends on the sandbox
# (an earlier session couldn't install Foundry because GitHub release-API egress was
# policy-blocked there; that's not universal — check `forge --version` before assuming a
# human has to run this). Either way, funding the deployer key from a faucet is a human step
# (captcha/account-gated); once funded, this script can be run by whoever holds the key.
#
# Usage:
#   1. cast wallet new                      # generate a fresh deployer key, or reuse one
#   2. Fund that address with testnet OKB:  https://web3.okx.com/xlayer/faucet
#   3. PRIVATE_KEY=0x... ./script/deploy_xlayer.sh testnet
#   4. Copy the printed contract address into XLAYER_CONTRACT_ADDRESS in .env
#
# For mainnet (real OKB, real submission — only once the testnet flow is proven):
#   PRIVATE_KEY=0x... ./script/deploy_xlayer.sh mainnet
set -euo pipefail

NETWORK="${1:-testnet}"
if [ "$NETWORK" = "testnet" ]; then
  RPC_URL="${XLAYER_RPC_URL:-https://testrpc.xlayer.tech}"
  CHAIN_ID=1952
elif [ "$NETWORK" = "mainnet" ]; then
  RPC_URL="${XLAYER_RPC_URL:-https://rpc.xlayer.tech}"
  CHAIN_ID=196
else
  echo "usage: $0 [testnet|mainnet]" >&2
  exit 1
fi

if [ -z "${PRIVATE_KEY:-}" ]; then
  echo "PRIVATE_KEY is not set. Generate one with 'cast wallet new', fund it on $NETWORK, then re-run." >&2
  exit 1
fi

echo "Deploying AgentSkillRegistry to X Layer $NETWORK (chainId $CHAIN_ID) via $RPC_URL ..."
forge script script/Deploy.s.sol \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --chain-id "$CHAIN_ID"

echo
echo "Next: copy the deployed address above into .env as XLAYER_CONTRACT_ADDRESS"
echo "(and XLAYER_RPC_URL/XLAYER_CHAIN_ID if you overrode the defaults)."
