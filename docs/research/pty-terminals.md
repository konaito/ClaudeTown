# Claude を PTY で束ねる OSS と部品の調査

調査日は 2026-11-12。GitHub の値は `gh api repos/<owner>/<repo>` の一次情報。公式ドキュメントは code.claude.com の本文を取得して確認した。コードの動作確認はしていない（実行したものは無い）。確認できなかった項目は「未確認」と書く。

## 結論

- 30体を1つのアプリが PTY で持つ構成の先行例は、Tauri + portable-pty + xterm.js が claude-view と racker-terminal、サーバー側 node-pty + xterm.js が mulmoterminal と Nimbalyst。形そのものは確立している。
- アプリを閉じても生かす方法は2つある。tmux に PTY を預ける（Claude Squad、Agent Deck、mulmoterminal、cmux の opt-in）か、Claude Code 自身のバックグラウンドセッション（`claude --bg`、supervisor）に預ける。後者は公式機能で、自前デーモンを書かずに済む可能性がある。ただし attach の挙動は未検証。
- 30本の PTY の重さを測った一次情報は見つからなかった。実測が要る。

## 1. 類似 OSS

| 名前 | URL | ライセンス | 最終 push | スター | PTY の持ち方 | アプリを閉じても生きるか | 画面状態の保持 | 承認・入力の扱い | 親子 | 合う点 | 合わない点 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Squad | github.com/smtg-ai/claude-squad | AGPL-3.0 | 2026-08-20 | 8789 | tmux セッション。attach 時に `creack/pty` で `tmux attach` を包む（Go TUI） | 生きる（tmux） | `CapturePaneContent`（capture-pane）で内容を読む | trust プロンプトを pane 内容から検出して Enter を送る。auto-yes あり | 未確認（git worktree 単位の並列。親子の概念は README に無い） | tmux 方式の実例。worktree 隔離 | AGPL。TUI でありデスクトップ UI の部品ではない |
| Nimbalyst（旧 Crystal） | github.com/nimbalyst/nimbalyst（旧 stravu/crystal） | MIT | 2026-11-11（Crystal は 2026-02-26 で更新停止、Nimbalyst に改名） | 2067（Crystal 3127） | Electron。`node-pty` を同梱し、`@anthropic-ai/claude-agent-sdk` も使う | 未確認 | 未確認 | Agent SDK 経由の承認 UI（赤緑 diff の承認）。PTY 内 TUI の承認は未確認 | 未確認 | 並列セッションと kanban の UI の参考 | Electron。主経路が SDK で、claude の TUI を本物の端末で見せる方式ではない可能性（未確認） |
| CCManager | github.com/kbwo/ccmanager | MIT | 2026-10-27 | 1278 | tmux 不要。自前 PTY（依存に `@xterm/headless` と `@xterm/addon-serialize`、UI は ink） | 未確認（tmux を使わない作りなので、プロセスが落ちれば終わる可能性が高いが未確認） | `@xterm/headless` + `addon-serialize` で状態を保持（依存から読み取り。使い方の詳細は未確認） | 状態検出で auto-approval（AI 検証付き、experimental）。claude には `--teammate-mode in-process` を自動付与して PTY 管理との衝突を避ける | 未確認 | headless + serialize という、こちらの設計に最も近い部品の組み合わせ。MIT | TUI（ink）でありデスクトップではない |
| opcode（旧 Claudia） | github.com/winfunc/opcode | AGPL-3.0 | 2026-11-06 | 22436 | PTY を使わない。`claude -p --output-format stream-json` を tokio で起動（claude.rs で確認） | 未確認 | セッション履歴を読み直して resume（`--resume`） | 権限は設定で事前に制御する形。対話の承認は未確認 | 未確認 | Tauri の実例。スター最多 | PTY でなく stream-json なので TUI を見せる要件に合わない。AGPL |
| cmux | github.com/manaflow-ai/cmux | NOASSERTION（LICENSE 名は "Other"。要確認） | 2026-11-12 | 28774 | Ghostty ベースの macOS ターミナル。通常は Ghostty の PTY。`cmux local-tmux` で tmux を持続層に使える（opt-in） | 既定では閉じると終わる。opt-in の tmux なら生きる | スクロールバックを「best effort」で保存し、再起動時に復元。hooks が保存した session ID で agent を resume | `cmux claude-teams` で teammate を分割ペインに出す。通知あり | 対応（teammate を native split で表示） | こちらが今使う Specter（Ghostty 系）に最も近い。親子の見せ方の参考 | ライセンスが不明確。アプリでなく端末そのもの |
| Agent Deck | github.com/asheshgoplani/agent-deck | MIT | 2026-11-11 | 1251 | tmux（Go TUI。依存に `creack/pty`、`charmbracelet/x/vt`） | 生きる（tmux） | tmux。archive は tmux を止めるが会話・メタデータ・親子リンクは保持 | status 検出（running → waiting 等）で親へ通知。conductor（常駐の監督セッション）が自動応答か人へエスカレーション | 対応（`session children`、親リンク、子完了を親に通知） | 親子と状態遷移通知の実装が最も近い。MIT | TUI。tmux 依存 |
| Sculptor | github.com/imbue-ai/sculptor | MIT | 2026-11-12 | 246 | 未確認（README に PTY の記述なし。Electron と Docker 関連ファイルがある） | 未確認 | 未確認 | 未確認 | 未確認 | 並列エージェントの UI | 「実験的な研究プレビュー」と README が明記。外部貢献を受け付けていない |
| Conductor | conductor.build | クローズド | - | - | - | - | - | - | - | 除外（依頼の指示どおり） | - |
| mulmoterminal | github.com/receptron/mulmoterminal | MIT | 2026-11-10 | 265 | サーバー側 `node-pty`（1セッション1PTY）→ WebSocket → ブラウザの xterm.js | tmux があれば生きる（再起動後に復帰） | tmux + 出力バッファの再生。`GET /api/terminal/:id/screen` で現在の画面を平文で返す | hooks で状態検出（blocked = 権限待ち、等）。`-p` や Agent SDK は使わず対話モード。権限プロンプトはそのまま動く | 未確認 | 「本物の PTY の対話モードを格子で並べ、待ち状態を色で示す」点が Claude Town の目的に近い | ブラウザ + Express 構成。Tauri ではない |
| claude-view | github.com/Quantum-vik/claude-view | ライセンス欄なし | 2026-09-20 | 0 | Tauri + Rust `portable-pty` → バイナリ WebSocket → xterm.js | 窓を閉じても PTY は殺さない。アプリ終了後は未確認 | サーバーが PTY 出力の末尾 2 MB を保持し、再接続時に再生 | 既定で `--dangerously-skip-permissions` で起動（承認が出ない）。トグルで切替 | 対応（transcript の subagent ファイルを tail して agent strip に表示） | 構成が Claude Town と同じ（Tauri + portable-pty + xterm.js）。スクロールバック再生の最小実装 | スター 0、ライセンス不明。参考実装としてのみ |
| racker-terminal | github.com/kogasura/racker-terminal | MIT | 2026-11-12 | 1 | Tauri 2 + React + xterm.js + portable-pty | 再起動後の resume（`claude --resume` 系。PTY 自体の存続は未確認） | 未確認 | タブ単位の状態表示（working / blocked / done） | 未確認 | 同じ技術構成 | Windows 向け。小規模 |

補足:
- Claude Squad のスター数と最終 push は `gh api` の値。tmux.go の `CapturePaneContent` の存在はソースの grep で確認した。
- opcode が stream-json である根拠は `src-tauri/src/commands/claude.rs` の引数（`-p`、`--output-format stream-json`）。
- CCManager の headless 使用は `package.json` の依存からの推定。コードは読んでいない。
- 他に見つかった小規模の候補（いずれもスター 30 未満）: izll/agent-session-manager-desktop（Wails + xterm.js）、Bendzae/showrunner（tmux）、clank（Tauri v2、4セル）。詳細は未確認。

## 2. 部品

| 部品 | URL | ライセンス | 最終更新 | Rust（Tauri）側で使えるか | 備考・重さの一次情報 |
|---|---|---|---|---|---|
| xterm.js（@xterm/xterm） | github.com/xtermjs/xterm.js | MIT | 2026-11-08（npm 6.0.0） | 不可（WebView 側。TS） | スター 21347。30体分の同時描画の重さは未確認 |
| @xterm/addon-serialize | 同上 addons/addon-serialize | MIT | 2026-11-08（0.14.0） | 不可（JS） | 端末のフレームバッファを文字列か HTML にする。README が「実験的」と明記 |
| @xterm/addon-fit | 同上 addons/addon-fit | MIT | 2026-11-08（0.11.0） | 不可（JS） | 親要素に合わせて cols/rows を決める |
| @xterm/addon-webgl | 同上 addons/addon-webgl | MIT | 2026-11-08（0.19.0） | 不可（JS） | 描画を GPU にする。30体なら表示中の端末だけに付ける、などの運用になる見込みだが未確認 |
| @xterm/headless | 同上 headless | MIT | 2026-11-08（6.0.0） | 不可（Node 用。WebView でも動くかは未確認） | README が「実験的」と明記。サーバー側で端末状態を持つ用途を想定と記載。CCManager が使用 |
| portable-pty | github.com/wezterm/wezterm（pty/） | MIT | crates.io 0.9.0、2025-02-11 | 可（Rust crate。claude-view と racker-terminal が Tauri で使用） | DL 数 2800万。wezterm 本体の push は 2026-11-12。30本の負荷の一次情報は未確認 |
| tauri-plugin-pty / tauri-pty | github.com/Tnze/tauri-plugin-pty | ライセンス欄なし（npm の tauri-pty は MIT） | 2026-07-08 | 可（Tauri v2 プラグイン。内部は portable-pty と推定、未確認） | スター 22。README は「Developing」と書く。xterm.js 用の `spawn` API あり。マルチ PTY の扱いは未確認 |
| node-pty | github.com/microsoft/node-pty | MIT（npm）。GitHub API は NOASSERTION | 2026-11-02（npm 1.1.0） | 不可（Node ネイティブ） | Nimbalyst と mulmoterminal が使用。Tauri に載せるなら Node サイドカーが要る |
| vt100（crate） | github.com/doy/vt100-rust | MIT | 2026-10-19（0.18.1） | 可 | 「端末のバイト列を解釈し、描画後の内容をメモリに持つ」。screen や tmux のような用途を想定と README に記載。DL 1900万 |
| alacritty_terminal | github.com/alacritty/alacritty | Apache-2.0 | crates.io 0.26.0、2026-04-06 | 可 | 端末エミュレータ用ライブラリ。ヘッドレスでの状態保持の実績は未確認 |
| wezterm-term | wezterm リポジトリ内 | 未確認 | 未確認 | 可（と推定。未確認） | crates.io の API 取得に失敗したため詳細は未確認 |
| tmux control mode | github.com/tmux/tmux/wiki/Control-Mode | ISC（tmux 本体） | tmux 本体 2026-11-12 | 可（子プロセスとして `tmux -CC` を起動してテキストを読む） | `%output %<pane> <data>` で出力を受け、制御文字と `\` は8進にする。遅れた pane は `%pause` で止められる（`pause-after`）。再同期には `capture-pane` が要る。スケール指針は wiki に無い |

重さについて: 「30本の PTY」の実測値を載せた一次情報は見つからなかった。mulmoterminal の README に「IDE 複数窓より軽い」という利用者の体験談があるが、本人が「ベンチマークではない」と書いている。使わない。

## 3. Claude Code 自体の仕組み

出典はすべて code.claude.com/docs/en/ の該当ページ（cli-reference、agent-view、cross-session-messaging、hooks、remote-control）。バージョンは各ページ記載のもの。実機での動作確認はしていない。

| 仕組み | 内容 | Claude Town での使い道 | 注意 |
|---|---|---|---|
| `claude agents --json` | 背景セッションと対話セッションの配列を出す。フィールドは `cwd`、`kind`（interactive / background）、`startedAt`、`id`、`state`（working / blocked / done / failed / stopped）、`pid`、`status`（busy / waiting / idle）、`waitingFor`（permission prompt / input needed / sandbox request / worker request / dialog open）、`sessionId`、`name`。`--cwd`、`--all` あり | 状態と「何を待っているか」を取れる。ポーリングで足りる | 親子の項目が無い。公式が「subagent や teammate は別行にならない」と書く。親子は別手段（hooks か transcript）で作る必要がある |
| バックグラウンドセッション（`claude --bg`、supervisor） | supervisor が各セッションを別プロセスで動かし、端末やエージェントビューを閉じても動き続ける。`claude attach <id\|name>` で端末に接続、`claude logs`、`claude stop`、`claude respawn`、`claude --resume <id> --bg "prompt"` あり。状態は `~/.claude/daemon/roster.json` と `~/.claude/jobs/<id>/state.json`。約1時間 attach されていない完了・待機セッションは停止し、会話は残って再開できる | アプリを閉じてもセッションを生かす層を、自前デーモン無しで得られる可能性がある。Claude Town が PTY 内で `claude attach` を動かす案が成り立つかは要検証 | 研究プレビュー。attach は端末を丸ごと奪う全画面で、30本同時の attach の重さは未確認。Claude セッションが PTY で動くかは公式ページから確認できなかった（シェルジョブのみ PTY と明記）。マシンの電源断で停止 |
| 入力・承認のスクリプト操作 | 実行中の背景セッションへ返信・承認する非対話コマンドは文書に無い。返信はエージェントビューの peek パネル、承認は attach が必要。「ダイアログへの返信は答えにならない」と書かれている | 承認は PTY の入力として直接書くか、hooks で処理する | 文書に無い。未確認ではなく「文書に無い」 |
| hooks | 33 イベント（`SessionStart`、`PermissionRequest`、`Notification`、`Stop`、`SubagentStart`、`SubagentStop` など）。入力 JSON に `session_id`、`transcript_path`、`cwd`、`permission_mode`、`agent_id`、`agent_type`。型は command / http / mcp_tool / prompt / agent。`PermissionRequest` は `hookSpecificOutput.decision.behavior` で allow / deny を返せる | 承認をアプリの画面で受ける道。http 型の hook でアプリに POST させ、応答で allow / deny を返す。`Notification` は `agent_needs_input` / `agent_completed` の型を持つ | 親セッションを指す項目は文書に無い。`PermissionRequest` の完全なスキーマは取得できた範囲では未確認 |
| cross-session messaging | `ListAgents` と `SendMessage`（v2.1.224 以降、macOS/Linux）。セッションごとの Unix ソケットで配送。パスは `/status` の `Peer address`（`uds:` 付き）と環境変数 `CLAUDE_CODE_MESSAGING_SOCKET`、トークンは `CLAUDE_CODE_MESSAGING_TOKEN`。通常の置き場所の記述は無く、受け付けられないディレクトリのときの代替として `/tmp/cc-socks-<uid>` が文書にある。1行目に `{"type":"auth","token":"..."}` を送る（macOS/Linux では省略可）。同一マシンの送信は Anthropic サーバーを通らない | 外から文を入れる経路。ソケットに書けば、Claude を介さずセッションに文を届けられる | 受けた文は承認として扱われない（ペンディングの権限プロンプトに答えられない）。受信側の `crossSessionInbound` が hold / refuse にできる。bypass 同士でない限り承認ダイアログで保留される場合がある。ソケットに送る具体的なメッセージ形式（auth 行以外）は文書から確認できず未確認 |
| `--resume` / `--session-id` / `--name` / `--fork-session` | ID か名前で再開。`--session-id` で UUID を指定して起動。`--name` で表示名 | Claude Town が ID を先に決めて起動すれば、セッションと画面のキャラを結びつけられる | - |
| `--settings` | JSON ファイルかインライン JSON で、そのセッションだけ設定を上書き | Claude Town 専用の hooks（http）を、ユーザーの設定を触らずに注入できる | 設定の優先順位の詳細は未確認 |
| `claude remote-control`（`--rc`） | claude.ai やアプリから、手元のセッションを操作する。サーバーモードで同時 32 セッション（`--capacity`）。接続は手元からの外向き HTTPS のみ | 今回の要件（自アプリの端末表示）の代わりにはならない | claude.ai のサブスクリプション認証が必要（API キー不可）。第三者アプリが使える API かは文書から確認できず未確認 |
| `claude -p` + `--input-format stream-json` + `--permission-prompt-tool` | 非対話で構造化入出力と承認を MCP ツールに任せる | 画面を持たない補助実行に使える | 対話モード（TUI）を端末に出す今回の要件とは別系統 |
| `--teammate-mode` | agent teams の表示方式（in-process / auto / tmux / iterm2） | CCManager のように `in-process` を強制して、PTY 管理との衝突を避ける参考 | 実際に衝突するかは未確認（CCManager の README の記述） |

## 4. Claude Town が流用すべきもの3つ

1. **Tauri + portable-pty + xterm.js の構成と、PTY 出力の末尾バッファ再生。** claude-view が 2 MB の末尾再生を実装済みで、構成が同じ。Rust 側で PTY を持ち、WebView の xterm.js に流す。一番の近道。ライセンス不明なので、コードは写さず設計だけ参考にする。
2. **Claude Code の hooks（http 型）と `--settings` による Claude Town 専用の注入。** 承認（`PermissionRequest`）、待ち状態（`Notification`）、サブエージェント（`SubagentStart/Stop`）を公式の経路で受けられる。画面の文字を読む方式（Claude Squad の trust プロンプト検出）より壊れにくい。親子の項目が無い点は、`SessionStart` で自分が付けた `--session-id` と対応づけて補う。
3. **`claude agents --json` による状態の取得と、`--bg` / `attach` / `--resume` による存続の層。** 状態と待ち種別（`waitingFor`）が公式の JSON で取れる。存続は、自前デーモンを書く前に「PTY 内で `claude attach` を動かす」案を1本だけ試作して確かめる価値がある。ダメなら tmux（Agent Deck と mulmoterminal が実績）に切り替える。

## 5. 避けるべきもの3つ

1. **AGPL のコードの取り込み（Claude Squad、opcode）。** 取り込むとアプリ全体に AGPL の義務が及ぶ。設計を読むだけにする。
2. **PTY を使わない方式（opcode の stream-json、Agent SDK 経由）を主経路にすること。** 右パネルを本物の端末にする要件と合わない。承認や TUI の表示が自前の再実装になる。
3. **画面の文字列を読んで状態や承認を判定する方式を主にすること（Claude Squad の trust 検出、capture-pane の解析）。** claude の TUI の変更で壊れる。hooks と `agents --json` を主にし、画面の読み取りは補助に限る。なお、`tauri-plugin-pty` のような小規模（スター 22、「Developing」）なプラグインに PTY 管理を丸ごと任せることも避け、portable-pty を直接使う。

## 6. 未確認として残った項目

- 30本の PTY を同時に持ったときの CPU・メモリ（どの部品でも一次情報なし）。
- xterm.js の端末を30個並べたときの描画負荷。
- 「PTY 内で `claude attach` を動かす」構成の実動作（再接続時の画面復元、同時 attach 数、サイズ変更）。
- Claude セッションが supervisor 配下で PTY として動くか。
- Nimbalyst、Sculptor、opcode の存続性と画面状態の保持。
- cmux の LICENSE 全文、wezterm-term の詳細。
- 受信ソケットに送るメッセージの形式（auth 行以外）。
