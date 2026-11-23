#!/usr/bin/env bash
# release-stable.sh、rollback-stable.sh、install-stable-hooks.sh の試験（#172）。
#
#   scripts/test-stable-scripts.sh            このスクリプトの隣のスクリプトを試す
#   scripts/test-stable-scripts.sh <dir>      <dir> にあるスクリプトを試す
#
# 本物の安定版には触らない。
# - スクリプトを一時のリポジトリに写し、そこから動かす（スクリプトは自分の置き場所のリポジトリを使う）
# - CT_DEST_DIR、CT_STABLE_HOME、CT_BUILD_WORKTREE、CT_TARGET_DIR と HOME を全部 mktemp -d の下に向け、CT_NO_OPEN=1 を付ける
# - tauri build は偽の bunx に替える。偽の bunx は渡された --config を控え、安定版の値の .app を作るだけにする
set -uo pipefail

SRC="${1:-$(cd "$(dirname "$0")" && pwd)}"
root="$(mktemp -d)"
trap 'chmod -R u+w "$root" 2>/dev/null; rm -rf "$root"' EXIT
failed=0
ok() { echo "ok   $1"; }
ng() { echo "FAIL $1"; failed=1; }

# --- 偽の bun と bunx ---
bin="$root/bin"
mkdir -p "$bin"
cat > "$bin/bun" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$bin/bunx" <<'EOF'
#!/bin/sh
# 渡された --config の中身を控え、安定版の値の .app を作る
: > "$FAKE_LOG"
prev=""
for a in "$@"; do
  echo "arg $a" >> "$FAKE_LOG"
  if [ "$prev" = "--config" ]; then echo "config $a" >> "$FAKE_LOG"; cat "$a" >> "$FAKE_LOG"; fi
  prev="$a"
done
app="$CARGO_TARGET_DIR/release/bundle/macos/Claude Town.app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>jp.fybe.family-computing</string>
<key>CFBundleName</key><string>Claude Town</string>
<key>CFBundleExecutable</key><string>fake-claude-town-172</string>
</dict></plist>
PL
exit 0
EOF
chmod +x "$bin/bun" "$bin/bunx"
TEST_PATH="$bin:$PATH"
for c in bun bunx; do
  got="$(PATH="$TEST_PATH" command -v "$c")"
  [ "$got" = "$bin/$c" ] || { echo "偽の $c が先頭にない（${got}）。中断する" >&2; exit 1; }
done

# --- 一時のリポジトリ ---
# origin の feat/app-v1 は2つ目のコミット、ローカルの feat/app-v1 は1つ目のコミットのまま（上流より古い）にする
git init -q --bare "$root/origin.git"
git clone -q "$root/origin.git" "$root/repo" 2>/dev/null
repo="$root/repo"
g() { git -C "$repo" "$@"; }
g config user.email test@example.invalid
g config user.name test
g config commit.gpgsign false
g config tag.gpgsign false
g checkout -q -b feat/app-v1
mkdir -p "$repo/scripts" "$repo/hooks" "$repo/src-tauri"
for f in release-stable.sh rollback-stable.sh install-stable-hooks.sh stable-lib.sh; do
  cp "$SRC/$f" "$repo/scripts/$f"
done
echo 'print("v1")' > "$repo/hooks/fc-report.py"
echo 'print("hook")' > "$repo/scripts/hook.py"
echo '{"from": "v1"}' > "$repo/src-tauri/tauri.stable.conf.json"
g add -A && g commit -q -m v1
v1="$(g rev-parse HEAD)"
echo 'print("v2")' > "$repo/hooks/fc-report.py"
echo '{"from": "v2"}' > "$repo/src-tauri/tauri.stable.conf.json"
g commit -q -am v2
v2="$(g rev-parse HEAD)"
g push -q -u origin feat/app-v1 2>/dev/null
g reset -q --hard "$v1"
# 作業ツリーの上書き設定は、タグのどれとも違う中身にしておく
echo '{"from": "checkout"}' > "$repo/src-tauri/tauri.stable.conf.json"

run() { # run <名前> <スクリプト> [引数...]  出力は $root/<名前>.out、終了コードは $root/<名前>.rc
  local name="$1" script="$2"; shift 2
  env HOME="$root/home" PATH="$TEST_PATH" FAKE_LOG="$root/$name.bunx" \
    CT_DEST_DIR="$root/dest" CT_STABLE_HOME="$root/stable" \
    CT_BUILD_WORKTREE="$root/wt" CT_TARGET_DIR="$root/target" CT_NO_OPEN=1 \
    bash "$repo/scripts/$script" "$@" > "$root/$name.out" 2>&1
  echo $? > "$root/$name.rc"
}
rc() { cat "$root/$1.rc"; }
drop_tags() { g tag -l 'stable-*' | while read -r t; do g tag -d "$t" >/dev/null; done; }
mkdir -p "$root/home"

# 1. 上流より古いローカルのブランチを渡すと、タグを打たずに止まる
run stale release-stable.sh feat/app-v1
if [ "$(rc stale)" != 0 ] && [ -z "$(g tag -l 'stable-*')" ] && [ ! -e "$root/stale.bunx" ]; then
  ok "上流より古いローカルのブランチでは、タグを打たずに止まる"
else
  ng "上流より古いローカルのブランチでも進んだ（終了 $(rc stale)、タグ: $(g tag -l 'stable-*' | tr '\n' ' ')）"
  sed 's/^/     /' "$root/stale.out"
fi
drop_tags

# 2. 上書き設定は、上げる版（タグ）のものを読む
run fresh release-stable.sh origin/feat/app-v1
if [ "$(rc fresh)" = 0 ] && grep -q '"from": "v2"' "$root/fresh.bunx" 2>/dev/null; then
  ok "上書き設定をタグの中身（v2）から読む"
else
  ng "上書き設定をタグから読んでいない（終了 $(rc fresh)）"
  sed 's/^/     /' "$root/fresh.out" "$root/fresh.bunx" 2>/dev/null
fi
if [ "$(cat "$root/stable/hooks.ref" 2>/dev/null | cut -d' ' -f2)" = "$v2" ] \
  && grep -q v2 "$root/stable/hooks/fc-report.py" 2>/dev/null \
  && [ -d "$root/dest/Claude Town.app" ]; then
  ok "上げると .app が入れ先に入り、hook と hooks.ref が v2 になる"
else
  ng "上げた後の .app か hook か hooks.ref が違う（hooks.ref: $(cat "$root/stable/hooks.ref" 2>/dev/null)）"
fi
drop_tags

# 3. 上流に追いついたローカルのブランチなら止めない
g merge -q --ff-only "origin/feat/app-v1" 2>/dev/null || { g checkout -q -- . && g merge -q --ff-only "origin/feat/app-v1"; }
run synced release-stable.sh feat/app-v1
if [ "$(rc synced)" = 0 ]; then
  ok "上流に追いついたローカルのブランチなら上げる"
else
  ng "上流に追いついたローカルのブランチで止まった（終了 $(rc synced)）"
  sed 's/^/     /' "$root/synced.out"
fi
drop_tags

# 4. commit_hooks が写せなかったら、release-stable.sh と同じ呼び方（|| の左）でも失敗を返し、hooks.ref を書かない
d="$root/lib"
mkdir -p "$d/hooks"
(
  set -euo pipefail
  . "$repo/scripts/stable-lib.sh"
  stage_hooks "$repo" "$v2" "$d" >/dev/null
  chmod 555 "$d/hooks"
  commit_hooks "$repo" "$v2" "$d" >/dev/null 2>&1 || echo CAUGHT
) > "$root/lib.out" 2>&1
chmod 755 "$d/hooks"
if grep -q CAUGHT "$root/lib.out" && [ ! -e "$d/hooks.ref" ]; then
  ok "commit_hooks は || の左でも、写せなければ失敗を返し hooks.ref を書かない"
else
  ng "commit_hooks が写せないのに成功を返したか、hooks.ref を書いた（hooks.ref: $(cat "$d/hooks.ref" 2>/dev/null)）"
fi

# 5. install-stable-hooks.sh も、写せなければ 0 以外で終わり hooks.ref を書かない
s5="$root/stable5"
mkdir -p "$s5/hooks"
chmod 555 "$s5/hooks"
env HOME="$root/home" CT_STABLE_HOME="$s5" bash "$repo/scripts/install-stable-hooks.sh" "$v2" > "$root/install.out" 2>&1
install_rc=$?
chmod 755 "$s5/hooks"
if [ "$install_rc" != 0 ] && [ ! -e "$s5/hooks.ref" ] && grep -q "Permission denied" "$root/install.out"; then
  ok "install-stable-hooks.sh は写せなければ 0 以外（${install_rc}）で終わり、hooks.ref を書かない"
else
  ng "install-stable-hooks.sh が写せないのに終了 ${install_rc}、hooks.ref: $(cat "$s5/hooks.ref" 2>/dev/null)"
fi

# 6. release-stable.sh で hook を写せなければ、.app は入れたうえで知らせ、0 以外で終わる
g tag -a stable-t6 -m t6 "$v2"
chmod 555 "$root/stable/hooks"
run relro release-stable.sh stable-t6
chmod 755 "$root/stable/hooks"
if [ "$(rc relro)" != 0 ] && grep -q "状態 hook を写せなかった" "$root/relro.out" && ! grep -q "状態 hook を写した" "$root/relro.out" \
  && grep -q "^入れた: " "$root/relro.out" && grep -q " release stable-t6 " "$root/stable/releases.log" \
  && grep -q " hooks-failed stable-t6 " "$root/stable/releases.log"; then
  ok "release-stable.sh は hook を写せなければ知らせて 0 以外（$(rc relro)）で終わる"
else
  ng "release-stable.sh が hook を写せないのに終了 $(rc relro)"
  sed 's/^/     /' "$root/relro.out"
fi
drop_tags

# 7. 上書き設定の無い ref は、タグを打たずに止まる
g checkout -q --detach "$v2"
g rm -q src-tauri/tauri.stable.conf.json
g commit -q -m noconf
noconf="$(g rev-parse HEAD)"
g checkout -q feat/app-v1
run noconf release-stable.sh "$noconf"
if [ "$(rc noconf)" != 0 ] && [ -z "$(g tag --points-at "$noconf")" ] && [ ! -e "$root/noconf.bunx" ]; then
  ok "上書き設定の無い ref では、タグを打たずに止まる"
else
  ng "上書き設定の無い ref で進んだ（終了 $(rc noconf)）"
  sed 's/^/     /' "$root/noconf.out"
fi

# 8. rollback-stable.sh も、hook を写せなければ 0 以外で終わる
# 戻した先のタグは previous.ref から読むので、ここで残っているタグを書いておく
g tag -a stable-t7 -m t7 "$v1"
echo "stable-t7 $v1" > "$root/stable/previous.ref"
chmod 555 "$root/stable/hooks"
run rbro rollback-stable.sh
chmod 755 "$root/stable/hooks"
if [ "$(rc rbro)" != 0 ] && grep -q "状態 hook を写し直せなかった" "$root/rbro.out" && [ -d "$root/dest/Claude Town.app" ]; then
  ok "rollback-stable.sh は hook を写せなければ知らせて 0 以外（$(rc rbro)）で終わる"
else
  ng "rollback-stable.sh が hook を写せないのに終了 $(rc rbro)"
  sed 's/^/     /' "$root/rbro.out"
fi

[ "$failed" = 0 ] && echo "全部通った" || echo "落ちた試験がある"
exit "$failed"
