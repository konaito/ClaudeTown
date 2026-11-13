#!/bin/bash
# public/sprites/ninja の PNG から、色のプロファイル（iCCP、どれも 3144 バイトの sRGB）などの描画に使わない chunk を外す（#16）。
# 画素は変えない。外した後に元と画素を比べ、1枚でも違えば元に戻して止まる。
# WebKit はプロファイルの無い画像を sRGB として描くので、見た目は変わらない。
#   scripts/strip-sprites.sh
# 要るもの: ImageMagick（magick）
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
before=0; after=0; n=0
while IFS= read -r f; do
  cp "$f" "$TMP/orig.png"
  magick "$TMP/orig.png" -strip -define png:compression-level=9 PNG32:"$TMP/new.png"
  diff=$(magick compare -metric AE "$TMP/orig.png" "$TMP/new.png" null: 2>&1 || true)
  if [ "${diff%% *}" != "0" ]; then echo "$f: 画素が変わった（$diff）。止める" >&2; exit 1; fi
  b=$(wc -c < "$TMP/orig.png"); a=$(wc -c < "$TMP/new.png")
  if [ "$a" -lt "$b" ]; then cp "$TMP/new.png" "$f"; else a=$b; fi
  before=$((before + b)); after=$((after + a)); n=$((n + 1))
done < <(find "$ROOT/public/sprites/ninja" -name '*.png')
echo "${n}枚: ${before} → ${after} バイト"
