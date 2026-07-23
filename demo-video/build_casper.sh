#!/usr/bin/env bash
# One-command KARMA-on-Casper demo video builder — the Casper-track sibling of build.sh.
# No preflight budget gate: unlike Pharos's faucet-limited Alpha/Beta wallets, the Casper
# governance-signer wallets used here are amply funded (thousands of testnet CSPR).
#
#   demo-video/build_casper.sh                # full live build
#   demo-video/build_casper.sh --skip-capture  # reuse existing .cast captures, just re-assemble
#   demo-video/build_casper.sh --skip-tts      # reuse existing narration
#   demo-video/build_casper.sh --skip-shot     # skip explorer screenshots
#
# Pipeline: capture(asciinema, real Casper tx) → render(agg+ffmpeg) → extract tx hashes
#           → shoot(testnet.cspr.live) → narrate(edge-tts) → manifest → assemble(remotion)
#           → out_casper/final-casper.mp4
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source ./config_casper.sh

SKIP_CAPTURE=0; SKIP_TTS=0; SKIP_SHOT=0
for a in "$@"; do case "$a" in
  --skip-capture) SKIP_CAPTURE=1 ;;
  --skip-tts) SKIP_TTS=1 ;;
  --skip-shot) SKIP_SHOT=1 ;;
  *) echo "unknown flag: $a"; exit 2 ;;
esac; done

hr() { printf '\n\033[36m── %s ─────────────────────────────────────────\033[0m\n' "$1"; }

if [ "$SKIP_CAPTURE" = "0" ]; then
  hr "1/6 capture (real Casper transactions)"
  ./record_casper.sh lifecycle courtroom governance || true
else echo "(skip capture — reusing $CAST_DIR)"; fi

hr "2/6 render terminal clips"
./render_casts_casper.sh || true

hr "3/6 extract real tx hashes from captures"
node ./extract_casper_txs.mjs || true

if [ "$SKIP_SHOT" = "0" ]; then
  hr "4/6 explorer screenshots (testnet.cspr.live)"
  EXPLORER="$EXPLORER" SHOTS_DIR="$SHOTS_DIR" DEMO_JSON_FILE="$OUT/demo_json.json" \
  CONTRACT="${CASPER_CONTRACT_HASH:-}" CHROME="$CHROME" \
    node ./remotion/scripts/shoot-explorer-casper.mjs || true
fi

if [ "$SKIP_TTS" = "0" ] && { [ ! -f "$OUT/narration.json" ] || [ "$DV/narration/script_casper.json" -nt "$OUT/narration.json" ]; }; then
  hr "5/6 narration (edge-tts + loudnorm)"
  SCRIPT_JSON="$DV/narration/script_casper.json" AUDIO_DIR="$AUDIO_DIR" \
  NARRATION_OUT="$OUT/narration.json" TTS_VOICE="$TTS_VOICE" \
    "$VENV/bin/python" "$DV/narration/tts.py" || true
else echo "(narration up to date — $OUT/narration.json)"; fi

hr "6/6 manifest + Remotion render"
OUT="$OUT" REMOTION="$REMOTION" EXPLORER="$EXPLORER" CONTRACT="${CASPER_CONTRACT_HASH:-}" FPS="$FPS" \
  node ./manifest_casper.mjs

( cd "$REMOTION" && npx remotion render KarmaDemo "out/final-casper.mp4" \
    --browser-executable="$CHROME" --concurrency=2 --log=error ) || { echo "Remotion render failed"; exit 1; }

FINAL="$REMOTION/out/final-casper.mp4"
cp -f "$FINAL" "$OUT/final-casper.mp4" 2>/dev/null || true
hr "done"
echo "🎬  $OUT/final-casper.mp4"
ffprobe -v error -show_entries format=duration:stream=width,height -of default=noprint_wrappers=1 "$OUT/final-casper.mp4" 2>/dev/null
exit 0
