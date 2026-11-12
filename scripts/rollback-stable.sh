#!/usr/bin/env bash
# Claude Town の安定版を1つ前の版に戻す。今の版と1つ前の版を入れ替えるので、もう一度回すと元に戻る。
#
#   scripts/rollback-stable.sh
#
# 1つ前の版は release-stable.sh が $CT_STABLE_HOME/previous/ に退避したもの。
# 動いている安定版は、入れ先の実行ファイルの pid だけを終わらせ、入れ替えた後に起動し直す。
# 環境変数は release-stable.sh と同じ（CT_DEST_DIR、CT_STABLE_HOME、CT_NO_OPEN）。
set -euo pipefail

APP_NAME="Claude Town"
DEST_DIR="${CT_DEST_DIR:-/Applications}"
STATE="${CT_STABLE_HOME:-$HOME/.family-computing/stable}"
DEST="$DEST_DIR/$APP_NAME.app"
PREV="$STATE/previous/$APP_NAME.app"
SWAP="$STATE/swap/$APP_NAME.app"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/stable-lib.sh"

[ -d "$PREV" ] || { echo "1つ前の版が無い: $PREV" >&2; exit 1; }

was_running=0
if [ -d "$DEST" ] && stop_stable "$DEST"; then was_running=1; fi

mkdir -p "$STATE/swap"
rm -rf "$SWAP"
if [ -d "$DEST" ]; then mv "$DEST" "$SWAP"; fi
mv "$PREV" "$DEST"
if [ -d "$SWAP" ]; then mv "$SWAP" "$PREV"; fi

cur="$(cat "$STATE/current.ref" 2>/dev/null || true)"
prev="$(cat "$STATE/previous.ref" 2>/dev/null || true)"
printf '%s\n' "$prev" > "$STATE/current.ref"
printf '%s\n' "$cur" > "$STATE/previous.ref"
echo "$(date '+%Y-%m-%d %H:%M:%S') rollback to ${prev:-不明} (was ${cur:-不明})" >> "$STATE/releases.log"
echo "戻した: いまの版 ${prev:-不明}、1つ前の版 ${cur:-不明}"

if [ "${CT_NO_OPEN:-0}" != 1 ]; then
  open "$DEST"
  echo "起動した（前に動いていた: ${was_running}）"
fi
