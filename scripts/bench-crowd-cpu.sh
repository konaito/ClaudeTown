#!/bin/bash
# 町に同じ状態のキャラを大勢並べ、開発版の待機中の CPU 時間と RSS を測る（#7）。
#   scripts/bench-crowd-cpu.sh <ラベル> <人数> <state> [回数]
#   例: scripts/bench-crowd-cpu.sh before 20 waiting_permission 3
# 結果は 1回1行の JSON を $OUT（既定 /tmp/ct-bench-crowd.jsonl）に足す。
# - 開発版は 1420 番を全員で使うので、ct-lock（来た順に /tmp/ct-dev.lock と /tmp/claudetown-dev.lock を渡す）で取ってから起動する
# - 書き込みは FC_APP_HOME の一時ディレクトリに分ける。モックは scripts/mock-ccn-crowd.ts（PTY を起こさない）
# - 窓が裏にあると WebKit が描画を止めるので FC_BENCH_TOP=1 で最前面に出す
#   ただし、本人がフルスクリーンの別の画面を使っていると最前面にしても隠れ、CPU が0に近くなる（2026-11-13 に起きた）。
#   結果の PNG（/tmp/ct-bench-crowd-*.png）で窓が見えていたかを必ず確かめる。見えないときは scripts/bench-crowd-webkit.ts で比べる
# - WebContent と GPU は起動前後の pid の差分で自分の分を特定する。安定版の分は数えない
# - 1回の起動は10分で打ち切る。止めるのは自分が起動したプロセス（pid）だけ
set -u
LABEL=$1; N=$2; STATE=$3; RUNS=${4:-3}
WIN=${WIN:-30}; WARM=${WARM:-20}; PORT=${PORT:-4396}
OUT=${OUT:-/tmp/ct-bench-crowd.jsonl}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/usr/sbin:$PATH"

secs() { # ps の time（[[H:]M]M:SS.ss）を秒に
  awk -F: '{ if (NF==3) print $1*3600+$2*60+$3; else if (NF==2) print $1*60+$2; else print $1 }' <<<"$1"
}
cpu() { secs "$(ps -o time= -p "$1" 2>/dev/null | tr -d ' ')"; }
rss() { ps -o rss= -p "$1" 2>/dev/null | tr -d ' '; }
pids_of() { pgrep -f "$1" | sort; }
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }

# ロック。来た順に渡す ~/.local/bin/ct-lock で取る（/tmp/ct-dev.lock → /tmp/claudetown-dev.lock）。
# CT_LOCK_HELD=1 なら、呼び手がもう持っているとみなして取らない（何通りかを続けて測るとき）
HAVE=0
if [ "${CT_LOCK_HELD:-0}" != 1 ]; then
  ct-lock acquire ct-assets 10800 || exit 1
  HAVE=1
fi

MOCK=""; DEV=""; APP=""; VITE=""; HOMEDIR=$(mktemp -d)
cleanup() {
  for p in $APP $VITE; do kill "$p" 2>/dev/null; done
  if [ -n "$DEV" ]; then pkill -P "$DEV" 2>/dev/null; kill "$DEV" 2>/dev/null; fi
  [ -n "$MOCK" ] && kill "$MOCK" 2>/dev/null
  sleep 1
  rm -rf "$HOMEDIR"
  [ $HAVE -eq 1 ] && ct-lock release ct-assets
}
trap cleanup EXIT

lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null && { echo "$PORT 番が使用中" >&2; exit 1; }
lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null && { echo "1420 番が使用中（ロックの外で誰かが使っている）" >&2; exit 1; }
FC_CROWD_N=$N FC_CROWD_STATE=$STATE bun run "$ROOT/scripts/mock-ccn-crowd.ts" $PORT >"$HOMEDIR/mock.log" 2>&1 &
MOCK=$!
sleep 1
grep -q "pid=$MOCK" "$HOMEDIR/mock.log" || { echo "モックが立たなかった: $(cat "$HOMEDIR/mock.log")" >&2; exit 1; }

WC0=$(pids_of com.apple.WebKit.WebContent); GPU0=$(pids_of com.apple.WebKit.GPU); APP0=$(pids_of target/debug/family-computing)
cd "$ROOT"
FC_BENCH_TOP=1 FC_CCN_URL=http://127.0.0.1:$PORT FC_APP_HOME="$HOMEDIR" bun tauri dev >"$HOMEDIR/dev.log" 2>&1 &
DEV=$!
DEADLINE=$(( $(date +%s) + 600 ))
# 本体（cwd が この作業ツリーの src-tauri の target/debug/family-computing で、起動前にいなかったもの）が出るまで待つ
while [ -z "$APP" ]; do
  [ $(date +%s) -ge $DEADLINE ] && { echo "起動しなかった" >&2; tail -20 "$HOMEDIR/dev.log" >&2; exit 1; }
  sleep 1
  for p in $(comm -13 <(echo "$APP0") <(pids_of target/debug/family-computing)); do
    [ "$(cwd_of $p)" = "$ROOT/src-tauri" ] && APP=$p
  done
done
VITE=$(lsof -nP -iTCP:1420 -sTCP:LISTEN -t 2>/dev/null | head -1)
[ -n "$VITE" ] && [ "$(cwd_of $VITE)" != "$ROOT" ] && VITE=""
sleep "$WARM"
WC=$(comm -13 <(echo "$WC0") <(pids_of com.apple.WebKit.WebContent) | tr '\n' ' ')
GPU=$(comm -13 <(echo "$GPU0") <(pids_of com.apple.WebKit.GPU) | tr '\n' ' ')
[ -z "$WC" ] && { echo "自分の WebContent が見つからない" >&2; exit 1; }
echo "app=$APP vite=$VITE webcontent=$WC gpu=$GPU" >&2
screencapture -x "/tmp/ct-bench-crowd-$LABEL-$N-$STATE.png"

sum() { local s=0; for p in $1; do s=$(awk -v a=$s -v b="$(cpu $p)" 'BEGIN{print a+b}'); done; echo $s; }
for r in $(seq 1 "$RUNS"); do
  [ $(( $(date +%s) + WIN )) -ge $DEADLINE ] && { echo "10分の締切で打ち切った" >&2; break; }
  a_wc=$(sum "$WC"); a_gpu=$(sum "$GPU"); a_app=$(cpu $APP)
  sleep "$WIN"
  b_wc=$(sum "$WC"); b_gpu=$(sum "$GPU"); b_app=$(cpu $APP)
  rss_wc=0; for p in $WC; do rss_wc=$((rss_wc + $(rss $p))); done
  printf '{"label":"%s","n":%s,"state":"%s","run":%s,"win":%s,"webcontent":%.2f,"gpu":%.2f,"app":%.2f,"rssWebContentMB":%d,"rssAppMB":%d}\n' \
    "$LABEL" "$N" "$STATE" "$r" "$WIN" \
    "$(awk -v a=$a_wc -v b=$b_wc 'BEGIN{print b-a}')" "$(awk -v a=$a_gpu -v b=$b_gpu 'BEGIN{print b-a}')" "$(awk -v a=$a_app -v b=$b_app 'BEGIN{print b-a}')" \
    $((rss_wc / 1024)) $(( $(rss $APP) / 1024 )) | tee -a "$OUT"
done
