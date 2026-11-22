#!/usr/bin/env bash
# 開発版を同じ置き場所で2つ起動し、2つ目が窓を作らずに終わるか、台帳（terminals.json）が書き換わらないかを確かめる（#176）。
#
#   scripts/check-single-instance.sh [実行ファイル]   既定は src-tauri/target/debug/family-computing
#
# 開発版は既定では2つ目を止めない（子が並列で起動するため）。止める動きを確かめるときは FC_SINGLE_INSTANCE=1 を付けて回す。
#   FC_SINGLE_INSTANCE=1 scripts/check-single-instance.sh
# 前提: 先に `(cd src-tauri && cargo build)` で開発版を組んでおく。1420 番は ct-lock を取ってから回す
#   （画面の Vite は立てない。立っていると、その画面が2つの開発版につながる）。
# 置き場所はすべて一時のディレクトリに分ける。本物の claude は起動しない。止めるのは自分が起動した pid だけ。
# 終了コード: 0 は「2つ目が終わり、台帳がそのまま」。1 はそれ以外。
set -u
repo="$(cd "$(dirname "$0")/.." && pwd)"
bin="${1:-$repo/src-tauri/target/debug/family-computing}"
[ -x "$bin" ] || { echo "実行ファイルが無い: $bin" >&2; exit 2; }
sock="/tmp/jp_fybe_family_computing_dev_si.sock"
if [ "${FC_SINGLE_INSTANCE:-}" = 1 ] && [ -S "$sock" ] && python3 -c "import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1])" "$sock" 2>/dev/null; then
  echo "ほかの開発版が $sock を持っている。止めずに中断する" >&2
  exit 2
fi

t="$(mktemp -d /tmp/fc-si.XXXXXX)"
mkdir -p "$t/app" "$t/claude" "$t/state"
export FC_APP_HOME="$t/app" FC_CLAUDE_HOME="$t/claude" FC_STATE_DIR="$t/state" FC_LETTERS="$t/letters.jsonl"

# 窓の数（画面の層 0 の窓）。swiftc が無ければ数えない
wc_bin=""
if command -v swiftc >/dev/null; then
  cat > "$t/wincount.swift" <<'EOF'
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
print(list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && (($0[kCGWindowLayer as String] as? Int) ?? 1) == 0 }.count)
EOF
  swiftc -O -o "$t/wincount" "$t/wincount.swift" 2>/dev/null && wc_bin="$t/wincount"
fi
windows() { [ -n "$wc_bin" ] && "$wc_bin" "$1" || echo "?"; }

pid1="" pid2=""
cleanup() {
  for p in $pid2 $pid1; do kill -TERM "$p" 2>/dev/null; done
  for p in $pid2 $pid1; do wait "$p" 2>/dev/null; done
}
trap cleanup EXIT

"$bin" >"$t/first.log" 2>&1 &
pid1=$!
sleep 5
kill -0 "$pid1" 2>/dev/null || { echo "1つ目が起動しなかった（$t/first.log）" >&2; exit 2; }
echo "1つ目: pid ${pid1}、窓 $(windows "$pid1")"

# 1つ目が開いている端末の代わりに、台帳に1件を書く（jsonl が無い id なので、2つ目が立て直しを走らせると外して書き直す）
id="$(uuidgen | tr 'A-Z' 'a-z')"
printf '{"version":1,"terminals":[{"id":"%s","cwd":"%s","cols":120,"rows":40,"startedAt":1}]}\n' "$id" "$t" > "$t/app/terminals.json"
before="$(shasum "$t/app/terminals.json" | cut -d' ' -f1)"

"$bin" >"$t/second.log" 2>&1 &
pid2=$!
code=""
for _ in $(seq 1 100); do
  if ! kill -0 "$pid2" 2>/dev/null; then wait "$pid2"; code=$?; break; fi
  sleep 0.2
done
if [ -z "$code" ]; then
  echo "2つ目: 20秒たっても動いている（pid ${pid2}、窓 $(windows "$pid2")）"
else
  echo "2つ目: 終了コード $code で終わった"
  pid2=""
fi
# 2つ目が終わったあとも、少し待ってから台帳を見る
sleep 3
after="$(shasum "$t/app/terminals.json" | cut -d' ' -f1)"
echo "台帳: 前 ${before}、後 $after"
echo "台帳の中身: $(tr -d '\n ' < "$t/app/terminals.json")"
kill -0 "$pid1" 2>/dev/null && echo "1つ目: まだ動いている" || echo "1つ目: 止まっていた"
echo "ログ: $t/first.log $t/second.log"

if [ "$code" = 0 ] && [ "$before" = "$after" ]; then
  echo "OK"
  exit 0
fi
echo "FAIL"
exit 1
