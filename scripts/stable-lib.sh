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

# タグの状態 hook（hooks/ と scripts/hook.py）を、安定版の置き場（$3）の下に同じ相対位置で写す。
# fc-report.py は ../scripts/hook.py を世帯の名付けの案内に使うので、hook.py も写す。
# 写すのは2段に分ける。release-stable.sh は、安定版を止める前に stage_hooks を済ませ、だめなら何も触らずに中断する。
#   stage_hooks  <リポジトリ> <タグか ref> <置き場>   $3/hooks-incoming に取り出して構文を確かめる
#   commit_hooks <リポジトリ> <タグか ref> <置き場>   取り出した分を、ファイルごとに mv で置き換える
# ファイルごとに mv するのは、登録先のファイルが無い瞬間を作らないため。登録先が無いと python3 が 2 で終わり、
# PreToolUse の hook としては、この機械の全セッションの道具を止める扱いになる。
stage_hooks() {
  local repo="$1" ref="$2" dest="$3" tmp f
  tmp="$dest/hooks-incoming"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  git -C "$repo" archive "$ref" hooks scripts/hook.py | tar -x -C "$tmp" \
    || { echo "タグから hook を取り出せない: $ref" >&2; rm -rf "$tmp"; return 1; }
  [ -f "$tmp/hooks/fc-report.py" ] || { echo "タグに hooks/fc-report.py が無い: $ref" >&2; rm -rf "$tmp"; return 1; }
  for f in hooks/fc-report.py scripts/hook.py; do
    [ -f "$tmp/$f" ] || continue
    /usr/bin/python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$tmp/$f" \
      || { echo "構文が読めない: $ref:$f" >&2; rm -rf "$tmp"; return 1; }
  done
}

commit_hooks() {
  local repo="$1" ref="$2" dest="$3" tmp f
  tmp="$dest/hooks-incoming"
  [ -f "$tmp/hooks/fc-report.py" ] || { echo "取り出した hook が無い（先に stage_hooks を呼ぶ）" >&2; return 1; }
  (cd "$tmp" && find . -type f) | while read -r f; do
    f="${f#./}"
    mkdir -p "$dest/$(dirname "$f")"
    cp -p "$tmp/$f" "$dest/$f.incoming"
    mv -f "$dest/$f.incoming" "$dest/$f"
  done
  rm -rf "$tmp"
  echo "$ref $(git -C "$repo" rev-parse "$ref^{commit}")" > "$dest/hooks.ref"
  echo "状態 hook を写した: $ref -> $dest/hooks/"
}

install_hooks() {
  stage_hooks "$@" && commit_hooks "$@"
}
