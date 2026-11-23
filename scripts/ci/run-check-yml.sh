#!/usr/bin/env bash
# .github/workflows/check.yml の run の step を、手元で上から順に流す。CI の設定を push する前に同じコマンドを確かめるための台本
# uses の step（checkout、setup-bun など）は飛ばす。手元に bun、python3、cargo、jq が入っている前提で、OS は macOS で確かめた
# 使い方: scripts/ci/run-check-yml.sh [<ジョブ名> ...]（省くと全部のジョブ。例: types tests）
# 別の版の check.yml を今の木で流すときは CHECK_YML=<パス> を付ける
# yq（mikefarah/yq v4）が要る
set -euo pipefail

root=$(git rev-parse --show-toplevel)
wf=${CHECK_YML:-$root/.github/workflows/check.yml}

if [ $# -gt 0 ]; then
  jobs=("$@")
else
  jobs=()
  while IFS= read -r j; do jobs+=("$j"); done < <(yq '.jobs | keys | .[]' "$wf")
fi

for job in "${jobs[@]}"; do
  n=$(yq ".jobs.\"$job\".steps | length" "$wf")
  if [ "$n" = 0 ]; then
    echo "check.yml にジョブ $job が無い" >&2
    exit 2
  fi
  for ((i = 0; i < n; i++)); do
    cmd=$(yq ".jobs.\"$job\".steps[$i].run // \"\"" "$wf")
    [ -z "$cmd" ] && continue
    wd=$(yq ".jobs.\"$job\".steps[$i].\"working-directory\" // \".\"" "$wf")
    echo "=== [$job] ($wd) $cmd"
    # GitHub の run の既定のシェル（bash --noprofile --norc -eo pipefail）と同じにする
    (cd "$root/$wd" && bash --noprofile --norc -eo pipefail -c "$cmd")
  done
done
echo "=== 全部通った: ${jobs[*]}"
