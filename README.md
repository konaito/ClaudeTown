# Claude Town

Claude Town は、Claude Code のセッションの親子を、町に住む家族の子供たちが働く姿として見せる Tauri 製のデスクトップアプリである。旧名はファミリーコンピューティングで、リポジトリとディレクトリの名前（family-computing）、bundle identifier、hook と状態の置き場（`~/.family-computing/`）は旧名のまま使う。画面の子供をクリックすると、その子に注文を出せる。この文書は企画書で、決まったことと決まっていないことを分けて書く。

## 動かすのに要るもの

Claude Town は、この Mac の Claude Code の記録と、状態を書く hook だけで動く。ほかに常駐するプログラムは要らない。2026-11-20 までは ccn（Claude Code Nodes）とセットで動いていたが、2026-11-21 の本人の決定で、アプリから ccn を外した。

- Claude Code の CLI（`claude`）が要る。町の一覧と会話は `~/.claude` の記録から読む。新しい世帯は、アプリの中の端末で `claude` を起動して立てる。
- 状態の hook（`hooks/fc-report.py`）が要る。頼まれたことや、いまやっていることを `~/.family-computing/state/` に書く。登録の仕方は下の「hook」にある。

アプリは `claude` を、ログインシェルの PATH から探す。見つからなければ `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` の順に探す。

ブラウザ版（PWA）は、まだ ccn を通して動く。扱いは本人が決める（下の「ブラウザ版（PWA）」）。

## 何を作るか

エージェンティックコーディングでは、1人の人が Claude Code を親、子、孫と何十体も並べて動かす。Claude Town は、この並びを「家族」として扱う。人が開いたセッションが親で、親が作ったセッションが子、子が作ったセッションが孫になる。1つの親とその子孫を1世帯と数え、町は世帯の集まりになる。

画面は3つのペインに分ける（#89）。左は新しい世帯のペインで、最近使った場所の一覧から親を立てる。中央は町で、世帯（根のセッション1つとその子孫）ごとに、淡い色の角丸の枠を1つ描き、中に親と子と孫を木の形で並べる。右には選んだ子の会話と注文の欄を出す。左のペインはヘッダーのボタンとドラッグで開け閉めでき、右の欄はセッションを選んでいない間は閉じている。スマホの幅では別の画面（`src/mobile/`）になり、この3ペインではない。

世帯の中の配置は、決定論的な幾何の配置で決める（`src/layout/`。方針は `docs/design/geometric-layout.md`、検証の条件は `docs/design/physics-layout.md` の 10）。世帯の一番上の親を中心に、世代ごとの半径に並べる。根の子は下向きを中心に、孫より下は親の角度を中心に、兄弟を重ならない最小の角度（2·arcsin(r/R)）で並べる。子孫の多い枝には、葉から計算した広い角度を割り当てる。実際の箱（キャラと名前）で重なり、親子線の交差、線が箱を通ること、枝の混ざりを検査し、残れば決まった順序で角度の余白、次に半径を広げる。兄弟を並べる弧の上限を4通り試し、検査を通るもののうち s（配置の幅と高さを表示領域で割った大きいほう）が一番小さいものを選ぶ。子が1〜8人の世帯は、この計算をせず決まった座標に子を置く。3人から8人は格子に並べ、左右の子は親と同じ高さにする。子3人は親の左右に1人ずつと真下に1人、子4人は親の左右に1人ずつと下の段に2人、子5人は親の左右に1人ずつと下の段に3人を並べる。子6人は上の段に2人、親の左右に1人ずつ、下の段に2人を並べる。子7人は6人の下の段に真下を足し、子8人はさらに真上を足して親の周りの8か所を埋める。子9人以上は上の計算で置く。孫がいても子の座標は変えず、孫をその子の、親から離れる向きの延長に並べる。検査を通らなければ、孫までの距離を広げる。乱数と時刻は使わない。配置を計算し直すのは世帯の顔ぶれが変わったときだけで、新しい座標へは短いアニメーションで移る。パラメータは `src/layout/params.ts` にまとめた。

孫より下は、キャラと名前と状態の点だけの小さい札にする。札を押すと、親や子と同じ大きさのカードを上に重ねて広げ、周りの配置は動かさない。空白を押すと元に戻る。

世帯の枠（モジュール）の並べ方は、世帯の中の配置とは別の処理にした（`src/layout/pack.ts`、仕様は `docs/design/household-packing.md`）。並び順は「親（根）のセッションの開始時刻の順、同じなら ID の順」に決めた。大きさや状態では並べ替えない。この順に1個ずつ、決まった横幅の中へ上詰めで置く。直前の世帯より上には置かず、直前と同じ高さなら右に置く。隙間は残り、後の世帯が先の世帯を追い越さない。毎回最初から計算し、新しい座標へは短いアニメーションで移る。人を待っている世帯は、上の「お便り」の行で先に知らせる。

親と子のカードには、親・子・孫の別、係の1行、状態、キャラ、名前を出す。キャラは状態に合わせて動く。作業中は足踏みし、印は出さない。承認待ち、返事待ち、完了のときだけ、頭の右肩に絵文字の印を出す。

画面の一番上には「お便り」の行を置く。人を待っている子のうち最初の1件を大きく出し、横に次の2件を小さく並べる。この行の書き方は i-have-adhd スキルに従う。

子が承認待ちか返事待ちに入ると、macOS の通知を出して音を鳴らす（#292、`src-tauri/src/notify.rs`）。報告（完了）では出さない。窓が隠れている間は町の一覧の見張りが止まるので、判断は Rust が持ち、見張りが止まっている間だけ自分で一覧を作る。子ごとに入ったときに1回だけ出し、アプリを起動したときに既に待っている子には出さない。

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

Claude Town の違いは3つある。データ源をこの Mac の Claude Code の記録に寄せること、キャラから文を送れること、孫までの親子を家族の木として見せることである。

## データの取り方

町の一覧と会話は、この Mac の Claude Code の記録と、hook の状態ファイルから作る。記録の置き場所は `~/.claude` で、`FC_CLAUDE_HOME` で差し替えられる。読むだけで、`~/.claude` には書かない。cam の各プロファイルの `sessions`、`projects`、`teams` は `~/.claude` へのリンクなので、1か所を読めば全部のアカウントの分が読める。

| 知りたいこと | 取り方 |
| --- | --- |
| 生きている対話セッションと状態 | `~/.claude/sessions/<pid>.json`。pid が生きているものだけを出す。status の busy は作業中、waiting は承認待ち、idle は待機にする（`src-tauri/src/native/sessions.rs`） |
| 会話 | `~/.claude/projects/<cwd を直した名前>/<session id>.jsonl` を、前に読んだ位置から続けて読む（`native/conv.rs`） |
| sub-agent と in-process のチームメイト | 親のセッションの `<session id>/subagents/agent-<agent id>.jsonl` と `.meta.json`。meta の taskKind が in_process_teammate ならチームメイトとして出す（`native/subagents.rs`） |
| tmux のチームメイト | `~/.claude/teams/<チーム名>/config.json` の members と、ps で見た claude の起動の引数（`--agent-id`、`--parent-session-id`）。会話は同じ cwd の jsonl のうち、teamName と agentName が合うもの（`native/teams.rs`） |
| 親子 | sub-agent とチームメイトは、置き場所と config.json から親を決める。ほかのセッションは、最初の文の from 行（`from agent:<ノード>/<親の sid 先頭8>/<役割> via <ノード>`）から引く。from 行は ccn などのプロダクトが子を立てるときに付ける。sid 先頭8が16進の8文字でない from 行（ccn が session id を知らないときの `agent:<ノード>/<役割>`）からは親を引かない。/clear で id が変わっても pid は変わらないので、同じ pid の前の id を使って親子をつなぐ。前の id は、アプリの端末なら台帳の ids から、ほかの端末なら状態 hook が claude のプロセスごとに書く `~/.family-computing/ids/<pid>.json`（名乗った id の並び）から引く。子の from 行が親の前の id を指していれば、親の今の id を親にする。子が /clear して今の記録に from 行が無ければ、子の前の id の記録の from 行を使う。hook の並びは、最後の id が同じ pid の今の id と合うときだけ使う。並びは新しいプロセスの始まり（SessionStart の source が startup か resume）で作り直し、pid が死んだものを SessionStart の掃除で消す。この hook が動く前に変わった id と、hook の環境に CLAUDE_PID が無い版の claude の id は、並びに無いので引けない。親子が輪になったら、輪の中で最も早く始まったセッションを根にする |
| 頼まれたこと、いまやっていること、最後の報告、次の一手 | hook が書く `~/.family-computing/state/<session_id>.json` |
| 閉じてよいか | close-check-state hook が書く `~/.claude/close-check/<session_id>.json` |
| 新しい世帯の「最近の場所」 | Claude Code の入力の履歴 `~/.claude/history.jsonl` の project と timestamp（`src-tauri/src/places.rs`） |

記録から読むセッション（Claude Town の外で起動したもの）には、割り込み、端末、承認の操作ができない。操作できるのは、アプリが立てたセッションだけである（下の「アプリの中の端末」）。

停止と再起動は、外で起動した対話セッションにもできる（#309）。停止は、`sessions/<pid>.json` の pid に SIGHUP を送る。アプリが立てた端末と同じ止め方である。送る前に、記録の `procStart` と今のプロセスの起動時刻（`LC_ALL=C TZ=UTC ps -o lstart=`）が合うかを確かめ、合わない記録や `procStart` の無い記録には送らない。3秒たっても同じプロセスが残っていれば SIGKILL を送る。外で起動した claude は、SIGHUP から 1.69 秒で終わり、`sessions/<pid>.json` と hook の状態ファイルも消えた（2026-11-26、2.1.332）。起動した端末はシェルに戻る。再起動は、止めてから同じ id を `claude --resume` でアプリの端末に立て直す。立て直した後は、アプリが立てたセッションとして扱う。受信ソケットに `/exit` を送る方法は使えない。`/` のコマンドは、ただの文として届く。

文の送信だけは、外で起動した対話セッションにもできる（#156）。`sessions/<pid>.json` の `messagingSocketPath` にある受信ソケットへ、`{"type":"user","message":{"role":"user","content":"<文>"}}` の1行を書く。ccn の `terminal-driver.ts` と同じ形である。届いた文は、相手には別の Claude のセッションからの文として入る。

同じセッションを2か所で開くと（アプリの端末と、外の端末の `claude -r <id>` など）、`sessions/` に同じ sessionId の記録が2つできる（#328）。町の一覧では、1つの id を1行にまとめる（#331、`native/sessions.rs` の `merge_same_id`）。画面の key、状態ファイル、キャラの割り当て、操作の命令が、どれも id を鍵にしているためである。
- 残す行は、アプリの端末の pid の行にする。アプリの端末が無ければ、新しく開いたほう（`startedAt` が大きいほう）の行にする。外で起動したセッションへの送信と停止も、同じ並びで選んだプロセスに当たる。
- 様子は、どれかが承認待ちなら承認待ち、どれかが作業中なら作業中にする。待ちの通知（#329）と同じ考え方である。開始は早いほう、最後の動きは遅いほうの時刻にする。
- 停止は、同じ id を名乗るプロセスを全部止める。アプリの端末は端末ごと止め、外の claude には SIGHUP を送る。1つでも残ると id が一覧に残り、画面は10秒後に「止まらなかった」と出すためである。
- 再起動は、2か所以上で開いているときは止める前に断る。再起動は会話をアプリの端末に移す操作なので、外の端末を黙って閉じないようにした。外で開いている分を閉じてから再起動する。
- アプリの端末が一覧で落とした側の pid でも、台帳（`terminals.json`）の今の id はまとめる前の行から決める。

- 相手が作業中なら、文は順番待ちになり、ターンの途中で取り込まれる（2026-11-22、2.1.330 で確かめた）。
- `/` のコマンドと `!` のシェルは、コマンドとして動かずに文として届くので、送らずに断る。
- 相手は、送り主を別のセッションと読む。2026-11-22 の確認では、haiku の相手が返事を SendMessage で送り返そうとして、送り主が分からずに止まった。
- ソケットのファイルが無いセッション、sub-agent、チームメイトには送れない。

チームメイトの出し方は、2026-11-21 の実測（`docs/research/agent-teams-observed.md`）に合わせた。

- 終わったセッションのチームは `~/.claude/teams` に残る（61件のうち58件はリードが死んでいた）。リードの session id が生きているセッションの一覧にあり、`leadProcess.pid` がそのセッションの pid と同じチームだけを見る。
- tmux のチームメイトは `sessions/<pid>.json` を作らない（2回の観測の両方で同じだった）。ps に起動の引数が無ければ、終わったものとして出さない。
- in-process のチームメイトには finished の印が付かない。チームの config.json の members にいる間は、待機のまま町に出し続ける。
- 知らない形（知らない backendType、読めない config.json など）は、黙って落とさず件数に数える。数は snapshot の `sources.native.unexpected` に出る。

### アプリの中の端末

「新しい世帯」を押すと、Rust が PTY の中で `claude --session-id <新しい UUID>` を起動する（`src-tauri/src/pty.rs`）。出力は右パネルの xterm.js に流し、打ったキーは PTY に書く。crate は portable-pty（wezterm の一部、MIT）を使う。

- Claude Code は、`--session-id` で渡した id を `sessions/<pid>.json` に書く。この pid は、PTY で起動した claude の pid と同じである（2026-11-21 に実測）。
- 信頼の確認の画面を抜けるまで、`sessions/<pid>.json` は作られない。その間は、アプリの台帳から仮の行を町に出す。
- /clear で session id が変わっても、pid は変わらない。台帳は pid で引き、一覧で同じ pid に見えた id を同じ端末として扱う。
- 子プロセスの環境からは、`CLAUDECODE` と、`CLAUDE_CODE_` で始まる変数などを外す。アプリを Claude Code の中から起動したときに、子が親のセッションを名乗らないようにするためである。`CLAUDE_CONFIG_DIR` は残すので、子はアプリを起動したアカウントで動く。
- アプリを終了すると、アプリから立てた世帯の claude は全部止まる。終了のときに SIGHUP を送り、3秒で終わらなければ SIGKILL を送る（claude は SIGHUP から終わるまで 1.27 秒かかるので、1秒では後始末の途中で SIGKILL になっていた。#232）。アプリが落ちたときも、PTY が閉じて claude は終わる（2026-11-21 に、子を止めずに親のプロセスを終えて確かめた）。
- アプリが立てた端末の一覧（台帳）を `terminals.json`（安定版は `~/.family-computing/`、開発版は `~/.family-computing/dev/`）に残す。次にアプリを起動したとき、台帳にあるセッションを `claude --resume <id>` で元の場所に立て直す（#152）。立て直した端末も、アプリが立てた端末として送れて止められる。結果は同じ置き場所の `restore.log` に書く。
  - 台帳から外すのは、画面から閉じたときと、claude が自分で終わったとき（`/exit` など）だけである。アプリを終了したとき、落ちたとき、`release-stable.sh` で入れ替えたとき（SIGTERM）は、開いていた分が台帳に残る。
  - `/clear` や `/resume` で id が変わったら、台帳には今の id を残す。
  - 会話の記録（`projects/*/<id>.jsonl`）が無いもの（1通目を送る前に止まったもの）と、同じ id がよそで動いているものは、立て直さずに台帳から外す。起動に失敗したものは台帳に残し、次の起動でもう一度試す。
  - `FC_NO_RESTORE=1` で起動すると、立て直さず、台帳も書かない。
- 左のペインの下の「セッション id で開き直す」に、終わったセッションの id を入れて Enter を押すと、会話の記録の場所で `claude --resume` を立てる。

## 操作

- 子供を左クリックすると、右のパネルにその子の会話が出る。
- 子供を右クリックすると、その子を選んで端末を開く。端末を開けるのは、アプリが立てたセッションだけである。
- 左のペインの「新しい世帯」（lucide の plus の付いたボタン）を押すと、すぐ設定の場所（設定していなければ `~/Documents/meta`）で、親のいない claude を立てる（上の「アプリの中の端末」）。立てたら、そのセッションを選んで右のチャットを開き、入力欄にフォーカスを当てる。最初の依頼の欄は出さない。セッションが0本の空の町でも、ここから最初の世帯を作れる。
- 「新しい世帯」の下の「最近の場所」は、Claude Code の入力の履歴から作り、新しい順に20件出す。worktree はリポジトリの場所にまとめ、今は無い場所は出さない。新しい世帯の置き場所（設定した場所、無ければ `~/Documents/meta`）は、ボタンと同じ場所なので一覧から除く（2026-11-21）。ペインに見出しは出さない（2026-11-21）。
- 置き場所は、ヘッダーの右端の歯車（設定）の「新しい世帯の場所」で変える。最近の場所から選ぶか、絶対パスを入力する。無い場所は、立てるときに断り、通知に場所を出す。保存先は localStorage の `claude-town.newHousePlace` で、この Mac のアプリ（ブラウザ版ではそのブラウザ）ごとに1つ。
- 子は親のセッション自身が作る（Agent ツールや agent team）。画面から子を足す操作は出さない（2026-11-12、本人の判断。使う機会が無いため）。
- チャット欄の文は、アプリが立てたセッションの端末の入力欄へ貼り、Enter を押して送る。/ と ! で始まる文も、CLI に打ったのと同じに動く。画面を開くコマンド（/model など）は、送った後にターミナルのタブを開く。承認待ちのときと、claude がまだ起動していないとき（信頼の確認の画面）は送らない。
- チャット欄に貼るか落とした画像は、手元のファイルのパスとして文に入る（#64）。送るとき、画像のパスは文から切り分けて1つずつ貼る。CLI は、1回の貼り付けの中身全体が画像のパスのときだけ `[Image #N]` の添付にするからである（#67、2026-11-26 に v2.1.332 で確かめた）。画像のパスを貼ったら、入力欄に `[Image #N]` が出るのを最大5秒待ってから次を貼る。待たずに続けて貼ると、印が後ろの文より後ろに付く。切り分けるのは、`/` から始まり、実在し、拡張子が png、jpg、jpeg、gif、webp のパスだけである。! と / で始まる文（bash のモードとコマンド）は、頭の語が画像のパスでない限り切り分けず、今までどおり1回で貼る。切り分けは `src-tauri/src/composer.rs` の `paste_parts` にある。
- カードの右下と右パネルの見出しに、同じ3つのボタンを並べる。閉じる（lucide の power）、様子を聞く（message-circle-question-mark）、許可する（thumbs-up）の順で、並びと送る文は `src/card/CardActions.tsx` の `CARD_ACTIONS` で決める。ボタンに乗せると、押せるときは何をするか、押せないときは押せない理由を、WebView の標準のツールチップ（`title`）で出す。
- 閉じる（power）は、claude を子孫ごと孫から順に止める。Claude Town の外で起動したセッションも止める（#309）。tmux のチームメイトは止めずに残す。
- 承認待ちの子は、カードの枠が黄色で点滅する。アプリが立てたセッションの承認には、右パネルの承認の欄から答えられる（下の「承認の欄」）。Claude Town の外で起動したセッションは、起動した端末で答える。
- 作業中で入力欄が空のときは、送るボタンが止めるボタン（lucide の square を塗ったもの）になる。押すと端末に Esc を書き、今の作業を止める（#83）。端末への書き込みが3秒以上戻っていない（claude が入力を読んでいない）ときは Esc を書かず、claude を止めて同じ会話を `--resume` で立て直すかを聞く。「立て直す」はカードの再起動と同じ処理で、届いていない入力は捨てる（#240）。
- 会話の道具の行は、結果が届いたら押して開ける。開くと、まとめた道具ごとに1行と結果の頭（40行、1500字まで）を出し、失敗した道具には「失敗」と付ける（#83）。止めたターンと失敗したターンは、会話の中に「ここで止めた」「ターンが失敗で終わった」の印を出す。
- `~/.family-computing/send-disabled` があると、注文、端末への入力、新しい世帯の作成、停止を全部断る（送信の非常停止）。

ccn を外したときに、別の機械の町、転出、引き継ぎ、チャットの欄からの承認、オフラインの保存をやめた（2026-11-21）。どれも ccn の口を使っていた。モデルと権限モードの切り替えは、端末に書く作りで戻した（下の「モデルと権限モードと effort」）。チャットの欄からの承認も、端末に書く作りで戻した（下の「承認の欄」、2026-11-22）。

### 承認の欄

アプリが立てたセッションの承認（質問、道具の承認、計画の確認）に、右パネルから答える。処理は `src-tauri/src/dialog.rs`、画面は `src/approval/Approval.tsx` にある。

- 承認の中身は、端末の画面（vt100 で解いたもの）と、待っている道具の input から作る。画面の番号の行を読み、待っている道具と突き合わせる。質問の文と選択肢は、AskUserQuestion の input から読む。
- 待っている道具の input は、先に状態 hook が PermissionRequest で残したもの（`~/.family-computing/perm/<session_id>.json`、新しい順の8件）を見る。無ければ transcript で結果がまだ無い道具を見る。transcript には、承認の画面が出ている間に道具の行がまだ書かれていないことがあった（2026-11-22、質問と計画の確認の両方で見た）。
- hook が動くのは安定版の置き場の `fc-report.py` なので、perm のファイルは安定版へ上げた後に書かれる。それまでは transcript だけを見て、読めない質問はターミナルで答える。
- 道具の承認と計画の確認は、画面に出た行をそのままボタンにする。行は道具と設定で変わる（Yes、Yes, and …、No）。
- 答えるときは、CLI の承認の画面に人が打つのと同じキーを書く。キーを1つ書くたびに画面を読み直し、次のキーを決める。番号で選ぶ行は、番号と行の文の両方が合うときだけ押す。
- 画面の承認が、この会話で待っている道具と合わないときは何も書かない。欄には理由と「ターミナルを開く」を出す。
- 端末の高さを超える command の承認は、上が「↑ N more lines」と省かれ、見出しと command の1行目が画面に出ない。このときだけ、command の後ろから画面に続けて出ている長さで比べる。後ろから30字（短い command は全部）が出ていない記録は使わない（#319、2026-11-26 に v2.1.332 の実機で確かめた）。
- in-process のチームメイトの道具の承認は、リードの端末に「Bash command · from the list-kun agent」のような見出しで出る。見出しの名前と同じチームメイトの hook の記録とだけ突き合わせ、合えばリードの欄から答える。名前は記録の `agent_id` から `subagents/agent-<agent_id>.meta.json` の name で引く。欄の題には依頼元のチームメイトの名前を出す（#317）。2026-11-26 に v2.1.332 の実機で確かめたのは、Bash の承認の許可、理由付きの拒否、理由なしの拒否の3つ。ほかの道具も同じ見出しの形で出ると仮置きしている。チームメイトの承認を理由なしで断ると、道具の結果が「別のやり方を試す」になり、チームメイトの作業は止まらない。リードは割り込まれない。見出しに名前の無い承認が、チームメイトや sub-agent の記録とだけ合うときは、今まで通り答えない。チームメイトの質問と計画の確認は、実物の画面を見ていないので答えない。
- PreToolUse の hook が ask を返した承認は、画面に出た hook の理由を欄に出す。
- 計画の確認は、画面だけで決める。id は画面に出た計画の本文から作る。計画の本文の無い ExitPlanMode は「Exit plan mode?」の画面になり、道具の承認と同じに扱う。
- 計画を承認すると、claude が新しい session id に移ることがあった。一覧は pid で同じ端末として扱うので、承認の欄は新しい id で読み直す。
- 道具の承認を理由付きで断ると、No の行で Tab を押して理由を打つ。作業は止まらない。理由が空なら No を押し、作業が止まる。
- 見本（preview）付きの質問は、ここからは答えない。キーの動きを確かめていないためである。
- 2026-11-22 に v2.1.330 の本物の claude で確かめたキーの動きは、`dialog.rs` の頭に書いた。本物の claude で通しに確かめる試験は `real_claude_answers_through_the_pty`（`#[ignore]`、起動の仕方はその試験のコメントにある）。

### モデルと権限モードと effort

チャット欄の「送信先」の行に、モデルと権限モードと effort の選択を置く。選択はいつでも押せる（2026-11-21、本人の依頼。effort は 2026-11-23 の依頼で足した、#291）。設定の画面でも、新しい世帯のモデル、権限モード、effort の既定を選べる。既定の effort は claude の `--effort` で渡す。ブラウザ版の新しい世帯には渡さない（ccn の POST /sessions が受けない）。決まりは `src/session/control.ts` の `planOf`、端末に書く処理は `src-tauri/src/switch.rs` にある。

- アプリが立てたセッションは、端末に CLI と同じ入力を書いて替える。モデルは `/model` のピッカーを開き、目当ての行で `s`（このセッションだけ）を押す。権限モードは Shift+Tab である。
- モデルは作業中でもすぐ替える。`/model` は作業中に打っても待たされず、同じターンの次の要求から効く。
- 権限モードは待機中に替える。Shift+Tab は default、acceptEdits、plan、bypassPermissions、auto の順に回るので、作業中に回すと途中のモードで道具が走りうる。
- 承認待ちの間は、モデルも権限モードも替えない。端末に書いた入力が承認の画面に入り、Enter が許可になるためである。
- 今は替えられないときに選んだ値は予約になる。選択は破線の枠で予約の値を出し、下に「承認に答えたら替える」「このターンが終わったら替える」と出す。今の値を選び直すと予約を取り消す。
- 予約は Rust が持ち、0.5秒ごとに `sessions/<pid>.json` の status を見て当てる。窓が隠れていても当たる。アプリを終えると予約は消える。アプリが立てた claude もアプリと一緒に止まるので、持ち越す先が無い。
- 今の値は transcript の `permission-mode` の行と、assistant の行の `message.model` から読む。アプリの端末の権限モードは、端末の下の行（「⏸ manual mode on」など）を優先する。待機中に Shift+Tab で替えたモードは、次の文を送るまで transcript に書かれないためである。端末の画面は、出力を vt100（crate、MIT）で解いて読む。作業中に開いたピッカーは行を描き直さず ❯ の1文字だけを書き直すので、出力の生の文字列では読めなかった。
- `/model <別名>` と、ピッカーで Enter を押すのは、新しいセッションの既定も替える。`~/.claude/settings.json` に model を書き、その行を消しても既定は戻らなかった（2026-11-21 に確かめた）。だからアプリはピッカーの `s` を使う。`s` では「for this session only」と出て、settings.json も既定も変わらなかった。ピッカーの上の段に無いモデル（More models の中など）は、ここからは選べない。
- dontAsk は Shift+Tab の順に出ないので、端末からは替えられない。bypassPermissions と auto は、そのセッションで使えるときだけ順に出る。順に出なければ、1周して元のモードに戻し、理由を通知に出す。
- effort は `/effort` のピッカーで替える。ピッカーは ←/→ で low、medium、high、xhigh、max を動かし、`s` でこのセッションだけに効く。`s` では settings.json は変わらなかった（2026-11-23、v2.1.330 で確かめた）。`/effort <値>` と Enter は、会話があると「saved as your default for new sessions」と出て、settings.json の `modelSettings.<モデル>.effortLevel` を書き換えた。だからアプリは値を付けて打たない。
- effort はモデルと同じく作業中でもすぐ替え、承認待ちの間だけ予約する。ピッカーは作業中にも開いて効いた。
- 今の effort は、transcript の `Set effort level to <値>` の行（`/effort` の出力）から読む。使うのはこの起動より後の行だけである。`--resume` で立て直すと、前の起動で替えた effort は消えるためである。替えていなければ、起動に渡した `--effort` の値、それも無ければ画面の「● high · /effort」か起動の見出しの「with xhigh effort」から読む。
- ブラウザ版の ccn の行では effort を替えられない。ccn の PATCH は effort を受けず、端末のセッションへの `/effort` は設定ファイルに保存されるとして ccn が断る。選ぶと理由を出す。
- アプリの外で起動したセッション、チームメイト、sub-agent には、外からモデルや権限モードを届ける口を作っていない。選ぶと、代わりの手（そのターミナルで `/model` を打つ、など）を出す。公式の文書に載っている口は無い（2026-11-21 に確かめた）。設定ファイルの model は起動のときに1回だけ読まれる。hook の出力で権限モードを替えられるのは PermissionRequest の `setMode` だけで、その承認を許可するのと一緒にしか使えない。チームメイトのモデルは起動のときに決まる。tmux のチームメイトの `tmuxPaneId`（tmux send-keys で書ける）と、`sessions/<pid>.json` の `messagingSocketPath` は試していない。

## hook

本人の依頼は「このプロダクトのために再度整理させるための hook」だった。2つの読み方を出して本人に聞き、A に決まった。

- A（採用）: 各セッションに、いまの様子を書き出させる hook。UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、Notification、Stop、SessionStart、SessionEnd で、頼まれたこと、いまやっていること、最後の報告、次の一手、人を待っているかを状態ファイルに書く。LLM は呼ばない。
- B（不採用）: 各エージェントに、終わった子を閉じさせ、ツリーを浅く保たせる hook。

hook の本体は `hooks/fc-report.py` に置く。2026-11-12 に本人に確かめて `~/.claude/settings.json` に登録した（同じ日に PermissionRequest も足した）。`~/.claude/settings.json` が呼ぶのは作業ツリーの hook ではなく、安定版のタグから写した `~/.family-computing/stable/hooks/fc-report.py` である（下の「安定版と開発版」）。登録と解除は `python3 scripts/hook.py install` と `python3 scripts/hook.py uninstall` で行う。install は写した先を登録し、写した先が無ければ何も書かずに止まる。書く前に settings.json の控えを残す。cam の各プロファイルの settings.json は `~/.claude/settings.json` へのリンクなので、1か所で全部に効く。登録するコマンドは、登録先のファイルが無ければ何もせず 0 で終わる（#171）。登録したまま worktree や写した先を消しても、セッションの道具と入力は止まらない。#171 より前に登録した形（`/usr/bin/python3 <パス> # family-computing`）にはこの確認が無いので、`status` が「古い形の登録がある」と出したら install し直す。

hook は本物の `claude -p` で試し、頼まれたこと、道具、最後の報告、次の一手が状態ファイルに入ることを確かめた。

in-process のチームメイトと sub-agent の hook は、リードの session_id に `agent_id` が付いて届く。hook はこれをリードの状態ファイルには書かない。例外は承認で、チームメイトの承認の画面はリードの端末に出るので、リードの承認の並びに足し、終われば外す（2026-11-21 に Claude Code 2.1.330 で確かめた）。送ったお手紙は、from を町のチームメイトの行の id（`sub-<agent_id>@<session_id の先頭8字>`）にして書く（#271）。チームメイトの文（`<teammate-message>`）を受けたときは UserPromptSubmit が出ないので、受けた記録は作らない（2026-11-23 に Claude Code 2.1.330 の in-process と tmux で確かめた）。既読の印は、アプリが受けた側の jsonl に出た teammate-message から作り、画面に渡す一覧の中で sent と対にする。letters.jsonl には書かない（#276、`src-tauri/src/native/received.rs`）。チームメイトの様子は、hook ではなく `native/subagents.rs` が meta.json と jsonl から作る。tmux のチームメイトは自分の session_id で届くので、ふつうのセッションと同じに書く。

## 決まったこと

- hook は A にする。
- 左クリックの「メッセージの挿入」は、端末の入力欄へ文を貼って送ることにする（2026-11-21 までは ccn で送っていた）。モックに合わせ、送る欄は右のパネルの会話の下に置く。
- 白を基調にした明るい配色にする。
- 状態は、作業中（緑）、返事待ち（青）、承認待ち（黄）、完了（灰）、待機の5つにする。承認待ちは `sessions/<pid>.json` の status が waiting のもの、返事待ちは hook が「人への問いで終わった」と書いたものと、set_status の blocked。
- キャラの体は Ninja Adventure Asset Pack（CC0）のドット絵、状態の印は Noto Animated Emoji（CC BY 4.0）の WebP にする（見本ページの案 C）。印の置き方は案 A の位置の2段階目（A2）。キャラは55体から、根はおじさん、子はお兄さん、孫より下は子供に見える顔ほど出やすい、世代の重みつきの乱数で選ぶ（2026-11-12 から。`src-tauri/src/avatars.rs`、`docs/design/character-age.md`）。見本は `docs/research/assets/index.html` と `docs/research/assets/balance.html`。
- 家の絵（屋根、壁、床）は描かない。世帯は淡い色の枠で見分ける。
- プロダクト名は Claude Town にする（2026-11-12）。数える単位は世帯で、画面の見出しは「5世帯・23人」のように出す。
- 世帯とカードの名前は、そのセッションが作業しているプロジェクトの名前にする（2026-11-13）。プロジェクトの名前は、リポジトリの本体のディレクトリの名前（例 family-computing）。決め方は `src-tauri/src/naming.rs` と `src/model.ts` の cardNames に同じものを書き、試験の事例は `src/naming-cases.json` にまとめて両方で読む。
  1. git の worktree は、`.git` の gitdir から本体の名前に直す（この機械の町だけ）。`.git` を読めないときは `<名前>.wt/<x>` を <名前> にし、それ以外は cwd の最後の名前にする。
  2. cwd があれば、cwd のプロジェクトの名前にする。ホーム、`~/Documents` 直下、`~/.local/share/ccn/lobby`、`/`、`/tmp` も cwd の最後の名前のままにする（子孫の cwd は見ない）。
  3. cwd が無ければセッションの題名（`sessions/<pid>.json` の name）、それも無ければセッション ID の先頭8字にする。
- 世帯の名前は、根（親）のカードの名前と同じにする。子のプロジェクトは世帯の名前に影響しない。親が meta なら世帯の名前は meta になる（2026-11-21、#93）。画面からも、エージェント（旧 `hook.py name`、hook の促し）からも付けられない。旧版が `~/.family-computing/houses.json` に書いた名前（by=human、by=agent）は、読まず、消さない。
- チャットの発言とお手紙の差出人には、発言したセッション自身のカードの名前を出す。
- キャラの見た目は、右下の「素材」を開いた中の「キャラの見た目」で「いつもの」と「ポケモン」を切り替えられる。使う素材が見た目で変わるので、素材の表示と同じ所に置く。既定は「いつもの」で、選んだ値はこの画面の localStorage に残す。ポケモンでは、世帯の根のセッションの ID から3段進化の系統を1つ決め、親を3段目（最終進化）、子を2段目、孫（孫より下も）を1段目で描く。例えばリザードンの系統なら、親がリザードン、子がリザード、孫がヒトカゲになる。作業中は GIF を動かして小さく跳ねさせ、それ以外は1フレームを止める。絵は2Dのドット絵で、アニメの無い番号（第6世代以降の一部、38番号）は作業中も止め絵のまま跳ねる（2026-11-18、#76）。状態の印と待機の薄さは「いつもの」と同じ。GIF が読めないときは、その1体だけ「いつもの」の絵に戻す（2026-11-13）。

## 決まっていないこと

- 状態ファイルの「次の一手」は、返事の中の「次:」で始まる行と、最後の行が問いかどうかで決めている。この決め方で足りるかは、使ってみるまで分からない。

## 素材のクレジット

コードは MIT ライセンスです（`LICENSE`）。以下の素材は、それぞれのライセンスのままです。

- キャラ: Ninja Adventure Asset Pack（Pixel-boy、AAA。https://pixel-boy.itch.io/ninja-adventure-asset-pack）。CC0 1.0 で、帰属表示は要らない。使うキャラの Walk.png、Idle.png、Dead.png だけを `public/sprites/ninja/` に置いた。色のプロファイルなどの描画に使わない部分は外した（`scripts/strip-sprites.sh`、画素は変えていない）。
- 状態の印、幽霊、お手紙: Animated emoji: Noto Animated Emoji by Google, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Source: https://googlefonts.github.io/noto-emoji-animation/ 。状態の印の3種（270b、1f97a、2705）、閉じる演出の幽霊（1f47b）、お手紙の封筒（1f48c）の 512.webp を 64px に縮め、コマを半分に間引いた 64.webp を `public/sprites/noto/` に置いた。作り方は `scripts/make-noto-small.sh` にある。アプリの下の帯の「素材」にも同じ表示を出す。
- ポケモン（「素材」の中の「キャラの見た目」でポケモンを選んだときだけ）: 2Dのドット絵を、PokeAPI/sprites（https://github.com/PokeAPI/sprites）の `sprites/pokemon/versions/generation-v/black-white/animated/<図鑑番号>.gif`（ブラック・ホワイトの形のアニメ）から読む。アニメの無い番号は、同じ形の止め絵 `sprites/pokemon/versions/generation-v/black-white/<図鑑番号>.png` を使う。画像はこのリポジトリにもアプリにも入れず、表示中のキャラの分だけ実行時に raw.githubusercontent.com から取得する。URL はブランチ名ではなく、確かめたときのコミットで指す。系統の一覧 `src/kid/pokemon-lines.json` は図鑑番号と英名、止め絵の番号、余白を切る矩形だけで、`bun run scripts/pokemon-lines.ts` で作り直す。Pokémon © Nintendo / Creatures Inc. / GAME FREAK inc.
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

安定版は1つしか起動しない（#176）。2つ目は窓を作る前に終わり、1つ目の窓を前に出す。2つ目が端末の台帳（`terminals.json`）を空で書き直さないためである。止める仕組みは `tauri-plugin-single-instance` で、1つ目を identifier だけで見分ける（macOS では `/tmp/<identifier の . と - を _ にしたもの>_si.sock`）。安定版と開発版は identifier が違うので、互いを止めない。開発版は子が別のポートと別の `FC_APP_HOME` で並列に起動するので、既定では止めない。開発版で止める動きを確かめるときだけ `FC_SINGLE_INSTANCE=1` を付ける（`scripts/check-single-instance.sh`）。

子と開発者の決まり:

- 起動と確認には開発版だけを使う。
- 安定版（`/Applications/Claude Town.app`）を止めない、差し替えない、消さない。
- 安定版へ上げるのは、本人か親が頼んだときだけにする。
- 起動の仕方は「開発」の節の「子が開発版で確かめるとき」に書いてある。

安定版へ上げる:

```bash
git fetch origin && scripts/release-stable.sh origin/main
```

ローカルの `main` を渡さない。本体の checkout のローカルのブランチは pull されずに古いままのことがある。ローカルのブランチを渡したときは、上流より古ければスクリプトが止まる。

スクリプトは次の順に進む。

1. ref に `stable-YYYYMMDD-HHMM` のタグを打つ。既存の `stable-` のタグを渡すと、タグを打たずにそのタグを使う。ref が上流より古いローカルのブランチのときと、ref に `src-tauri/tauri.stable.conf.json` が無いときは、タグを打たずに止まる。
2. 作業ツリーとは別の一時 worktree にタグを取り出し、`bun install --frozen-lockfile` と `tauri build --bundles app` を行う。`--config` には、一時 worktree の中の `src-tauri/tauri.stable.conf.json`（上げるタグの版）を渡す。スクリプトを動かした checkout の版は使わない。Rust のビルド結果は `$HOME/.cache/claude-town/stable-target` に置き、次のリリースで使い回す。
3. できた .app の identifier と名前が安定版の値か確かめる。違えば入れずに中断する。
4. 安定版が動いていれば終わらせる。終わらせるのは `/Applications/Claude Town.app` の実行ファイルの pid だけで、開発版や他のプロセスには触らない。
5. 今の .app を `$HOME/.family-computing/stable/previous/` に退避し、新しい .app を入れる。タグの `hooks/` と `scripts/hook.py` を `$HOME/.family-computing/stable/` の下に同じ相対位置で写す。どのタグから写したかは同じ場所の `hooks.ref` に残る。
6. 安定版を起動する。5 で hook を写せなかったときは、起動まで済ませてから 1 で終わり、`releases.log` に `hooks-failed` の行を足す。`scripts/install-stable-hooks.sh <タグ>` で写し直す。

入っている版は `$HOME/.family-computing/stable/current.ref`、履歴は同じ場所の `releases.log` に残る。

設定の画面から上げる（#295）:

安定版の設定の画面に「更新」の欄がある。欄には、今の版（`current.ref` のタグと sha）、`origin/main` の sha、何コミット新しいかを出す。`origin/main` が今の版の子孫で、同じでないときは、ヘッダーの歯車に青い点を付ける。

- 安定版は、起動の20秒後から5分ごとに、本体の checkout（`~/Documents/family-computing`）で `git fetch origin` を裏で回す。設定の画面を開いたときも1回回す。どれも起動を待たせない。
- 「更新して再起動」を押すと、`git fetch origin` の後に、`origin/main` の `scripts/` を一時の場所に取り出し、`release-stable.sh origin/main` を走らせる。リポジトリの場所は `CT_REPO` で本体の checkout を渡す。本体の checkout の作業ツリーのスクリプトは走らせず、作業ツリーとブランチにも触らない。ローカルの main は pull されずに古いことがあり、新しいスクリプトの直しが更新に入らなかったためである（#299）。PATH はログインシェルのもので、無ければ `~/.cargo/bin`、`~/.bun/bin`、`/usr/sbin` を足す。
- スクリプトはアプリから切り離して走らせる。新しいセッション（setsid）にし、標準入力は `/dev/null`、出力は `$HOME/.family-computing/stable/update-run.log` に書く。0〜2 以外のファイル記述子は exec で閉じる。スクリプトが途中で安定版を終わらせても、スクリプトは最後まで進む。
- 終わったときの時刻と終了コードは、同じ場所の `update-run.exit` に書く。失敗したら、設定の画面に終了コードと出力の末尾を出す。2つのファイルは足しただけで、古い安定版は読まない。
- 開発版は欄も点も出さない。確かめるときは `FC_UPDATE=1` を付ける。開発版で「更新して再起動」が走るのは、`CT_DEST_DIR`、`CT_STABLE_HOME`、`FC_UPDATE_REPO`（比べる相手と、走らせるスクリプトを取り出すリポジトリ）の3つを付けたときだけである。`--update-run` は安定版の実行ファイルでは断る。スクリプトに渡す PATH は `FC_UPDATE_PATH` で差し替えられる。

安定版の中の端末（Claude Code）から `release-stable.sh` を走らせない。スクリプトが安定版を終わらせると、端末の claude と一緒にスクリプトも止まる。2026-11-23 には、.app だけ入れ替わり、`current.ref`、hook の写し、`releases.log`、起動が抜けた。安定版から上げるときは「更新して再起動」を使う。

1つ前の版に戻す:

```bash
scripts/rollback-stable.sh    # 今の版と1つ前の版を入れ替える。もう一度回すと元に戻る
```

スクリプトを直したら `scripts/test-stable-scripts.sh` を流す。一時のリポジトリと一時の置き場所だけを使い、tauri build は偽の bunx に替えるので、本物の安定版には触らない。

「更新して再起動」の切り離しは `scripts/test-update-detach.sh` で確かめる。開発版の実行ファイルを一時の入れ先の .app に写し、`--update-run`（画面を作らずに同じ処理を走らせる開発用の引数）で動かす。スクリプトの `stop_stable` がこのプロセスを終わらせた後も、入れ替え、`current.ref`、hook の写し、`releases.log` まで進むかを見る。

戻すときも、状態 hook を戻した先の版のタグから写し直す。アプリを入れ替えずに hook だけを写し直すときは `scripts/install-stable-hooks.sh [タグ]` を使う（タグを省くと、いま入っている版のタグから写す）。

作業ツリーの hook を試すときは、手で見本の入力を流す。`FC_STATE_DIR`、`FC_LETTERS`、`FC_PERM_DIR`、`FC_IDS_DIR` の4つを一時の場所に向けると、本物の状態ファイルに書かない。`FC_PERM_DIR` を忘れると、PermissionRequest が本物の `perm/` に書き、SessionStart と SessionEnd が本物の `perm/` のファイルを消す。claude の中で流すと環境変数 `CLAUDE_PID` が付いているので、`FC_IDS_DIR` を向けないと本物の `ids/` に書く。

```bash
echo '{"session_id":"0123abcd-0000-0000-0000-000000000001","hook_event_name":"UserPromptSubmit","prompt":"試し"}' \
  | FC_STATE_DIR=/tmp/fc-try FC_LETTERS=/tmp/fc-try/letters.jsonl FC_PERM_DIR=/tmp/fc-try/perm FC_IDS_DIR=/tmp/fc-try/ids python3 hooks/fc-report.py
```

hook が書く状態ファイルとお手紙の形は、`python3 -m unittest discover -s hooks -v` で確かめる（`hooks/test_fc_report.py`、標準ライブラリだけ、一時の場所にだけ書く）。`scripts/hook.py` が書く登録の形も、同じコマンドで `hooks/test_hook_install.py` が確かめる。

`scripts/native/survey.py`（`~/.claude` の記録の形を数える調べもの）は、`python3 -m unittest discover -s scripts/native -v` で確かめる。合成の置き場所を一時の場所に作って引数に渡すので、本物の `~/.claude` は読まない。

本物のセッションで試すときだけ、`python3 scripts/hook.py install --worktree` で作業ツリーの hook に登録を替える。その間は安定版にも作業ツリーの hook の内容が出るので、済んだら `python3 scripts/hook.py install` で写した先に戻す。2つを同時に登録しないのは、同じ状態ファイルに2つの版の hook が書くと、作業ツリーの hook がまた安定版の表示に混ざるためである。

開発版のアイコンは、安定版のアイコンに帯を重ねて作る。`src-tauri/icons/` を作り直したら `scripts/make-dev-icon.sh` も回してコミットする（ImageMagick が要る）。

### 署名と macOS の許可

macOS の画面収録などの許可は、アプリの指定要件（designated requirement）に結びつく。安定版は ad-hoc 署名なので、指定要件はビルドの cdhash になる。cdhash はビルドのたびに変わる。そのため上げ直すと、前の版に出した許可が新しい版に当たらない。設定の一覧には「Claude Town」がオンのまま残る（#188）。

`scripts/release-stable.sh` は、環境変数 `CT_SIGN_IDENTITY` に証明書の名前が入っていれば、その証明書で署名する。スクリプトはこの名前を Tauri の `APPLE_SIGNING_IDENTITY` に渡す。Tauri はこの変数を、設定の `bundle.macOS.signingIdentity` より先に見る。証明書で署名すると、指定要件は identifier と証明書の組になり、ビルドが変わっても同じになる見込みである。

```bash
CT_SIGN_IDENTITY="Claude Town Local Signing" scripts/release-stable.sh <ref>
```

`CT_SIGN_IDENTITY` が空なら、置き場（`~/.family-computing/stable`）の `sign-identity` の1行目を証明書の名前として使う。設定の「更新して再起動」は環境変数を渡さないので、このファイルで証明書を決める（#297）。2026-11-23 に本人が Apple Development の証明書を使うと決め、この Mac の `sign-identity` に名前を書いた。どちらも無ければ、今までどおり ad-hoc 署名になる。どちらの場合も、スクリプトは入れた後に `codesign -d -r-` で指定要件を読んで出す。指定要件が cdhash だけなら警告を出すが、止めはしない。スクリプトを直したら `scripts/test-stable-sign.sh` を流す（一時のリポジトリと偽の bunx だけを使う）。

自己署名の証明書と Apple Developer の証明書のどちらを使うかは、まだ決めていない（#188）。開発版（`bun tauri dev`）の署名は変えていない。

自己署名の証明書は次の手順で作る。ログインキーチェーンに証明書と鍵を足すので、使うと決めてから本人が行う。

```bash
d="$(mktemp -d)"
cat > "$d/codesign.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Claude Town Local Signing
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$d/codesign.cnf" \
  -keyout "$d/key.pem" -out "$d/cert.pem"
/usr/bin/openssl pkcs12 -export -inkey "$d/key.pem" -in "$d/cert.pem" \
  -name "Claude Town Local Signing" -out "$d/codesign.p12" -passout pass:ct-local
security import "$d/codesign.p12" -k ~/Library/Keychains/login.keychain-db -P ct-local -T /usr/bin/codesign
security find-identity -p codesigning    # "Claude Town Local Signing" が出れば CT_SIGN_IDENTITY に使える
rm -rf "$d"
```

- `openssl` は macOS 付属の `/usr/bin/openssl`（LibreSSL）を使う。付属のものは旧形式の .p12 を作る。Homebrew の OpenSSL 3 以降が作る .p12 を `security import` で読めるかは確かめていない。
- `-T /usr/bin/codesign` は、codesign にこの鍵を使わせる指定である。それでも初回に確認の窓が出たら「常に許可」を押す。
- 自己署名の証明書は信頼されていないので、`security find-identity -v` には出ない。信頼の設定なしで codesign が署名できるかは、まだ確かめていない。
- Tauri は証明書で署名するとき、`codesign --options runtime`（hardened runtime）を付ける。`bundle.macOS.hardenedRuntime` の既定が true のためである。Claude Town が hardened runtime で今までどおり動くかは、まだ確かめていない。
- 証明書で署名した最初の版は、ad-hoc の版と指定要件が違う。そのため最初の1回は、画面収録の許可を足し直す見込みである。

両版で共有しているもの:

- 状態 hook は1つだけ登録してあり、両版が同じ状態ファイルを読む。登録先は安定版のタグから写した `~/.family-computing/stable/hooks/fc-report.py` なので、作業ツリーの hook を書き換えても、安定版を上げ直すまで両版に出る内容は変わらない。
- hook が書くファイル（state/、letters.jsonl）と、送信の非常停止（send-disabled）は、両版が `~/.family-computing/` の同じものを読む。非常停止は1か所で両版を止めるために共有にしてある。

両版で分けているもの:

- アプリが書くファイル（avatars.json、avatars-recent.json）は、安定版は `~/.family-computing/` に、開発版は `~/.family-computing/dev/` に置く。開発版でキャラの割り当てを変えても、安定版のファイルは変わらない。
- どちらに置くかは、ビルドに入った identifier で決める。安定版の identifier なら今までの場所、それ以外（開発版）なら dev/ にする。環境変数を付け忘れても、開発版が安定版のファイルに書かない。
- 置き場所を決める関数は `src-tauri/src/lib.rs` の `fc_path` だけにしてある。`FC_APP_HOME` を付けると、アプリが書くファイルの置き場所だけを差し替えられる。`FC_AVATARS` は今までどおり使える。`FC_HOUSES` は、`houses.json` を読まなくなったので効かない。
- 置き場所は `src-tauri/target/debug/family-computing --paths` で確かめられる。identifier と、各ファイルの置き場所を出す。
- 開発版の dev/ は、初めて起動したときは空なので、キャラは安定版と違う顔ぶれで振り直される。avatars-recent.json は、キャラの選び方の変更（feat/char-age）が入った版から使う。ccn を使っていた版が書いた `avatars-peer-<機械>.json`、avatars-custom-ccn.json、`cache/`、town-settings.json は、今の版では読まず、消さない。

## ブラウザ版（PWA）

Claude Town は、ブラウザから開けるインストール可能な PWA としても配る。公開先は https://town.fybe.jp である。アプリからは ccn を外したが、ブラウザ版はまだ ccn を通して動く。扱いを本人が決めるまで、`web/` と、画面のブラウザ版の経路（`src/bridge.ts` の `WEB`、`src/webConv.ts`、`src/webPerm.ts`）は残す。別の機械の町を選ぶ欄は、アプリと同じ画面から消えた。Cloudflare Access（アプリ `claude-town`）が全体を守り、ポリシー `town-owner` が `ceo@fybe.jp` だけを通す。

仕組みは次のとおり。

- 画面は Tauri 版と同じ `src/` である。Tauri の外でビルドした版（`import.meta.env.PROD`）は、`invoke` の代わりに、同じオリジンの `/api` へ HTTP で話す（`src/bridge.ts` の `WEB`）。ccn の行は source が ccn で、コマンドの振り分けはこの行にだけ出る。承認の欄は、ccn の行では ccn の permissions の口で答える。モデルと権限モードの切り替えは、ccn の行では ccn の PATCH で替え、予約は画面が持つ（`src/webReserve.ts`）。
- ccn は別オリジンからの要求を 403 で断るので、ブラウザは ccn に直接つなげない。`web/` の Worker（Void アプリ）が画面を配り、`/api` と `/n/` を `https://ccn.fybe.jp` に中継する。
- 中継は Origin と Sec-Fetch-* を ccn へ渡さないので、ccn の CSRF の確認はブラウザ版では働かない。代わりに `web/middleware/01.access.ts` が、GET と HEAD 以外の要求で Origin の host か Sec-Fetch-Site が同じオリジンでなければ 403 を返す（`web/lib/origin.ts`、#167）。
- 中継は、受け取った Access の JWT を `Cf-Access-Token` で渡す（Linked App Token）。ccn の Access アプリ `ccn` に、`claude-town` からの Linked App Token を通すポリシー `town-linked` を足してある。ccn には人（email）の呼び手として届き、サービストークンの秘密は持たない。
- Service Worker（`public/sw.js`）は何もキャッシュしない。ホーム画面に追加するためだけに置いた。manifest は `public/manifest.webmanifest`、アイコンは `public/app-icon.svg` から `bun run pwa:icons` で作る。
- デプロイは、既定ブランチ（`main`）へのマージで `.github/workflows/void-deploy.yml` が行う。
- 手元の開発サーバー（`web/` で `bun run dev`）は、`web/.env` に `DEV_NO_AUTH=1` を書くと Access の確認を飛ばす。このときは localhost だけで受け、`--host` を付けると起動しない（`web/dev-host.ts`、#244）。macOS では `[::1]` で受けるので、`http://localhost:5174/` で開く（`127.0.0.1` では開けない）。Worker から見える Host と接続元の IP は LAN の別の機械でも偽れるので、受ける口を絞る。`DEV_NO_AUTH` が無いときは今までどおり全部のインターフェースで受けるが、Access の JWT が無い要求は 403 になる。

会話の表示は、Rust の `conversation` と同じ処理を TS に移してある（`src/webConv.ts`）。承認への返事は、ccn を使っていたころの Rust の `answer_permission` を TS に移したもので、今の Rust には無い（`src/webPerm.ts`）。承認への返事は、`src/webPerm.ts` だけが確認（まだ承認待ちか、許可でも拒否でも requestId が見せた中身と同じか、質問には全部の答えがあるか）をしてから送る。ただし送信の非常停止（`~/.family-computing/send-disabled`）は手元のファイルなので、ブラウザ版では効かない。会話の「今の動き」の行（`live`）と、保存した会話は移していない。

ブラウザ版で使えない機能は次のとおり。Rust にしか実装が無いものを、TS に移していない。

| 機能 | 状態 |
| --- | --- |
| お手紙、プロンプト履歴、スラッシュ補完、ファイルの候補、クリップボードの貼り付け| 動かない |
| 町の一覧の名前づけ | パスの形だけで決める（Rust は `.git` も読む） |

### スマホ専用の画面

幅が 720px 以下か、タッチが主の入力で幅が 1024px 以下のときだけ、スマホ専用の画面（`src/mobile/`）に切り替わる。Tauri の画面は常に今までの画面である。URL に `?layout=mobile` か `?layout=desktop` を付けると、判定を上書きできる。

- 取得、選択、送信の状態は `App` が持つ。`MobileShell` は並べ方だけを持ち、チャットの中身は `Panel` を `mobile` つきで使う。
- 一覧、チャットの2画面。一覧の先頭の「あなたの番」に、承認待ちと返事待ちを出す。押すとチャットが全画面で開き、戻る操作（履歴の `popstate`）で一覧に戻る。
- 入力欄は画面の下に固定する。キーボードが出ると、`visualViewport` の高さ（`--vv-h`）に合わせて縮む。Enter は改行で、送るのは送信ボタンだけである。
- スマホの見た目の確認は、`bun run dev` を `?layout=mobile` で開き、agent-browser を 390x844、倍率 3 にして行う。モックの ccn（`scripts/mock-ccn-town.ts`）は ccn を外したときに消した。

Void アプリの確認は `web/` で行う。`web/src` は `../src` へのリンクで、画面が読む react や @xterm/* はリポジトリ直下の node_modules にある。先に直下で install する。

```sh
bun install --frozen-lockfile   # リポジトリ直下
cd web && bun install --frozen-lockfile
bun run check   # Worker（tsconfig.server.json）と設定のファイル（tsconfig.node.json）の型を確かめる
bun run build   # .cloudflare/ に Worker と画面が出る
bun test        # web/test の試験。ルートの bun test は src だけを走らせる（bunfig.toml）
```

## 開発

```bash
bun install
bun run tauri dev   # 開発版（Claude Town Dev）が起動する

# 見た目だけをブラウザで確かめるとき（送信はしない）
src-tauri/target/debug/family-computing --snapshot > public/dev-snapshot.json
bun run dev   # http://localhost:1420/

# 合成の ~/.claude で町を出す（本物の記録を読まない。作り方は src-tauri/src/native/mod.rs の testtree）
FC_CLAUDE_HOME=/tmp/<合成の置き場所> bun run tauri dev

# 新しい世帯で起動する claude を差し替える（課金をかけずに端末の動きだけを見る）
FC_CLAUDE_BIN=/tmp/<代わりのスクリプト> bun run tauri dev

# 配置計算だけの検証（世帯の中の8ケースと、世帯の並べ方の5条件）
bun test src/layout

# 型の確認。画面（tsconfig.json）、試験を含めた src（tsconfig.test.json）、設定のファイル（tsconfig.node.json）の3つを流す
bun run typecheck
```

`bun test` は型を見ずに試験を走らせる。`tsconfig.json` は試験を外しているので、試験の型は `bun run typecheck` でだけ確かめられる。

`public/dev-*.json` には本物のセッションの中身が入るので、コミットしない（.gitignore に入れてある）。

### 子が開発版で確かめるとき

本人が安定版や他のアプリを前面で使うので、子が起動した開発版の窓はふつう裏に隠れている。隠れている間は、町・会話・承認の取得と1秒の時計が止まる（src/visible.ts、#6）。`VITE_FC_FORCE_VISIBLE=1` を付けて起動すると、窓が隠れていても見えている扱いにして、取得と時計を止めない（#62）。この変数は `bun tauri dev` の開発版でだけ効く。ビルドした画面（安定版）では、付けてビルドしても無視される。

```bash
# 1420 番は子どうしで共有している。来た順に渡すロックを取ってから使い、済んだら外す
~/.local/bin/ct-lock acquire <名前>
lsof -nP -iTCP:1420 -sTCP:LISTEN   # 何も出なければ空いている

# アプリが書くファイル（キャラの割り当てなど）は FC_APP_HOME で一時の場所に分ける。HOME は分けない
# （HOME を分けると、新しい世帯で起動した claude がログインを失う）
VITE_FC_FORCE_VISIBLE=1 FC_APP_HOME=$(mktemp -d) FC_PERF_LOG=/tmp/<名前>-perf.jsonl bun tauri dev

~/.local/bin/ct-lock release <名前>
```

1420 番が使われていてロックを待てないときは、別のポートで起動する。`--config` に渡した JSON は tauri.conf.json に重なる。devUrl は Rust に埋め込まれるので、ポートを変えると Rust を組み直す。

```bash
VITE_FC_FORCE_VISIBLE=1 bun tauri dev --config '{"build":{"devUrl":"http://localhost:1430","beforeDevCommand":"bun run dev --port 1430"}}'
```

- この変数で続くのは取得と時計だけで、描画は続かない。窓が隠れている間は WebKit が requestAnimationFrame を止める（2026-11-13 の実測で fps 0）。起動から隠れたままだと一度も描かれないので、`screencapture -l` で見た目を撮るときは窓を前に出す。
- 止めるときは、自分が起動した `bun tauri dev` の pid を指定する。安定版と開発版は実行ファイル名が同じなので、名前で止めない。
- 開発版は2つ目の起動を止めない（#176）。同じ `FC_APP_HOME` で2つ起動すると、2つ目が端末の台帳を書き直すので、起動のたびに `mktemp -d` で分ける。2つ目を止める動きは `FC_SINGLE_INSTANCE=1 scripts/check-single-instance.sh` で確かめる。
- 軽さの計測（`src/term/bench.ts` の scene）では付けない。隠した窓の負荷を測る場面（hidden、minimized）の数字が変わる。
- 開発版はお便りの通知（#292）を出さない。確かめるときだけ `FC_NOTIFY=1` を付ける。開発版は通知をターミナル（`com.apple.Terminal`）の名義で出す。2026-11-23 に確かめた機械では、usernoted が要求を断り、画面に出なかった。ターミナルの通知を許可すれば出るかは確かめていない。出す判定が動いたかは `FC_PERF_LOG` の `notify` の行で見る。
- 開発版は設定の「更新」の欄とヘッダーの歯車の点（#295）を出さない。確かめるときは `FC_UPDATE=1` と、`CT_STABLE_HOME`（`current.ref` を置いた一時の場所）、`FC_UPDATE_REPO`（一時のリポジトリ）を付ける。「更新して再起動」まで押すときは、`CT_DEST_DIR`、`CT_BUILD_WORKTREE`、`CT_TARGET_DIR`、`CT_NO_OPEN=1` も一時の場所に向け、`FC_UPDATE_PATH` で偽の bunx を PATH の先頭に置く。ボタンは一時のリポジトリの `origin/main` から `scripts/` を取り出して走らせるので、`CT_REPO` を読む `release-stable.sh` を一時のリポジトリの `origin/main` に push しておく。作業ツリーに写しただけでは走らない（#299）。
- 開発版で「新しい世帯」を押すと、本物の claude が起動し、本物の `~/.claude` に会話が残る。押す確認は捨ての場所（一時のディレクトリ）を置き場所にして行い、済んだら閉じる（power）か、開発版を終了して止める。
