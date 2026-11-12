#!/usr/bin/env bash
# 開発版（Claude Town Dev）のアイコンを、安定版のアイコン src-tauri/icons/icon.png に橙の「DEV」の帯を重ねて作る。
# 元の画像は変えない。出力は src-tauri/icons-dev/（tauri.conf.json の bundle.icon が指す）。
# アイコンを作り直したら、このスクリプトも回してコミットする。要るもの: ImageMagick（magick）、bun。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=src-tauri/icons/icon.png
OUT=src-tauri/icons-dev
FONT=/System/Library/Fonts/Helvetica.ttc
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

[ -f "$SRC" ] || { echo "元のアイコンが無い: $SRC" >&2; exit 1; }

# 512px の元画像に、下寄りの帯（y=350〜440）を重ね、元画像の不透明な部分（角丸の正方形）で切り抜く
magick "$SRC" -resize 512x512 "$TMP/base.png"
magick -size 512x512 xc:none -fill '#E8590C' -draw 'rectangle 0,350 512,440' \
  -font "$FONT" -weight Bold -pointsize 78 -fill white -gravity north -annotate +0+353 'DEV' \
  "$TMP/band.png"
magick "$TMP/band.png" "$TMP/base.png" -compose DstIn -composite "$TMP/band-clipped.png"
magick "$TMP/base.png" "$TMP/band-clipped.png" -compose Over -composite "$TMP/dev-icon.png"

rm -rf "$OUT"
bunx tauri icon "$TMP/dev-icon.png" -o "$OUT" >/dev/null
# macOS 用に要るものだけ残す（tauri.conf.json の bundle.icon と、dev で使う icon.png）
find "$OUT" -mindepth 1 ! -name '32x32.png' ! -name '128x128.png' ! -name '128x128@2x.png' \
  ! -name 'icon.png' ! -name 'icon.icns' ! -name 'icon.ico' -exec rm -rf {} +
ls "$OUT"
