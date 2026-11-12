# ccn の転出（teleport）の仕様

2026-11-12 に、ccn の転出を読んで書いた。Claude Town に「転出」を足すための調査で、どのリポジトリのコードも書き換えていない。

- 対象のコード: `~/Documents/claude-code-nodes.wt/session-teleport`（`feat/session-teleport`、HEAD `41741d3`、konaito/claude-code-nodes#18、未マージ）。以下の `src/...:行` はすべてこの worktree のもの。
- 読んだもの: `docs/superpowers/specs/2026-11-12-session-teleport-design.md`、`docs/results/2026-11-12-session-teleport.md`、`src/api/`、`src/teleport/`、`src/cli/teleport.ts`、`src/mcp/tools.ts`、`src/relay/relay.ts`。
- 確かめた手段は、コードを読んだことだけ。API は1本も実行していない。実機での動作は、結果の文書（`docs/results/2026-11-12-session-teleport.md`）の記述に頼る。読んだだけの記述には「コードから」と付けた。
- 動かせるのは移動元・移動先の両ノードが PR #18 の版のときだけ。古い版のノードは道が無く、本文 `{"error":"not found"}` の 404 を返す（`src/api/app.ts:144`、`src/cli/teleport.ts:16`）。

## 1. 転出の API

### 全体の形

進み具合を返す口（SSE もポーリング用の状態）は無い（コードから。`/api/events` と `/api/sessions/:id/events` に teleport の段階を出す処理は grep で見つからなかった）。実行は1本の POST で、終わるまで応答が返らない。その中でノードが「下見、止める、書き出す、取り込む」を順に進める（`src/api/sessions.ts:302-327`）。

Claude Town が出せる進み具合は、次の2種類に限られる。

- 画面側で段階を分けて見せる。「移動元を調べる（GET）」「行き先を下見する（POST check）」「実行（POST teleport、応答待ち）」の3呼び出しなら、段階ごとに表示を切り替えられる。
- 実行中の中身（clone、bundle、取り込み）は見えない。見せるなら「実行中」の1つだけになる。

### HTTP

どのパスも `127.0.0.1` のノードに送る。別の機械のノードへは `/n/<peer>/api/...` で中継される（`src/api/app.ts:60-64`）。

| 用途 | メソッドとパス | どのノードに送るか |
| --- | --- | --- |
| 移動元の説明（下見の1段目） | `GET /api/sessions/:id/teleport` | 移動元のノード |
| 行き先の下見（下見の2段目） | `POST /api/teleport/check` | 行き先のノード |
| 実行 | `POST /api/sessions/:id/teleport` | 移動元のノード |
| 手元へ持ってくる（pack の書き出し） | `POST /api/sessions/:id/export` | 移動元のノード。Claude Town は使わない |
| pack の取り込み | `POST /api/teleport?cwd=` | 行き先のノード。移動元のノードが呼ぶ。Claude Town は使わない |

ルーティング: `src/api/app.ts:113-117`（`/api/teleport` と `/check`）、`:136-140`（`/sessions/:id/teleport` と `/export`）。

#### GET /api/sessions/:id/teleport（移動元の説明）

`src/api/sessions.ts:229-240`。応答は次の形。

```
{ id, kind, state, capabilities, title, permissionMode, awaitingFirst, live,
  from: { node, cwd, lobby }, git: { remote, repoName, rel, branch } | null }
```

- `kind` は `"node"` か `"terminal"`（`src/sessions/types.ts:3`）。過去のセッションの `kind` は未確認（history.ts を読んでいない）。
- `live` は、台帳で終わっていない、または端末で動いている、のとき true。
- `git` は cwd が git のリポジトリでなければ null。

#### POST /api/teleport/check（行き先の下見）

`src/api/sessions.ts:280-288`、`src/teleport/place.ts:30-79`。

要求（JSON）:

```
{ id?, fork?, cwd?, from: { node, cwd, lobby }, git: RepoInfo | null }
```

`from` と `git` は、上の GET の応答のものをそのまま渡す。`cwd` は行き先のノード上の絶対パスで、省くと remote で探す。

応答（200）: `{ node, cwd, top, cloned }`。

- `node` は行き先のノード名。`cwd` は行き先で使うディレクトリ。`top` はリポジトリの最上位（git でなければ null）。`cloned` は下見の中で clone したか。

**この下見には副作用がある**。remote が一致する場所が無ければ、`~/Documents/<リポジトリ名>` に `git clone` する（`place.ts:60-74`）。`~/Documents` が無い機械では作る。「見るだけ」の API ではない。clone を避けたいなら、画面で先に `--cwd` に当たる欄を出すか、行き先の `GET /api/places` で一致する場所を確かめる必要がある。

下見で断るもの（行き先の状態）:

- 作業ツリーが汚れている（409、`code: "dirty"`）。
- merge や rebase などの途中（409、`code: "busy"`）。
- 同じ id が行き先で生きている（409、`code: "id_live"`。`fork` でないときだけ見る。`sessions.ts:222-227, 284`）。
- 行き先が決まらない（`PlaceError`。下の表）。

下見が見ないもの: ブランチの分岐（`diverged`）、前提 commit の欠け（`missing_commits`）、別の worktree で使用中のブランチ（`branch_in_use`）は、実行の取り込みで初めて分かる（`git.ts:137-176`、コードから）。つまり、下見が通っても実行が `import` 段階で失敗する場合がある。

#### POST /api/sessions/:id/teleport（実行）

`src/api/sessions.ts:302-327`。

要求（JSON）: `{ to: string, fork?: boolean, cwd?: string }`

- `to` は行き先のノード名（`GET /api/peers` の名前）。必須。自分のノード名なら 400。
- `fork: true` で移動元を残し、行き先は別の id で分岐する。省くか false で move。
- `cwd` は行き先のノード上の絶対パス。

応答（200。取り込みの 201 ではなく `json()` の既定値）:

```
{ node, sourceNode, sourceId, fork, resume,
  id, cwd, cloned, git: { top, branch, head, previous: { branch, head }, notes[] } | null,
  file, warnings[] }
```

- 行き先のノード名は `node`、新しいセッション id は `id`（move は元の id のまま、fork は新しい id）。移動元の id は `sourceId`。
- `fork` は実際に fork になったかを表す。move を頼んでも、生きている端末セッションは fork に切り替わり、`fork: true` と警告が返る（`sessions.ts:248-256`）。画面は、頼んだ値でなく応答の `fork` を見る必要がある。
- `resume` は、1通も届かないまま30分で台帳から消えたときの再開コマンド（`ccn new <cwd> --peer <node> --resume <id>`）。
- `cloned` は、下見の clone と取り込みの clone のどちらかが true なら true（`sessions.ts:325`）。
- 取り込んだ子は `awaitingFirst: true` の遅延起動で、1通目を送ると claude が起動する（`sessions.ts:289-300`、`src/engine/node-driver.ts:19`）。端末として開く操作は返らない（section 4）。

### 実行の手順と、失敗がどの段階で起きるか

実行 POST の中の順序（`sessions.ts:302-327`）:

1. 入力検査（400）。
2. 移動元の説明を取る（404 `unknown session`）。
3. 空のセッション（`code: "empty"`）と、move で動いている途中（`code: "busy"`）を断る（409）。ここで断れば行き先に clone を残さない。
4. 行き先の下見（`POST /api/teleport/check`）。失敗は `stage: "check"` を付けて返す。
5. 書き出し。move で止められる（ノードの子）なら、ここで止める。
6. 取り込み（`POST /api/teleport`）。失敗は `stage: "import"` を付けて返す。

### 失敗の種類と値

エラー本文は JSON で、最低 `{ "error": "<文>" }` が付く。変換は `src/api/errors.ts:17-37`。

実行 POST が返すもの:

| 状況 | HTTP | 本文の主な値 |
| --- | --- | --- |
| `to` が無い、自分のノード、`cwd` が文字列でない | 400 | `error` |
| 移動元が無い | 404 | `error: "unknown session"` |
| 会話が無い（1通も届いていない） | 409 | `code: "empty"` |
| move で動いている途中（`running`、`waiting_permission`） | 409 | `code: "busy"`。待つか interrupt するか fork を促す文 |
| 行き先が古い版 | 502 | `stage: "check"`、`error` に ccn update の案内 |
| 行き先に届かない | 502 | `error`、`peer`（`PeerUnreachableError`） |
| 行き先の名前が不明 | 404 | `error`、`peer` |
| 中継の設定が無い | 503 | `error` |
| このノードが teleport 非対応（`deps.teleport` 無し） | 501 | `error: "teleport is not available on this node"` |
| 行き先の下見で断られた | 行き先の状態コードそのまま | 行き先の本文に `at: <to>`、`stage: "check"` を足したもの |
| 行き先の取り込みで失敗 | 行き先の状態コードそのまま | 行き先の本文に `at: <to>`、`stage: "import"`、move なら `hint` を足したもの |

`hint`（move の取り込み失敗のとき）は、移動元を止めた後なので、移動元で再開する手順を書いた文（`ccn new <cwd> --peer <移動元> --resume <id>`）。この失敗では**移動元はすでに止まっている**（`sessions.ts:318-322`）。画面は、move の `stage: "import"` の失敗を「移動元が止まった」状態として出す必要がある。

行き先が返す、`code` つきの本文（`errors.ts:29-34`）:

| 例外 | `code` | HTTP | 意味 |
| --- | --- | --- | --- |
| GitError | `dirty` | 409 | 行き先の作業ツリーに変更がある。`detail: { top, files[最大20] }` |
| GitError | `busy` | 409 | merge、cherry-pick、revert、rebase、bisect の途中。移動元のインデックスに未解決の衝突があるときも同じ |
| GitError | `diverged` | 409 | 行き先のブランチに、移動元に無い commit がある |
| GitError | `missing_commits` | 409 | 行き先に前提の commit が無い。移動元で push してやり直す |
| GitError | `branch_in_use` | 409 | ブランチが行き先の別の worktree で使われている |
| GitError | `not_repo`、`no_commits` | 400 | git でない、commit が無い |
| GitError | `failed` | 500 | git の失敗 |
| PlaceError | `no_place` | 400 | 行き先が決まらない（移動元が git でない、remote が無い、`cwd` が存在しない、git でない）。`hint: "pass cwd"` |
| PlaceError | `ambiguous` | 409 | 候補が2つ以上。`detail` に候補のパス |
| PlaceError | `exists` | 409 | clone 先に別のものがある |
| PlaceError | `outside_roots` | 400 | `cwd` や clone 先が行き先の roots の外 |
| PlaceError | `remote_mismatch` | 400 | `cwd` の remote が一致しない |
| IdConflictError | `id_conflict` | 409 | 行き先に同じ id の別の会話がある |
| （refuseLive） | `id_live` | 409 | 同じ id が行き先で動いている |
| NoTranscriptError | なし | 404 | 会話の記録が無い |
| PackTooLargeError | なし | 413 | pack が 90MB を超える |
| BadPackError | なし | 400 | pack の形が不正 |

### 注意: 中継の待ち時間

`/n/<peer>/api/...` の中継は、最初の応答まで既定 15 秒で打ち切る（`src/relay/relay.ts:25,28`）。`app.ts:63` は teleport のために延ばしていない。95 秒に延ばしてあるのは、ノードが行き先の下見と取り込みを呼ぶときだけ（`sessions.ts:50, 330`）。

このため、Claude Town が別の機械のノードを `/n/<peer>/...` で叩く場合は、実行 POST が clone や大きな会話で 15 秒を超えると、Claude Town 側が 502（`PeerUnreachableError`）を受ける。ところが移動元のノードはその間も処理を続け、最後まで進める（設計書の「CLI の接続が切れても、ノードは最後まで進める」）。Claude Town が 502 を「失敗」と表示すると、実際は成功している場合がある（コードから。実機では未確認）。

対策案: Claude Town は、移動元が手元のノードのセッションだけ実行 POST を打つ。別の機械のセッションを転出するときは、そのノードの API を直接叩ける経路があるかを決める。それが無い間は、502 の後に行き先のセッション一覧（`GET /n/<to>/api/sessions`）で新しい id を確かめて結果を判断する。下見の POST を `/n/<dest>/api/teleport/check` で呼ぶときも clone が 15 秒を超えうるので、同じ扱いになる。

### 呼び手

呼び手（caller）は、中継を通すと元の呼び手が `HEADER_FROM` で運ばれる（`relay.ts:44-45`）。ノードの子が自分自身を move するとき、呼び手の名前（`agent:<ノード>/<id の先頭8文字>/...`）がそのセッション自身なら、running でも止めて運ぶ（`sessions.ts:262-265`、`isSelf`）。Claude Town が呼ぶときの呼び手は、Claude Town が認証される身元になる。このため `isSelf` には当たらず、move で動いている途中のセッションは必ず 409 `busy` になる。

POST の CSRF 検査（`app.ts:15-26`）は、`Origin` があればホストが一致すること、`sec-fetch-site` があれば `same-origin` か `none` であることを求める。Rust の HTTP クライアントなら、どちらのヘッダも付けなければ通る（コードから。Claude Town の実装は確かめていない）。

### MCP と CLI

MCP（`src/mcp/tools.ts:285-300`）: ツール名 `teleport_session`。

| 引数 | 型 | 意味 |
| --- | --- | --- |
| `peer` | string、省略可 | 移動元のノード名。省くと MCP を提供しているノード |
| `session` | string | 対象（`sessionArg`。形式は `tools.ts` の定義で、未確認） |
| `to` | string | 行き先のノード名（`list_peers` から） |
| `fork` | boolean、省略可 | 移動元を残す |
| `cwd` | string、省略可 | 行き先のノード上の絶対パス |

戻りは `{ peer: <to>, ...<実行 POST の応答> }`。MCP に下見のツールは無い。手元の端末に持ってくる操作も MCP には無い（説明文に `ccn teleport <peer>/<id>` を使うよう書いてある）。

CLI（`src/cli/commands.ts:51, 263-279`、`src/cli/teleport.ts`）:

```
ccn teleport [<対象>] [--to <peer>] [--fork] [--cwd <dir>] [--no-open]
```

- `--to <peer>` あり: `push`（`teleport.ts:32-41`）が `POST /api/sessions/<id>/teleport` を呼ぶ。出力は `<peer>/<id>`、cwd、git、mode、警告、`続ける: ccn send <peer>/<id> <文>`、30分の注意。
- `--to` なし: 手元の端末へ持ってくる `pull`（`teleport.ts:44-65`）。`GET .../teleport`、手元での下見、`POST .../export`、取り込み、`claude --resume` の順。Claude Town の「転出」には使わない。
- 対象を省くと、`CLAUDE_CODE_SESSION_ID` の自分のセッション。

## 2. 転出できる条件と、できないとき

### 対象のセッション

| 種類 | move | fork |
| --- | --- | --- |
| `node`（ノードの子、live） | できる。止められる（`capabilities.stop`）ので止めてから運ぶ | できる |
| `node`（過去、exited） | できる。止めるものが無く書き出すだけ。移動元の jsonl は消さない（警告が付く） | できる |
| `terminal`（端末の対話、live） | 止められないので **fork に切り替わり、警告が付く**。移動元は人が閉じる | できる |
| `terminal`（過去） | 過去のセッションの扱いは node と同じ（コードから `info.live` が false の分岐） | できる |
| まだ1通も届いていない（`awaitingFirst`） | できない。409 `code: "empty"` | できない |

根拠は `sessions.ts:242-259, 267-273`、設計書「move の順序と、止められないセッション」。`pty` の kind は PR #18 には無い（`Kind` は `"node" | "terminal"`、`src/sessions/types.ts:3`）。

### 状態

- move で `running` か `waiting_permission` のノードの子は断る（409 `busy`）。待つか interrupt（`POST /api/sessions/:id/interrupt`）してから再試行する。fork なら動いている途中でも通る。
- ただし、呼び手がそのセッション自身なら running でも通る（section 1）。Claude Town からは当たらない。
- 同じ id が行き先で生きていれば止める（409 `id_live`）。fork の場合は新しい id になるので見ない。
- 手元へ持ってくる move で、同じ id が手元で動いていれば断る（`src/cli/teleport.ts:50`）。`--to` の経路ではこの検査は無い。

### 作業ツリー

運ぶもの（`git.ts` の `snapshot`）: HEAD、ブランチ、index（stage 済みの変更）、作業ツリー全体（未コミット、未追跡を含み、ignore 対象は除く）、remote に無い commit（bundle）。

止まるもの:

- 移動元のリポジトリに commit が無い（400 `no_commits`）。
- 移動元の index に未解決の衝突がある（409 `busy`）。
- 移動元が git でない: remote を探す手がかりが無いので、移動元がロビー（受け口）でなければ `cwd` を求めて止まる（400 `no_place`）。ロビーなら行き先のロビーに置く。
- 移動元が remote の無いリポジトリ: `cwd` を求めて止まる（400 `no_place`）。
- 移動元のディレクトリが無い: 止まらず、会話だけ運んで警告を返す（`teleport.ts:19`）。
- git の submodule と LFS の中身は運ばない（gitlink だけ）。
- 移動元の作業ツリーは move でも消さない（`reset --hard`、`clean`、`checkout -f` は使わない）。

「未コミットの変更があるから転出できない」わけではない。**行き先の作業ツリーが汚れているときに止まる**（`git status --porcelain --untracked-files=all` が空でない）。移動元の未コミットの変更は運ばれる。

### 行き先の条件

- ノードが PR #18 の版で動いている。古い版なら 502 と更新の案内（`sessions.ts:312`）。
- ノードが `GET /api/peers` に出る名前で、中継のサービストークンが設定済み。無ければ 404（不明な名前）か 503。
- 行き先のディレクトリ: `cwd` があればそれを使う（存在、roots の内側、git、remote 一致が必要）。無ければ places で remote が一致するものを探し、2つ以上なら名前がリポジトリ名と同じものに絞り、それでも決まらなければ 409 `ambiguous`。無ければ `<home>/Documents/<リポジトリ名>` に clone する（`place.ts:30-79`）。
- 行き先の作業ツリーがきれいで、merge や rebase の途中でない。
- ブランチが行き先で分岐していない、別の worktree で使われていない。
- 前提の commit が行き先の remote から取れる、または bundle に入っている。
- 行き先に git がある。vm は 2026-11-12 に git が無く、konaito が入れた（結果の文書）。git が無い行き先の失敗の値は未確認。
- 会話の大きさ: gzip の pack が 90MB 以下（413）。

### そのほかの注意

- 運ばないもの: `tool-results`、file-history、todos、memory（設計書）。
- 行き先の新しい clone は、Claude Code にとって未信頼のフォルダ。ノードの子（SDK）でこの確認が出るかは未確認（結果の文書では、行き先のノードの子は移動後に返事をしている）。端末で `claude --resume` を開くと確認が出る（結果の文書。`ccn teleport` の手元への取り込みでの観測）。
- 行き先のノードの子は、1通目が届くまで claude を起動しない。30分届かないと台帳から消える（会話と作業ツリーは残る）。

## 3. 世帯ごとの転出

### 結論

**条件付きでできる**。ただし、Claude Town の画面から「世帯をまとめて」押すだけでは安全に成立しない。API に世帯ごとの口は無く、子を1つずつ移すと、親子の記録が壊れ、同じ repo の子どうしが行き先で衝突する。

### 親と子孫をまとめて移す口はあるか

無い。次を確かめた。

- HTTP の `teleport` と `export` は、どちらも1つの `:id` だけを扱う（`app.ts:136-140`）。複数 id、`family`、`children` などの引数を受ける処理は `sessions.ts` に無い。
- MCP の `teleport_session` も `session` を1つ受ける（`tools.ts:288-294`）。
- CLI の `ccn teleport` も対象を1つ受ける（`commands.ts:263-279`）。
- 設計書にも「親子をまとめて移す」記述は無い。

### 親子の記録は何が起きるか

コードから読んだこと（実機では未確認）。

- 子認識は、子の側が持つ。`SessionSummary.parent` は「最初の文の from 行の呼び手」で、親の側には何も持たない（`src/sessions/types.ts:19-20`）。一覧の `GET /api/sessions?parent=<呼び手>` は `parent` の文字列一致で絞るだけ（`sessions.ts:99-107`）。
- 生きている子の `parent` は、ノードの子を立てたときの呼び手（`caller.id`）で決まる（`src/main.ts:31`、`src/engine/node-driver.ts:120`）。
- 過去のセッションの `parent` は、最初のプロンプトの from 行から導く（`src/engine/history.ts:41`）。
- 取り込みで行き先に立てる子は `startNode({ ... }, caller)` で作る（`sessions.ts:295`）。この `caller` は、`teleport` を呼んだ側が中継で運んだ呼び手になる。つまり行き先の `parent` は、**もとの親ではなく、転出を押した呼び手**（Claude Town の身元）になる。
- 会話本体（jsonl）はそのまま運ぶので、最初の from 行の文面は元のまま残る。行き先の子が生きている間は `parent` が呼び手、終わって過去のセッションになると from 行から導く元の親、と**2通りの値になりうる**。

結果として、子を1つだけ移すと、行き先の一覧に出る `parent` が元の親と一致しないので、元の親の `?parent=` 一覧にも行き先の一覧にも、親子としては出ない。親の側は移動元のノードに残り、`parent` の文字列が指す親の名前（`agent:<名前>`）が行き先のノードにあるとは限らない。

親（ノードの子）を先に移した場合も、同じ理由で、親の `agent:<名前>` が指すセッションは行き先でも同じ名前に見えるかは未確認（`src/identity/agent-name.ts` を詳しく読んでいない）。

### 子の作業ディレクトリ

- 子が別の worktree を使っていても、行き先の決め方は「remote が一致するリポジトリの最上位」で、worktree は考えない。`resolveDest` は places から remote が一致するものを探し、`join(top, g.rel)` を cwd にする（`place.ts:45-78`）。
- 取り込みは `git checkout -B <ブランチ> <HEAD>` と `read-tree -m -u` で、その最上位の作業ツリーを書き換える（`git.ts:166-176`）。
- したがって、**同じ repo の複数の子を同じ行き先へ移すと、同じディレクトリを上書きし合う**。1つ目の取り込みの後は作業ツリーが汚れているので、2つ目の下見は `dirty`（409）で止まる。ただし1つ目が未コミットの変更を持たない（きれいな）場合は、2つ目が通って、1つ目の子が見ているブランチと作業ツリーを書き換える。どちらも、世帯の子を並べて動かす用途には合わない。
- 個別に `cwd` を渡せば別のディレクトリに置ける。ただし、そのディレクトリは行き先で既存の git リポジトリで、remote が一致し、きれいでなければならない。worktree を新しく作る処理は無い。

### 順番

- 順番を決める API は無い。呼ぶ側が決める。
- move は子の1つずつが「止める、書き出す、取り込む」を行い、途中で止まるものがある（busy、dirty、diverged など）。世帯の途中で1つ失敗すると、先に移した子と移していない子が別々の機械に分かれる。巻き戻す口は無い（移動元の jsonl と作業ツリーは残るので、手で再開はできる）。
- 親が子を動かしている途中（親が `running`）だと、親の move は 409 `busy`。子から先に移すと、親の子認識が切れる（上記）。

### Claude Town が世帯ごとの転出を出せるか

**条件付きでできる**。

- できる範囲: 世帯の子孫のうち、動いていない（`idle`）ノードの子や過去のセッションを、1つずつ `fork` または `move` で移す。親子の `parent` は呼び手になるので、Claude Town は「この世帯の子を転出した」記録を自分の側（Claude Town のデータ）に持ち、行き先でつなぎ直して見せる必要がある。
- 条件: (a) 同じ repo の子を同じ行き先へ移さない、または子ごとに `cwd` を決める。(b) `running` の子は先に止まるのを待つ。(c) 失敗した時点で止め、先に移した分を一覧に出す。
- できない範囲: 親子の `parent` の値を ccn に保たせること。API に世帯の口は無く、`parent` を指定する引数も無い。一括で移して失敗したら全部巻き戻す、という操作もできない。
- 提案（ccn 側。伝えるのは family-computing の判断）: 取り込みの `caller` を移動元の `parent` で上書きするか、`teleport` に `parent` を渡せる引数を足す。世帯ごとの口（`POST /api/sessions/:id/teleport` に `descendants: true`）を足す。

## 4. PTY のセッション

### 読んだもの

- `~/Documents/claude-code-nodes.wt/pty-driver`（`feat/pty-driver`）は、2026-11-12 時点で `git status` が空で、`main`（`086d910`）と同じ HEAD にある。PTY の Driver の実装は**まだ無い**（`src/engine` には `driver.ts`、`node-driver.ts`、`terminal-driver.ts`、`history.ts`、`agents.ts` だけ）。
- 設計は `docs/design/terminal-panel.md`（A2 案）にある。ここに書かれた計画と、teleport のコードを突き合わせた。PTY 側の実装は読めていないので、PTY 側の記述はすべて計画の文書からで、**未確認**。

### 計画されている PTY の Driver（`terminal-panel.md:28-37`）

- `src/engine/pty-driver.ts`。`Bun.spawn(["claude", "--session-id", id, ...], { terminal })` で起動する。出力の末尾を覚える。能力は send、interrupt、stop、events と、新しい `terminal`。
- `create_session` に `terminal: true` を足し、PTY の Driver で立てる。
- 承認は PermissionRequest の hook を `--settings` で注入する。
- 一覧の重複を避けるため、PTY の Driver のセッションは端末のセッションの一覧から除く。

### 転出したセッションを、行き先でも PTY の端末として再開するには

今の teleport では、行き先は必ず `NodeDriver`（SDK）の子になる。`importPack` のあと `this.d.startNode({ cwd, resume, defer: true, permissionMode, settings }, caller)` で作る（`sessions.ts:295`）。`startNode` は `NodeDriver.start` に固定されている（`src/main.ts:31`）。行き先を PTY にするには、次の点をつなぐ必要がある（ccn-pty への提案）。

1. **取り込みの最後の分岐（teleport 側）。** `sessions.ts:295-296` の `startNode` と `store.add` を、Driver の種類で分ける。`teleport` の要求に `terminal?: boolean`（または `driver: "node" | "pty"`）を足し、`POST /api/teleport?cwd=...&terminal=1` のように行き先まで運ぶ。`teleport()` の `peerCall` の `qs`（`sessions.ts:317-319`）に足す場所がある。
2. **PTY の Driver の起動に、resume を渡せること（pty 側）。** 計画の起動コマンドは `claude --session-id <id>`（新規）。転出は既存の id の会話を続けるので、`claude --resume <id>` で起動できる必要がある。`--session-id` と `--resume` を同時に使えるかは未確認（`claude --help` を読んでいない）。fork のときは行き先の id が新しい id で、会話は同じ id の jsonl として置かれるので、同じ形で `--resume <新しい id>` になる。
3. **遅延起動（pty 側）。** 今の取り込んだ子は1通目まで claude を起動しない（`defer`）。PTY は画面を出す前提なので、遅延させるか、取り込んだ直後に起動するかを決める必要がある。起動するなら、30分で台帳から消える規則（`src/engine/store.ts`、未読）が PTY の子にも当たるのかを決める。
4. **信頼の確認（teleport と pty の両方）。** 新しく clone したフォルダは、対話の `claude --resume` が最初に「このフォルダを信頼するか」を出す（結果の文書。`ccn teleport` の手元への取り込みで観測）。ノードの子（SDK）は出ない。PTY の子は端末なので、この確認が出る。承認の hook（`--settings` の注入）は信頼の確認には効かない（未確認だが、計画は PermissionRequest だけ）。画面でユーザーが「Yes」を押す導線が要る。または、取り込むときに信頼の記録（`~/.claude.json` のプロジェクト設定）を書く。後者は設定の書き換えなので、本人に確かめる前提。
5. **設定ディレクトリの一致（teleport 側）。** 会話は `<CLAUDE_CONFIG_DIR>/projects/<cwd の符号>/` に書く（`transcript.ts` の `writeTranscript`）。ノードの常駐は `CLAUDE_CONFIG_DIR` を持たず `~/.claude` を使う。PTY の Driver が起動する `claude` が別の設定ディレクトリ（cam のプロファイルなど）を使うと、`--resume` から会話が見えない。結果の文書では、cam の agent プロファイルの `projects` が `~/.claude/projects` への symlink なので、置き場は同じになる。PTY の Driver が起動時に渡す環境変数が、取り込み先の `configDir` と一致する必要がある。
6. **一覧の重複（pty 側と teleport 側）。** PTY の子は `claude agents --json` にも `kind: interactive` で出る。teleport は `refuseLive` で `agents()` を見て、同じ id が生きていれば断る（`sessions.ts:222-227`）。PTY の Driver のセッションを、この検査から正しく除くか、台帳側で先に見る必要がある。
7. **move の「止める」（pty 側）。** 計画の PTY の Driver は能力に `stop` を持つ。そうなれば、`exportPack` の `live.capabilities.stop` の分岐（`sessions.ts:248-251`）に入り、端末のセッションのような fork への切り替えは起きず、止めてから運べる。`stop()` が PTY のプロセスを止め、台帳から外すこと（`store.remove`）を確かめる必要がある。`refuseBusy` の `running` 判定は、PTY の `state` が `running` と `waiting_permission` を返すことに依る。PTY では、人が画面を操作中に move が押された場合に、途中のターンを切るかどうかを決める必要がある。
8. **`Kind` の追加（共通）。** `Kind` は `"node" | "terminal"` のみ（`src/sessions/types.ts:3`）。PTY の Driver を足すと `kind` が増える。teleport の `teleportInfo` は `kind` を返すだけで分岐には使っていない（能力で分岐している）ので、`pty` を足しても teleport 側の判定は変わらない。Claude Town の画面は、`kind` でなく `capabilities` を見るのがよい。
9. **移動元が PTY のとき、手元への持ち帰り。** `pull` は `GET .../teleport` の `info.live` と `capabilities` を見ないので、変更は要らない。ただし、手元の端末で開くのは `claude --resume`（人の端末）で、PTY の Driver で開くのではない。手元の PTY で開くなら、`pull` の `deps.open` に当たる部分を、ノードの PTY の口へ置き換える必要がある。

最小の繋ぎは、(1) と (2) の2点。teleport の要求に「PTY で起動する」を足し、取り込みの最後の `startNode` を PTY の Driver の起動に差し替える。(4) の信頼の確認が、使い勝手に最も効く。

## 5. モック用の応答の見本

値は、コードの形に合わせた**作り物**。実機の応答ではない。id や名前は例。

### 下見 1段目: 移動元の説明（GET /api/sessions/:id/teleport）

```json
{
  "id": "24d05012-35de-4fa8-bd69-70a1e2918b17",
  "kind": "node",
  "state": "idle",
  "capabilities": { "send": true, "permissions": true, "interrupt": true, "stop": true, "events": true },
  "title": "family-computing の調査",
  "permissionMode": "default",
  "awaitingFirst": false,
  "live": true,
  "from": { "node": "konaito-pro", "cwd": "/Users/konaito/Documents/family-computing", "lobby": false },
  "git": { "remote": "https://github.com/konaito/family-computing.git", "repoName": "family-computing", "rel": "", "branch": "feat/app-v1" }
}
```

### 下見 2段目: 行き先の下見（POST /api/teleport/check）

要求:

```json
{
  "id": "24d05012-35de-4fa8-bd69-70a1e2918b17",
  "fork": false,
  "from": { "node": "konaito-pro", "cwd": "/Users/konaito/Documents/family-computing", "lobby": false },
  "git": { "remote": "https://github.com/konaito/family-computing.git", "repoName": "family-computing", "rel": "", "branch": "feat/app-v1" }
}
```

応答（200）:

```json
{
  "node": "vm",
  "cwd": "/home/konaito/Documents/family-computing",
  "top": "/home/konaito/Documents/family-computing",
  "cloned": true
}
```

### 実行: 要求と応答（POST /api/sessions/:id/teleport）

要求:

```json
{ "to": "vm", "fork": false }
```

応答（200）:

```json
{
  "node": "vm",
  "sourceNode": "konaito-pro",
  "sourceId": "24d05012-35de-4fa8-bd69-70a1e2918b17",
  "fork": false,
  "resume": "ccn new /home/konaito/Documents/family-computing --peer vm --resume 24d05012-35de-4fa8-bd69-70a1e2918b17",
  "id": "24d05012-35de-4fa8-bd69-70a1e2918b17",
  "cwd": "/home/konaito/Documents/family-computing",
  "cloned": true,
  "git": {
    "top": "/home/konaito/Documents/family-computing",
    "branch": "feat/app-v1",
    "head": "29b7bee0000000000000000000000000000000000",
    "previous": { "branch": "main", "head": "086d9100000000000000000000000000000000000" },
    "notes": []
  },
  "file": "/home/konaito/.claude/projects/-home-konaito-Documents-family-computing/24d05012-35de-4fa8-bd69-70a1e2918b17.jsonl",
  "warnings": ["the source transcript stays on konaito-pro; do not resume it there"]
}
```

### 進み具合

ccn 側に進み具合を返す口は無い（section 1）。次は、Claude Town が自分で作る表示の形の例で、ccn の応答ではない。

```json
{
  "_note": "ccn の応答ではない。Claude Town が画面の段階として持つ想定の値",
  "sessionId": "24d05012-35de-4fa8-bd69-70a1e2918b17",
  "to": "vm",
  "fork": false,
  "stage": "executing",
  "stages": [
    { "name": "info", "state": "done" },
    { "name": "check", "state": "done", "cloned": true },
    { "name": "execute", "state": "running", "since": "2026-11-12T10:00:00Z" }
  ]
}
```

### 完了

実行 POST の応答（上）が完了。move の完了後、移動元の `GET /api/sessions/:id` は `state: "exited"` を返す（結果の文書の記述）。行き先の `GET /n/vm/api/sessions` には、次の形の子が出る（コードから。`awaitingFirst` の経路は `node-driver.ts:121`）。

```json
{
  "id": "24d05012-35de-4fa8-bd69-70a1e2918b17",
  "kind": "node",
  "capabilities": { "send": true, "permissions": true, "interrupt": true, "stop": true, "events": true },
  "cwd": "/home/konaito/Documents/family-computing",
  "state": "idle",
  "startedAt": 1794477600000,
  "lastActivityAt": 1794477600000,
  "permissionMode": "default",
  "parent": "user@example.com",
  "awaitingFirst": true
}
```

`parent` は、転出を呼んだ呼び手の例（section 3）。元の親ではない。

### 失敗

移動元は止まった後で、取り込みが断られた例（move、行き先の作業ツリーが汚れている場合は下見で止まるので、これは取り込みの段階での失敗）。HTTP 409。

```json
{
  "error": "branch feat/app-v1 here has commits the source does not have (1a2b3c4d is not an ancestor of 29b7bee0)",
  "code": "diverged",
  "at": "vm",
  "stage": "import",
  "hint": "the source session was stopped; resume it on konaito-pro with: ccn new /Users/konaito/Documents/family-computing --peer konaito-pro --resume 24d05012-35de-4fa8-bd69-70a1e2918b17"
}
```

下見で止まった例（行き先が汚れている）。HTTP 409。移動元は止まっていない。

```json
{
  "error": "the destination working tree has changes (3 files). Commit, stash or move them first: /home/konaito/Documents/family-computing",
  "code": "dirty",
  "detail": { "top": "/home/konaito/Documents/family-computing", "files": [" M a.txt", "?? u.txt", "?? b.txt"] },
  "at": "vm",
  "stage": "check"
}
```

## 未確認のまとめ

- API は1本も実行していない。応答の見本は、コードから起こした作り物。
- 別の機械のノードを `/n/<peer>/...` で叩いたときの 15 秒の打ち切りが、実行 POST で起きるか（コードからは起きうる）。
- 取り込んだ子の `parent` が呼び手になること、世帯を1つずつ移したときの親子と worktree の衝突（コードの読み。実機では未確認）。
- 過去のセッションの `kind` と `parent` の出方（`history.ts` の全体は読んでいない）。
- `sessionArg` の形式、`agent-name.ts` の名前の規則、`store.ts` の30分の規則。
- PTY の Driver の実装（pty-driver にコードがまだ無い）。`--session-id` と `--resume` の併用、PTY の `stop`、一覧の重複の除き方。
- Claude Town の Rust クライアントが CSRF 検査（`Origin`、`sec-fetch-site`）を通ること。
- 行き先に git が無いときの失敗の値。
