# 軽さの計測（#2）

> 2026-11-21 に、Claude Town のアプリから ccn を外した。`scripts/bench.ts` はそのとき消え、#187 で合成の `~/.claude` を使う形に作り直した。2026-11-13 の記録はモックの ccn で測ったもので、町の出どころが今と違う。

## 使い方

軽さを直した子は、直す前と直した後に、同じ worktree で `bun run scripts/bench.ts --label <名前>` を流して比べる。このコマンドは、合成の `~/.claude`（`scripts/bench-town.ts`）で町を作り、開発版を場面ごとに起動する。場面は、待機、窓を隠す、最小化、ターミナルの出力、長い会話、大きな町の6つある。各場面で、本体と WebKit のプロセス（WebContent、GPU、Networking）の CPU 時間の差と RSS を、ps で60秒ずつ測る。既定では、場面ごとに有効な回が3回たまるまで測る。1回はおよそ1分半かかる。結果は `docs/perf/<日付>-<名前>.jsonl` に1回ずつ足し、場面ごとの中央値と範囲を同じ名前の `.md` に書く。途中で止めても、同じ日付と名前でもう一度流せば続きから測る。場面を絞るときは `--scenes idle,town`、回数は `--runs 5` で指定する。ターミナルを DOM の描き方で比べるときは `--renderer dom` を付ける。ロックは `~/.local/bin/ct-lock`（来た順に渡す）を通して、1回ごとに `ct-lock acquire ct-bench` で取り、測り終えたら `ct-lock release ct-bench` で外す。次の回は列の後ろに並び直すので、ほかの子と交互に回り、全部で30分以上かかることがある。

HOME は分けない（README の「子が開発版で確かめるとき」）。開発版が読む先と書く先は、次の環境変数で1回ごとの一時の場所に向ける。本物の `~/.claude` と `~/.family-computing/` は、読まず、書かない。

- `FC_CLAUDE_HOME`: 合成の `~/.claude`。
- `FC_SHARED_HOME`: `~/.family-computing` の代わり。お手紙の記録（letters.jsonl）と hook の状態（state/）をここから読む。#187 で Rust に足した。
- `FC_APP_HOME`: アプリが書くファイル（キャラの割り当てなど）。
- `FC_NO_RESTORE=1` と `FC_CAM_BIN=/usr/bin/false`: 端末の立て直しをせず、cam を呼ばない。
- `FC_CLAUDE_BIN`: ターミナルの出力の場面で、claude の代わりに `scripts/bench-flood-claude.ts` を起動する。

町の作りだけを確かめるときは `bun run scripts/bench.ts --town-check` を流す。ロックも窓も使わない。開発版の Rust の `--native-list` と `--snapshot` で、人数、親の無い世帯の数、作業中と承認待ちの数、お手紙の数を数え、場面ごとに OK か NG を出す。

## 決めてあること

- 数字はどれも開発版（デバッグビルドの Rust と、vite の開発用の React）のもので、前後の比較に使う。安定版（/Applications/Claude Town.app）の数字とは比べられない。
- 見えているはずの場面で窓が描かれなかった回（visibilityState が hidden、または fps が 20 未満）と、隠したはずの場面で見えていた回は、無効として表の数に入れない。無効の理由と、そのときの前面のアプリは `.md` の末尾に出る。
- 窓は最前面に置き、どのデスクトップにも出す（`FC_BENCH_TOP`）。ただし、本人が全画面のアプリ（Specter など）を前面にしている間は窓が隠れ、見えるはずの場面は無効になる。無効が続いても終わるように、1場面に試す回数は `--max-tries`（既定は `--runs` の3倍）までにする。
- 本体は、起動したプロセスの木の中の `family-computing`。WebKit のプロセスは、起動の前後で増えたもののうち、本体の起動から15秒以内に始まったものとみなす。WebContent が1つに決まらなければ、その回は無効にする。
- 町は `scripts/bench-town.ts` が毎回同じに作る。小さな町は4世帯・10人で全員待機、大きな町は30世帯・100人で作業中20・承認待ち5。id、親子、cwd、開始時刻の並びは、消えたモックの ccn（`mock-ccn-town.ts`）と同じにした。
- 町に出るのは pid が生きている行だけなので、町を作るときにセッションごとに `/bin/sleep` を1つ起動し、その pid を `sessions/<pid>.json` に書く。sleep は1回ごとに pid で止める。
- 子は、会話の最初の文の from 行（`from agent:bench/<親の id の先頭8字>/子 via bench`）で親につなぐ。
- 長い会話の場面は、先頭の世帯の子に1000件の発言の jsonl を置き、チャットの欄で開く。
- ターミナルの出力の場面は、開発版が新しい世帯と同じ口（create_session）で代役の claude を立てる。代役は旧モックと同じ書き換え（`scripts/flood-chunk.ts`）を1秒に100かたまり流し、先頭の世帯の子として町に出る。旧モックの出力は ccn の SSE を通って届いた。今は PTY から Rust を通って届くので、ccn のころの terminal の数字とは経路が違う。
- 表の「ccn への要求/分」は、合成の町で測った回では「−」になる。記録の `httpPerMin` は空のまま残し、`source` に `native` を入れる。
- お手紙の記録（letters.jsonl）は、既定で 56KB（2026-11-13 の本人の Mac の大きさ）にし、時刻は24時間前にそろえる。#11 の 1MB の場合は `--letters-kb 1024` で測る。
- 起動の時間は、プロセスが始まってから、一覧を読んだ町の最初の描画までの時間。vite の開発サーバーから読むので、製品版より長い。

## headless の WebKit での計測（`scripts/bench-crowd-webkit.ts`）

開発版の窓が隠れて描かれない間も、headless の WebKit（Playwright）なら同じ条件で CPU を測れる。`bun run build` した dist を `bun scripts/bench-crowd-webkit.ts <ラベル> <dist> <人数> <running|waiting_permission|idle> [回数]` で開く。町のモックは script の中で動くので、別のプロセスは要らない。段ごとの経過秒を標準エラーに出すので、止まったときは最後の段が止まった箇所である。

- 必要なもの: playwright-core（Apache-2.0）と WebKit（約 320MB）。リポジトリの依存には入れず、`mkdir /tmp/pw-bench && cd /tmp/pw-bench && bun add playwright-core && bunx playwright-core install webkit` で入れ、`NODE_PATH=/tmp/pw-bench/node_modules` で渡す。WebKit は `~/Library/Caches/ms-playwright/webkit-<版>` に入る。
- 2026-11-22 に数字が出なかった原因: #131 で `?mock` とモック（`scripts/mock-ccn-crowd.ts`）を消したので、旧 script の手順では町が出なかった。この script は、PROD で開いたときの `/api/sessions`（ccn の口の形）を同じポートで返すように変えた。
- 窓の大きさは `VW` と `VH`（既定 1440×900）、ならしは `WARM` 秒、計測は `WIN` 秒で変える。結果は `OUT`（既定 `/tmp/ct-bench-crowd-webkit.jsonl`）に足す。
