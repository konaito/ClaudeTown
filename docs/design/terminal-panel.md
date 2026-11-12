# 右パネルを本物の端末にする設計案

2026-11-12 に本人が決めた方針は「右パネルを、Claude Code のセッションに対応した本物の端末にする。Specter 対応はやめ、ccn には対応する」。この文書は、実装の前に本人に決めてもらうための案である。類似 OSS と部品の調査は `docs/research/pty-terminals.md` にある。

## 確かめたこと

- bun 1.3.11 は、`Bun.spawn` の `terminal` で PTY を持てる。2026-11-12 に `claude --session-id <決めた ID> --model haiku "1行で hi とだけ言って"` を bun の PTY の中で対話モードのまま動かし、返事が出ることを確かめた。1往復の出力は 5.5KB だった。
- そのセッションは `claude agents --json` に `kind: interactive` で、こちらが決めたセッション ID のまま出た。ccn の今の作り（端末のセッションを `claude agents --json` から拾い、受信ソケットで文を届ける）でも、一覧と送信はそのまま効く。
- ccn は、1つのセッションを動かす部品を Driver という境界で分けている（`src/engine/driver.ts`）。いまは SDK で動かす NodeDriver と、人が端末で開いたセッションに文を届ける TerminalDriver がある。PTY で動かす Driver を足す場所がある。
- ccn のノードは LaunchAgent で常駐している。
- 先行例（claude-view、racker-terminal、mulmoterminal）は「PTY の持ち主が出力の末尾を覚え、画面が付いたときに再生する」形で、xterm.js に流している。

## 決めてほしいこと: PTY をどこが持つか

| | A1: Claude Town が持つ | A2: ccn のノードが持つ | A3: Claude Code の `--bg` に預ける |
| --- | --- | --- | --- |
| 中身 | Rust の portable-pty で claude を起動し、xterm.js に流す | ccn に PTY の Driver を足す。Claude Town は ccn から画面のバイト列を受けて xterm.js に流す | `claude --bg` で起動し、Claude Town の PTY の中で `claude attach` を動かす |
| アプリを閉じたとき | セッションも終わる（生かすなら tmux が要る） | 生きる（ノードは常駐） | 生きる（Claude Code の supervisor） |
| ccn から見えるか | 一覧と送信だけ（いまの端末のセッションと同じ）。画面と承認は見えない | 一覧、画面、送信、承認が、ccn.fybe.jp と別の機械からも見える | 一覧と送信だけ。画面は attach した Claude Town にしか無い |
| 別の機械のセッション | ccn の中継で一覧と会話は出せるが、端末は出せない | 同じ仕組みで、別の機械のセッションの端末も出せる | A1 と同じ |
| 変えるもの | Claude Town だけ | ccn（別プロジェクト）と Claude Town | Claude Town だけ |
| 危ないところ | 30本の PTY の重さは未計測 | ccn の変更が大きい。ccn の試験（bun test と VM の live 試験）も要る | 公式の研究プレビュー。30本の attach の挙動と画面の復元は未検証 |

「ccn に対応する」を「ccn からも画面と承認を扱える」と読むなら、A2 だけが満たす。A1 と A3 は、ccn から一覧と送信しかできない。

## A2 の中身（選ばれた場合）

ccn に足すもの（claude-code-nodes は別プロジェクトなので、本人の了承を取ってから変える）:
1. PTY の Driver（`src/engine/pty-driver.ts`）。`Bun.spawn(["claude", "--session-id", id, ...], { terminal })` で起動する。出力の末尾（例: 2MB）を覚える。能力は send、interrupt、stop、events に加えて、新しく `terminal` を持つ。
2. 端末の口を3つ足す。
   - `GET /api/sessions/<id>/terminal`: 末尾の再生と、その後の出力を流す（WebSocket か SSE）。
   - `POST /api/sessions/<id>/terminal/input`: キーの入力。
   - `POST /api/sessions/<id>/terminal/resize`: cols と rows の変更。
   中継（`/n/<peer>/...`）も同じ口を通す。
3. `create_session` に `terminal: true` を足し、PTY の Driver で立てる。親は今と同じ from 行から導く。これが specter-agents の spawn_child の代わりになる。子を作る側の Claude Code は、ccn の MCP（create_session、send_message、read_messages、list_sessions の parent）をそのまま使う。
4. 承認: PTY の Driver は、Claude Code の hooks（PermissionRequest）を `--settings` で注入して承認の中身を受け、ccn の `answer_permission` で許可か拒否を返す。画面の文字は読まない。
5. 一覧の重複を避ける。PTY の Driver で動くセッションは `claude agents --json` にも出るので、端末のセッションの一覧から除く。

Claude Town で変えるもの:
- 右パネルを xterm.js（MIT、addon-fit）の端末にする。開いたときだけ ccn の端末の口に繋ぎ、閉じたら切る（30本を同時に描かない）。
- 新しいセッションは「新しい世帯を作る」のボタンから、ccn の create_session（terminal: true）で立てる。子は親のセッション自身が create_session で作る（2026-11-12、画面から子を足す操作はやめた）。
- Specter の send key、AppleScript の focus、`~/.specter/agents.json` への依存を外す。親子は ccn の parent から作る。いま Specter で動いているセッションは、端末のセッションとして一覧と送信だけを出す（画面は出せない）。
- 状態 hook と承認の欄は、PTY の Driver が出す承認に寄せる。

## 見積もり

- A1: Claude Town だけで中央値3時間、p90 6時間。長引きそうなのは、xterm.js の大きさ合わせと WebKit での入力、末尾の再生、承認をキーで返す部分。
- A2: ccn 側が中央値3時間、p90 6時間。Claude Town 側が中央値2時間、p90 4時間。長引きそうなのは、ccn の WebSocket と中継の口、PTY の Driver の試験（VM での live 試験）、一覧の重複の扱い。
- A3: 試作1本で30分から1時間。成り立つかの検証が先になる。

## 未確認のこと

- 30本の PTY を同時に持ったときの CPU とメモリ。どの案でも、試作の段階で測る。
- xterm.js の端末を開け閉めしたときの画面の復元の精度（末尾の再生で足りるか、ヘッドレスの端末で状態を持つ必要があるか）。
- `claude attach` を PTY の中で動かせるか（A3 の前提）。
