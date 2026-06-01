#!/bin/bash
# Download fonts needed for render_icon.py
set -e
DIR="$(dirname "$0")/fonts"
mkdir -p "$DIR"

# Playfair Display variable font (supports wght axis 400–900)
curl -sL "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf" \
  -o "$DIR/PlayfairDisplay-VF.ttf"
echo "Downloaded PlayfairDisplay-VF.ttf"

# Inter Light (for SEAN / HYMAN name text)
# From the official Inter v4.0 release
TMP=$(mktemp -d)
curl -sL "https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip" -o "$TMP/inter.zip"
unzip -o "$TMP/inter.zip" "extras/ttf/Inter-Light.ttf" -d "$TMP"
mv "$TMP/extras/ttf/Inter-Light.ttf" "$DIR/Inter-Light.ttf"
rm -rf "$TMP"
echo "Downloaded Inter-Light.ttf"

echo "Fonts ready in $DIR"
