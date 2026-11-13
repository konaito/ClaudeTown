#!/usr/bin/env bash
# Claude Town の安定版を、git の ref から作って /Applications に入れる。
#
#   scripts/release-stable.sh <ref>           ref に stable-YYYYMMDD-HHMM のタグを打ち、そのタグからビルドして入れる
#   scripts/release-stable.sh stable-...      すでにある stable- のタグなら、タグを打たずにそのタグからビルドして入れる
#
# 手順:
#   1. タグを打つ（同じ名前のタグがあれば中断）
#   2. 作業ツリーとは別の一時 worktree にタグを取り出し、bun install と tauri build（.app だけ）を行う
#      設定は tauri.conf.json（開発版）に、このスクリプトの隣の ../src-tauri/tauri.stable.conf.json を重ねる
#   3. できた .app の識別子と名前が安定版の値か確かめる（違えば中断）
#   4. 安定版が動いていれば、その実行ファイルの pid だけを終わらせる
#   5. 今の /Applications/Claude Town.app を退避先に移し（1つ前の版として残す）、新しい .app を入れる
#      タグの状態 hook（hooks/ と scripts/hook.py）を退避先と同じ置き場の hooks/ と scripts/ に写す
#      （~/.claude/settings.json はここを登録するので、作業ツリーの hook を書き換えても安定版に出る内容は変わらない）
#   6. 安定版を起動する
#
# 戻すときは scripts/rollback-stable.sh（今の版と1つ前の版を入れ替える）。
#
# 環境変数（試験用）:
#   CT_DEST_DIR     入れ先（既定 /Applications）
#   CT_STABLE_HOME  退避先と記録の置き場（既定 $HOME/.family-computing/stable）
#   CT_NO_OPEN=1    最後に起動しない
set -euo pipefail

APP_NAME="Claude Town"
STABLE_ID="jp.fybe.family-computing"
DEST_DIR="${CT_DEST_DIR:-/Applications}"
STATE="${CT_STABLE_HOME:-$HOME/.family-computing/stable}"
DEST="$DEST_DIR/$APP_NAME.app"
PREV="$STATE/previous/$APP_NAME.app"
TARGET_DIR="${CT_TARGET_DIR:-$HOME/.cache/claude-town/stable-target}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STABLE_CONF="$SCRIPT_DIR/../src-tauri/tauri.stable.conf.json"
. "$SCRIPT_DIR/stable-lib.sh"

ref="${1:-}"
[ -n "$ref" ] || { echo "使い方: $0 <ref>" >&2; exit 2; }
[ -f "$STABLE_CONF" ] || { echo "安定版の上書き設定が無い: $STABLE_CONF" >&2; exit 1; }

repo="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify --quiet "$ref^{commit}")" || { echo "ref が見つからない: $ref" >&2; exit 1; }

# 1. タグ
if [[ "$ref" == stable-* ]] && git -C "$repo" rev-parse --verify --quiet "refs/tags/$ref" >/dev/null; then
  tag="$ref"
  echo "既存のタグを使う: $tag ($sha)"
else
  tag="stable-$(date +%Y%m%d-%H%M)"
  if git -C "$repo" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    echo "タグ $tag はもうある。1分おいてやり直すか、既存のタグを渡す" >&2
    exit 1
  fi
  git -C "$repo" tag -a "$tag" -m "Claude Town 安定版 ($ref)" "$sha"
  echo "タグを打った: $tag -> $sha"
fi

# 2. 一時 worktree でビルド
# 置き場所は毎回同じにする（Rust のビルド結果がパスで紐づくので、場所が変わると全部作り直しになる）
wt="${CT_BUILD_WORKTREE:-$HOME/.cache/claude-town/stable-worktree}"
cleanup() { git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true; git -C "$repo" worktree prune; }
cleanup
if [ -e "$wt" ]; then echo "一時 worktree の場所に別のものがある: $wt" >&2; exit 1; fi
trap cleanup EXIT
mkdir -p "$(dirname "$wt")"
git -C "$repo" worktree add --detach "$wt" "$tag" >/dev/null
echo "ビルドする: $wt"
(
  cd "$wt"
  bun install --frozen-lockfile
  CARGO_TARGET_DIR="$TARGET_DIR" bunx tauri build --bundles app --config "$STABLE_CONF"
)
built="$TARGET_DIR/release/bundle/macos/$APP_NAME.app"
[ -d "$built" ] || { echo ".app ができていない: $built" >&2; exit 1; }

# 3. 安定版の値か確かめる
plist="$built/Contents/Info.plist"
got_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist")"
got_name="$(/usr/libexec/PlistBuddy -c 'Print CFBundleName' "$plist")"
if [ "$got_id" != "$STABLE_ID" ] || [ "$got_name" != "$APP_NAME" ]; then
  echo "できた .app が安定版の値ではない（$got_id / $got_name）。入れずに中断する" >&2
  exit 1
fi

mkdir -p "$STATE/previous" "$STATE/staging"
# 状態 hook は、安定版を止める前に取り出して確かめる。だめならここで中断し、安定版には触らない
stage_hooks "$repo" "$tag" "$STATE"
staged="$STATE/staging/$APP_NAME.app"
rm -rf "$staged"
ditto "$built" "$staged"

# 4. 動いている安定版を終わらせる（入れ先の実行ファイルの pid だけ）
was_running=0
if [ -d "$DEST" ] && stop_stable "$DEST"; then was_running=1; fi

# 5. 入れ替え（今の版は1つ前の版として退避する）
if [ -d "$DEST" ]; then
  rm -rf "$PREV"
  mv "$DEST" "$PREV"
  if [ -f "$STATE/current.ref" ]; then mv "$STATE/current.ref" "$STATE/previous.ref"; fi
fi
mkdir -p "$DEST_DIR"
mv "$staged" "$DEST"
echo "$tag $sha" > "$STATE/current.ref"
commit_hooks "$repo" "$tag" "$STATE" || echo "状態 hook を写せなかった。scripts/install-stable-hooks.sh $tag で写し直す" >&2
echo "$(date '+%Y-%m-%d %H:%M:%S') release $tag $sha" >> "$STATE/releases.log"
echo "入れた: $DEST ($tag $sha)"

# 6. 起動
if [ "${CT_NO_OPEN:-0}" != 1 ]; then
  open "$DEST"
  echo "起動した（前に動いていた: ${was_running}）"
fi
