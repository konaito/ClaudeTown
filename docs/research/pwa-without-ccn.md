# ブラウザ版（PWA）を ccn なしで作り直す設計（#141）

2026-11-26 に本人が「ccn なしで作り直す」を選んだ。この文書は、その作り直しの設計である。実装は含まない。

ブラウザ版は town.fybe.jp の PWA で、今は Worker が ccn.fybe.jp へ中継している。作り直した後は、Mac で動く Claude Town のアプリが外からの要求に答える。Worker はアプリへ中継する。

## 結論

- 推す案は、案C の「アプリから Worker の Durable Object へ WebSocket を張る」形である。理由は「6. 推す案と理由」に書いた。
- 案C には、確かめていない前提が2つある。サービストークンを付けた WebSocket の upgrade が Access を通るか。Void の WebSocket の部屋で、アプリとブラウザの間を中継できるか。
- そこで実装の1本目の issue は、この2つを試して決めることにする。通らなければ案A（Cloudflare Tunnel とアプリの HTTP の口）に移る。
- ブラウザ版の口は、ccn の REST の形をまねない。Tauri の invoke と同じ「命令名と引数」で受け、アプリの同じ Rust の関数を呼ぶ。こうすると `src/webConv.ts`、`src/webPerm.ts`、`src/webReserve.ts` が要らなくなる。
- ccn から消すのは、Access アプリ `ccn` のポリシー `town-linked` だけである。ccn そのものと、ほかのポリシーは ccn が使うので残す。

## 確かめた版と方法

- コードは `origin/main` の 065259e を読んだ。
- Cloudflare の設定は `cf zero-trust access applications list` で読んだだけで、書き込んでいない。このリポジトリは public なので、ID は書かず名前で指す。
- 公式ドキュメントは、sub-agent（web-fetch）が読んで要約したものを使った。要約モデルを通った読みなので、細かい文言が要る項目は原文で見直す。
- Void の WebSocket と Durable State は、`void@1.10.0`（web/ の版）を `npm pack` で取って docs があることを確かめた。中身は lifeos の `node_modules/void`（1.11.0）で読んだ。
- アプリの起動、本番への要求、計測はしていない。

## 1. 今の PWA が ccn に頼っている口と、アプリの Rust の命令との対応

画面（`src/`）は Tauri 版と同じものを使う。Tauri の外でビルドした版では、`src/bridge.ts` の `webCall` が命令を ccn の HTTP の口に置き換えて呼ぶ。Worker（`web/lib/proxy.ts`）は `/api/*` と `/n/*` を ccn.fybe.jp へそのまま中継する。

対応は1対1にならないので、4つに分けた。Rust の命令は `src-tauri/src/lib.rs` の `generate_handler!`（694行）にあるものである。

### 1-1. アプリの同じ命令をそのまま呼べるもの

| 画面の命令 | 今の PWA が呼ぶ ccn の口 | アプリの Rust の命令 | 変わること |
|---|---|---|---|
| snapshot | `GET /sessions` を TS で並べ直す | `snapshot`（lib.rs） | 行の source が ccn からアプリと同じ値になる。名前づけが Rust と同じになる（今は .git を読めない） |
| conversation | `GET /sessions/<id>/messages?after=` と `src/webConv.ts` | `conversation`（conversation.rs） | webConv.ts が要らなくなる。今の動き（live）も出る |
| create_session | `POST /sessions` | `create_session`（session_ops.rs） | effort も渡せる（ccn は受けなかった） |
| stop_session | `DELETE /sessions/<id>` | `stop_session`（session_ops.rs） | なし |
| send_direct、send_or_queue | `POST /sessions/<id>/terminal/input` に貼り付けと Enter | `send_direct`、`send_or_queue`（composer.rs） | 起動前の預かり（boot_status、cancel_queued）が働く |
| boot_status、cancel_queued | 固定の値を返す | `boot_status`、`cancel_queued`（composer.rs） | 本物の値になる |
| interrupt_session | `POST /sessions/<id>/interrupt` | `interrupt_session`（composer.rs） | なし |
| term_input | `POST /sessions/<id>/terminal/input` | `term_input`（terminal.rs） | 順序の扱いは 1-3 |
| session_detail | `GET /sessions/<id>` | `session_detail`（dialog.rs） | 返す形が ccn と違う。画面の IS_WEB の分岐（SessionControls.tsx）を消す |
| house_places | `/host`、`/sessions`、`/places` | `house_places`（session_ops.rs） | なし |
| place_repos | 空を返す | `place_repos`（repo.rs） | 場所のリポジトリ名が出る |
| prompt_history、slash_commands、file_suggestions | 呼ばない（Composer.tsx の `local`） | 同じ名前（composer.rs） | README の「ブラウザ版で使えない機能」の表の大半が使えるようになる |
| resume_session、restart_session、restore_report | 呼ばない | 同じ名前（session_ops.rs） | 使えるようになる |

### 1-2. 置き換わるもの

| 画面の命令（今の PWA） | ccn の口 | 置き換え先の Rust の命令 | 消える TS |
|---|---|---|---|
| answer_permission | `GET /sessions/<id>` と `POST /sessions/<id>/permissions/<requestId>` | `answer_dialog`（dialog.rs）。アプリの承認の欄と同じく、端末の画面に書いて答える | `src/webPerm.ts`、`Approval.tsx` の分岐 |
| session_controls、configure_session | `POST /sessions/<id>/command`、`PATCH /sessions/<id>` | `session_settings`、`switch_session`、`cancel_switch`（switch.rs）。予約は Rust が持つ | `src/webReserve.ts`、`SessionControls.tsx` の分岐 |
| run_command | `POST /sessions/<id>/command` | 端末へ貼って送る（send_or_queue）。アプリと同じ | `usePanelSend.ts` の ccn の枝 |
| send_message | `POST /sessions/<id>/messages` | `send_or_queue` か `send_direct`。アプリと同じ | `sendVia.ts` の ccn の枝 |

置き換えた後は、アプリと同じ確認が通る。たとえば `answer_dialog`、`switch_session`、`term_input` は `refuse_if_disabled`（lib.rs 182行）を通る。今の PWA では効かない送信の非常停止（`~/.family-computing/send-disabled`）が、ブラウザ版にも効くようになる。

### 1-3. Channel で流し続けるもの

| 画面の命令 | 今の PWA | Rust の作り | 外へ流すときに要ること |
|---|---|---|---|
| term_open、term_close | `GET /sessions/<id>/terminal` を EventSource で読む | `term_open` が `tauri::ipc::Channel` を受け、`pty::subscribe` に mpsc の Sender を渡す（terminal.rs、pty.rs 665行） | Sender の先を Channel から外への流れに付け替える。ただし `pty::subscribe` は1つの端末に購読を1つしか持たない（`sub: Option<…>`）。今のままだと、スマホで開くと Mac の窓の端末が止まる。購読を複数にする |
| term_resize | `POST /sessions/<id>/terminal/resize` | `term_resize`（terminal.rs） | スマホの幅で PTY を縮めると、Mac の窓の端末も同じ幅になる。ブラウザ版からは送らない（許可リストから外す）ことにする。スマホは Mac の幅のまま表示し、横にスクロールする |
| town_watch、town_unwatch、town_kick | 呼ばない。2秒ごとに snapshot を呼ぶ（`src/town.ts`） | 見張りは1本だけで、新しく始めると前の見張りを止める（watch.rs の `WATCH`） | 外からは town_watch を呼ばせない。初めの段階では、今と同じく snapshot を2秒ごとに呼ぶ。案C では、後の段階でアプリが変わったときだけ送る形に替えられる |

`term_input` は、届いた順に1つずつ動く前提で作ってある（terminal.rs 68〜72行のコメント、#231）。外から受けるときも、1本の接続の中では届いた順に処理する。要求ごとに別のスレッドへ投げない。

### 1-4. 外から呼ばせないもの

`update_run`、`update_status`、`paste_clipboard`、`stage_files`、`perf_log`、`perf_ping`、`perf_window` は外から呼ばせない。更新は Mac の前でする操作である。クリップボードとファイルの添付は Mac の手元のものを指す。スマホからの画像の添付は、別に upload の口が要る（後の段階）。

外から呼べる命令は、Rust 側に許可リストとして持つ。許可リストに無い名前は断る。試験で、許可リストの名前がどれも `generate_handler!` にあることを確かめる。

## 2. 外からアプリへ届く経路の案

3つの案を比べた。どの案でも、town.fybe.jp の Worker と Access アプリ `claude-town` は残す。画面の配信と、人のログインの確認は今のままである。

### 案A: Cloudflare Tunnel と公開ホスト名で、アプリの HTTP の口へ中継する

今の ccn と同じ形である。ccn.fybe.jp は Mac の cloudflared（LaunchAgent `jp.fybe.ccn.tunnel`）が出している。

- アプリが `127.0.0.1` の HTTP の口か、unix socket を持つ。cloudflared のトンネルが、新しいホスト名（例: `town-mac.fybe.jp`）をその口へつなぐ。
- 新しいホスト名に Access アプリを作り、`claude-town` からの Linked App Token を通すポリシーを付ける。Worker は今と同じく、受け取った JWT を `Cf-Access-Token` で渡す。web/ の変更は、中継先と道の名前だけで済む。
- アプリは要求ごとに Access の JWT を確かめる。`127.0.0.1` の口は、同じ Mac の別のプロセスからも届くためである。create_session と term_input を呼べるので、確かめずに受けてはいけない。
- Tunnel は unix socket を宛先にできる（公式の protocols のページ、`unix:/path`）。unix socket にすると、ファイルの権限で届く相手を同じユーザーに絞れる。

### 案B: Workers VPC で、公開ホスト名なしにトンネルの先へ届ける

- Worker が `vpc_services` のバインディングで、トンネルの先のサービスを呼ぶ。公開ホスト名と、新しい Access アプリが要らない。
- 公式は「beta」と書いている（https://developers.cloudflare.com/workers-vpc/）。WebSocket と SSE を通すかは、読んだページに書かれていなかった。
- Worker とアプリの間に Access が入らない。アプリは Worker を、共有の秘密のヘッダーで見分けることになる。

### 案C: アプリから Durable Object へ WebSocket を張る

- アプリが town.fybe.jp の WebSocket の道（例: `/relay`）へ外向きにつなぐ。Access のサービストークン（`CF-Access-Client-Id`、`CF-Access-Client-Secret`）を付ける。
- Worker の Durable Object が、アプリの接続とブラウザの接続を同じ部屋に持つ。ブラウザが送った `{ id, cmd, args }` をアプリへ渡し、アプリの返事を id で送り手のブラウザに返す。端末の出力も同じ接続で流す。
- Mac 側に待ち受けの口が無い。cloudflared も、新しいホスト名も、新しい Access アプリも要らない。`claude-town` にサービストークンのポリシーを1つ足す。
- Void は `.ws.ts` の道で WebSocket の部屋（`defineRoom`）を作れる。部屋は Durable Object で、Void の実装は `state.acceptWebSocket`（休眠の API）を使っている（void 1.11.0 の `dist/server-CfUbeOjx.mjs` 249行）。

### 比べた表

| 項目 | 案A Tunnel と公開ホスト名 | 案B Workers VPC | 案C Durable Object と WebSocket |
|---|---|---|---|
| Mac で常駐するもの | cloudflared が要る。今は ccn の LaunchAgent が動かしている。ccn を外すなら、アプリが子として起動するか、別に入れる | 案A と同じく cloudflared が要る | アプリだけ。README 7行目の「ほかに常駐するプログラムは要らない」を保てる |
| Mac 側の待ち受け | `127.0.0.1` の口か unix socket。アプリが JWT を確かめる | 案A と同じ口。アプリが共有の秘密を確かめる | 無い（外向きの接続だけ） |
| ブラウザの認証 | 今と同じ（`claude-town` の Access と `01.access.ts`） | 今と同じ | 今と同じ。WebSocket の upgrade でも Origin を確かめる（下の注1） |
| アプリの認証 | Linked App Token（今の ccn と同じ形。本番で動いている組み合わせ） | 共有の秘密のヘッダー | サービストークン。JWT に email が無く `common_name` が入る（公式の application-token のページ）。`01.access.ts` は今 `/__void/` 以外でこれを断るので、`/relay` の例外を足す |
| 端末の流れ | SSE（今の ccn と同じ道。本番のコードが前提にしている。今日の動作は未確認）。Tunnel は WebSocket も通す（公式の Tunnel の FAQ） | 未確認（docs に記述が無い） | 同じ WebSocket に流す |
| 安定版と開発版の同時起動 | 同じトンネルを2つが動かすと、要求はどちらに行くか決まらない（公式の tunnel-availability のページ）。開発版はトンネルを起動しない | 案A と同じ | 部屋に入れるアプリは1つにし、新しい接続が来たら古い方を閉じる。開発版は既定ではつながない |
| Mac が寝ている、アプリを閉じている | Tunnel が error 1033 を返す。Worker が「Mac のアプリにつながらない」に直す。寝ているのか閉じているのかは区別できない | fetch が投げる。案A と同じ | Durable Object が「アプリの接続が無い」と分かる。最後につながっていた時刻を出せる。寝ているのか閉じているのかは区別できない |
| 新しく作る Cloudflare の設定 | トンネル、DNS、Access アプリ、Linked App Token のポリシー | トンネル、VPC サービス | サービストークン、`claude-town` のポリシー1つ |
| 費用 | 料金のページから Tunnel の値段を読めなかった（未確認）。同じアカウントで ccn のトンネルが動いている | beta の間は無料（公式） | 下の試算。Durable Object は Free と Paid の両方で使える（公式） |
| 作業量（推定） | 小さい。Rust の HTTP の口（axum）、JWT の確認、cloudflared の起動と止め方。web/ はほぼそのまま | 案A に近い。beta の挙動を確かめる分が増える | 中くらい。Rust の WebSocket の接続と再接続、部屋の Worker、bridge.ts の WebSocket の呼び出し |
| 確かめていないこと | 少ない | WebSocket と SSE、beta の変更 | サービストークンで WebSocket の upgrade が通るか。Void の部屋で中継が書けるか。部屋の接続ごとの印（アプリかブラウザか）を休眠をまたいで保てるか |

注1: ブラウザは別のオリジンのページからも、クッキー付きで WebSocket を開ける。今の `web/lib/origin.ts` は GET を確かめないので、WebSocket の upgrade（GET）は素通りする。案C では、upgrade の要求の Origin が town.fybe.jp でなければ断る。Void の docs も、`onBeforeConnect` で Origin を自分で確かめるよう書いている。

### 案C の費用の試算

以下は AI の仮定で組んだ試算で、実測ではない。仮定は、スマホで1日1時間開き、そのうち15分は端末を開いている、である。

- 公式の値（Durable Objects の pricing のページ）は次のとおり。Paid は要求が月100万回まで込みで、その後は100万回ごとに0.15ドル。時間は月40万 GB-s まで込み。Free は要求が1日10万回、時間が1日1万3千 GB-s。受けた WebSocket のメッセージは20通で1回と数え、送るメッセージは数えない。休眠の間は時間を数えない。
- 一覧: 今の PWA は2秒ごとに snapshot を呼ぶ（`src/town.ts`）。1時間で1,800通、20で割って90回。
- 端末: Rust は16msに1回までにまとめて送る（terminal.rs の `TERM_FLUSH`）。出力が続くと最大で毎秒約60通になる。15分で54,000通、20で割って2,700回。
- 時間: 開いている1時間ずっと起きているとすると、128MB で 450 GB-s/日。
- 合計は1日約3,000回と 450 GB-s で、Free の1日の枠にも収まる。Paid なら月の込みの範囲に収まる。
- アカウントが Workers の Free か Paid かは、`cf` で読めなかった（未確認）。
- アプリの接続を見張るための ping を30秒ごとに送ると、1日2,880通（144回）になる。Void の部屋が自動の応答（`setWebSocketAutoResponse`）を使えるかは未確認。
- cloudflare-do-safety に合わせ、alarm と setTimeout は使わない。アプリが最後につながっていた時刻は、要求が来たときに保存した値と比べて決める。

## 3. 推す案と理由

案C を推す。ただし1本目の issue で前提を試し、通らなければ案A にする。

理由は次の4つである。

1. 常駐するものが増えない。README 7行目は、アプリが Claude Code の記録と hook だけで動くと書いている。案A と案B は cloudflared が要り、ccn を外すとその入れ方と起動の仕方を別に決めることになる（README、ccn の `src/join/services.ts`）。
2. Mac に待ち受けの口ができない。外から呼べる命令には create_session と term_input がある。案A では、`127.0.0.1` の口を同じ Mac のほかのプロセスからも呼べる。JWT の確認を1か所でも漏らすと、手元のどのプログラムからでも claude を起動できる（コードからの推論）。
3. 安定版と開発版を分けやすい。Tunnel は、同じトンネルを2つのプロセスが動かすと行き先を決められない（公式の tunnel-availability のページ）。案C は、部屋に入れるアプリを Worker の側で1つに決められる。
4. アプリにつながっていないことを、Worker が自分で分かる。今の PWA は ccn に届かないと「ccn に繋がらない」としか出せない（bridge.ts の `es.onerror`）。

案A を残す理由もある。案A は、今の ccn と同じ組み合わせ（Tunnel、Access、Linked App Token、SSE）なので、確かめていないことが少ない。web/ の変更も小さい。1本目の試しで案C の前提が通らなかったら、案A に移る。案B は beta で、端末の流れを通すかが分からないので、今は推さない。

### アプリを閉じたときの後退

どの案でも、アプリを閉じるとブラウザ版から何も見えず、何も操作できない。ccn は LaunchAgent で常駐していたので、今の PWA からの後退になる。

- アプリは終わるときに、自分が立てた claude を全部止める（lib.rs 707行の `pty::kill_all`）。閉じた後に残るのは、アプリの外で起動したセッションだけである。
- アプリの外で起動したセッションは、アプリが開いていても読むだけで、操作は送信だけである（`app_guard`、lib.rs 178行）。
- アプリを閉じても外から見たいかは、本人に聞く確認事項である。要るなら、アプリを窓なしで常駐させる別の issue にする。

## 4. 実装の issue の案

順に進める。2から4は1の結果で案が決まってから始める。

### 1. 案C の前提を試して決める

- やること: 開発用の Worker で、Void の `.ws.ts` の部屋を作る。Rust か小さなスクリプトからサービストークン付きでつなぎ、ブラウザの要求を中継させる。
- 完了の条件:
  - サービストークンを付けた WebSocket の upgrade が、Access を通って部屋に届く。JWT の `common_name` が読める
  - 人のログインのブラウザから同じ部屋へつなぎ、`{ id, cmd, args }` を送ってアプリの返事が id どおりに返る
  - 部屋が休眠した後も、接続ごとの印（アプリかブラウザか）が残る
  - 別のオリジンのページからの upgrade が断られる
  - 結果を issue に書き、案C か案A かを決める
- 通らなかったとき: 案A に移る。2の Rust の口は案A でも同じなので、無駄にならない。
- 本人に聞くこと: 開発用のホスト名、Access アプリ、サービストークンを Cloudflare に作る。本番の設定への書き込みなので、作る前に本人の了承を取る。

### 2. アプリに外から呼べる口を足す（案A と案C で共通）

- やること: 命令名と引数で受け、許可リストの命令だけを同じ Rust の関数で呼ぶ。`pty::subscribe` の購読を複数にする。
- 完了の条件:
  - 許可リストの命令を、試験から名前と引数で呼べる。リストに無い名前は断る
  - 許可リストの名前が全部 `generate_handler!` にあることを、試験で確かめる
  - Mac の窓で端末を開いたまま、2つ目の購読をつけても、両方に出力が届く
  - 1本の接続から続けて送った term_input が、送った順に PTY に届く
  - 外からの口は、設定で有効にしたときだけ動く。開発版は既定で動かない

### 3. 経路をつなぐ（案C の場合）

- やること: Rust から部屋への接続と再接続、ping。Worker の部屋と、`01.access.ts` のサービストークンの例外。
- 完了の条件:
  - アプリを起動すると部屋につながり、ネットワークが切れても戻ればつなぎ直す
  - アプリがつながっていないとき、ブラウザに「アプリにつながっていない（最後は何時何分）」が出る
  - 2つ目のアプリがつなぐと、古い接続が閉じる
  - cloudflare-do-safety を実行し、結果を PR 本文に書く
  - サービストークンの秘密は、アプリの置き場所（`fc_path(Scope::App, …)`）に権限 600 のファイルで置く。安定版と開発版で分かれ、古い安定版はこのファイルを読まないので、形を気にしなくてよい

案A になった場合は、ここを「cloudflared の起動と止め方、トンネル、DNS、Access アプリ、Linked App Token のポリシー、アプリでの JWT の確認」に読み替える。

### 4. 画面をつなぎ替える

- やること: `src/bridge.ts` の `WEB` を、新しい口で命令名と引数を送る形にする。`openTerminal` も新しい口で読む。
- 完了の条件:
  - ブラウザ版で、一覧、会話、送信、承認、割り込み、新しい世帯、停止、端末の表示が動く。スマホの幅でも確かめる
  - 承認の欄、モデルと権限モードの切り替えが、アプリと同じ Rust の処理を通る
  - Mac の窓とスマホで同じ端末を開いても、Mac の窓の端末の幅が変わらない
  - README の「ブラウザ版（PWA）」を書き直す

### 5. ccn の経路を消す

下の「5. 消すもの」の順で消す。

## 5. 消すもの

新しい経路でブラウザ版が動いたことを確かめてから消す。先に消すと、その間ブラウザ版が使えなくなる。

1. 画面の ccn の枝を消す。`src/webConv.ts`、`src/webPerm.ts`、`src/webReserve.ts` と、その試験（`webConv.test.ts`、`webPerm.test.ts`、`perm-cases.json`。`perm-cases.json` を読むのは webPerm の2つだけである）。`session/control.ts` の `viaCcn` と、それを使う分岐（`sendVia.ts`、`usePanelSend.ts`、`useBoot.ts`、`Composer.tsx`、`SessionControls.tsx`、`App.tsx` の `source: "ccn"`）。
2. Worker の中継を消す。`web/lib/proxy.ts`、`web/routes/api/[...path].ts`、`web/routes/n/[...path].ts`。`web/lib/origin.ts` は新しい経路でも使うので残す。
3. デプロイして、town.fybe.jp が新しい経路だけで動くことを確かめる。
4. Access アプリ `ccn` から、ポリシー `town-linked` を外す。`owner` と `nodes` は ccn 自身が使うので残す。この後は、town.fybe.jp から ccn.fybe.jp へ届かなくなる。
5. README の「ブラウザ版（PWA）」から ccn の記述を消す。`void.config.ts` のコメントも直す。

ccn そのもの（LaunchAgent、トンネル、Access アプリ `ccn`）は、ほかのプロダクトと本人の MCP が使っているので、この作り直しの範囲では止めない。

## 6. 確かめていないこと

- Access のサービストークンを付けた WebSocket の upgrade が通るか（公式の service-tokens のページに WebSocket の記述が無かった）。
- Void の `defineRoom` で、アプリへ送って返事を返す中継が書けるか。部屋の休眠をまたいで接続ごとの状態が残るか。自動の応答を使えるか。
- Void の middleware が `.ws.ts` の道にも通るか。
- 今の本番で、ccn 経由の端末の SSE が動いているか（コードと README は動く前提である）。
- Workers VPC が WebSocket と流れる応答を通すか。
- Cloudflare Tunnel の値段。アカウントの Workers のプラン（Free か Paid か）。
- 端末の出力の通数（毎秒約60通は上限からの推定で、実測ではない）。
- アプリを閉じても外から見たいか（本人への確認事項）。
