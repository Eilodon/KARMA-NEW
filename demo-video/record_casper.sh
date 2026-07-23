#!/usr/bin/env bash
# Capture the Casper courtroom/lifecycle/governance demo segments to asciinema .cast files.
# Each segment is a real run of one of the demo_casper_*.ts scripts in src/scripts/ — real
# transactions on the live governance-hardened contract, not a scripted recording.
#
#   demo-video/record_casper.sh                       # all three segments
#   demo-video/record_casper.sh lifecycle              # just one (good for testing/re-takes)
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config_casper.sh"

export REC_COLS="${REC_COLS:-110}" REC_ROWS="${REC_ROWS:-32}"
PTYREC=("python3" "$DV/lib/ptyrec.py")

# segment -> "timeout|command"  (command runs in $KARMA_ROOT via $SHELL -c)
declare -A SEG=(
  [lifecycle]="240|pnpm exec tsx src/scripts/demo_casper_full_job_lifecycle.ts"
  [courtroom]="360|pnpm exec tsx src/scripts/demo_casper_courtroom.ts"
  [governance]="180|pnpm exec tsx src/scripts/demo_casper_cross_chain_rep_governance.ts"
)
ORDER=(lifecycle courtroom governance)
SEGMENTS=("$@"); [ ${#SEGMENTS[@]} -eq 0 ] && SEGMENTS=("${ORDER[@]}")

capture() {
  local name="$1" spec timeout cmd out
  spec="${SEG[$name]:-}"; [ -z "$spec" ] && { echo "unknown segment: $name"; return 2; }
  IFS='|' read -r timeout cmd <<<"$spec"
  out="$CAST_DIR/$name.cast"
  echo ">>> capture [$name]  (pty ${REC_COLS}x${REC_ROWS}, timeout ${timeout}s)"
  if timeout -k 5 "$timeout" \
       "${PTYREC[@]}" "$ASCIINEMA" rec -q --overwrite \
       -c "cd '$KARMA_ROOT' && $cmd" "$out"; then
    echo "OK    $name → $out"
    return 0
  fi
  echo "FAIL  $name"
  return 1
}

rc=0
for s in "${SEGMENTS[@]}"; do
  capture "$s" || rc=$?
done
echo "capture done (rc=$rc)"
exit "$rc"
