#!/bin/sh
# 両方の町の GET /api/sessions を保存する。full と、id/title/state/parent/kind/cwd に絞ったもの
L=$1; O=/private/tmp/ccn-tp/out
for t in A:4431 B:4432; do n=${t%%:*}; p=${t##*:}
  curl -s -m 20 127.0.0.1:$p/api/sessions > $O/$L-$n.full.json
  jq '[.[] | {id, title, state, parent, kind, cwd, awaitingFirst}]' $O/$L-$n.full.json > $O/$L-$n.json
  echo "== $L town $n"; jq -c '.[] | {id: .id[0:8], state, parent, kind, title}' $O/$L-$n.json
done
