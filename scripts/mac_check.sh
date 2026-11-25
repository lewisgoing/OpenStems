#!/bin/bash
# What a Mac says about OpenStems, in one file to send back.
#
#   bash mac_check.sh SONG            the engine the installed app set up
#   bash mac_check.sh SONG ENGINE     another engine, e.g. engine/.venv/bin/openstems
#
# It runs the doctor, the light self-test, one model on the GPU against the CPU, a timed
# full-song separation of SONG on Fast, a timed every-stem run, and shows what a Mac with
# 8 GB would be told. Stems go to a temporary folder that is removed at the end. Nothing is
# sent anywhere: the report is a text file on the Desktop.
#
# A step that fails does not stop the rest: its error is part of the report.

SONG="$1"
ENGINE="${2:-$HOME/Library/Application Support/OpenStems/engine-env/bin/openstems}"
REPORT="$HOME/Desktop/openstems-mac-check.txt"

if [ "$(uname)" != "Darwin" ]; then echo "This script is for a Mac."; exit 2; fi
if [ -z "$SONG" ] || [ ! -f "$SONG" ]; then echo "Usage: bash mac_check.sh SONG [ENGINE]   (SONG is an audio file)"; exit 2; fi
if [ ! -x "$ENGINE" ]; then echo "No engine at: $ENGINE"; echo "Open OpenStems once and let it finish its setup, then run this again."; exit 2; fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
export NO_COLOR=1 COLUMNS=120 PYTHONUTF8=1

section() { printf '\n===== %s =====\n' "$1" | tee -a "$REPORT"; }

# Run a command, keep what it prints, and say how long it took and how it ended.
step() {
  local title="$1"; shift
  section "$title"
  local start=$SECONDS
  "$@" >>"$REPORT" 2>&1
  local code=$?
  printf '[exit %s, %s s]\n' "$code" "$((SECONDS - start))" | tee -a "$REPORT"
}

: >"$REPORT"
section "machine"
{
  date
  sw_vers
  sysctl -n machdep.cpu.brand_string
  echo "memory: $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
  echo "engine: $ENGINE"
} >>"$REPORT" 2>&1

section "song"
# Only its length and format: the file's name and tags stay out of the report.
afinfo "$SONG" 2>&1 | grep -E "estimated duration|Data format" >>"$REPORT"

step "doctor" "$ENGINE" doctor
step "self-test, operations only" "$ENGINE" selftest --ops-only
step "models here" "$ENGINE" models list
step "self-test, one model on the GPU against the CPU" "$ENGINE" selftest -m bs-roformer-sw
step "full-song on Fast (the time above the stems is the whole run)" \
  "$ENGINE" separate "$SONG" --recipe full-song --quality fast --force --out "$OUT/full-song"
step "full-song again, model already on disk cache" \
  "$ENGINE" separate "$SONG" --recipe full-song --quality fast --force --out "$OUT/full-song-2"
step "every-stem on Fast (needs its four models; an error here lists what is missing)" \
  "$ENGINE" separate "$SONG" --recipe every-stem --quality fast --force --out "$OUT/every-stem"
step "the stems written" find "$OUT" -type f \( -name '*.wav' -o -name '*.flac' -o -name '*.mp3' \) -exec ls -l {} \;

export OPENSTEMS_MEMORY_GB=8
step "doctor, as a Mac with 8 GB" "$ENGINE" doctor
step "models, as a Mac with 8 GB" "$ENGINE" models list
unset OPENSTEMS_MEMORY_GB

section "engine log, last lines"
tail -n 40 "$HOME/Library/Logs/OpenStems/engine.log" >>"$REPORT" 2>&1
section "app log, last lines"
tail -n 40 "$HOME/Library/Logs/OpenStems/app.log" >>"$REPORT" 2>&1

# The stems' folder names carry the song's name: keep the report free of it.
NAME="$(basename "$SONG")"
NAME="${NAME%.*}"
if [ -n "$NAME" ]; then sed -i '' "s|$NAME|SONG|g" "$REPORT" 2>/dev/null; fi

echo
echo "Done. The report is on the Desktop: $REPORT"
