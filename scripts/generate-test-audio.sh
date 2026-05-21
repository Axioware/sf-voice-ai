#!/usr/bin/env bash
# Generates test WAV files for 3 agents and 3 leads using espeak TTS.
# Output: test-audio/agent{1,2,3}.wav and test-audio/lead{1,2,3}.wav
# Format: 16-bit PCM, mono, 16000 Hz (matches what parec captures)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../test-audio"
mkdir -p "$OUT_DIR"

speak() {
  local text="$1" voice="$2" speed="$3" pitch="$4" outfile="$5"
  local tmp
  tmp=$(mktemp --suffix=.wav)
  espeak -v "$voice" -s "$speed" -p "$pitch" -a 180 "$text" -w "$tmp" 2>/dev/null
  # Convert to 16kHz mono 16-bit PCM (what parec expects)
  sox "$tmp" -r 16000 -c 1 -b 16 "$outfile" 2>/dev/null
  rm -f "$tmp"
  echo "  Generated: $(basename "$outfile")"
}

echo "Generating agent WAV files..."

speak \
  "Hi there, this is Sarah calling from TechSolutions. I noticed your company has been growing quickly, and I wanted to share how our CRM platform has helped similar businesses scale their sales process. Do you have just a few minutes to chat?" \
  "en+f3" 155 55 "$OUT_DIR/agent1.wav"

speak \
  "That is a great question. Our platform actually costs about forty percent less than Salesforce, and it includes built-in AI features that automatically surface your best opportunities. The best part is setup takes under a day, not weeks like the competition." \
  "en+f1" 158 52 "$OUT_DIR/agent2.wav"

speak \
  "I completely understand that budget is a concern right now. We offer flexible monthly plans starting at just ninety-nine dollars per user per month. And we can get you started with a free thirty-day trial with absolutely no credit card required. Would that work for your team?" \
  "en+m3" 150 46 "$OUT_DIR/agent3.wav"

echo "Generating lead WAV files..."

speak \
  "Sure, I have a few minutes. We have actually been evaluating CRM systems lately. Our current one is getting pretty expensive and the reporting is clunky. What makes your platform different from Salesforce or HubSpot?" \
  "en+m1" 162 48 "$OUT_DIR/lead1.wav"

speak \
  "That does sound interesting, but honestly budget is really tight this quarter. We had some unexpected infrastructure costs come up. What kind of pricing are we looking at, and is there any flexibility on the contract length?" \
  "en+m4" 148 44 "$OUT_DIR/lead2.wav"

speak \
  "Okay, that actually sounds more reasonable than I expected. Can you send over a detailed proposal? I would need to review it with my manager and probably our IT team before we could move forward with anything." \
  "en+f2" 155 58 "$OUT_DIR/lead3.wav"

echo ""
echo "Done! Generated 6 WAV files in test-audio/:"
ls -lh "$OUT_DIR"/*.wav
