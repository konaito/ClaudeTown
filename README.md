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

Claude Town の違いは3つある。データ源をこの Mac の Claude Code の記録に寄せること、キャラから文を送れること、孫までの親子を家族の木として見せることである。

## データの取り方

町の一覧と会話は、この Mac の Claude Code の記録と、hook の状態ファイルから作る。記録の置き場所は `~/.claude` で、`FC_CLAUDE_HOME` で差し替えられる。読むだけで、`~/.claude` には書かない。cam の各プロファイルの `sessions`、`projects`、`teams` は `~/.claude` へのリンクなので、1か所を読めば全部のアカウントの分が読める。

| 知りたいこと | 取り方 |
| --- | --- |
| 生きている対話セッションと状態 | `~/.claude/sessions/<pid>.json`。pid が生きているものだけを出す。status の busy は作業中、waiting は承認待ち、idle は待機にする（`src-tauri/src/native/sessions.rs`） |
| 会話 | `~/.claude/projects/<cwd を直した名前>/<session id>.jsonl` を、前に読んだ位置から続けて読む（`native/conv.rs`） |
| sub-agent と in-process のチームメイト | 親のセッションの `<session id>/subagents/agent-<agent id>.jsonl` と `.meta.json`。meta の taskKind が in_process_teammate ならチームメイトとして出す（`native/subagents.rs`） |
| tmux のチームメイト | `~/.claude/teams/<チーム名>/config.json` の members と、ps で見た claude の起動の引数（`--agent-id`、`--parent-session-id`）。会話は同じ cwd の jsonl のうち、teamName と agentName が合うもの（`native/teams.rs`） |
| 親子 | sub-agent とチームメイトは、置き場所と config.json から親を決める。ほかのセッションは、最初の文の from 行（`from agent:<ノード>/<親の sid 先頭8>/<役割> via <ノード>`）から引く。from 行は ccn などのプロダクトが子を立てるときに付ける |
| 頼まれたこと、いまやっていること、最後の報告、次の一手 | hook が書く `~/.family-computing/state/<session_id>.json` |
| 閉じてよいか | close-check-state hook が書く `~/.claude/close-check/<session_id>.json` |
| 新しい世帯の「最近の場所」 | Claude Code の入力の履歴 `~/.claude/history.jsonl` の project と timestamp（`src-tauri/src/places.rs`） |

記録から読むだけのセッション（Claude Town の外で起動したもの）には、送信、停止、端末、承認の操作ができない。操作できるのは、アプリが立てたセッションだけである（下の「アプリの中の端末」）。

チームメイトの出し方は、2026-11-21 の実測（`docs/research/agent-teams-observed.md`）に合わせた。

- 終わったセッションのチームは `~/.claude/teams` に残る（61件のうち58件はリードが死んでいた）。リードの session id が生きているセッションの一覧にあり、`leadProcess.pid` がそのセッションの pid と同じチームだけを見る。
- tmux のチームメイトは `sessions/<pid>.json` を作らない（2回の観測の両方で同じだった）。ps に起動の引数が無ければ、終わったものとして出さない。
- in-process のチームメイトには finished の印が付かない。チームの config.json の members にいる間は、待機のまま町に出し続ける。
- 知らない形（知らない backendType、読めない config.json など）は、黙って落とさず件数に数える。数は snapshot の `sources.native.unexpected` に出る。

### アプリの中の端末

「＋ 新しい世帯」を押すと、Rust が PTY の中で `claude --session-id <新しい UUID>` を起動する（`src-tauri/src/pty.rs`）。出力は右パネルの xterm.js に流し、打ったキーは PTY に書く。crate は portable-pty（wezterm の一部、MIT）を使う。

- Claude Code は、`--session-id` で渡した id を `sessions/<pid>.json` に書く。この pid は、PTY で起動した claude の pid と同じである（2026-11-21 に実測）。
- 信頼の確認の画面を抜けるまで、`sessions/<pid>.json` は作られない。その間は、アプリの台帳から仮の行を町に出す。
- /clear で session id が変わっても、pid は変わらない。台帳は pid で引き、一覧で同じ pid に見えた id を同じ端末として扱う。
- 子プロセスの環境からは、`CLAUDECODE` と、`CLAUDE_CODE_` で始まる変数などを外す。アプリを Claude Code の中から起動したときに、子が親のセッションを名乗らないようにするためである。`CLAUDE_CONFIG_DIR` は残すので、子はアプリを起動したアカウントで動く。
- アプリを終了すると、アプリから立てた世帯の claude は全部止まる。終了のときに SIGHUP を送り、1秒で終わらなければ SIGKILL を送る。アプリが落ちたときも、PTY が閉じて claude は終わる（2026-11-21 に、子を止めずに親のプロセスを終えて確かめた）。

## 操作

- 子供を左クリックすると、右のパネルにその子の会話が出る。
- 子供を右クリックすると、その子を選んで端末を開く。端末を開けるのは、アプリが立てたセッションだけである。
- 左のペインの「＋ 新しい世帯」を押すと、すぐ設定の場所（設定していなければ `~/Documents/meta`）で、親のいない claude を立てる（上の「アプリの中の端末」）。立てたら、そのセッションを選んで右のチャットを開き、入力欄にフォーカスを当てる。最初の依頼の欄は出さない。セッションが0本の空の町でも、ここから最初の世帯を作れる。
- 「＋ 新しい世帯」の下の「最近の場所」は、Claude Code の入力の履歴から作り、新しい順に20件出す。worktree はリポジトリの場所にまとめ、今は無い場所は出さない。新しい世帯の置き場所（設定した場所、無ければ `~/Documents/meta`）は、ボタンと同じ場所なので一覧から除く（2026-11-21）。ペインに見出しは出さない（2026-11-21）。
- 置き場所は、ヘッダーの右端の歯車（設定）の「新しい世帯の場所」で変える。最近の場所から選ぶか、絶対パスを入力する。無い場所は、立てるときに断り、通知に場所を出す。保存先は localStorage の `claude-town.newHousePlace` で、この Mac のアプリ（ブラウザ版ではそのブラウザ）ごとに1つ。
- 子は親のセッション自身が作る（Agent ツールや agent team）。画面から子を足す操作は出さない（2026-11-12、本人の判断。使う機会が無いため）。
- チャット欄の文は、アプリが立てたセッションの端末の入力欄へ貼り、Enter を押して送る。/ と ! で始まる文も、CLI に打ったのと同じに動く。画面を開くコマンド（/model など）は、送った後にターミナルのタブを開く。承認待ちのときと、claude がまだ起動していないとき（信頼の確認の画面）は送らない。
- カードの右下と右パネルの見出しに、同じ3つのボタンを並べる。閉じる（🐺）、様子を聞く（🚪）、許可する（👍）の順で、並びと送る文は `src/App.tsx` の `CARD_ACTIONS` で決める。ボタンに乗せると、押せるときは何をするか、押せないときは押せない理由を、WebView の標準のツールチップ（`title`）で出す。
- 閉じる（🐺）は、アプリが立てた claude を、子孫ごと孫から順に止める。Claude Town の外で起動したセッションは止めずに残す。
- 承認待ちの子は、カードの枠が黄色で点滅する。承認は端末の承認の画面で答える。右パネルには「ターミナルを開く」のボタンを出す。Claude Town の外で起動したセッションは、起動した端末で答える。
- 作業中で入力欄が空のときは、送るボタンが止めるボタン（■）になる。押すと端末に Esc を書き、今の作業を止める（#83）。
- 会話の道具の行は、結果が届いたら押して開ける。開くと、まとめた道具ごとに1行と結果の頭（40行、1500字まで）を出し、失敗した道具には「失敗」と付ける（#83）。止めたターンと失敗したターンは、会話の中に「ここで止めた」「ターンが失敗で終わった」の印を出す。
- `~/.family-computing/send-disabled` があると、注文、端末への入力、新しい世帯の作成、停止を全部断る（送信の非常停止）。

ccn を外したときに、別の機械の町、転出、引き継ぎ、チャットの欄からの承認、オフラインの保存をやめた（2026-11-21）。どれも ccn の口を使っていた。モデルと権限モードの切り替えは、端末に書く作りで戻した（下の「モデルと権限モード」）。

### モデルと権限モード

チャット欄の「送信先」の行に、モデルと権限モードの選択を置く。選択はいつでも押せる（2026-11-21、本人の依頼）。決まりは `src/session/control.ts` の `planOf`、端末に書く処理は `src-tauri/src/switch.rs` にある。

- アプリが立てたセッションは、端末に CLI と同じ入力を書いて替える。モデルは `/model <別名>`、権限モードは Shift+Tab である。
- モデルは作業中でもすぐ替える。`/model` は作業中に打っても待たされず、同じターンの次の要求から効く。
- 権限モードは待機中に替える。Shift+Tab は default、acceptEdits、plan、bypassPermissions、auto の順に回るので、作業中に回すと途中のモードで道具が走りうる。
- 承認待ちの間は、モデルも権限モードも替えない。端末に書いた入力が承認の画面に入り、Enter が許可になるためである。
- 今は替えられないときに選んだ値は予約になる。選択は破線の枠で予約の値を出し、下に「承認に答えたら替える」「このターンが終わったら替える」と出す。今の値を選び直すと予約を取り消す。
- 予約は Rust が持ち、0.5秒ごとに `sessions/<pid>.json` の status を見て当てる。窓が隠れていても当たる。アプリを終えると予約は消える。アプリが立てた claude もアプリと一緒に止まるので、持ち越す先が無い。
- 今の値は transcript の `permission-mode` の行と、assistant の行の `message.model` から読む。アプリの端末の権限モードは、端末の下の行（「⏸ manual mode on」など）を優先する。待機中に Shift+Tab で替えたモードは、次の文を送るまで transcript に書かれないためである。
- `/model` は、そのセッションのモデルを替えるだけでなく、新しいセッションの既定も替える（Claude Code の動き）。`~/.claude/settings.json` に model を書くが、その行を消しても既定は戻らなかった（2026-11-21 に確かめた）。既定を戻すには、`/model` で前の値を選び直してから settings.json の model の行を消す。アプリは書き戻さない。
- dontAsk は Shift+Tab の順に出ないので、端末からは替えられない。bypassPermissions と auto は、そのセッションで使えるときだけ順に出る。順に出なければ、1周して元のモードに戻し、理由を通知に出す。
- アプリの外で起動したセッション、チームメイト、sub-agent には、外からモデルや権限モードを届ける口を作っていない。選ぶと、代わりの手（そのターミナルで `/model` を打つ、など）を出す。公式の文書に載っている口は無い（2026-11-21 に確かめた）。設定ファイルの model は起動のときに1回だけ読まれる。hook の出力で権限モードを替えられるのは PermissionRequest の `setMode` だけで、その承認を許可するのと一緒にしか使えない。チームメイトのモデルは起動のときに決まる。tmux のチームメイトの `tmuxPaneId`（tmux send-keys で書ける）と、`sessions/<pid>.json` の `messagingSocketPath` は試していない。

## hook

本人の依頼は「このプロダクトのために再度整理させるための hook」だった。2つの読み方を出して本人に聞き、A に決まった。

- A（採用）: 各セッションに、いまの様子を書き出させる hook。UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、Notification、Stop、SessionStart、SessionEnd で、頼まれたこと、いまやっていること、最後の報告、次の一手、人を待っているかを状態ファイルに書く。LLM は呼ばない。
- B（不採用）: 各エージェントに、終わった子を閉じさせ、ツリーを浅く保たせる hook。

hook の本体は `hooks/fc-report.py` に置く。2026-11-12 に本人に確かめて `~/.claude/settings.json` に登録した（同じ日に PermissionRequest も足した）。`~/.claude/settings.json` が呼ぶのは作業ツリーの hook ではなく、安定版のタグから写した `~/.family-computing/stable/hooks/fc-report.py` である（下の「安定版と開発版」）。登録と解除は `python3 scripts/hook.py install` と `python3 scripts/hook.py uninstall` で行う。install は写した先を登録し、写した先が無ければ何も書かずに止まる。書く前に settings.json の控えを残す。cam の各プロファイルの settings.json は `~/.claude/settings.json` へのリンクなので、1か所で全部に効く。

hook は本物の `claude -p` で試し、頼まれたこと、道具、最後の報告、次の一手が状態ファイルに入ることを確かめた。

## 決まったこと

- hook は A にする。
- 左クリックの「メッセージの挿入」は、端末の入力欄へ文を貼って送ることにする（2026-11-21 までは ccn で送っていた）。モックに合わせ、送る欄は右のパネルの会話の下に置く。
- 白を基調にした明るい配色にする。
- 状態は、作業中（緑）、返事待ち（青）、承認待ち（黄）、完了（灰）、待機の5つにする。承認待ちは `sessions/<pid>.json` の status が waiting のもの、返事待ちは hook が「人への問いで終わった」と書いたものと、set_status の blocked。
- キャラの体は Ninja Adventure Asset Pack（CC0）のドット絵、状態の印は Noto Animated Emoji（CC BY 4.0）の WebP にする（見本ページの案 C）。印の置き方は案 A の位置の2段階目（A2）。親には大人のキャラ6体、子より下には子供のキャラ18体から、名前で決めて当てる。見本は `docs/research/assets/index.html` と `docs/research/assets/balance.html`。
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

子と開発者の決まり:

- 起動と確認には開発版だけを使う。
- 安定版（`/Applications/Claude Town.app`）を止めない、差し替えない、消さない。
- 安定版へ上げるのは、本人か親が頼んだときだけにする。
- 起動の仕方は「開発」の節の「子が開発版で確かめるとき」に書いてある。

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

作業ツリーの hook を試すときは、手で見本の入力を流す。`FC_STATE_DIR`、`FC_LETTERS` を一時の場所に向けると、本物の状態ファイルに書かない。

```bash
echo '{"session_id":"0123abcd-0000-0000-0000-000000000001","hook_event_name":"UserPromptSubmit","prompt":"試し"}' \
  | FC_STATE_DIR=/tmp/fc-try FC_LETTERS=/tmp/fc-try/letters.jsonl python3 hooks/fc-report.py
```

本物のセッションで試すときだけ、`python3 scripts/hook.py install --worktree` で作業ツリーの hook に登録を替える。その間は安定版にも作業ツリーの hook の内容が出るので、済んだら `python3 scripts/hook.py install` で写した先に戻す。2つを同時に登録しないのは、同じ状態ファイルに2つの版の hook が書くと、作業ツリーの hook がまた安定版の表示に混ざるためである。

開発版のアイコンは、安定版のアイコンに帯を重ねて作る。`src-tauri/icons/` を作り直したら `scripts/make-dev-icon.sh` も回してコミットする（ImageMagick が要る）。

両版で共有しているもの:

- 状態 hook は1つだけ登録してあり、両版が同じ状態ファイルを読む。登録先は安定版のタグから写した `~/.family-computing/stable/hooks/fc-report.py` なので、作業ツリーの hook を書き換えても、安定版を上げ直すまで両版に出る内容は変わらない。
- hook が書くファイル（state/、letters.jsonl）と、送信の非常停止（send-disabled）は、両版が `~/.family-computing/` の同じものを読む。非常停止は1か所で両版を止めるために共有にしてある。

両版で分けているもの:

- アプリが書くファイル（avatars.json、avatars-recent.json）は、安定版は `~/.family-computing/` に、開発版は `~/.family-computing/dev/` に置く。開発版でキャラの割り当てを変えても、安定版のファイルは変わらない。
- どちらに置くかは、ビルドに入った identifier で決める。安定版の identifier なら今までの場所、それ以外（開発版）なら dev/ にする。環境変数を付け忘れても、開発版が安定版のファイルに書かない。
- 置き場所を決める関数は `src-tauri/src/lib.rs` の `fc_path` だけにしてある。`FC_APP_HOME` を付けると、アプリが書くファイルの置き場所だけを差し替えられる。`FC_AVATARS` と `FC_HOUSES` は今までどおり使える。
- 置き場所は `src-tauri/target/debug/family-computing --paths` で確かめられる。identifier と、各ファイルの置き場所を出す。
- 開発版の dev/ は、初めて起動したときは空なので、キャラは安定版と違う顔ぶれで振り直される。avatars-recent.json は、キャラの選び方の変更（feat/char-age）が入った版から使う。ccn を使っていた版が書いた `avatars-peer-<機械>.json`、avatars-custom-ccn.json、`cache/`、town-settings.json は、今の版では読まず、消さない。

## ブラウザ版（PWA）

Claude Town は、ブラウザから開けるインストール可能な PWA としても配る。公開先は https://town.fybe.jp である。アプリからは ccn を外したが、ブラウザ版はまだ ccn を通して動く。扱いを本人が決めるまで、`web/` と、画面のブラウザ版の経路（`src/bridge.ts` の `WEB`、`src/webConv.ts`、`src/webPerm.ts`）は残す。別の機械の町を選ぶ欄は、アプリと同じ画面から消えた。Cloudflare Access（アプリ `claude-town`）が全体を守り、ポリシー `town-owner` が `ceo@fybe.jp` だけを通す。

仕組みは次のとおり。

- 画面は Tauri 版と同じ `src/` である。Tauri の外でビルドした版（`import.meta.env.PROD`）は、`invoke` の代わりに、同じオリジンの `/api` へ HTTP で話す（`src/bridge.ts` の `WEB`）。ccn の行は source が ccn で、承認の欄とコマンドの振り分けはこの行にだけ出る。モデルと権限モードの切り替えは、ccn の行では ccn の PATCH で替え、予約は画面が持つ（`src/session/reserve.ts`）。
- ccn は別オリジンからの要求を 403 で断るので、ブラウザは ccn に直接つなげない。`web/` の Worker（Void アプリ）が画面を配り、`/api` と `/n/` を `https://ccn.fybe.jp` に中継する。
- 中継は、受け取った Access の JWT を `Cf-Access-Token` で渡す（Linked App Token）。ccn の Access アプリ `ccn` に、`claude-town` からの Linked App Token を通すポリシー `town-linked` を足してある。ccn には人（email）の呼び手として届き、サービストークンの秘密は持たない。
- Service Worker（`public/sw.js`）は何もキャッシュしない。ホーム画面に追加するためだけに置いた。manifest は `public/manifest.webmanifest`、アイコンは `public/app-icon.svg` から `bun run pwa:icons` で作る。
- デプロイは、既定ブランチへのマージで `.github/workflows/void-deploy.yml` が行う。

会話の表示と承認への返事は、Rust の `conversation` と `answer_permission` と同じ処理を TS に移してある（`src/webConv.ts`、`src/webPerm.ts`）。承認への返事は Rust と同じ確認（まだ承認待ちか、requestId が見せた中身と同じか、質問には全部の答えがあるか）をしてから送る。ただし送信の非常停止（`~/.family-computing/send-disabled`）は手元のファイルなので、ブラウザ版では効かない。会話の「今の動き」の行（`live`）と、保存した会話は移していない。

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

Void アプリの確認は `web/` で行う。

```sh
cd web && bun install
bun run build   # .cloudflare/ に Worker と画面が出る
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
```

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
- 軽さの計測（`src/term/bench.ts` の scene）では付けない。隠した窓の負荷を測る場面（hidden、minimized）の数字が変わる。
- 開発版で「＋ 新しい世帯」を押すと、本物の claude が起動し、本物の `~/.claude` に会話が残る。押す確認は捨ての場所（一時のディレクトリ）を置き場所にして行い、済んだら閉じる（🐺）か、開発版を終了して止める。
