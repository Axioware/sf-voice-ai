#!/usr/bin/env bash
# Downloads a static Windows ffmpeg.exe build into assets/bin/
# Run this once before `npm run build:win`
set -euo pipefail

DEST="assets/bin/ffmpeg.exe"
ZIP="/tmp/ffmpeg-win.zip"
URL="https://github.com/BtbN/ffmpeg-builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip"

if [ -f "$DEST" ]; then
  echo "✓ $DEST already exists — skipping download"
  exit 0
fi

mkdir -p assets/bin

echo "→ Downloading ffmpeg Windows build (~90 MB)..."
curl -L --progress-bar "$URL" -o "$ZIP"

echo "→ Extracting ffmpeg.exe..."
unzip -j "$ZIP" "*/bin/ffmpeg.exe" -d assets/bin/

rm "$ZIP"
echo "✓ Done: $DEST ($(du -h "$DEST" | cut -f1))"
