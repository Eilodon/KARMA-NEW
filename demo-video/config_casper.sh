#!/usr/bin/env bash
# Casper-track variant of config.sh — same pipeline (asciinema+agg+ffmpeg+edge-tts+Remotion),
# different chain facts. Kept separate from config.sh so the original Pharos submission video
# stays reproducible untouched; sourced instead of it by the *_casper.sh scripts.
# NO SECRETS HERE (safe to commit). Secrets: none needed — no faucet-limited wallet on this track,
# CASPER_GOV_SIGNER_*_SECRET_HEX in the repo .env is reused directly.

KARMA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DV="$KARMA_ROOT/demo-video"
VENV="$DV/.venv"
ASCIINEMA="$VENV/bin/asciinema"
EDGE_TTS="$VENV/bin/edge-tts"
AGG="$DV/bin/agg"
OUT="$DV/out_casper"
CAST_DIR="$OUT/cast"
CLIPS_DIR="$OUT/clips"
AUDIO_DIR="$OUT/audio"
SHOTS_DIR="$OUT/shots"
REMOTION="$DV/remotion"

EXPLORER="https://testnet.cspr.live"
CHROME="/usr/bin/google-chrome"

FPS=30
AGG_THEME="${AGG_THEME:-dracula}"
AGG_FONT_SIZE="${AGG_FONT_SIZE:-28}"
AGG_IDLE_LIMIT="${AGG_IDLE_LIMIT:-2}"
AGG_SPEED="${AGG_SPEED:-1}"
TTS_VOICE="${TTS_VOICE:-en-US-GuyNeural}"

# Pull CASPER_RPC_URL / CASPER_CONTRACT_HASH / CASPER_GOV_SIGNER_*_SECRET_HEX from the repo .env.
if [ -f "$KARMA_ROOT/.env" ]; then
  set -a; # shellcheck disable=SC1091
  . "$KARMA_ROOT/.env" 2>/dev/null || true
  set +a
fi

mkdir -p "$CAST_DIR" "$CLIPS_DIR" "$AUDIO_DIR" "$SHOTS_DIR"
