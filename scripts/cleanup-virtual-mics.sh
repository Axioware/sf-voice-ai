#!/usr/bin/env bash
# Removes virtual PulseAudio sinks created by setup-virtual-mics.sh

set -euo pipefail

remove_module() {
  local type="$1" name="$2"
  local mod_id
  mod_id=$(pactl list "${type}s" 2>/dev/null | awk "/Name: ${name}/{found=1} found && /Owner Module:/{print \$3; exit}")
  if [[ -n "$mod_id" ]]; then
    pactl unload-module "$mod_id" 2>/dev/null && echo "  [REMOVED] $type: $name"
  else
    echo "  [SKIP] $type not found: $name"
  fi
}

echo "Cleaning up virtual audio devices..."
remove_module "source" "virtual_mic"     # in case old virtual-source still exists
remove_module "sink"   "virtual_mic"
remove_module "sink"   "virtual_lead"
remove_module "sink"   "agent_sink"      # old name cleanup
remove_module "sink"   "lead_speaker_sink"
echo "Done."
