#!/bin/bash
# リリースの .app を起動してから、画面の JS が町の一覧を取りに来るまでの時間と、起動の10秒後のメモリを測る（#16）。
#   scripts/bench-startup.sh <ラベル> <.app のパス> [回数=5]
# - モックは scripts/mock-ccn-crowd.ts（承認待ち20体）。FC_CROWD_LOG=1 で受けた要求の時刻を出させ、
#   起動の直前の時刻から、最初の /api/sessions（一覧か SSE）の要求までを「起動から一覧の要求まで」とする
# - 窓が描かれたかは見ていない。本人が別の画面を使っていると窓は隠れるが、JS は動くので要求は来る
# - 書き込みは FC_APP_HOME の一時ディレクトリに分ける。ロックは ct-lock（開発版の計測と重ならないように）
# - 結果は1回1行の JSON を $OUT（既定 /tmp/ct-bench-startup.jsonl）に足す。1回は30秒で打ち切る
set -u
LABEL=$1; APP=$2; RUNS=${3:-5}; PORT=${PORT:-4395}
OUT=${OUT:-/tmp/ct-bench-startup.jsonl}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$HOME/.local/bin:/usr/sbin:$PATH"
BIN="$APP/Contents/MacOS/family-computing"
[ -x "$BIN" ] || { echo "$BIN が無い" >&2; exit 1; }
now() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }

HAVE=0
if [ "${CT_LOCK_HELD:-0}" != 1 ]; then ct-lock acquire ct-assets 10800 || exit 1; HAVE=1; fi
TMP=$(mktemp -d); MOCK=""; PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  [ -n "$MOCK" ] && kill "$MOCK" 2>/dev/null
  rm -rf "$TMP"
  [ $HAVE -eq 1 ] && ct-lock release ct-assets
}
trap cleanup EXIT

lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null && { echo "$PORT 番が使用中" >&2; exit 1; }
FC_CROWD_LOG=1 FC_CROWD_N=20 bun run "$ROOT/scripts/mock-ccn-crowd.ts" $PORT >"$TMP/mock.log" 2>&1 &
MOCK=$!
sleep 1
grep -q "pid=$MOCK" "$TMP/mock.log" || { echo "モックが立たなかった" >&2; exit 1; }

for r in $(seq 1 "$RUNS"); do
  : > "$TMP/mock.log"
  mkdir -p "$TMP/home$r"
  t0=$(now)
  FC_CCN_URL=http://127.0.0.1:$PORT FC_APP_HOME="$TMP/home$r" "$BIN" >"$TMP/app$r.log" 2>&1 &
  PID=$!
  first=""
  while [ -z "$first" ]; do
    [ $(( $(now) - t0 )) -gt 30000 ] && break
    first=$(awk '$1=="req" && $3 ~ /^\/api\/sessions/ {print $2; exit}' "$TMP/mock.log")
    sleep 0.02
  done
  sleep 10
  rss=$(( $(ps -o rss= -p $PID | tr -d ' ') / 1024 ))
  printf '{"label":"%s","run":%s,"toFirstListMs":%s,"rssAppMB":%s}\n' "$LABEL" "$r" "${first:+$((first - t0))}" "$rss" | sed 's/"toFirstListMs":,/"toFirstListMs":null,/' | tee -a "$OUT"
  kill $PID; wait $PID 2>/dev/null; PID=""
  sleep 2
done
