# チャットの入力欄と Claude Code CLI の入力の比べ

issue #53 の調べ。Claude Town のチャットの入力欄を、Claude Code の CLI の入力と同じ動きにするために、CLI の動きを公式の文書と実測で確かめた。

- 調べた日は 2026-11-13 で、手元の CLI は 2.1.323。
- 文書は次の4ページを読んだ。
  - [interactive-mode](https://code.claude.com/docs/en/interactive-mode)（以下 IM）
  - [keybindings](https://code.claude.com/docs/en/keybindings)（以下 KB）
  - [terminal-config](https://code.claude.com/docs/en/terminal-config)（以下 TC）
  - [commands](https://code.claude.com/docs/en/commands)（以下 CMD）と [skills](https://code.claude.com/docs/en/slash-commands)
- 実測は、ccn で立てたテスト用のセッション2つで行った。1つは PTY の子（kind pty）、もう1つは -p の子（kind node、SDK）。作業フォルダは `family-computing.wt/ct-input-test` で、テスト用のスキル `ct-echo` を置いた。

## 実測で分かった前提

ccn の `POST /api/sessions/<id>/messages` は、本文の前に `from <誰> via <ノード>` の1行と空行を付ける（claude-code-nodes の `src/api/sessions.ts` の `withFromLine`）。外す指定は無い。Claude Town の送信もこの口を通るので、先頭の `/` と `!` は文の頭に来ない。

| 送り方 | `/ct-echo hi` | `!echo SHELL-OK` |
|---|---|---|
| ccn の send_message で PTY の子へ | コマンドとしては動かない。Claude が文を読み、Skill ツールで ct-echo を呼んだ | シェルモードにならない。Claude が文を読み、Bash ツールで実行した |
| ccn の send_message で -p の子へ | 同じく Claude が Skill ツールで呼んだ | 同じく Claude が Bash ツールで実行した |
| ccn の端末の口（terminal/input）で PTY の子へ貼り付けて Enter | コマンドとして動いた。会話の記録は `<command-name>/ct-echo</command-name>` の形 | シェルモードで動いた（`! echo SHELL-DIRECT`）。ccn の messages には発言が出ず、返事だけ出る |

端末の口では、組み込みのコマンドも試した。

- `/clear` は動き、そのあとも ccn は同じセッションとして会話を追えた。次の send_message の返事も読めた。
- `/model` は端末に選択の画面を開いた。ccn の状態は idle のままで、チャットからは何も見えない。この画面で Enter を押すと既定のモデルが変わるので、Esc で閉じた。

CLI の補完の動きも端末で確かめた。

- `/ct-ec` と打つと、候補の1行目に `/ct-echo` と説明と `(project)` が出た。ここで Enter を押すと `/ct-echo` が送られ、スキルが動いた。
- `/ct` のあと Tab を押すと、入力欄が `/ct-echo` になり、送られなかった。
- `x @a` と打つとファイルの候補が出た。ここで Enter を押すと、候補を選ばずに `x @a` のまま送られた。
- Ctrl+U を2回押すと、入力欄が空になった。

## 表

「出所」の IM、KB、TC、CMD は上の文書を指す。「実測」は上のテスト用のセッションで確かめたもの。

| キー・機能 | CLI での動き | 出所 | Claude Town でどうするか |
|---|---|---|---|
| Enter | 送る（chat:submit）。補完が出ているときは下の行を見る | KB、TC | 同じにした。前は ⌘Enter で送っていた |
| ⌘Enter、Ctrl+Enter | Ctrl+Enter は「待たせている文を今すぐ送る」（chat:sendNow）。⌘ は端末に届かない | KB、IM | どちらも送る。Claude Town には待たせる列が無いので、Enter と同じにした |
| 日本語の変換を決める Enter | 端末が変換を受け持つので、CLI には届かない | CLI では実測していない。Claude Town は開発版で実測 | 送らない。`isComposing` と keyCode 229 で見分ける |
| Shift+Enter | 改行。iTerm2、Ghostty、Kitty などではそのまま、VS Code などは /terminal-setup が要る | IM、TC | 改行 |
| Ctrl+J | 改行（chat:newline）。どの端末でも動く | KB、TC | 改行 |
| \ のあと Enter | \ を消して改行。どの端末でも動く | IM、TC | 同じにした。カーソルの直前が \ のときだけ |
| Option+Enter | 改行。macOS では Option を Meta にする設定が要る | IM、TC | 改行。設定は要らない |
| 貼り付け | 改行を含んでも1つの文。長い文は `[Pasted text #N]` にたたむ | IM | 1つの文として入る。たたまずに全文を見せる |
| 画像の貼り付け（Ctrl+V、iTerm2 は ⌘V） | `[Image #N]` を入れる | IM、KB | 作らない。ccn の send_message は文しか受けない。画像だけを貼ったときは、送れないと知らせる。**ccn 側が要る** |
| / （文の頭） | コマンドかスキルを動かす。打つと候補が出て、文字で絞る | IM、CMD | 候補を出す。組み込みは CMD の一覧を `src/composer/commands.ts` に持つ（廃止、隠し、特定の環境だけのものを除く全部。別名でも引ける）。スキルとコマンドは Rust（slash_commands）が手元のフォルダから読む。絞り方は、名前の頭、別名の頭、- と : で区切った語の頭、名前の中の順にした。CLI の絞り方は文書に無い |
| / （文の途中、空白の後） | 補完は出るが、動くのは文の頭のときだけ | IM | 補完だけ出す |
| / の補完で Tab | 選んだコマンドに置き換える。送らない | KB（autocomplete:accept）、実測 | 同じにした。後ろに空白を足す |
| / の補完で Enter | 選んだコマンドで送る | 実測 | 同じにした |
| / の補完で ↑↓、Esc | 選び直す、閉じる | KB | 同じにした。Ctrl+P と Ctrl+N でも選び直せる |
| / の候補の中身 | 組み込み、スキル、プラグインと MCP のコマンド。`user-invocable: false` のスキルは出さない | IM、skills | 組み込み、ユーザーとプロジェクトのスキルとコマンド、有効なプラグインのスキルとコマンドを出す。MCP のプロンプトは出さない（Claude Town から一覧を取る口が無い）。別の機械のセッションでは組み込みだけを出す。**別の機械のスキルの一覧は ccn 側が要る** |
| / を送ったとき（PTY の子） | コマンドとして動く | 実測 | 端末の口で入力欄に直接貼り、Enter を押す（Rust の send_direct）。承認待ちのときと、claude がまだ起動していないときは送らずに断る。端末の口は ccn の send の検査を通らないので、承認の画面に Enter が届くと許可になり、信頼の確認の画面に届くと「No, exit」が選ばれるため。起動済みかは、ccn の detail の lastActivityAt が startedAt より進んでいて（SessionStart の hook が届いた）、起動から3秒たったかで見る。端末で何かを打っても lastActivityAt は進むので、確かな印ではない。**確かにするには ccn 側に起動済みの印が要る** |
| / を送ったとき（-p の子） | SDK の prompt の頭にあればスキルが動く（skills のページ） | 文書。ccn 経由では実測で動かなかった | ccn の send_message で送る。from の1行が付くので、Claude が文として読む。入力欄の下に、そう動くと出す。**ccn 側が要る**（/ と ! で始まる文に from の1行を付けない指定） |
| 画面を開くコマンド（/model、/config、/permissions など） | 端末に選択や設定の画面を出す | CMD、実測 | PTY の子に送ったあと、ターミナルのタブを開く。チャットの中では操作できない。画面を開いたまま次の文を送ると、Enter がその画面に入る。ccn の send_message も同じで、既知の制限として残す |
| ! （文の頭） | シェルモード。コマンドを直接動かし、出力を会話に足す | IM | 入力欄の枠を桃色にする。送るときは PTY の子なら端末の口で直接貼る。-p の子では Claude が文として読む |
| ! のシェルモードの Tab | 前に打った ! のコマンドから補完する | IM | 作らない。必要になったら履歴の ! の行から作れる |
| @ | ファイルとフォルダの補完。ほかのセッションの名前も出る | IM、実測 | ファイルとフォルダを出す。Rust（file_suggestions）が git ls-files で一覧を作り、名前の頭、名前の中、パスの中の順に並べる。セッションの名前は出さない。別の機械のセッションでは出さない。**別の機械のファイルの一覧は ccn 側が要る** |
| @ の補完で Tab | 選んだファイルに置き換える | KB | 同じにした。フォルダのときは空白を足さず、続けて中を選べる |
| @ の補完で Enter | 選ばずに、打った文のまま送る | 実測 | 同じにした |
| ↑↓、Ctrl+P、Ctrl+N | 入力が複数の表示行なら、まず行を動く。先頭か末尾の行にいるときに履歴を辿る | IM、KB | 同じにした。表示行は textarea-caret でカーソルの高さを測って決める |
| 履歴の中身 | 作業フォルダごとに持つ。同じプロジェクトの前のセッションの分も辿れる。続けて同じ文を送ったものは1つにする | IM | CLI と同じ `~/.claude/history.jsonl` を Rust（prompt_history）が読み、同じ project の分を使う。手元の 7MB の履歴で、1回 17〜25ms、渡す JSON は 57KB だった（release ビルド）。ccn が付けた from の1行は外す。`[Pasted text #N]` は `~/.claude/paste-cache` の本文に戻す。Claude Town から送った文は、すぐ先頭に足す。別の機械のセッションでは、Claude Town から送った文だけ。**別の機械の履歴は ccn 側が要る** |
| Ctrl+R | 履歴を探す。打つと一致した文が入力欄に出る。もう一度 Ctrl+R で古いほうへ。Tab か Esc で決めて直す。Enter で決めて送る。Ctrl+C か、空のときの Backspace でやめる。全部のプロジェクトを探す | IM | 同じにした。探す文字は入力欄の上の欄に打つ（日本語を打てるようにするため）。全部のプロジェクトの履歴は新しい 1000 件で、JSON が約 1.2MB あるので、Ctrl+R を押したときだけ読む |
| Ctrl+A、Ctrl+E | 今の行（改行で区切った行）の頭、末尾へ | IM | 同じにした |
| Ctrl+K | 行末まで消し、Ctrl+Y で貼れるように取っておく | IM | 同じにした。行末では改行を消す（readline と同じ。CLI では実測していない） |
| Ctrl+U | 行頭まで消す。続けて押すと前の行も消える | IM、実測 | 同じにした |
| Ctrl+W | 前の空白まで消す。パスや --flag=value は1回で消える | IM | 同じにした |
| Ctrl+Y、Alt+Y | 消した文を貼る。続けて Alt+Y で、前に消した文に替える | IM | 同じにした。Option+Y で替える |
| Alt+B、Alt+F、Alt+D | 語の単位で動く、消す。語は文字と数字の並びで、_ . / で区切る。日本語でも1語ずつ動く。macOS では Option を Meta にする設定が要る | IM | 同じにした。Option で押す（設定は要らない）。日本語の語の切れ目は Intl.Segmenter で決める |
| Option+Delete | 前の1語を消す（macOS） | IM | macOS の textarea が元から持つ動きのまま（開発版では押していない） |
| Ctrl+_ | 入力の編集を1つ戻す | IM、KB | 同じにした（WebKit の undo）。⌘Z でも戻る |
| Ctrl+D | 文があるときはカーソルの後ろの1字を消す。空のときは2回で CLI を終える | IM | 文があるときは macOS の textarea が元から持つ動きのまま（開発版では押していない）。空のときは何もしない（チャットからセッションを終えない） |
| Ctrl+S | 打ちかけを退避して空にする。空のときに押すと戻す | IM、KB | 同じにした。セッションごとに持つ |
| Esc | 作業中なら止める。補完やダイアログを閉じる | IM、KB | 補完、キーの一覧を閉じる。作業中なら ccn の interrupt の口で止める（Rust の interrupt_session を足した） |
| Esc を2回 | 文があれば消して履歴に残し、↑ で呼び戻せる。空なら巻き戻しの画面を開く | IM | 文があるときは同じにした。2回の間は 800ms にした（CLI の値は文書に無いので、Ctrl+D の 800ms に合わせた仮置き）。空のときの巻き戻しは作らない（画面が端末の中にある） |
| Ctrl+C | 作業中なら止める。止めるものが無ければ文を消し、↑ で呼び戻せる。2回目で CLI を終える | IM | 作業中なら止める。そうでなければ文を消して履歴に残す。CLI は終えない。文字を選んでいるときは何もしない |
| ? （空のとき） | キーの一覧を開く | IM | 同じにした。入力欄の上に一覧を出す |
| Shift+Tab | 権限のモードを順に替える（default、acceptEdits、plan、bypassPermissions、auto） | IM、KB | 作らない。下の「作らなかったもの」に理由を書いた |
| Ctrl+G、Ctrl+X Ctrl+E | 外部のエディタで打つ | IM、KB | 作らない。下に理由を書いた |
| vim モード | /config の Editor mode で入る。NORMAL と INSERT を持つ | IM | 作らない。下に理由を書いた |
| Ctrl+L | IM は画面の描き直し、KB は chat:clearInput（入力を消す）と書いてあり、文書の間で食い違う | IM、KB | 作らない。描き直しは Claude Town では要らない。入力を消すほうは、食い違いを実測で確かめてから決める |
| Ctrl+O、Ctrl+T、Ctrl+B | 記録の表示、やることの一覧、作業を裏へ回す | IM | 作らない。どれも CLI の画面の中の表示と操作で、チャットの欄には当たる場所が無い |
| Option+P、Option+T、Option+O | モデル、拡張思考、fast mode を替える | IM | 作らない。替えるなら / のコマンド（/model、/fast）を送る |
| : の絵文字 | `:heart:` などを絵文字に替える | IM | 作らない。macOS の絵文字の入力（⌃⌘Space）がある |
| 作業中の Enter | 送った文は列に並び、今の作業のあとに送られる | IM | ccn がそのまま送る。PTY の子は CLI が列に並べ、-p の子は SDK が受ける |

## 作らなかったもの

- Shift+Tab の権限のモードは作らない。ccn には `PATCH /api/sessions/<id>` の permissionMode があるが、どのモードを選べるかは機械とセッションで変わり、Claude Town からは分からない。さらに、キー1つで bypassPermissions に替わるのは、画面のフォーカス移動にも使う Shift+Tab では危ない。替えるときは今のモードを見せる表示も要るので、別の issue で扱う。
- Ctrl+G の外部のエディタは作らない。Claude Town の入力欄は、それ自体が GUI のエディタで、複数行を打てる。CLI が外部のエディタを持つのは、端末の1行の入力欄では長い文を打ちにくいためである。
- vim モードは作らない。CLI でも /config で入れたときだけの動きで、本人の `~/.claude/settings.json` には editorMode が無い（既定の動き）。

## ccn 側が要るもの

- 画像を送る口。今の send_message は文しか受けない。
- / と ! で始まる文に from の1行を付けずに渡す指定。-p の子で / のスキルを CLI と同じに動かすのに要る。PTY の子は端末の口で代えた。
- 別の機械のセッションの、スキルの一覧、ファイルの一覧、入力の履歴を読む口。

## 開発版で確かめたこと

2026-11-13 に開発版（Claude Town Dev）を起動し、テスト用のセッション2つに向けてキーを1つずつ押した。キーは osascript と cliclick で押し、画面はスクショで見た。

| 確かめたこと | 結果 | 画像 |
|---|---|---|
| 日本語の変換中に Enter を押す | 変換が決まるだけで、送られなかった | cli-input/ime-enter.png |
| `/ct` と打つ | 補完が出た。1行目はプロジェクトのスキル `/ct-echo` | cli-input/slash-menu.png |
| 補完が出ているときに Tab | `/ct-echo ` に置き換わり、送られなかった | cli-input/slash-tab.png |
| Shift+Enter、\ のあと Enter、Ctrl+J | どれも改行になった | cli-input/newline.png |
| 空の入力欄で ↑ | 前に送った文が出た | cli-input/history-up.png |
| Ctrl+R のあと `PONG` | 全部のプロジェクトの履歴から一致した文が出た | cli-input/ctrl-r.png |
| 空の入力欄で ? | キーの一覧が出た | cli-input/help.png |
| PTY の子で `!echo SHELL-CT` | 枠が桃色になり、送るとシェルモードで動いた。Claude は出力 SHELL-CT を受けて返事した | cli-input/shell-mode.png |
| PTY の子で `/ct-ec` のあと Enter | 補完の `/ct-echo` で送られ、コマンドとして動いた（返事 PONG-SKILL ARGS=） | cli-input/pty-direct.png |
| -p の子で `/ct` と打つ | 入力欄の下に、CLI のコマンドとしては動かないと出た | cli-input/slash-menu.png |
| 4行の文で Ctrl+U を6回 | 1回で行の中身、もう1回で改行が消え、1行目の `a` だけが残った | 画像なし |

cliclick の `kp:tab` では Tab が入力欄に届かなかった。osascript の `key code 48` では届いた。押し方の違いで、アプリの動きの問題ではない。

## 未確認

- Ctrl+K を行末で押したときに改行を消すかは、CLI で実測していない。
- Ctrl+W、Ctrl+Y、Option+Y、Option+B、Option+F、Option+D、Ctrl+S、Ctrl+_、Esc と Ctrl+C の中断は、開発版では押していない。関数の単体テスト（src/composer/edit.test.ts）だけで確かめた。
- @ のファイルの補完は、開発版では押していない。Rust の並べ方は単体テストで確かめた。
- 作業中に Esc と Ctrl+C で止める動きは、ccn の interrupt の口を呼ぶだけで、開発版では試していない。
- Esc を2回押す間の長さは、CLI の値を確かめていない。
