#!/usr/bin/env bash
# 「更新して再起動」（#295）の通しの試験。アプリが走らせた release-stable.sh が、アプリを終わらせた後も最後まで進むかを見る。
#
#   scripts/test-update-detach.sh [<family-computing の実行ファイル>]
#
# 実行ファイルを省くと src-tauri で cargo build した target/debug/family-computing を使う。
# 2026-11-23 に、安定版の中から走らせた release-stable.sh が安定版の終わりと一緒に落ち、current.ref、hook の写し、
# releases.log、起動が抜けた。この試験では、アプリ役のプロセスを release-stable.sh の stop_stable が終わらせる当のプロセスにする。
#
# 本物の安定版には触らない。
# - 実行ファイルを一時の入れ先（CT_DEST_DIR）の Claude Town.app の中に写し、--update-run で動かす（画面は作らない）
# - 一時のリポジトリ（FC_UPDATE_REPO）に release-stable.sh と stable-lib.sh を写し、一時の bare リポジトリを origin にする
# - CT_DEST_DIR、CT_STABLE_HOME、CT_BUILD_WORKTREE、CT_TARGET_DIR、FC_APP_HOME を mktemp -d の下に向け、CT_NO_OPEN=1 を付ける
# - tauri build は偽の bunx に替え、FC_UPDATE_PATH で偽物を PATH の先頭に置く（偽物が先頭か、走らせる前と出力で確かめる）
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TOP="$(cd "$HERE/.." && pwd)"
bin_src="${1:-}"
if [ -z "$bin_src" ]; then
  (cd "$TOP/src-tauri" && PATH="$HOME/.cargo/bin:$PATH" cargo build --quiet) || { echo "cargo build に失敗した" >&2; exit 1; }
  bin_src="$TOP/src-tauri/target/debug/family-computing"
fi
[ -x "$bin_src" ] || { echo "実行ファイルが無い: $bin_src" >&2; exit 1; }

# ps は実体のパスを出し、stop_stable もリンクを解いたパスで比べるので、/var/folders ではなく /private/var/folders で起動する
root="$(cd "$(mktemp -d)" && pwd -P)"
parent=""
cleanup() {
  [ -n "$parent" ] && kill -0 "$parent" 2>/dev/null && kill -KILL "$parent" 2>/dev/null
  chmod -R u+w "$root" 2>/dev/null; rm -rf "$root"
}
trap cleanup EXIT
failed=0
ok() { echo "ok   $1"; }
ng() { echo "FAIL $1"; failed=1; }

# --- 偽の bun と bunx（scripts/test-stable-scripts.sh と同じ形）---
fake="$root/bin"
mkdir -p "$fake"
printf '#!/bin/sh\nexit 0\n' > "$fake/bun"
cat > "$fake/bunx" <<'EOF'
#!/bin/sh
app="$CARGO_TARGET_DIR/release/bundle/macos/Claude Town.app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>jp.fybe.family-computing</string>
<key>CFBundleName</key><string>Claude Town</string>
<key>CFBundleExecutable</key><string>fake-claude-town-295</string>
</dict></plist>
PL
exit 0
EOF
chmod +x "$fake/bun" "$fake/bunx"
RUN_PATH="$fake:/usr/bin:/bin:/usr/sbin:/sbin"
for c in bun bunx; do
  got="$(PATH="$RUN_PATH" command -v "$c")"
  [ "$got" = "$fake/$c" ] || { echo "偽の $c が先頭にない（${got}）。中断する" >&2; exit 1; }
done

# --- 一時のリポジトリ（origin/main は v2、今の版は v1）---
git init -q --bare "$root/origin.git"
git clone -q "$root/origin.git" "$root/repo" 2>/dev/null
repo="$root/repo"
g() { git -C "$repo" -c user.email=test@example.invalid -c user.name=test -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
g checkout -q -b main
mkdir -p "$repo/scripts" "$repo/hooks" "$repo/src-tauri"
cp "$HERE/release-stable.sh" "$HERE/stable-lib.sh" "$repo/scripts/"
echo 'print("v1")' > "$repo/hooks/fc-report.py"
echo 'print("hook")' > "$repo/scripts/hook.py"
echo '{"from": "v1"}' > "$repo/src-tauri/tauri.stable.conf.json"
g add -A && g commit -q -m v1
v1="$(g rev-parse HEAD)"
echo 'print("v2")' > "$repo/hooks/fc-report.py"
g commit -q -am v2
v2="$(g rev-parse HEAD)"
g push -q -u origin main 2>/dev/null
# 本体の checkout は fetch の前の古い追跡 ref のまま（ボタンが fetch してから上げるかも見る）
g update-ref refs/remotes/origin/main "$v1"
# 本体の checkout のローカルの main は origin/main より古く、作業ツリーのスクリプトには未コミットの変更がある（#299）。
# ボタンが走らせるのは origin/main のスクリプトで、作業ツリーの古いものは走らせない。作業ツリーの方は、走ったら印を書いて 7 で終わる偽物にする
g reset -q --hard "$v1"
old_mark="$root/old-script-ran"
printf '#!/bin/sh\necho old > "%s"\nexit 7\n' "$old_mark" > "$repo/scripts/release-stable.sh"
printf 'echo old-lib > "%s"\n' "$old_mark" > "$repo/scripts/stable-lib.sh"
before_status="$(git -C "$repo" status --porcelain)"
before_head="$(git -C "$repo" rev-parse HEAD)"
before_branch="$(git -C "$repo" symbolic-ref --short HEAD)"
[ -n "$before_status" ] && [ "$before_head" = "$v1" ] || { echo "作業ツリーの準備が違う" >&2; exit 1; }

# --- 一時の入れ先に、アプリ役の .app を置く ---
dest_dir="$root/Applications"
app="$dest_dir/Claude Town.app"
mkdir -p "$app/Contents/MacOS"
cp "$bin_src" "$app/Contents/MacOS/family-computing"
cat > "$app/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>jp.fybe.family-computing</string>
<key>CFBundleName</key><string>Claude Town</string>
<key>CFBundleExecutable</key><string>family-computing</string>
</dict></plist>
PL
state="$root/stable"
mkdir -p "$state"
echo "stable-20000101-0000 $v1" > "$state/current.ref"

# --- アプリ役を動かす ---
env FC_UPDATE=1 FC_UPDATE_REPO="$repo" FC_UPDATE_PATH="$RUN_PATH" FC_APP_HOME="$root/app-home" \
  CT_DEST_DIR="$dest_dir" CT_STABLE_HOME="$state" CT_BUILD_WORKTREE="$root/build-wt" CT_TARGET_DIR="$root/target" CT_NO_OPEN=1 \
  "$app/Contents/MacOS/family-computing" --update-run > "$root/parent.out" 2>&1 &
echo "$!" > "$root/parent.pid"
for _ in $(seq 1 50); do [ -s "$root/parent.pid" ] && break; sleep 0.1; done
parent="$(cat "$root/parent.pid" 2>/dev/null)"
[ -n "$parent" ] || { echo "アプリ役が起動しなかった" >&2; exit 1; }

# アプリ役が終わるのを待つ（release-stable.sh の stop_stable が SIGTERM で終わらせるはず）
for _ in $(seq 1 600); do kill -0 "$parent" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$parent" 2>/dev/null; then
  ng "アプリ役が60秒たっても終わらない"
  cat "$root/parent.out"; cat "$state/update-run.log" 2>/dev/null
  exit 1
fi
grep -q '^pid ' "$root/parent.out" && ! grep -q '^終わった' "$root/parent.out" \
  && ok "アプリ役は更新の終わりを待たずに終わった（stop_stable に終わらされた）" \
  || { ng "アプリ役の終わり方が違う"; cat "$root/parent.out"; }

# スクリプトが最後まで進むのを待つ
for _ in $(seq 1 600); do [ -f "$state/update-run.exit" ] && break; sleep 0.1; done
log="$(cat "$state/update-run.log" 2>/dev/null)"
grep -q "安定版を終わらせる: pid $parent" <<< "$log" && ok "スクリプトがアプリ役（pid ${parent}）を終わらせた" || ng "スクリプトがアプリ役を終わらせた記録が無い"
grep -qx "bunx: $fake/bunx" <<< "$log" && ok "スクリプトの PATH の先頭は偽の bunx" || ng "スクリプトの bunx が偽物でない"
[ -f "$state/update-run.exit" ] && [ "$(awk '{print $3}' "$state/update-run.exit")" = 0 ] \
  && ok "update-run.exit に終了コード 0" || ng "update-run.exit が無いか 0 でない: $(cat "$state/update-run.exit" 2>/dev/null)"
read -r tag sha < "$state/current.ref"
[[ "$tag" == stable-* ]] && [ "$tag" != stable-20000101-0000 ] && [ "$sha" = "$v2" ] \
  && ok "current.ref が fetch した origin/main（v2）のタグ" || ng "current.ref が違う: $(cat "$state/current.ref")"
[ "$(cat "$state/previous.ref" 2>/dev/null)" = "stable-20000101-0000 $v1" ] && ok "previous.ref に前の版" || ng "previous.ref が違う"
[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null)" = fake-claude-town-295 ] \
  && ok "入れ先の .app が新しい版に入れ替わった" || ng "入れ先の .app が入れ替わっていない"
[ -x "$state/previous/Claude Town.app/Contents/MacOS/family-computing" ] && ok "前の .app を previous に退避した" || ng "前の .app が previous に無い"
grep -q "release $tag $v2" "$state/releases.log" 2>/dev/null && ok "releases.log に記録" || ng "releases.log に記録が無い"
[ "$(cat "$state/hooks/fc-report.py" 2>/dev/null)" = 'print("v2")' ] && [ "$(cat "$state/hooks.ref" 2>/dev/null)" = "$tag $v2" ] \
  && ok "状態 hook を新しい版から写した" || ng "状態 hook が写っていない"

[ ! -e "$old_mark" ] && ok "作業ツリーの古いスクリプトは走らなかった" || ng "作業ツリーの古いスクリプトが走った: $(cat "$old_mark")"
[ "$(git -C "$repo" status --porcelain)" = "$before_status" ] && [ "$(git -C "$repo" rev-parse HEAD)" = "$before_head" ] \
  && [ "$(git -C "$repo" symbolic-ref --short HEAD)" = "$before_branch" ] \
  && ok "本体の checkout の作業ツリー、HEAD、ブランチは変わっていない" || ng "本体の checkout が変わった"
took="$(sed -n 's/^origin\/main のスクリプトを取り出した: //p' <<< "$log" | head -n 1)"
[ -n "$took" ] && [ ! -e "$took" ] && ok "取り出したスクリプトの一時の場所（${took}）は消えた" || ng "取り出したスクリプトの一時の場所が無いか残った: ${took:-（記録なし）}"

if [ "$failed" != 0 ]; then
  echo "--- update-run.log"; cat "$state/update-run.log"
  exit 1
fi
echo "全部通った"
