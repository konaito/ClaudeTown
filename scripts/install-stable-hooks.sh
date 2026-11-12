#!/usr/bin/env bash
# 安定版のタグの状態 hook を、$CT_STABLE_HOME（既定 $HOME/.family-computing/stable）の hooks/ に写す。
# release-stable.sh と rollback-stable.sh も同じことをする。これは、アプリを入れ替えずに hook だけを写し直すとき
# （初めて写すときなど）に使う。
#
#   scripts/install-stable-hooks.sh          いま入っている安定版のタグ（current.ref）から写す
#   scripts/install-stable-hooks.sh <ref>    指定した ref から写す
#
# ~/.claude/settings.json の登録先を写した先に向けるのは scripts/hook.py install（既定で写した先を登録する）。
set -euo pipefail

STATE="${CT_STABLE_HOME:-$HOME/.family-computing/stable}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/stable-lib.sh"

repo="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
ref="${1:-}"
if [ -z "$ref" ]; then
  ref="$(cut -d' ' -f1 "$STATE/current.ref" 2>/dev/null || true)"
  [ -n "$ref" ] || { echo "current.ref が無い。ref を渡す: $0 <ref>" >&2; exit 2; }
fi
git -C "$repo" rev-parse --verify --quiet "$ref^{commit}" >/dev/null || { echo "ref が見つからない: $ref" >&2; exit 1; }
mkdir -p "$STATE"
install_hooks "$repo" "$ref" "$STATE"
