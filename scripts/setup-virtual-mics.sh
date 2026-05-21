#!/usr/bin/env bash
# Sets up PulseAudio virtual audio devices for testing without a physical mic.
#
# Creates:
#   virtual_mic        → null sink; play agent WAV here
#   virtual_mic.monitor → app's _getDefaultMic() auto-detects this as agent source
#   virtual_lead       → null sink; play lead WAV here
#   virtual_lead.monitor → select this in app Settings → Audio Device

set -euo pipefail

remove_if_exists() {
  local type="$1" name="$2"
  local mod_id
  mod_id=$(pactl list "${type}s" 2>/dev/null | awk "/Name: ${name}/{found=1} found && /Owner Module:/{print \$3; exit}")
  if [[ -n "$mod_id" ]]; then
    pactl unload-module "$mod_id" 2>/dev/null && echo "  [REMOVED] old $type: $name"
  fi
}

ensure_null_sink() {
  local name="$1" desc="$2"
  if pactl list sinks short 2>/dev/null | grep -qP "^\d+\t${name}\t"; then
    echo "  [OK] Sink already exists: $name"
  else
    pactl load-module module-null-sink \
      "sink_name=${name}" \
      "sink_properties=device.description=\"${desc}\"" >/dev/null
    echo "  [CREATED] Sink: $name → source: ${name}.monitor"
  fi
}

echo "Cleaning up any broken virtual devices..."
# Remove the broken module-virtual-source chain if present
remove_if_exists "source" "virtual_mic"    # broken virtual-source type
remove_if_exists "sink"   "agent_sink"     # old null-sink backing it

echo ""
echo "Setting up virtual audio devices..."
ensure_null_sink "virtual_mic"  "Virtual-Mic-Agent-Sink"
ensure_null_sink "virtual_lead" "Virtual-Lead-Speaker-Sink"

echo ""
echo "Current sources:"
pactl list sources short 2>/dev/null | grep -E "(virtual_mic|virtual_lead)"
echo ""
echo "Next steps:"
echo "  1. Open the app → Settings → Audio Device"
echo "     Select: virtual_lead.monitor"
echo ""
echo "  2. Run the test call:"
echo "     ./scripts/run-test-call.sh"
