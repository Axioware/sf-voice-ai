#!/usr/bin/env bash
# Simulates a live call by playing agent and lead WAV files simultaneously.
#
# Each WAV is played to TWO destinations:
#   → real speakers   (so you can hear what's happening)
#   → virtual sink    (so the app captures and transcribes it)
#
# Usage:
#   ./scripts/run-test-call.sh          # plays all 3 pairs (full conversation)
#   ./scripts/run-test-call.sh 1        # plays only pair 1
#   ./scripts/run-test-call.sh 2        # plays only pair 2
#   ./scripts/run-test-call.sh 3        # plays only pair 3
#
# Prerequisites:
#   1. Run setup:  ./scripts/setup-virtual-mics.sh
#   2. In the app, go to Settings → Audio Device → select: virtual_lead.monitor
#   3. Start a call in the app, then run this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIO_DIR="$SCRIPT_DIR/../test-audio"

check_sink() {
  local name="$1"
  if ! pactl list sinks short 2>/dev/null | grep -qP "^\d+\t${name}\t"; then
    echo "ERROR: Sink '$name' not found. Run setup first:"
    echo "  ./scripts/setup-virtual-mics.sh"
    exit 1
  fi
}

check_sink "virtual_mic"
check_sink "virtual_lead"

play_pair() {
  local n="$1"
  local agent_wav="$AUDIO_DIR/agent${n}.wav"
  local lead_wav="$AUDIO_DIR/lead${n}.wav"

  if [[ ! -f "$agent_wav" || ! -f "$lead_wav" ]]; then
    echo "ERROR: Missing WAV files for pair $n. Run:"
    echo "  ./scripts/generate-test-audio.sh"
    exit 1
  fi

  echo "Playing pair $n..."
  echo "  Agent: $(basename "$agent_wav")"
  echo "  Lead : $(basename "$lead_wav")"

  # Lead speaks first, agent responds 1 second later (natural conversation flow)
  # Each audio goes to: (1) real speakers so you hear it, (2) virtual sink so app captures it
  paplay "$lead_wav" &                              # you hear lead
  paplay --device=virtual_lead "$lead_wav" &        # app captures lead

  sleep 1
  paplay "$agent_wav" &                             # you hear agent
  paplay --device=virtual_mic "$agent_wav" &        # app captures agent

  # Wait for all background paplay jobs to finish
  wait
  echo "  Pair $n done."
  echo ""
}

PAIR="${1:-}"

if [[ -n "$PAIR" ]]; then
  play_pair "$PAIR"
else
  echo "Running full conversation (3 pairs)..."
  echo ""
  for i in 1 2 3; do
    play_pair "$i"
    [[ $i -lt 3 ]] && sleep 2
  done
  echo "Full test conversation complete."
fi
