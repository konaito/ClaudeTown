#!/bin/bash
# 状態の印などに使う Noto Animated Emoji を、表示の大きさに合わせて縮めたアニメ WebP を作る（#7）。
#   scripts/make-noto-small.sh            public/sprites/noto/<cp>/64.webp を作り直す
# 配布元の 512.webp を一時ディレクトリに取り、全コマを重ねて（coalesce）64px に縮める。
# コマは2枚に1枚を残し、残したコマの長さに間引いたコマの長さを足す（1周の長さは元と同じ）。
# 要るもの: curl、ImageMagick（magick）、libwebp（webpmux、img2webp）
set -euo pipefail
SIZE=${SIZE:-64}; Q=${Q:-80}; STEP=${STEP:-2}
CPS=(270b 1f97a 2705 1f47b 1f48c)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

for cp in "${CPS[@]}"; do
  src="$TMP/$cp.webp"
  curl -fsSL "https://fonts.gstatic.com/s/e/notoemoji/latest/$cp/512.webp" -o "$src"
  durs=($(webpmux -info "$src" | awk '$1 ~ /^[0-9]+:$/ {print $7}'))
  [ ${#durs[@]} -gt 0 ] || { echo "$cp: コマの長さが読めない" >&2; exit 1; }
  mkdir "$TMP/$cp"
  magick "$src" -coalesce -resize ${SIZE}x${SIZE} "$TMP/$cp/%03d.png"
  n=$(ls "$TMP/$cp" | wc -l | tr -d ' ')
  [ "$n" -eq ${#durs[@]} ] || { echo "$cp: コマの数（$n）と長さの数（${#durs[@]}）が合わない" >&2; exit 1; }
  args=(); total=0; out=0
  for ((i = 0; i < n; i += STEP)); do
    d=0; for ((j = i; j < i + STEP && j < n; j++)); do d=$((d + durs[j])); done
    args+=(-d "$d" "$TMP/$cp/$(printf %03d $i).png"); out=$((out + d))
  done
  for d in "${durs[@]}"; do total=$((total + d)); done
  [ "$out" -eq "$total" ] || { echo "$cp: 1周の長さが変わった（$total → $out）" >&2; exit 1; }
  mkdir -p "$ROOT/public/sprites/noto/$cp"
  img2webp -loop 0 -min_size -lossy -q "$Q" -m 6 "${args[@]}" -o "$ROOT/public/sprites/noto/$cp/$SIZE.webp" >/dev/null
  echo "$cp: ${n}コマ → $(( (n + STEP - 1) / STEP ))コマ、1周 ${total}ms、$(wc -c < "$ROOT/public/sprites/noto/$cp/$SIZE.webp" | tr -d ' ') bytes"
done
