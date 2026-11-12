# Claude Town

Claude Town は、Claude Code のセッションの親子を、町に住む家族の子供たちが働く姿として見せる Tauri 製のデスクトップアプリである。旧名はファミリーコンピューティングで、リポジトリとディレクトリの名前（family-computing）、bundle identifier、hook と状態の置き場（`~/.family-computing/`）は旧名のまま使う。画面の子供をクリックすると、その子に注文を出せる。この文書は企画書で、決まったことと決まっていないことを分けて書く。

## ccn とセットで動く

Claude Town は、ccn（Claude Code Nodes）とセットで動くアプリである。Claude Town だけでは動かない。ccn は作者が作っている別のプロダクトで、リポジトリは公開していない。

ccn は、機械ごとに常駐するノードである。ノードは、その機械で Claude Code のセッションを立て、一覧にし、文を送り、承認に答える HTTP の口を出す。ノードどうしをつなぐと、別の機械のセッションも同じ口で扱える。

Claude Town は、手元のノード（`127.0.0.1`、ポートは `~/.config/ccn/ccn.json` の `port`）に次の口を呼ぶ。別の機械のセッションは、パスの頭に `/n/<ノード名>` を付けて、手元のノードに中継してもらう。

| 用途 | ccn の口 |
| --- | --- |
| 機械の一覧 | `GET /api/peers` |
| セッションの一覧、状態、親子 | `GET /api/sessions` |
| 承認の中身などの詳細 | `GET /api/sessions/<id>` |
| 新しい世帯を立てる | `POST /api/sessions`（`terminal: true`） |
| 会話を読む、文を送る | `GET /api/sessions/<id>/messages`、`POST /api/sessions/<id>/messages` |
| 端末 | `GET /api/sessions/<id>/terminal`（SSE）、`POST /api/sessions/<id>/terminal/input`、`POST /api/sessions/<id>/terminal/resize` |
| 承認に答える | `POST /api/sessions/<id>/permissions/<requestId>` |
| 閉じる | `DELETE /api/sessions/<id>` |
| 別の機械へ移す（転出） | `GET /api/sessions/<id>/teleport`、`POST /api/sessions/<id>/teleport` |

## 何を作るか

エージェンティックコーディングでは、1人の人が Claude Code を親、子、孫と何十体も並べて動かす。Claude Town は、この並びを「家族」として扱う。人が開いたセッションが親で、親が作ったセッションが子、子が作ったセッションが孫になる。1つの親とその子孫を1世帯と数え、町は世帯の集まりになる。

画面は左右に分ける。左には世帯（根のセッション1つとその子孫）ごとに、淡い色の角丸の枠を1つ描き、中に親と子と孫を木の形で並べる。右には選んだ子の会話と注文の欄を出す。

世帯の中の配置は、決定論的な幾何の配置で決める（`src/layout/`。方針は `docs/design/geometric-layout.md`、検証の条件は `docs/design/physics-layout.md` の 10）。世帯の一番上の親を中心に、世代ごとの半径に並べる。根の子は下向きを中心に、孫より下は親の角度を中心に、兄弟を重ならない最小の角度（2·arcsin(r/R)）で並べる。子孫の多い枝には、葉から計算した広い角度を割り当てる。実際の箱（キャラと名前）で重なり、親子線の交差、線が箱を通ること、枝の混ざりを検査し、残れば決まった順序で角度の余白、次に半径を広げる。兄弟を並べる弧の上限を4通り試し、検査を通るもののうち s（配置の幅と高さを表示領域で割った大きいほう）が一番小さいものを選ぶ。乱数と時刻は使わない。配置を計算し直すのは世帯の顔ぶれが変わったときだけで、新しい座標へは短いアニメーションで移る。パラメータは `src/layout/params.ts` にまとめた。

孫より下は、キャラと名前と状態の点だけの小さい札にする。札を押すと、親や子と同じ大きさのカードを上に重ねて広げ、周りの配置は動かさない。空白を押すと元に戻る。

世帯の枠（モジュール）の並べ方は、世帯の中の配置とは別の処理にした（`src/layout/pack.ts`、仕様は `docs/design/household-packing.md`）。並び順は「親（根）のセッションの開始時刻の順、同じなら ID の順」に決めた。大きさや状態では並べ替えない。この順に1個ずつ、決まった横幅の中へ上詰めで置く。直前の世帯より上には置かず、直前と同じ高さなら右に置く。隙間は残り、後の世帯が先の世帯を追い越さない。毎回最初から計算し、新しい座標へは短いアニメーションで移る。人を待っている世帯は、上の「お便り」の行で先に知らせる。

親と子のカードには、親・子・孫の別、係の1行、状態、キャラ、名前を出す。キャラは状態に合わせて動く。作業中は足踏みし、印は出さない。承認待ち、返事待ち、完了のときだけ、頭の右肩に絵文字の印を出す。

画面の一番上には「お便り」の行を置く。人を待っている子のうち最初の1件を大きく出し、横に次の2件を小さく並べる。この行の書き方は i-have-adhd スキルに従う。

画面の構成は、本人が作ったモック（`docs/design/2026-11-12-mock-chatgpt.png`）に合わせた。モックから取るのは構成だけで、キャラの絵柄は取らない。

## 解決したいこと

子と孫をペインの分割で並べるターミナルでは、子と孫が増えるたびにペインが分かれる。孫が16体になると、各ペインは数文字の幅しかなく、誰が何をしていて誰が人を待っているかが読めない。

Claude Town は、ペインの中身を読まなくても、状態と次の一手が分かる画面を目指す。20〜30体を1画面で読めることを成功条件にする。

## 類似プロダクトとの違い

17件を調べた結果は `docs/research/similar-products.md` にある。調査は README と docs の記述によるもので、コードは読んでいない。

- エージェントの状態をキャラで見せるものは多い。pixel-agents（MIT）、Claude Office Visualizer（MIT）、Agents in the Office（MIT、Tauri）、Clawd on Desk（AGPL）などがある。
- 状態の分け方は pixel-agents の定義が分かりやすい。完了、入力待ち、承認待ちを分け、承認待ちだけが作業の途中で起きる。
- 端末へ移る操作と、承認に答える操作を持つものはある。キャラから任意の文を送れるものは、調べた範囲では見つからなかった。
- 深さ3以上の親子を一度に見せるものも見つからなかった。表現はオフィスと社員が中心で、家族として見せるものは無かった。

Claude Town の違いは3つある。データ源を ccn に寄せること、キャラから文を送れること、孫までの親子を家族の木として見せることである。

## データの取り方

2026-11-12 に、右パネルを本物の端末にする方針（`docs/design/terminal-panel.md` の A2）に切り替えた。claude は ccn のノードが PTY の中で対話モードのまま動かし、Claude Town は ccn の口だけを使う。ほかのターミナルアプリには依存しない。ccn の PTY の口は、2026-11-12 に ccn に入った。ccn を動かさずに画面を作るときは、同じ口を持つモックのノード（`scripts/mock-ccn-pty.ts`）を使う。

| 知りたいこと | 取り方 |
| --- | --- |
| 生きているセッション、状態、親子 | 手元の ccn ノードの `GET /api/sessions`。親は一覧の parent（`agent:<ノード>/<親の sid 先頭8>/<役割>`）から引く。ポートは `~/.config/ccn/ccn.json` の `port` |
| 端末の画面 | `GET /api/sessions/<id>/terminal`（SSE）。最初に size、続けて末尾の replay、以後 data。Rust で読み、Tauri のイベントで xterm.js に流す |
| 承認の中身 | `GET /api/sessions/<id>` の pending（toolName、input、requestId） |
| 頼まれたこと、いまやっていること、最後の報告、次の一手 | hook が書く `~/.family-computing/state/<session_id>.json` |
| 閉じてよいか | close-check-state hook が書く `~/.claude/close-check/<session_id>.json` |

人がターミナルで開いたセッションは、ccn から一覧と送信だけができる。親子は ccn の parent だけから引く。ccn を通さずに作った子は、親とつながらず別の世帯として出る。名前の決め方は、ccn で作ったセッションと同じにする（下の「世帯とカードの名前」）。

ccn は Origin 付きの要求を CSRF として断る。このため、HTTP の要求は画面からではなく Tauri の Rust 側から出す。

## 操作

- 子供を左クリックすると、右のパネルにその子が出る。端末のセッションは「端末」の欄が先に開き、打ったキーはそのまま PTY に届く（`POST /api/sessions/<id>/terminal/input`）。端末の大きさは、開いたときに ccn に伝える（後に開いた画面に合わせる）。
- 子供を右クリックすると、その子を選んで端末を開く。
- 子は親のセッション自身が ccn の create_session（terminal: true）で作る。画面から子を足す操作は出さない（2026-11-12、本人の判断。使う機会が無いため）。
- 上の「＋ 新しい世帯」を押すと、すぐ `~/Documents/meta` で親のいない端末のセッションを立て、そのノードを選んで右の端末を開き、フォーカスを当てる。最初の依頼の欄は出さない。押した瞬間から端末に最初の出力が来るまでに打ったキーはためておき、出力が来たら流す。セッションが0本の空の町でも、ここから最初の世帯を作れる。
- 右パネルの「転出」で、ccn の teleport（PR #18）を呼び、別の機械へ移す（move）か複製する（fork）。下見は移動元の説明（`GET /api/sessions/<id>/teleport`）だけを見せる。行き先の下見は clone することがあるので、実行の中で ccn に任せる。作業中と承認待ちのセッションは転出できない。世帯ごとの転出は出していない。ccn に一括の口が無く、1つずつ移すと子の parent が転出を呼んだ側に変わり、同じリポジトリの子が行き先の同じ作業ツリーを書き換え合うため（`docs/research/ccn-teleport.md`）。
- 承認待ちの子は、カードの枠が黄色で点滅し、右パネルに承認の中身と「許可する」「拒否する」を出す。押すと、今も承認待ちで requestId が同じかを確かめてから、ccn の permissions の口で答える。質問（AskUserQuestion）や計画の確認（ExitPlanMode）の待ちには許可を送らない。人が端末で開いたセッションは、その端末で答える。
- 上の帯のノードの切り替えで、ccn につながる別の機械のセッションも出せる。
- 送信の非常停止: `~/.family-computing/send-disabled` があると、注文、端末への入力、承認、作成、転出を全部断る。

## hook

本人の依頼は「このプロダクトのために再度整理させるための hook」だった。2つの読み方を出して本人に聞き、A に決まった。

- A（採用）: 各セッションに、いまの様子を書き出させる hook。UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、Notification、Stop、SessionStart、SessionEnd で、頼まれたこと、いまやっていること、最後の報告、次の一手、人を待っているかを状態ファイルに書く。LLM は呼ばない。
- B（不採用）: 各エージェントに、終わった子を閉じさせ、ツリーを浅く保たせる hook。

hook の本体は `hooks/fc-report.py` に置く。2026-11-12 に本人に確かめて `~/.claude/settings.json` に登録した（同じ日に PermissionRequest も足した）。`~/.claude/settings.json` が呼ぶのは作業ツリーの hook ではなく、安定版のタグから写した `~/.family-computing/stable/hooks/fc-report.py` である（下の「安定版と開発版」）。登録と解除は `python3 scripts/hook.py install` と `python3 scripts/hook.py uninstall` で行う。install は写した先を登録し、写した先が無ければ何も書かずに止まる。書く前に settings.json の控えを残す。cam の各プロファイルの settings.json は `~/.claude/settings.json` へのリンクなので、1か所で全部に効く。

hook は本物の `claude -p` で試し、頼まれたこと、道具、最後の報告、次の一手が状態ファイルに入ることを確かめた。

## 決まったこと

- hook は A にする。
- 左クリックの「メッセージの挿入」は、ccn で文を送ることにする。モックに合わせ、送る欄は右のパネルの会話の下に置く。
- 白を基調にした明るい配色にする。
- 状態は、作業中（緑）、返事待ち（青）、承認待ち（黄）、完了（灰）、待機の5つにする。承認待ちは ccn の waiting_permission、返事待ちは hook が「人への問いで終わった」と書いたものと、set_status の blocked。
- キャラの体は Ninja Adventure Asset Pack（CC0）のドット絵、状態の印は Noto Animated Emoji（CC BY 4.0）の WebP にする（見本ページの案 C）。印の置き方は案 A の位置の2段階目（A2）。親には大人のキャラ6体、子より下には子供のキャラ18体から、名前で決めて当てる。見本は `docs/research/assets/index.html` と `docs/research/assets/balance.html`。
- 家の絵（屋根、壁、床）は描かない。世帯は淡い色の枠で見分ける。
- プロダクト名は Claude Town にする（2026-11-12）。数える単位は世帯で、画面の見出しは「5世帯・23人」のように出す。
- 世帯とカードの名前は、そのセッションが作業しているプロジェクトの名前にする（2026-11-13）。プロジェクトの名前は、リポジトリの本体のディレクトリの名前（例 family-computing）。決め方は `src-tauri/src/naming.rs` と `src/model.ts` の cardNames に同じものを書き、試験の事例は `src/naming-cases.json` にまとめて両方で読む。
  1. git の worktree は、`.git` の gitdir から本体の名前に直す（この機械の町だけ）。`.git` を読めないときは `<名前>.wt/<x>` を <名前> にし、それ以外は cwd の最後の名前にする。
  2. cwd が振り分けの場所（ホーム、`~/Documents`、`~/Documents/meta`、`~/.local/share/ccn/lobby`、`/`、`/tmp`、`/private/tmp`、`/root`）なら、子孫のプロジェクトで一番多いものにする。振り分けの場所にいる子孫は数えず、同数なら先に始まった子孫の分にする。
  3. 子孫から分からなければ、エージェントが `python3 scripts/hook.py name <プロジェクトの名前>` で付けた名前にする。それも無ければ cwd の最後の名前（meta など）のままにする。
  4. cwd が無ければ ccn の題名、それも無ければセッション ID の先頭8字にする。
- 世帯の名前は、根のカードの名前と同じにする。本人は画面で世帯の名前をダブルクリックして直せて、本人が付けた名前が最優先になる。名前は `~/.family-computing/houses.json` に入る。
- 振り分けの場所で動く親が、別のプロジェクトで子を作ると（ccn の create_session か Specter の spawn_child）、状態 hook が「そのプロジェクトのディレクトリの名前を `hook.py name` で付けて」と促す。プロジェクトごとに1回だけ促す。Specter の子は ccn に親が残らず、アプリが子孫として数えられないので、この名前で世帯の名前が分かる。
- キャラの見た目は、右下の「素材」を開いた中の「キャラの見た目」で「いつもの」と「ポケモン」を切り替えられる。使う素材が見た目で変わるので、素材の表示と同じ所に置く。既定は「いつもの」で、選んだ値はこの画面の localStorage に残す。ポケモンでは、世帯の根のセッションの ID から3段進化の系統を1つ決め、親を3段目（最終進化）、子を2段目、孫（孫より下も）を1段目で描く。例えばリザードンの系統なら、親がリザードン、子がリザード、孫がヒトカゲになる。作業中は GIF を動かして小さく跳ねさせ、それ以外は1フレームを止める。状態の印と待機の薄さは「いつもの」と同じ。GIF が読めないときは、その1体だけ「いつもの」の絵に戻す（2026-11-13）。

## 決まっていないこと

- 状態ファイルの「次の一手」は、返事の中の「次:」で始まる行と、最後の行が問いかどうかで決めている。この決め方で足りるかは、使ってみるまで分からない。

## 素材のクレジット

コードは MIT ライセンスです（`LICENSE`）。以下の素材は、それぞれのライセンスのままです。

- キャラ: Ninja Adventure Asset Pack（Pixel-boy、AAA。https://pixel-boy.itch.io/ninja-adventure-asset-pack）。CC0 1.0 で、帰属表示は要らない。使うキャラの Walk.png、Idle.png、Faceset.png だけを `public/sprites/ninja/` に置いた。
- 状態の印、幽霊、お手紙: Animated emoji: Noto Animated Emoji by Google, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Source: https://googlefonts.github.io/noto-emoji-animation/ 。状態の印の3種（270b、1f97a、2705）、エラー用の1種（2049_fe0f）、閉じる演出の幽霊（1f47b）、お手紙の封筒（1f48c）の 512.webp を、改変せずに `public/sprites/noto/` に置いた。アプリの下の帯の「素材」にも同じ表示を出す。
- ポケモン（「素材」の中の「キャラの見た目」でポケモンを選んだときだけ）: Pokémon Showdown のアニメ GIF を、PokeAPI/sprites（https://github.com/PokeAPI/sprites）の `sprites/pokemon/other/showdown/<図鑑番号>.gif` から読む。画像はこのリポジトリにもアプリにも入れず、表示中のキャラの分だけ実行時に raw.githubusercontent.com から取得する。URL はブランチ名ではなく、確かめたときのコミットで指す。系統の一覧 `src/kid/pokemon-lines.json` は図鑑番号と英名だけで、`bun run scripts/pokemon-lines.ts` で作り直す。Pokémon © Nintendo / Creatures Inc. / GAME FREAK inc.
- 見本ページの Kenney のプレビュー画像（`docs/research/assets/kenney-toon-characters.png`）: Kenney（https://kenney.nl）。CC0 で、帰属表示は要らない。
- 見本ページ（`docs/research/assets/`）は、比べたときの素材を全部参照している。絞った後の public には一部しか残っていないので、見本ページの画像は一部が出ない。

## 安定版と開発版

本人は安定版で作業し、子や開発者は開発版で確かめる。子が作業ツリーを書き換えても、安定版は変わらない。

| | 安定版 | 開発版 |
|---|---|---|
| 名前（productName） | Claude Town | Claude Town Dev |
| Dock の名前 | Claude Town | family-computing（`tauri dev` は .app にならず、実行ファイル名が出る） |
| identifier | `jp.fybe.family-computing` | `jp.fybe.family-computing.dev` |
| 置き場所 | `/Applications/Claude Town.app` | 作業ツリーから `bun tauri dev` で起動する |
| アイコン | `src-tauri/icons/` | `src-tauri/icons-dev/`（橙の DEV の帯付き） |
| ウィンドウの題 | Claude Town | Claude Town Dev（開発版） |
| 中身 | `stable-` で始まる git のタグ | 作業ツリーのいまの中身 |

`src-tauri/tauri.conf.json` は開発版の設定にしてある。何も付けずに `bun tauri dev` や `bun tauri build` を動かすと、必ず開発版になる。安定版は `src-tauri/tauri.stable.conf.json` を Tauri の `--config` で重ねてビルドする（`--config` に渡した JSON は元の設定に重なる。配列が丸ごと置き換わる前提で、窓の定義とアイコンの一覧は全部書いてある）。開発版は 1420 番のポートを使う。安定版はビルドした画面を中に持つのでポートを使わない。2つは同時に起動できる。

子と開発者の決まり:

- 起動と確認には開発版だけを使う。
- 安定版（`/Applications/Claude Town.app`）を止めない、差し替えない、消さない。
- 安定版へ上げるのは、本人か親が頼んだときだけにする。

安定版へ上げる:

```bash
scripts/release-stable.sh <ref>    # 例: scripts/release-stable.sh feat/app-v1
```

スクリプトは次の順に進む。

1. ref に `stable-YYYYMMDD-HHMM` のタグを打つ。既存の `stable-` のタグを渡すと、タグを打たずにそのタグを使う。
2. 作業ツリーとは別の一時 worktree にタグを取り出し、`bun install --frozen-lockfile` と `tauri build --bundles app` を行う。Rust のビルド結果は `$HOME/.cache/claude-town/stable-target` に置き、次のリリースで使い回す。
3. できた .app の identifier と名前が安定版の値か確かめる。違えば入れずに中断する。
4. 安定版が動いていれば終わらせる。終わらせるのは `/Applications/Claude Town.app` の実行ファイルの pid だけで、開発版や他のプロセスには触らない。
5. 今の .app を `$HOME/.family-computing/stable/previous/` に退避し、新しい .app を入れる。タグの `hooks/` と `scripts/hook.py` を `$HOME/.family-computing/stable/` の下に同じ相対位置で写す。どのタグから写したかは同じ場所の `hooks.ref` に残る。
6. 安定版を起動する。

入っている版は `$HOME/.family-computing/stable/current.ref`、履歴は同じ場所の `releases.log` に残る。

1つ前の版に戻す:

```bash
scripts/rollback-stable.sh    # 今の版と1つ前の版を入れ替える。もう一度回すと元に戻る
```

戻すときも、状態 hook を戻した先の版のタグから写し直す。アプリを入れ替えずに hook だけを写し直すときは `scripts/install-stable-hooks.sh [タグ]` を使う（タグを省くと、いま入っている版のタグから写す）。

作業ツリーの hook を試すときは、手で見本の入力を流す。`FC_STATE_DIR`、`FC_LETTERS`、`FC_HOUSES` を一時の場所に向けると、本物の状態ファイルに書かない。

```bash
echo '{"session_id":"0123abcd-0000-0000-0000-000000000001","hook_event_name":"UserPromptSubmit","prompt":"試し"}' \
  | FC_STATE_DIR=/tmp/fc-try FC_LETTERS=/tmp/fc-try/letters.jsonl FC_HOUSES=/tmp/fc-try/houses.json python3 hooks/fc-report.py
```

本物のセッションで試すときだけ、`python3 scripts/hook.py install --worktree` で作業ツリーの hook に登録を替える。その間は安定版にも作業ツリーの hook の内容が出るので、済んだら `python3 scripts/hook.py install` で写した先に戻す。2つを同時に登録しないのは、同じ状態ファイルに2つの版の hook が書くと、作業ツリーの hook がまた安定版の表示に混ざるためである。

開発版のアイコンは、安定版のアイコンに帯を重ねて作る。`src-tauri/icons/` を作り直したら `scripts/make-dev-icon.sh` も回してコミットする（ImageMagick が要る）。

両版で共有しているもの:

- 状態 hook は1つだけ登録してあり、両版が同じ状態ファイルを読む。登録先は安定版のタグから写した `~/.family-computing/stable/hooks/fc-report.py` なので、作業ツリーの hook を書き換えても、安定版を上げ直すまで両版に出る内容は変わらない。
- hook が書くファイル（state/、letters.jsonl）と、送信の非常停止（send-disabled）は、両版が `~/.family-computing/` の同じものを読む。非常停止は1か所で両版を止めるために共有にしてある。
- エージェントが hook（`scripts/hook.py name`）で付けた世帯の名前は、`~/.family-computing/houses.json` に入り、両版が読む。

両版で分けているもの:

- アプリが書くファイル（avatars.json、avatars-recent.json、`avatars-peer-<機械>.json`、avatars-custom-ccn.json、houses.json）は、安定版は `~/.family-computing/` に、開発版は `~/.family-computing/dev/` に置く。開発版でキャラの割り当てや世帯の名前を変えても、安定版のファイルは変わらない。
- どちらに置くかは、ビルドに入った identifier で決める。安定版の identifier なら今までの場所、それ以外（開発版）なら dev/ にする。環境変数を付け忘れても、開発版が安定版のファイルに書かない。
- 開発版の世帯の名前は、共有の houses.json を下地に読み、開発版の houses.json を上に重ねる。本人が開発版の画面で付けた名前は開発版の分にだけ書く。開発版で名前を消しても、共有の分にある名前は残って見える。
- 置き場所を決める関数は `src-tauri/src/lib.rs` の `fc_path` だけにしてある。`FC_APP_HOME` を付けると、アプリが書くファイルの置き場所だけを差し替えられる。`FC_AVATARS` と `FC_HOUSES` は今までどおり使える。
- 置き場所は `src-tauri/target/debug/family-computing --paths` で確かめられる。identifier と、各ファイルの置き場所を出す。
- 開発版の dev/ は、初めて起動したときは空なので、キャラは安定版と違う顔ぶれで振り直される。avatars-recent.json、`avatars-peer-<機械>.json`、avatars-custom-ccn.json の3つは、キャラの選び方の変更（feat/char-age）が入った版から使う。

## 開発

```bash
bun install
bun run tauri dev   # 開発版（Claude Town Dev）が起動する

# 見た目だけをブラウザで確かめるとき（送信はしない）
src-tauri/target/debug/family-computing --snapshot > public/dev-snapshot.json
bun run dev   # http://localhost:1420/

# 端末の口のモック（中身は bash。FC_MOCK_CMD=claude で claude）。ブラウザは http://localhost:1420/?mock で直接繋ぐ
bun run scripts/mock-ccn-pty.ts
FC_CCN_URL=http://127.0.0.1:4399 bun run tauri dev   # Tauri をモックに繋ぐ

# 配置計算だけの検証（世帯の中の8ケースと、世帯の並べ方の5条件）
bun test src/layout
```

`public/dev-*.json` には本物のセッションの中身が入るので、コミットしない（.gitignore に入れてある）。
