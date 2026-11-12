# release-stable.sh と rollback-stable.sh が読む共通の関数。単体では動かさない。

# 入れ先の .app の実行ファイルを、絶対パスの完全一致で探して pid を出す。
# 名前（"Claude Town" や family-computing）では探さない。開発版のバイナリや、claude のセッションの引数にも同じ文字列が入るため。
stable_pids() {
  local app exe
  # ps は実体のパスを出す（/tmp は /private/tmp になる）ので、リンクを解いたパスで比べる
  app="$(cd "$1" && pwd -P)"
  exe="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$app/Contents/Info.plist")"
  ps -axo pid=,comm= | while read -r pid comm; do
    [ "$comm" = "$exe" ] && echo "$pid"
  done
  return 0
}

# 入れ先の安定版が動いていれば終わらせる。終わらせたら 0、動いていなければ 1 を返す。
stop_stable() {
  local app="$1" pids pid i
  pids="$(stable_pids "$app")"
  [ -n "$pids" ] || return 1
  for pid in $pids; do
    echo "安定版を終わらせる: pid $pid"
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in $pids; do
    for i in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "10秒で終わらなかったので強制終了する: pid $pid"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  return 0
}
