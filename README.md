# family-computing

ファミリーコンピューティングは、Claude Code のセッションの親子を、家族の子供たちが働く姿として見せる Tauri 製のデスクトップアプリである。画面の子供をクリックすると、その子に注文を出せる。この文書は企画書で、決まったことと決まっていないことを分けて書く。

## 何を作るか

エージェンティックコーディングでは、1人の人が Claude Code を親、子、孫と何十体も並べて動かす。ファミリーコンピューティングは、この並びを「家族」として扱う。人が開いたセッションが親で、親が作ったセッションが子、子が作ったセッションが孫になる。

画面は左右に分ける。左には家族（根のセッション1つとその子孫）ごとに、淡い色の角丸の枠を1つ描き、中に親と子と孫を木の形で並べる。右には選んだ子の会話と注文の欄を出す。

木はどの深さでも同じ規則で描く。カードの下に子を横に並べ、上から線でつなぐ。子の段は 0.86倍ずつ縮める。孫より下は、キャラと名前と状態の点だけの小さい札にする。札を押すと、親や子と同じ見た目の大きさのカードを上に重ねて広げ、周りの配置は動かさない。空白を押すと元に戻る。

家族の枠は、一番大きいものを左に置き、残りを右の余った幅に折り返して詰める。右に入れると 0.6倍より小さくなるときは、残りを下に回す。

親と子のカードには、親・子・孫の別、係の1行、状態、キャラ、名前を出す。キャラは状態に合わせて動く。作業中は足踏みし、印は出さない。承認待ち、返事待ち、完了のときだけ、頭の右肩に絵文字の印を出す。

画面の一番上には「次の一手」の行を置く。人を待っている子のうち最初の1件を大きく出し、横に次の2件を小さく並べる。この行の書き方は i-have-adhd スキルに従う。

画面の構成は、本人が作ったモック（`docs/design/2026-11-12-mock-chatgpt.png`）に合わせた。モックから取るのは構成だけで、キャラの絵柄は取らない。

## 解決したいこと

Specter（Ghostty の改名版のターミナル）では、子と孫が増えるたびにペインが分割される。孫が16体になると、各ペインは数文字の幅しかなく、誰が何をしていて誰が人を待っているかが読めない。`/Users/konaito/Desktop/スクリーンショット 2026-11-12 16.52.58.png` と `/Users/konaito/Desktop/スクリーンショット 2026-11-12 17.43.01.png` がその状態である。

ファミリーコンピューティングは、ペインの中身を読まなくても、状態と次の一手が分かる画面を目指す。20〜30体を1画面で読めることを成功条件にする。

## 類似プロダクトとの違い

17件を調べた結果は `docs/research/similar-products.md` にある。調査は README と docs の記述によるもので、コードは読んでいない。

- エージェントの状態をキャラで見せるものは多い。pixel-agents（MIT）、Claude Office Visualizer（MIT）、Agents in the Office（MIT、Tauri）、Clawd on Desk（AGPL）などがある。
- 状態の分け方は pixel-agents の定義が分かりやすい。完了、入力待ち、承認待ちを分け、承認待ちだけが作業の途中で起きる。
- 端末へ移る操作と、承認に答える操作を持つものはある。キャラから任意の文を送れるものは、調べた範囲では見つからなかった。
- 深さ3以上の親子を一度に見せるものも見つからなかった。表現はオフィスと社員が中心で、家族として見せるものは無かった。

ファミリーコンピューティングの違いは3つある。データ源を ccn に寄せること、キャラから文を送れること、孫までの親子を家族の木として見せることである。

## データの取り方

| 知りたいこと | 取り方 |
| --- | --- |
| 親子の木、名前、Specter のペイン | `~/.specter/agents.json`（specter-agents の記録）。ccn は親子を保存しない |
| 生きているセッションと状態 | 手元の ccn ノードの `GET /api/sessions`。ポートは `~/.config/ccn/ccn.json` の `port`（この機械では 4323） |
| 状態の種類 | ccn から取れるのは running、waiting_permission、idle の3つ |
| 頼まれたこと、いまやっていること、最後の報告、次の一手 | hook が書く `~/.family-computing/state/<session_id>.json` |
| 閉じてよいか | close-check-state hook が書く `~/.claude/close-check/<session_id>.json` |
| 子が自分で残した状態 | `agents.json` の selfStatus（specter-agents の set_status） |

2026-11-12 に試した時点では、生きているセッション12件が全部 `agents.json` の記録と一致した。ccn の一覧の取得には0.37秒かかった。アプリは2秒ごとに読み直す。

ccn は Origin 付きの要求を CSRF として断る。このため、HTTP の要求は画面からではなく Tauri の Rust 側から出す。

## 操作

- 子供を左クリックすると、右のパネルにその子の会話が出る。会話は ccn の `GET /api/sessions/<id>/messages` から読み、発言と道具の1行に縮めて出す。下の欄に打った文は ccn の `POST /api/sessions/<id>/messages` で、その子のセッションに届く。届いた文は、相手の入力欄に入るのではなく、別のセッションからの文として届き、相手はすぐに読む。
- 子の返事の最後が問いで、短い選択肢の行が並んでいれば、選択肢をボタンにする。押すとその文を送る。
- 上の帯のノードの切り替えで、ccn につながる別の機械のセッションも出せる。別の機械には Specter のツリーが無いので、親子は ccn の from 行から導き、ペインへの移動はできない。
- 子供を右クリックすると、Specter のその子のペインへ移る。Specter の通知をクリックしたときと同じく、窓を前に出してペインにフォーカスする。使うのは Specter の AppleScript の `focus` 命令で、specter-agents の focus_agent と同じ方法である。
- 承認待ちの子は、右のパネルに承認の中身（道具と、コマンドやファイル）を出し、「許可する」「拒否する」で答えられる。中身は状態 hook が PreToolUse で控えたもの。押すと、今も承認待ちで中身が同じかを確かめてから、Specter のその端末に `send key`（許可は `digit1`、拒否は `escape`）を送る。許可は中身が一致したときだけ送る。ノードが立てたセッション（claude -p）には ccn の permissions で答える。「今後も許可」はその子の設定を書き換えるので、まだ入れていない。迷ったときのために「ペインへ」も残す。
- 2026-11-12 に権限モード default の試験台で、許可（ファイルができた）、拒否（できなかった）、中身の id がずれたときと承認待ちでないときに送らないこと、id が無いときに許可を送らないことを確かめた。

## hook

本人の依頼は「このプロダクトのために再度整理させるための hook」だった。2つの読み方を出して本人に聞き、A に決まった。

- A（採用）: 各セッションに、いまの様子を書き出させる hook。UserPromptSubmit、PreToolUse、PostToolUse、Notification、Stop、SessionStart、SessionEnd で、頼まれたこと、いまやっていること、最後の報告、次の一手、人を待っているかを状態ファイルに書く。LLM は呼ばない。
- B（不採用）: 各エージェントに、終わった子を閉じさせ、ツリーを浅く保たせる hook。

hook の本体は `hooks/fc-report.py` に置く。`~/.claude/settings.json` への登録は設定の変更なので、本人に確かめてから行う。登録と解除は `python3 scripts/hook.py install` と `python3 scripts/hook.py uninstall` で行う。書く前に settings.json の控えを残す。cam の各プロファイルの settings.json は `~/.claude/settings.json` へのリンクなので、1か所で全部に効く。

hook は本物の `claude -p` で試し、頼まれたこと、道具、最後の報告、次の一手が状態ファイルに入ることを確かめた。

## 決まったこと

- hook は A にする。
- 左クリックの「メッセージの挿入」は、ccn で文を送ることにする。モックに合わせ、送る欄は右のパネルの会話の下に置く。
- 白を基調にした明るい配色にする。
- 状態は、作業中（緑）、返事待ち（青）、承認待ち（黄）、完了（灰）、待機の5つにする。承認待ちは ccn の waiting_permission、返事待ちは hook が「人への問いで終わった」と書いたものと、set_status の blocked。
- キャラの体は Ninja Adventure Asset Pack（CC0）のドット絵、状態の印は Noto Animated Emoji（CC BY 4.0）の WebP にする（見本ページの案 C）。印の置き方は案 A の位置の2段階目（A2）。親には大人のキャラ6体、子より下には子供のキャラ18体から、名前で決めて当てる。見本は `docs/research/assets/index.html` と `docs/research/assets/balance.html`。
- 家の絵（屋根、壁、床）は描かない。家族は淡い色の枠で見分ける。
- 家族の名前は、親（根のセッション）が自分で付ける。子を持つ親に名前が無ければ、状態 hook が1回だけ「依頼の中身から短い名前を決めて `python3 scripts/hook.py name "<名前>"` で付けて」と促す。名前は `~/.family-computing/houses.json` に入る。本人は画面で家族の名前をダブルクリックして直せて、本人が付けた名前は親が付けた名前より優先する。名前が無いあいだは、子と孫の作業場所で一番多いディレクトリ名を仮の名前にする。

## 決まっていないこと

- hook を `~/.claude/settings.json` に登録するか。本人の承認待ち。
- ほかの機械（ccn の別のノード）のセッションを出すか。いまは手元のノードだけを出す。
- 状態ファイルの「次の一手」は、返事の中の「次:」で始まる行と、最後の行が問いかどうかで決めている。この決め方で足りるかは、使ってみるまで分からない。

## 素材のクレジット

- キャラ: Ninja Adventure Asset Pack（Pixel-boy、AAA。https://pixel-boy.itch.io/ninja-adventure-asset-pack）。CC0 1.0 で、帰属表示は要らない。使うキャラの Walk.png、Idle.png、Faceset.png だけを `public/sprites/ninja/` に置いた。
- 状態の印: Animated emoji: Noto Animated Emoji by Google, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Source: https://googlefonts.github.io/noto-emoji-animation/ 。使う3種（270b、1f97a、2705）とエラー用の1種（2049_fe0f）の 512.webp を、改変せずに `public/sprites/noto/` に置いた。アプリの下の帯の「素材」にも同じ表示を出す。
- 見本ページ（`docs/research/assets/`）は、比べたときの素材を全部参照している。絞った後の public には一部しか残っていないので、見本ページの画像は一部が出ない。

## 開発

```bash
bun install
bun run tauri dev

# 見た目だけをブラウザで確かめるとき（送信とペインへの移動はしない）
src-tauri/target/debug/family-computing --snapshot > public/dev-snapshot.json
bun run dev   # http://localhost:1420/
```

`public/dev-*.json` には本物のセッションの中身が入るので、コミットしない（.gitignore に入れてある）。
