# agent team の実機での観測（2026-11-21）

Claude Code の agent team（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）で作ったチームメイトを、Claude Town の町に子として出すための観測である。版は Claude Code 2.1.330、モデルは haiku で行った。採取した生の JSON は `agent-teams-observed/` の下に置いた。

## 観測の仕方

- `/tmp/fc-team-obs/<回>/` に捨てのリポジトリを作り、プロジェクトの `.claude/settings.json` に hook を置いた。hook は全イベントの stdin をそのままファイルに書く。`teammateMode` は回ごとに `in-process` か `tmux` を入れた。グローバルの settings.json と登録済みの hook は変えていない。
- claude は自分専用の tmux サーバー（`tmux -L fcobs`）の中で、対話モードで起動した。`CLAUDE_CONFIG_DIR` などの自分のセッションの環境変数は外した。
- 頼んだのは、alpha と beta の2体のチームメイトを作り、それぞれ1ファイルを書かせることだけである。

| 回 | teammateMode | リードの session id | チーム名 | 結果 |
| --- | --- | --- | --- | --- |
| inproc1 | in-process | 4a38e9d3-8cde-4d65-894d-cd8192f6d8d3 | session-4a38e9d3 | 2体とも完了 |
| inproc2 | in-process | 4efbd1ba-8898-43c5-9e29-0e0c948dc52b | session-4efbd1ba | 2体とも完了 |
| tmux1 | tmux | ccdd10c6-4b19-40ac-8fcd-23888fb4ae8f | session-ccdd10c6 | 2体とも起動し、待機で止まった（下の注意を参照） |
| tmux2 | tmux | d35eb879-b166-4f7e-a890-c8a462e5ff26 | session-d35eb879 | 2体とも完了（下の「tmux の2回目」） |

tmux2 は、ccn を外す作業（feat/ccn-removal）の中で、別の子が取った。

### 観測の途中で分かった注意

- 最初の依頼（inproc1）で、リードは本人のグローバルの CLAUDE.md の委譲の決まりに従い、ccn の create_session を呼ぼうとした。これは断った。チームの道具を使えと頼み直すと、リードはチームメイトを作る道具が無いと答えた。今の版では、チームメイトは **Agent ツールに `name` を付けて呼ぶ** と作られる。`name` の無い Agent ツールは sub-agent になる。
- tmux の回では、チームメイトのペインが tmux サーバーの環境変数を引き継いだ。この回は観測用の tmux サーバーを自分のセッションから起動したため、`CLAUDE_CONFIG_DIR=~/.cam/profiles/ceo` と自分の `CLAUDE_CODE_SESSION_ID` がチームメイトに入った（`tmux1/teammate-ps.txt`）。このためチームメイトは、リードと別の設定の置き場所で信頼の確認に止まり、手で通した。製品の挙動ではなく観測の組み方による。ただし、tmux のチームメイトがリードではなく tmux サーバーの環境を持つことは、実際の使い方でも起きる。

## config.json の実物

置き場所は `~/.claude/teams/<チーム名>/config.json` である。cam の全プロファイルの `teams` は `~/.claude/teams` へのリンクなので、1か所を読めば全アカウントの分が読める。チーム名は `session-<リードの sid 先頭8字>` だった。

agent team が有効なセッションは、チームメイトを作る前から、リードだけの config.json を持つ。この観測をした自分のセッション（f5b74bcb）にもあった（`self-team/config.json` は写していない。キーは下と同じ）。

トップのキー（`~/.claude/teams` の61件を全部読んだ。読めないものは0件）:

- `name`、`createdAt`、`leadAgentId`、`leadSessionId`、`leadProcess`（`pid`、`pidSpace`、`claimedAt`）、`members`、`description`（古い名前付きのチームだけ）

members の1件のキー:

- `agentId`（`<名前>@<チーム名>`）、`name`、`agentType`、`joinedAt`、`tmuxPaneId`、`cwd`、`subscriptions`、`backendType`、`color`、`model`、`planModeRequired`、`prompt`

| 項目 | リード | in-process のチームメイト | tmux のチームメイト |
| --- | --- | --- | --- |
| agentId | team-lead@session-xxxx | alpha@session-xxxx | alpha@session-xxxx |
| backendType | in-process | in-process | tmux |
| tmuxPaneId | leader | in-process | %3（tmux のペイン id） |

members には、チームメイトの session id も pid も無い。

**公式ドキュメントとの違い**: ドキュメントは「セッション終了で削除」と書いている。実物では、`~/.claude/teams` の61件のうち58件は、`leadProcess.pid` のプロセスが既に無かった。終わったセッションのチームは消えずに残る。生死は `leadProcess.pid` で見る必要がある。

## hook の入力の実物

ファイルは `<回>/hooks/<時刻>-<pid>-<イベント>.json` である。

| イベント | inproc1 | inproc2 | tmux1 |
| --- | --- | --- | --- |
| SessionStart | 1 | 1 | 3（リードと2体） |
| UserPromptSubmit | 3 | 1 | 1 |
| PreToolUse / PostToolUse | 12 / 11 | 7 / 7 | 7 / 7 |
| SubagentStart | 2 | 2 | 0 |
| SubagentStop | 6 | 6 | 4 |
| TeammateIdle | 2 | 2 | 2 |
| Stop | 4 | 4 | 6 |
| Notification | 1 | 1 | 2 |
| PermissionRequest | 1 | 0 | 0 |
| TaskCreated / TaskCompleted | 0 | 0 | 0 |

TaskCreated と TaskCompleted は、どの回でも来なかった。タスクの一覧を使わせる依頼をしていないためと思われるが、確かめていない。

### in-process（inproc1 の実物から抜粋）

チームメイトの hook も、`session_id` はリードの id である。チームメイトかどうかは `agent_id` と `agent_type` で分かる。

```json
{"session_id":"4a38e9d3-…","hook_event_name":"SubagentStart","agent_id":"aalpha-08031d97a7e1dd9b","agent_type":"alpha", "transcript_path":".../4a38e9d3-….jsonl"}
{"session_id":"4a38e9d3-…","hook_event_name":"TeammateIdle","agent_id":"abeta-770e6dc0871690da","agent_type":"beta","teammate_name":"beta","team_name":"session-4a38e9d3"}
{"session_id":"4a38e9d3-…","hook_event_name":"PreToolUse","agent_id":"aalpha-08031d97a7e1dd9b","agent_type":"alpha","tool_name":"SendMessage"}
```

- `agent_id` は `a<名前>-<16桁の16進>` で、transcript のファイル名 `agent-<agent_id>.jsonl` と同じである。
- リードの SubagentStop の `background_tasks` に、`{"type":"teammate","status":"running","description":…}` の形でチームメイトが並ぶ。

### tmux（tmux1 の実物から抜粋）

チームメイトは自分の `session_id` を持つ。

```json
{"session_id":"b3fb04b0-4b4c-4d79-880e-c07440099d7b","hook_event_name":"SessionStart","agent_type":"general-purpose","source":"startup", "transcript_path":"/Users/konaito/.cam/profiles/ceo/projects/-private-tmp-fc-team-obs-tmux1/b3fb04b0-….jsonl"}
{"session_id":"b3fb04b0-…","hook_event_name":"TeammateIdle","agent_type":"general-purpose","teammate_name":"alpha","team_name":"session-ccdd10c6"}
```

- `agent_id` は付かない。`agent_type` は general-purpose で、チームメイトの名前ではない。
- SubagentStart はリードに来なかった。

## チームメイトの session id、pid、transcript の場所

| | in-process | tmux |
| --- | --- | --- |
| プロセス | リードの中（別の pid は無い） | 別のプロセス。tmux のペインの中で claude の実行ファイルが直接動く |
| 起動の引数 | なし | `--agent-id alpha@session-ccdd10c6 --agent-name alpha --team-name session-ccdd10c6 --parent-session-id <リードの sid> --agent-type general-purpose …`（`tmux1/teammate-ps.txt`） |
| session id | リードと同じ | 自分の id（b3fb04b0、58eebd3d） |
| `~/.claude/sessions/<pid>.json` | 作られない（リードの分だけ） | **作られない**。`sessions/<pid>.<ハッシュ>.key` だけが残った |
| transcript | `projects/<dir>/<リードの sid>/subagents/agent-<agent_id>.jsonl` | `projects/<dir>/<自分の sid>.jsonl`（リードと同じ階層） |
| meta.json | `agent-<agent_id>.meta.json`。`taskKind: in_process_teammate`、`teamName`、`name`、`agentType`（=名前） | 無い |
| jsonl の行の印 | （未確認。meta.json で足りる） | user と attachment の行に `teamName` と `agentName` がある（`tmux1/jsonl-identity.jsonl`） |

リードの `sessions/<pid>.json` には、tmux の中で動いていると `"tmux":"tmux1:@2.%2"` が付いた（`tmux1/sessions-45195.json`）。

## 親子の引き方の案

1. **in-process**: 今の `src-tauri/src/native/subagents.rs` で拾える。#96 で入れた読み方は、リードの `subagents/` の下の meta.json が `taskKind: in_process_teammate` なら teammate として子にする。今回の実物（2回とも）は、この形に合った。足すことは無い。ただし、`finished` が付かないので、実行中かは jsonl の更新時刻だけで決まる（今の ACTIVE_MS の決め方のまま）。
2. **tmux**: 今の読み方では町に出ない。`sessions/<pid>.json` が無いため、`native::sessions::live` の一覧に入らない。案は次の2つで、どちらも実物にある鍵だけを使う。
   - A. `~/.claude/teams/*/config.json` を読む。`leadProcess.pid` が生きているチームの members のうち `backendType: tmux` のものを、`leadSessionId` の子として出す。会話は `projects/<cwd を直した名前>/` の jsonl のうち、行の `teamName` と `agentName` が合うものから読む。生死は jsonl の更新時刻で決める（pid が config.json に無いため）。
   - B. `ps` で `--parent-session-id` と `--agent-name` の付いた claude のプロセスを探し、引数から親と名前を取る。pid の生死も分かる。会話の jsonl は、同じ cwd の projects の下で `agentName` の合うもの。
   - A は ps を起こさず、B はプロセスの生死が確かに分かる。A で一覧を作り、生死の判定にだけ B を使う組み合わせが無理が少ない。tmux の回が1回しか取れていないので、決める前にもう1回取る。
3. **hook の状態ファイル**: in-process のチームメイトの hook は、リードの `session_id` で届く。今の `hooks/fc-report.py` は `agent_id` を見ていないので、チームメイトの PreToolUse などがリードの状態ファイル（「いまやっていること」）に混ざるはずである。確かめていない。混ざるなら、`agent_id` があるイベントはリードの状態に書かない、などの手当てが要る。
   - 2026-11-23 の追記: 2026-11-21 の b2a0e8c で、`fc-report.py` は `agent_id` の付いた入力をリードの状態ファイルとお手紙に書かない形にした。承認だけはリードの並びに足して外す。確かめたのは `hooks/test_fc_report.py` の `MATE` を使う試験で、実物の状態ファイルでは見ていない。
4. 知らない形（members の知らない backendType、jsonl の無い member など）は、`Stats::odd` に数えて黙って落とさない。

## tmux の2回目（tmux2）

1回目の注意を受けて、tmux サーバーを `env -i` で起動した（HOME、USER、SHELL、LANG、TERM、PATH だけを渡し、`CLAUDE_CONFIG_DIR` と `CLAUDE_CODE_SESSION_ID` を外した）。サーバー名は `-L fcobs2`、場所は `/tmp/fc-team-obs2/tmux2/` で、hook と teammateMode は1回目と同じ形にした。リードの信頼の確認は tmux の send-keys で通した。チームメイトは信頼の確認で止まらず、2体ともファイルを書いて報告し、待機に入った。

1回目と同じだったこと（2回とも同じなので、実装の根拠にした）:

- チームメイトの claude は別のプロセスで、引数に `--agent-id <名前>@<チーム名>`、`--agent-name`、`--team-name`、`--parent-session-id <リードの sid>` がある（`tmux2/teammate-ps.txt`）。
- `~/.claude/sessions/<pid>.json` は作られない。`sessions/<pid>.<ハッシュ>.key` だけがある（`tmux2/sessions-dir-teammates.txt`）。起動から25分たっても作られなかった。
- 会話は `projects/<cwd の名前>/<自分の sid>.jsonl` で、user、assistant、attachment、system の行に teamName と agentName がある（`tmux2/jsonl-identity.jsonl`）。
- config.json の members の tmux のチームメイトには backendType: tmux と cwd があり、pid と session id は無い。
- チームメイトの hook は自分の session_id で届き、TeammateIdle に teammate_name と team_name が付く。

1回目と違ったこと:

- 起動の引数の `--agent-type general-purpose` と、config.json の member の agentType が、2回目には無かった。SessionStart の hook の agent_type も null だった。agentType には頼らない。
- hook の状態ファイル（`~/.family-computing/state/<sid>.json`）は、チームメイトの session id でも書かれた（ca615164、9ff4c1fc）。町では、tmux のチームメイトの様子をこのファイルから読む。

コードを読んだ範囲で分かったこと: `hooks/fc-report.py` は hook の入力の agent_id を見ていない。in-process のチームメイトと sub-agent の PreToolUse などは、リードの session_id で届くので、リードの状態ファイルの「いまやっていること」に混ざるはずである。実物の状態ファイルでは確かめていない。町の sub-agent とチームメイトの様子は meta.json と jsonl の末尾から作るので、混ざるのはリードの表示だけになる。この段落は観測した時点のコードの話で、今の `fc-report.py` は `agent_id` を見る（上の3の追記）。

## まだ確かめていないこと

- tmux のチームメイトに長い作業をさせたときの流れ（2回とも、1ファイルを書くだけだった）。
- TaskCreated、TaskCompleted の入力（タスクの一覧を使わせていない）。
- チームを片付けた（チームの削除を頼んだ）ときに、config.json と transcript がどうなるか。
- in-process のチームメイトの hook が、fc-report.py の状態ファイルに混ざるか（観測した時点のコードでは混ざった。b2a0e8c で書かない形にしたが、実物では確かめていない）。
- `~/.claude/tasks/<チーム名>/` と `inboxes/` の中身（見ていない）。

## 生の記録の一覧

`agent-teams-observed/<回>/` の下に次を置いた。

- `hooks/`: hook の stdin そのもの
- `team-config.json`: チームの config.json
- `sessions-<pid>.json`: リードの `~/.claude/sessions/<pid>.json`
- `subagents-meta/`: in-process のチームメイトと sub-agent の meta.json
- `transcript-files.txt`: transcript のファイルの一覧
- `project-settings.json`: 観測に使ったプロジェクトの設定（hook と teammateMode）
- `tmux1/teammate-ps.txt`: tmux のチームメイトのプロセスの引数
- `tmux1/jsonl-identity.jsonl`: tmux のチームメイトの jsonl から、行の種類ごとに識別の項目だけを抜いたもの。jsonl の本体には本人の CLAUDE.md を含むシステムプロンプトが入るので写していない
