#!/usr/bin/env bash
#
# Run both arms of one model, back to back, with a clean baseline before each.
#
# Sequential rather than parallel: the governed arm mutates the shared CMS, so
# two concurrent runs would contaminate each other's baseline.
#
# Usage: bash scripts/run-pair.sh <model-id>

set -uo pipefail
MODEL="${1:?usage: run-pair.sh <model-id>}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

stamp() { date '+%H:%M:%S'; }

# The raw arm never touches the CMS, so it runs first — if anything is wrong
# with the harness, we find out without having burned a CMS reset.
echo "[$(stamp)] === RAW ARM ==="
npm run bench --silent -- --model "$MODEL" --arm raw
RAW=$?
echo "[$(stamp)] raw arm exit=$RAW"

echo
echo "[$(stamp)] === resetting baseline before governed arm ==="
npm run reset --silent || { echo "reset FAILED — not starting governed arm"; exit 1; }

echo
echo "[$(stamp)] === GOVERNED ARM ==="
npm run bench --silent -- --model "$MODEL" --arm governed
GOV=$?
echo "[$(stamp)] governed arm exit=$GOV"

echo
echo "[$(stamp)] === PAIR COMPLETE — raw=$RAW governed=$GOV ==="
