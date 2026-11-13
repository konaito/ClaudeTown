# 類似プロダクト調査

調査日は 2026-11-12。スター数、ライセンス、最終 push 日は同日に `gh api repos/<owner>/<repo>` で取得した。
データ源、見せ方、操作の欄は各リポジトリの README と docs の記述に基づく。ソースコードは読んでいない。README に書かれていない項目は「未確認」とした。

## 1. 候補一覧（17件）

### 1-1. キャラクター・オフィス・ペット系（コード付き）

| # | 名前 / URL | ライセンス | 最終 push | ★ | データ源 | 見せ方 | 操作 | 形態 |
|---|---|---|---|---|---|---|---|---|
| 1 | pixel-agents<br>https://github.com/pixel-agents-hq/pixel-agents<br>（旧 pablodelucca/pixel-agents から移管と読めるが、移管の経緯は未確認） | MIT | 2026-11-10 | 10167 | 既定は Claude Code hooks（SessionStart / PreToolUse / PermissionRequest / Stop）。hooks が使えないときは `~/.claude/projects/` の JSONL を走査して推定 | 1 エージェント 1 キャラのピクセルオフィス。机で打つ、読む、待つ。吹き出しと通知音。コンテキスト残量バー。レイアウトエディタ、着せ替え、ペット、8bit BGM | エージェントの起動と過去会話の再開、キャラ選択。端末フォーカスの仕組みあり（端末なしのエージェントは「フォーカス対象なし」と docs に記載）。キャラ経由の任意文送信は未確認 | VS Code 拡張 + `npx pixel-agents`（ローカルサーバー + ブラウザ） |
| 2 | Clawd on Desk<br>https://github.com/rullerzhou-afk/clawd-on-desk | コード AGPL-3.0。絵と同梱テーマは AGPL の対象外で全権利留保 | 2026-11-12 | 6727 | hooks とログ。Claude Code、Codex、Cursor など 20 種超 | 画面端のデスクペット。12 状態（idle / thinking / typing / building / subagent groove / juggling / error / happy / notification / sweeping / carrying / sleeping）。マウス追従の目、60 秒で居眠り | 許可バブルで Allow / Deny。ダッシュボードから該当端末へジャンプ。Telegram、Feishu、Slack 通知 | Electron |
| 3 | Star Office UI<br>https://github.com/ringhyacinth/Star-Office-UI | コード MIT。美術資産は商用禁止（README と LICENSE の記載） | 2026-03-11 | 7576 | `state.json` を更新して Flask が配信（OpenClaw 連携が前提）。Claude Code 直結かは未確認 | ピクセルオフィスの状態ボード。昨日の作業、オンライン状況。複数エージェント | 読み取り中心。指示送信は未確認 | Python + Web |
| 4 | pixel-agent-desk<br>https://github.com/zep-ia/pixel-agent-desk（README の clone 先は Mgpixelart/pixel-agent-desk） | MIT | 2026-03-10 | 137 | Claude Code の hook イベント | アバターごとの状態アニメ、仮想オフィス、ヒートマップ、トークン集計、PiP | アバターのクリックで端末を前面へ。サブエージェントとチームモード対応 | Electron |
| 5 | pixtuoid<br>https://github.com/pixtuoid/pixtuoid | MIT | 2026-11-12 | 559 | 各エージェント CLI の hooks（接続は `s` キーの設定画面）。詳細は未確認 | 端末内のピクセルオフィス。机で打つ、`?` を掲げる、居眠り。猫と犬が歩く。昼夜と季節。画像対応端末では断面図表示 | 同僚（キャラ）のクリックで端末を前面へ | Rust の TUI（Homebrew / npm） |
| 6 | Claude Office Visualizer<br>https://github.com/paulrobello/claude-office | MIT | 2026-11-11 | 615 | Claude Code hooks → FastAPI → WebSocket。OpenCode はプラグイン | 「ボス」がメインエージェント、「社員」がサブエージェント。working / delegating / waiting。コンパクション時にゴミ箱を踏む。複数階のビル | Command Center（Needs-you / Working / Done / Ended の列）で全端末を俯瞰。`focus` の API あり（鍵で保護） | Next.js + PixiJS + FastAPI（Docker 可） |
| 7 | Agents in the Office<br>https://github.com/gukosowa/agents-in-the-office | MIT | 2026-03-09 | 3 | hooks がイベント JSON をファイルに書き、Rust の `notify` が監視して Tauri イベントにする。サブエージェントは JSONL を Rust でポーリング | タイルマップ上の NPC。書く時は PC へ、読む時は本棚へ、待機は徘徊と雑談。直近のプロンプトを頭上に表示 | 承認待ちでカメラが NPC に寄り、警告マークと赤いビネット。指示送信は未確認 | Tauri + Vue |
| 8 | claude-pet<br>https://github.com/floatrx/claude-pet | 未設定（LICENSE なし） | 2026-03-31 | 1 | hook が `~/.claude/pet-state.json` に状態を書く | セッションごとにペット 1 匹、サブエージェントは小さいペット。モデル別の色とサイズ（Opus 金・大、Sonnet 橙・中、Haiku 緑・小）。6 状態（歩く、考える、打つ、祝う、目を回す、手を振る） | ドラッグ移動、ホバーで詳細。指示送信なし（README 範囲） | Tauri v2 + Canvas。透過、最前面、クリック透過。macOS の private API を使うと README に記載 |
| 9 | Pixel Office（KalebKE）<br>https://github.com/KalebKE/PixelOffice | Apache-2.0 | 2026-08-01 | 12 | エージェントのライフサイクル hooks（AgentEvent プロトコル）。Claude Code と Codex | 開発者キャラが考える、ホワイトボードで計画、打つ、コマンド実行、入力待ち、祝う、テスト失敗。待機中は巡回して雑談。プロジェクト別に家具と配色が固定。猫と犬 | 未確認 | Kotlin / Gradle のデスクトップ（JDK 17+） |
| 10 | claude-code-tamagotchi<br>https://github.com/Ido-Levi/claude-code-tamagotchi | MIT | 2025-10-20 | 438 | Claude の動作を監視。方式の詳細は未確認 | ターミナル内のバーチャルペット。主眼は指示違反の検知と阻止 | 違反操作のブロック。指示送信は未確認 | TypeScript（CLI） |
| 11 | Vibe Notch<br>https://github.com/farouqaldori/vibe-notch | Apache-2.0 | 2026-04-20 | 2537 | Claude Code hooks（初回起動で自動設定）。通信方式は未確認 | MacBook のノッチから広がるダイナミックアイランド風オーバーレイ。複数セッション監視、会話履歴 | ツール実行の承認 / 拒否 | Swift（macOS 15.6+） |
| 12 | OpenAgentPeek<br>https://github.com/zuoxu3310/openagentpeek | MIT | 2026-05-24 | 1 | Claude Code と Codex のセッション情報。取得方式は未確認 | メニューバーの信号（待ち / 作業中 / 静か）、コンテキスト使用率 | クリックでその端末、VS Code、Codex アプリの窓を前面へ | Rust / Tauri（macOS メニューバー） |

### 1-2. マルチエージェント管理 UI・シミュレーション系（比較用）

| # | 名前 / URL | ライセンス | 最終 push | ★ | データ源 | 見せ方 | 操作 | 形態 |
|---|---|---|---|---|---|---|---|---|
| 13 | claude-squad<br>https://github.com/smtg-ai/claude-squad | AGPL-3.0 | 2026-08-20 | 8789 | 自前でエージェントを起動して管理（README 範囲では tmux と git worktree。実装は未確認） | 一覧表示のみ。キャラなし | 起動、変更のレビュー、チェックアウト | Go の TUI |
| 14 | vibe-kanban<br>https://github.com/BloopAI/vibe-kanban | Apache-2.0 | 2026-11-12 | 28661 | 自前でエージェントを起動（10 種超）。ワークスペース単位でブランチと端末を持つ | かんばん。キャラなし | 差分へのインラインコメントをエージェントへ送信、PR 作成 | Web（`npx vibe-kanban`）。README 冒頭に「Vibe Kanban is sunsetting」の告知あり |
| 15 | Crystal<br>https://github.com/stravu/crystal | MIT | 2026-02-26 | 3128 | worktree ごとの並列セッション | キャラなし。説明文に「Crystal is now Nimbalyst」とあり、後継へ移行済み | 並列セッション管理 | Electron と読めるが未確認 |
| 16 | AI Town<br>https://github.com/a16z-infra/ai-town | MIT | 2026-11-05 | 10790 | LLM キャラ同士の会話シミュレーション。コーディングエージェントの監視ではない | タイルマップ上のキャラが歩き、話す | 人間の参加は未確認 | Convex + PixiJS。素材クレジットは OpenGameArt などの外部素材 |
| 17 | StarNet<br>https://github.com/androoAGI/starnet | MIT | 2026-11-11 | 1806 | 自前のエージェント実行基盤。部屋が権限付きチーム、廊下が引き継ぎ経路。画面は実行状態の投影 | ピクセルアートの宇宙ステーション | エージェントの作成、Telegram や Slack 経由の指示、OUTBOX で成果物を受け取る | デスクトップアプリ（フレームワークは未確認） |

調査の範囲外として扱ったもの: Generative Agents（学術、更新 2024-08）、MetaGPT（フレームワーク）。
メニューバー監視系は他にも Hawky、ClaudePulse、cctop、Coucou、VibeBar などが検索に出たが、リポジトリでの一次確認はしていない。

## 2. family-computing との照合

### 2-1. 流用できる素材・コード（a）

- コードで取り込みやすいのは MIT / Apache-2.0 のもの。pixel-agents、Claude Office、Agents in the Office、pixtuoid、pixel-agent-desk、Vibe Notch、Pixel Office が該当する。
- AGPL-3.0 の Clawd on Desk と claude-squad は、コードの取り込みを避け、設計の参考にとどめる。
- 同じ Tauri の先行例は Agents in the Office（MIT、ただしスター 3 で作者が「vibe coded」と明記）と claude-pet（ライセンスなし）。コードの転用は前者が現実的。イベントをファイルまたは受信口から Rust が受け、Tauri イベントでフロントへ流す構成が参考になる。
- スプライトの扱いは pixel-agents が最も整っている。外部アセットディレクトリとマニフェストの形式（`docs/external-assets.md`）、アセットマネージャ、着せ替えの部品化が参考になる。ただし素体は他者の素材（Metro City）が出自のため、そのまま流用しない。
- Clawd on Desk のテーマ仕様は「最小テーマ = idle の SVG 1 枚 + 状態別 GIF / APNG 7 枚（thinking, working, error, happy, notification, sleeping, waking）」。状態数の目安として使える。
- いずれも親子 3 階層以上の大量並列を前提にした設計は確認できていない。

### 2-2. 状態とキャラの動きの対応（b）

| 状態 | 各プロダクトの表現 |
|---|---|
| 作業中 | pixel-agents: 机に座って打つ（編集）、読む（検索）。Clawd: typing / building / thinking。claude-pet: ノート PC で打つ、考える時は頭をかく。Pixel Office: ホワイトボードで計画、打つ、コマンド実行 |
| 待機 | pixel-agents: 完了後は ✓ が自然に消える。Clawd: 目が追従し、60 秒で居眠り。pixtuoid: 居眠り。Pixel Office: 巡回して雑談 |
| 承認待ち | pixel-agents: 「…」の吹き出しが解決まで残る。Clawd: 許可カードと全体ホットキー。Agents in the Office: カメラが寄り、警告マークと赤いビネット。claude-pet: 手を振る。pixtuoid: `?` を掲げる |
| 入力待ち（質問） | pixel-agents は承認待ちと別の状態として定義（CONTEXT.md の「Waiting for input」）。他は承認待ちと区別しているか未確認 |
| エラー | Clawd: error。claude-pet: 目を回す。Pixel Office: テスト失敗。pixel-agents は専用状態の有無が未確認 |
| 完了 | pixel-agents: ✓。Clawd: happy。claude-pet: 祝う。Pixel Office: 祝う |

pixel-agents の CONTEXT.md は、非実行状態を「完了」「入力待ち」「承認待ち」の 3 形態に分け、承認待ちだけが実行の途中でも起きると明記している。状態の定義として最も明快。

### 2-3. 親子ツリーの見せ方（c）

| プロダクト | 見せ方 |
|---|---|
| Agents in the Office | サブエージェントを別 NPC にしてバッジを付け、親 NPC と線でつなぐ |
| claude-pet | サブエージェントは親の近くに小さいペットとして出る |
| Claude Office | メインがボス、サブが社員。1 階層。複数セッションは Command Center で集約 |
| pixel-agents | サブエージェントとチームメイトは別キャラとして出る。親との線の有無は未確認 |
| pixel-agent-desk | サブエージェントとチームモードに対応と記載。表現は未確認 |
| Clawd on Desk | 人数のみ（1 人でヘッドホン、2 人以上でジャグリング）。個別のキャラは出ない |

孫以上（深さ 3 以上）を扱う表現は、確認できた範囲では見当たらない。

### 2-4. 合う点・合わない点

合う点
- 状態を 3 系統（作業中、待機系、承認待ち）に絞り、吹き出しで示す作法がすでに固まっている。
- Tauri、Rust のファイル監視、Canvas の組み合わせに動く先行例がある。
- 「操作できる」ものは、端末ジャンプ（pixel-agents、pixel-agent-desk、pixtuoid、OpenAgentPeek、Clawd）と承認操作（Clawd、Vibe Notch）に集中している。

合わない点
- データ源が Claude Code の hooks と JSONL に寄っている。family-computing は ccn が正本なので、状態の取り方はそのまま使えない。
- キャラ側から任意の文を送る UI は、README の範囲では確認できなかった。クリックで指示を送る点は独自になる可能性が高い（網羅確認ではない）。
- 人数が数体前提で、数十体の並列と 3 階層の親子を一望する設計は確認できなかった。
- 見た目が「オフィス」「社員」に偏っている。「家族・子供」の表現は先行例が見つからなかった。

## 3. フリー素材候補（ライセンスは各ページで確認）

| 名前 / URL | ライセンス | 内容 | 注意 |
|---|---|---|---|
| Puny Characters（Shade、OpenGameArt）<br>https://opengameart.org/content/puny-characters | CC0（ページの License 欄で確認） | 16x16 向けの基本キャラ（32x32 キャンバス）。RPG 用 | 作者は「商用でも可」と記載 |
| Kenney 全アセット（例: Tiny Dungeon）<br>https://kenney.nl/assets/tiny-dungeon | CC0（アセットページの License 欄と https://kenney.nl/support で確認） | 16x16 のピクセルアセット。クレジット不要 | Tiny Dungeon にキャラが含まれるかは未確認。キャラを含むパックを選ぶ前に各ページで要確認 |
| MetroCity Free Top Down Character Pack（JIK-A-4、itch.io）<br>https://jik-a-4.itch.io/metrocity-free-topdown-character-pack | 「completely free」「Credits are not necessary but would be appreciated」。CC0 などの明示的な SPDX 表記は確認できず、再配布や改変の条件は未確認 | pixel-agents の素体の出自 | 条件が曖昧なため、使う前に作者へ確認するか、避ける |

BitBop の Top-Down Characters（itch.io）は、検索結果では CC0 とされていたが、ページ本文は「free & commercial 可、素材ファイルの再販と再配布は不可」と読めた。CC0 とは確認できないため、候補から外した。

## 4. family-computing が取り入れるべき 3 点

1. 状態の定義を pixel-agents の 3 形態（完了、入力待ち、承認待ち）に揃え、そこへ「作業中」と「エラー」を足した 5 状態にする。承認待ちは「…」の吹き出しが解決まで残る形にし、完了の ✓ は自然に消す。
2. 承認待ちを画面で最優先に目立たせ、その場から操作できるようにする。Agents in the Office のカメラ寄せと赤いビネット、Clawd の許可カードが先行例。family-computing ではこの導線に「文を送る」を足す。
3. 親子は線でつなぎ、子は小さく描く。数十体を一望する集約ビューは Claude Office の Command Center（Needs-you / Working / Done / Ended の列）を参考にする。

## 5. 避けるべき 3 点

1. 他者のキャラ、ライセンス不明の素材、AGPL のコードを取り込むこと。Clawd は Anthropic の所有物、Star Office UI の美術は商用禁止、Clawd on Desk の絵は全権利留保、Metro City は条件が曖昧。素材は CC0 か自作に限る。
2. エージェント種別ごとの対応を広げること。Clawd は 20 種超の対応を抱えている。family-computing は ccn 一本に寄せる。
3. 歩き回りやペットなどの演出を、状態の読み取りより優先すること。これは調査結果ではなく所見。大量並列では、どのキャラが待っているかが一目で分からないと目的を外す。

## 6. 調査の限界

- 各プロダクトの「最終 push」は main 以外のブランチも含む可能性がある（`pushed_at` の値）。
- 実装の確認ではなく README と docs の記述による。動作は試していない。
- WebSearch の結果に出たプロダクトのうち、一次確認したのは上の 17 件のみ。
- Vibe Notch の通信方式、StarNet のフレームワーク、Crystal の技術基盤などは未確認のまま残した。
