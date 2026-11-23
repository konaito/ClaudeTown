# 軽さの計測（#2）

> 2026-11-21 に、Claude Town のアプリから ccn を外した。この文書は ccn を使っていたころに書いたもので、ccn の口、モックの ccn、別の機械の町についての記述は、今の実装と合わない。今の作りは README の「データの取り方」にある。

## 使い方

> この節と次の「決めてあること」は、`scripts/bench.ts` とモックの ccn（`scripts/mock-ccn-town.ts`）を使う手順で、どちらも #131 で消えた。今は流せない。作り直すかは #187 で決める。今流せる計測は、下の「headless の WebKit での計測」の `scripts/bench-crowd-webkit.ts` である。

軽さを直した子は、直す前と直した後に、同じ worktree で `bun run scripts/bench.ts --label <名前>` を流して比べる。このコマンドは、開発版をモックの ccn に繋いで場面ごとに起動する。場面は、待機、窓を隠す、最小化、ターミナルの出力、長い会話、大きな町の6つある。各場面で、本体と WebKit のプロセス（WebContent、GPU、Networking）の CPU 時間の差と RSS を、ps で60秒ずつ測る。既定では、場面ごとに有効な回が3回たまるまで測る。1回はおよそ1分半かかる。結果は `docs/perf/<日付>-<名前>.jsonl` に1回ずつ足し、場面ごとの中央値と範囲を同じ名前の `.md` に書く。途中で止めても、同じ日付と名前でもう一度流せば続きから測る。場面を絞るときは `--scenes idle,town`、回数は `--runs 5` で指定する。ターミナルを DOM の描き方で比べるときは `--renderer dom` を付ける。ロックは `~/.local/bin/ct-lock`（来た順に渡す）を通して、1回ごとに `ct-lock acquire ct-bench` で取り、測り終えたら `ct-lock release ct-bench` で外す。次の回は列の後ろに並び直すので、ほかの子と交互に回り、全部で30分以上かかることがある。HOME は一時のディレクトリに向けるので、本物の `~/.family-computing/` と開発版の `~/.family-computing/dev/` には書かない。

## 決めてあること

- 数字はどれも開発版（デバッグビルドの Rust と、vite の開発用の React）のもので、前後の比較に使う。安定版（/Applications/Claude Town.app）の数字とは比べられない。
- 見えているはずの場面で窓が描かれなかった回（visibilityState が hidden、または fps が 20 未満）と、隠したはずの場面で見えていた回は、無効として表の数に入れない。無効の理由と、そのときの前面のアプリは `.md` の末尾に出る。
- 窓は最前面に置き、どのデスクトップにも出す（`FC_BENCH_TOP`）。ただし、本人が全画面のアプリ（Specter など）を前面にしている間は窓が隠れ、見えるはずの場面は無効になる。無効が続いても終わるように、1場面に試す回数は `--max-tries`（既定は `--runs` の3倍）までにする。
- 本体は、起動したプロセスの木の中の `family-computing`。WebKit のプロセスは、起動の前後で増えたもののうち、本体の起動から15秒以内に始まったものとみなす。WebContent が1つに決まらなければ、その回は無効にする。
- 町はモック（`scripts/mock-ccn-town.ts`）が毎回同じに作る。小さな町は4世帯・10人で全員待機、大きな町は30世帯・100人で作業中20・承認待ち5。モックは ccn と同じく一覧の SSE（`/api/sessions/stream`）を返す。口が無い ccn と比べるときは、`scripts/mock-ccn-town.ts` に `--no-stream` を渡す。
- お手紙の記録（letters.jsonl）は、既定で 56KB（2026-11-13 の本人の Mac の大きさ）にし、時刻は24時間前にそろえる。#11 の 1MB の場合は `--letters-kb 1024` で測る。
- 起動の時間は、プロセスが始まってから、一覧を読んだ町の最初の描画までの時間。vite の開発サーバーから読むので、製品版より長い。

## headless の WebKit での計測（`scripts/bench-crowd-webkit.ts`）

開発版の窓が隠れて描かれない間も、headless の WebKit（Playwright）なら同じ条件で CPU を測れる。`bun run build` した dist を `bun scripts/bench-crowd-webkit.ts <ラベル> <dist> <人数> <running|waiting_permission|idle> [回数]` で開く。町のモックは script の中で動くので、別のプロセスは要らない。段ごとの経過秒を標準エラーに出すので、止まったときは最後の段が止まった箇所である。

- 必要なもの: playwright-core（Apache-2.0）と WebKit（約 320MB）。リポジトリの依存には入れず、`mkdir /tmp/pw-bench && cd /tmp/pw-bench && bun add playwright-core && bunx playwright-core install webkit` で入れ、`NODE_PATH=/tmp/pw-bench/node_modules` で渡す。WebKit は `~/Library/Caches/ms-playwright/webkit-<版>` に入る。
- 2026-11-22 に数字が出なかった原因: #131 で `?mock` とモック（`scripts/mock-ccn-crowd.ts`）を消したので、旧 script の手順では町が出なかった。この script は、PROD で開いたときの `/api/sessions`（ccn の口の形）を同じポートで返すように変えた。
- 窓の大きさは `VW` と `VH`（既定 1440×900）、ならしは `WARM` 秒、計測は `WIN` 秒で変える。結果は `OUT`（既定 `/tmp/ct-bench-crowd-webkit.jsonl`）に足す。
