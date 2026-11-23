#!/usr/bin/env bash
# release-stable.sh の署名の口（CT_SIGN_IDENTITY）と、指定要件の警告の試験（#188）。
#
#   scripts/test-stable-sign.sh            このスクリプトの隣のスクリプトを試す
#   scripts/test-stable-sign.sh <dir>      <dir> にあるスクリプトを試す
#
# 本物の安定版とキーチェーンには触らない。
# - スクリプトを一時のリポジトリに写し、そこから動かす（スクリプトは自分の置き場所のリポジトリを使う）
# - CT_DEST_DIR、CT_STABLE_HOME、CT_BUILD_WORKTREE、CT_TARGET_DIR と HOME を全部 mktemp -d の下に向け、CT_NO_OPEN=1 を付ける
# - tauri build は偽の bunx に替える。偽の bunx は APPLE_SIGNING_IDENTITY と引数を控え、
#   安定版の値の .app を作って ad-hoc で署名する（codesign -s - はキーチェーンを使わない）
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
: > "$FAKE_LOG"
if [ "${APPLE_SIGNING_IDENTITY+set}" = set ]; then
  echo "APPLE_SIGNING_IDENTITY=$APPLE_SIGNING_IDENTITY" >> "$FAKE_LOG"
else
  echo "APPLE_SIGNING_IDENTITY unset" >> "$FAKE_LOG"
fi
for a in "$@"; do echo "arg $a" >> "$FAKE_LOG"; done
app="$CARGO_TARGET_DIR/release/bundle/macos/Claude Town.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>jp.fybe.family-computing</string>
<key>CFBundleName</key><string>Claude Town</string>
<key>CFBundleExecutable</key><string>fake-claude-town-188</string>
</dict></plist>
PL
cp /usr/bin/true "$app/Contents/MacOS/fake-claude-town-188"
codesign --force -s - "$app" >> "$FAKE_LOG" 2>&1
exit 0
EOF
chmod +x "$bin/bun" "$bin/bunx"
TEST_PATH="$bin:$PATH"
for c in bun bunx; do
  got="$(PATH="$TEST_PATH" command -v "$c")"
  [ "$got" = "$bin/$c" ] || { echo "偽の $c が先頭にない（${got}）。中断する" >&2; exit 1; }
done

# --- 一時のリポジトリ ---
git init -q "$root/repo"
repo="$root/repo"
g() { git -C "$repo" "$@"; }
g config user.email test@example.invalid
g config user.name test
g config commit.gpgsign false
g config tag.gpgsign false
mkdir -p "$repo/scripts" "$repo/hooks" "$repo/src-tauri"
for f in release-stable.sh stable-lib.sh; do
  cp "$SRC/$f" "$repo/scripts/$f"
done
echo 'print("v1")' > "$repo/hooks/fc-report.py"
echo 'print("hook")' > "$repo/scripts/hook.py"
echo '{"from": "v1"}' > "$repo/src-tauri/tauri.stable.conf.json"
g add -A && g commit -q -m v1
# ref はコミットの sha で渡す（ローカルのブランチの鮮度の確かめに当たらないように）
v1="$(g rev-parse HEAD)"

run() { # run <名前> [環境変数...]  出力は $root/<名前>.out、終了コードは $root/<名前>.rc
  local name="$1"; shift
  rm -rf "$root/dest" "$root/stable"
  env -u APPLE_SIGNING_IDENTITY -u CT_SIGN_IDENTITY "$@" \
    HOME="$root/home" PATH="$TEST_PATH" FAKE_LOG="$root/$name.bunx" \
    CT_DEST_DIR="$root/dest" CT_STABLE_HOME="$root/stable" \
    CT_BUILD_WORKTREE="$root/wt" CT_TARGET_DIR="$root/target" CT_NO_OPEN=1 \
    bash "$repo/scripts/release-stable.sh" "$v1" > "$root/$name.out" 2>&1
  echo $? > "$root/$name.rc"
  g tag -l 'stable-*' | while read -r t; do g tag -d "$t" >/dev/null; done
}
rc() { cat "$root/$1.rc"; }
show() { sed 's/^/     /' "$root/$1.out" "$root/$1.bunx" 2>/dev/null; }
mkdir -p "$root/home"

# 1. CT_SIGN_IDENTITY を入れると、tauri build に APPLE_SIGNING_IDENTITY として渡る
run with_id CT_SIGN_IDENTITY="Claude Town Test Signing"
if [ "$(rc with_id)" = 0 ] && grep -qx 'APPLE_SIGNING_IDENTITY=Claude Town Test Signing' "$root/with_id.bunx" 2>/dev/null; then
  ok "CT_SIGN_IDENTITY が APPLE_SIGNING_IDENTITY として tauri build に渡る"
else
  ng "CT_SIGN_IDENTITY が tauri build に渡っていない（終了 $(rc with_id)）"
  show with_id
fi

# 2. CT_SIGN_IDENTITY が無ければ、今までどおり何も渡さない（ad-hoc のまま）
run without_id
if [ "$(rc without_id)" = 0 ] && grep -qx 'APPLE_SIGNING_IDENTITY unset' "$root/without_id.bunx" 2>/dev/null; then
  ok "CT_SIGN_IDENTITY が無ければ APPLE_SIGNING_IDENTITY を渡さない"
else
  ng "CT_SIGN_IDENTITY が無いのに何かを渡した（終了 $(rc without_id)）"
  show without_id
fi

# 3. 入れた .app の指定要件が cdhash だけなら警告を出す。止めはしない（終了 0、.app は入る）
if [ "$(rc without_id)" = 0 ] && [ -d "$root/dest/Claude Town.app" ] \
  && grep -q '指定要件が cdhash だけ' "$root/without_id.out"; then
  ok "ad-hoc の .app を入れると、指定要件が cdhash だけだと警告し、止めない"
else
  ng "ad-hoc の .app を入れても警告が出ていないか、止まった（終了 $(rc without_id)）"
  show without_id
fi

# 4. 警告の関数は、cdhash 以外の指定要件（Apple の署名の /usr/bin/true）では何も言わない
# 古い版のスクリプトに関数が無いときは、この試験だけ FAIL にする
out="$(bash -c '. "$1/stable-lib.sh"; type warn_cdhash_only >/dev/null 2>&1 || { echo "関数が無い"; exit 3; }; warn_cdhash_only /usr/bin/true' _ "$repo/scripts" 2>&1)"
code=$?
if [ "$code" = 0 ] && ! printf '%s' "$out" | grep -q 警告 \
  && printf '%s' "$out" | grep -q '^指定要件: identifier "com.apple.true" and anchor apple$'; then
  ok "cdhash 以外の指定要件では、指定要件を出すだけで警告しない"
else
  ng "cdhash 以外の指定要件で何か出た（終了 ${code}）: $out"
fi

[ "$failed" = 0 ] && echo "全部通った" || echo "落ちたものがある"
exit "$failed"
