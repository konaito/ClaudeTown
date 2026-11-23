# 軽さの計測（#2）

> 2026-11-21 に、Claude Town のアプリから ccn を外した。`scripts/bench.ts` はそのとき消え、#187 で合成の `~/.claude` を使う形に作り直した。2026-11-13 の記録はモックの ccn で測ったもので、町の出どころが今と違う。

## 使い方

軽さを直した子は、直す前と直した後に、同じ worktree で `bun run scripts/bench.ts --label <名前>` を流して比べる。このコマンドは、合成の `~/.claude`（`scripts/bench-town.ts`）で町を作り、開発版を場面ごとに起動する。既定で回す場面は、待機、窓を隠す、最小化、ターミナルの出力、長い会話、大きな町の6つある。起動の時間を測る場面（startup）は既定に入らず、`--scenes startup` で選ぶ（下の「起動の時間」）。各場面で、本体と WebKit のプロセス（WebContent、GPU、Networking）の CPU 時間の差と RSS を、ps で60秒ずつ測る。既定では、場面ごとに有効な回が3回たまるまで測る。1回はおよそ1分半かかる。結果は `docs/perf/<日付>-<名前>.jsonl` に1回ずつ足し、場面ごとの中央値と範囲を同じ名前の `.md` に書く。途中で止めても、同じ日付と名前でもう一度流せば続きから測る。場面を絞るときは `--scenes idle,town`、回数は `--runs 5` で指定する。ターミナルを DOM の描き方で比べるときは `--renderer dom` を付ける。ロックは `~/.local/bin/ct-lock`（来た順に渡す）を通して、1回ごとに `ct-lock acquire ct-bench` で取り、測り終えたら `ct-lock release ct-bench` で外す。次の回は列の後ろに並び直すので、ほかの子と交互に回り、全部で30分以上かかることがある。

HOME は分けない（README の「子が開発版で確かめるとき」）。開発版が読む先と書く先は、次の環境変数で1回ごとの一時の場所に向ける。本物の `~/.claude` と `~/.family-computing/` は、読まず、書かない。

- `FC_CLAUDE_HOME`: 合成の `~/.claude`。
- `FC_STATE_DIR`、`FC_LETTERS`、`FC_PERM_DIR`: hook の状態（state/）、お手紙の記録（letters.jsonl）、承認の input（perm/）の置き場所。hook（`hooks/fc-report.py`）と同じ名前と意味で、#187 で Rust も読むようにした。非常停止（send-disabled）は差し替えない。
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
- 起動の時間は、プロセスが始まってから、一覧を読んだ町の最初の描画までの時間。vite の開発サーバーから読むので、製品版より長い。区間の定義は次の節にある。

## 起動の時間（#16、#187）

`bun run scripts/bench.ts --scenes startup --label <名前>` で測る。idle と同じ小さな町（4世帯・10人、全員待機）で開発版を起動し、CPU は測らずに次を記録して終える。2026-11-23 の1回は、ロックを取ってから放すまで15秒だった（Rust の組み直しは無し）。ロック、環境変数の分け方、止め方は、ほかの場面と同じ。

区間の始点は、どれも Rust の `run()` の入口で、`FC_PERF_LOG` に `{"bench":"proc","procStartMs"}` として書く時刻（`src-tauri/src/lib.rs`）。終点は、画面（`src/term/bench.ts` の scene）が ready の行に書く時刻。計算は `scripts/lib/startup.ts` にある。

| 記録の名前 | 終点 |
| --- | --- |
| `boot.toNavStartMs` | WebView が画面の読み込みを始めた時刻（`performance.timeOrigin`） |
| `boot.toShellPaintMs` | 窓の最初の描画。App の最初のコミット（町の枠だけで、一覧はまだ）の後の最初の requestAnimationFrame |
| `boot.toTownPaintMs` | 町の最初の描画。一覧が届いて町を描いた後の最初の requestAnimationFrame。ほかの場面の `startupMs` と同じ |
| `boot.rssAppMB10s`、`boot.rssWebContentMB10s` | Rust の起動の10秒後の、本体と WebContent の RSS |

- 窓が隠れていると requestAnimationFrame が止まり、描画の時刻が取れない。そのため、窓が見えていない回は無効にする。本人が全画面のアプリを前面にしている間は、ほかの見えるはずの場面と同じく無効になる。
- 一覧の取得（`town_watch`）も、窓が見えている間だけ始まる（`src/town.ts`、#6）。窓が隠れたまま起動すると、町は描かれない。
- 結果の `.md` には、CPU の表とは別に「起動の時間（startup）」の表が出る。

### 2026-11-13 の定義との違い

2026-11-13 の記録（`2026-11-13-app-size.md`、`2026-11-13-app-size-startup.jsonl`）は、消えた `scripts/bench-startup.sh` で測ったもので、今の startup とは次の点が違う。数字を並べて比べない。

| | 2026-11-13（bench-startup.sh） | 今（bench.ts の startup） |
| --- | --- | --- |
| ビルド | リリースの .app（`bun tauri build --bundles app`）の実行ファイルを直に起動 | 開発版（`bun tauri dev`。デバッグビルドの Rust と、vite の開発サーバーの画面） |
| 始点 | 台本が実行ファイルを起動する直前の時刻。exec と dyld の時間を含む | Rust の `run()` の入口。exec と dyld の時間を含まない |
| 終点 | モックの ccn（`mock-ccn-crowd.ts`）が最初の `/api/sessions` の要求を受けた時刻 | 窓の最初の描画と、町の最初の描画（requestAnimationFrame） |
| 町 | モックの ccn の承認待ち20体 | 合成の `~/.claude` の4世帯・10人、全員待機 |
| 窓が隠れているとき | JS は動くので要求は来て、測れた | 描画も一覧の取得も止まるので、無効 |

### 2026-11-23 の1回

開発版で `--scenes startup --runs 1 --max-tries 1` を1回だけ流した。1回だけの値で、ばらつきは分からない。記録は `2026-11-23-startup-dev.jsonl` と同じ名前の `.md`。

| 画面の読み込み開始まで | 窓の最初の描画まで | 町の最初の描画まで | 本体 RSS（10秒後） | WebContent RSS（10秒後） |
| --- | --- | --- | --- | --- |
| 659ms | 1,153ms | 1,270ms | 137MB | 152MB |

- 条件は、Apple M5、デバッグビルドの Rust（起動の直前に組み終えていて、組み直しは無し）、vite の開発サーバー、4世帯・10人の町。窓は見えていて、ready のときの fps は 31。測った直後の `uptime` の load average は 13.00、12.47、16.81 で、ほかの子のビルドなどで機械は混んでいた。
- 窓の最初の描画から町の最初の描画までは 117ms だった。起動の時間の大半は、画面の読み込み開始まで（659ms）と、読み込み開始から窓の最初の描画まで（494ms）にある。どこに時間がかかっているかは調べていない。
- 同じ町が出ていることは `--town-check` で確かめた（idle は10人、4世帯）。画面に描かれた人数は記録していない。

## .app の大きさ（#16）

リリースの .app を開発版の設定（`src-tauri/tauri.conf.json`、Claude Town Dev）で組み、大きさを測る。安定版の設定（`tauri.stable.conf.json`）は重ねない。組んだ .app は起動せず、/Applications にも入れない。ビルドは数分かかり CPU を使い切るので、ほかの子の計測と重ならないよう、`~/.local/bin/ct-lock acquire <名前>` でロックを取ってから流し、済んだら外す。

```bash
# worktree の中で。beforeBuildCommand の bun run build（tsc と vite build）も走る
bun tauri build --bundles app
APP="src-tauri/target/release/bundle/macos/Claude Town Dev.app"
du -sk "$APP"                                              # .app の大きさ（KB）
stat -f %z "$APP/Contents/MacOS/family-computing"           # 実行ファイル（バイト）
ls -l dist/assets/*.js                                     # 画面の JS（vite build の出力）
```

2026-11-13 の表（`2026-11-13-app-size.md`）と同じく、.app は `du -sk`、実行ファイルはバイト数で書く。

2026-11-23 に、この手順で1回だけ組んで測った（main の fa15d1c に #187 の変更を足した版。Apple M5。Rust の組み立ては3分21秒）。identifier は `jp.fybe.family-computing.dev`。

| | 2026-11-23 |
| --- | --- |
| .app（`du -sk`） | 6,420KB |
| 実行ファイル（`Contents/MacOS/family-computing`） | 6,377,456 バイト |
| 起動のときに読む JS（`dist/assets/index-*.js`） | 472,631 バイト |
| ターミナルを開くときに読む JS（`dist/assets/TerminalView-*.js`） | 452,556 バイト |

2026-11-13 の数字（.app 6,196KB）は ccn を使っていたころのもので、中身が違う。増えた理由は調べていない。

## headless の WebKit での計測（`scripts/bench-crowd-webkit.ts`）

開発版の窓が隠れて描かれない間も、headless の WebKit（Playwright）なら同じ条件で CPU を測れる。`bun run build` した dist を `bun scripts/bench-crowd-webkit.ts <ラベル> <dist> <人数> <running|waiting_permission|idle> [回数]` で開く。町のモックは script の中で動くので、別のプロセスは要らない。段ごとの経過秒を標準エラーに出すので、止まったときは最後の段が止まった箇所である。

- 必要なもの: playwright-core（Apache-2.0）と WebKit（約 320MB）。リポジトリの依存には入れず、`mkdir /tmp/pw-bench && cd /tmp/pw-bench && bun add playwright-core && bunx playwright-core install webkit` で入れ、`NODE_PATH=/tmp/pw-bench/node_modules` で渡す。WebKit は `~/Library/Caches/ms-playwright/webkit-<版>` に入る。
- 2026-11-22 に数字が出なかった原因: #131 で `?mock` とモック（`scripts/mock-ccn-crowd.ts`）を消したので、旧 script の手順では町が出なかった。この script は、PROD で開いたときの `/api/sessions`（ccn の口の形）を同じポートで返すように変えた。
- 窓の大きさは `VW` と `VH`（既定 1440×900）、ならしは `WARM` 秒、計測は `WIN` 秒で変える。結果は `OUT`（既定 `/tmp/ct-bench-crowd-webkit.jsonl`）に足す。
