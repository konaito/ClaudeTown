# 転出（teleport）後の parent の見え方の試験

2026-11-12 に fc-teleport-test が行った。ccn のコードは変えていない。

## 組み合わせと立て方

- origin/main（086d910）に #18（feat/session-teleport 41741d3）と #19（feat/pty-driver 8091334）を手元でマージした（af40cf4。push していない）。
- 競合は `src/api/app.ts` と `src/api/errors.ts` の2か所で、両方の分岐を残して解いた。`tsc` はエラーなし、`bun test` は 336 pass、1 skip、0 fail だった。
- 試験ノードは町A（tp-a、4431）と町B（tp-b、4432）。`ccn serve` ではなく `launch.ts` で立てた。
- launch.ts は buildDeps の結果のうち、次の3点を差し替えた。
  - 登録簿を2ノードの StaticRegistry にし、中継のトークンを試験の値にした。設定に peers の欄が無いため。
  - 同じ機械では `~/.claude/projects` を共有するので、別の機械を模した。History と teleport の SDK 呼び出しには、町ごとの proj を dir として渡した。
  - 端末の一覧（claude agents）を空にした。
- claude は `--model haiku` で動かし、文は「ツールを使わず OK とだけ返して」にした。転出の body には毎回 `cwd`（町B の proj）を渡した。

## 試したことと保存した一覧

各段階の `<段階>-A.json` と `<段階>-B.json` は、id、title、state、parent、kind、cwd、awaitingFirst に絞った一覧。`.full.json` は GET /api/sessions の全体。id は `ids-*.txt` にある。

| 段階 | 内容 |
| --- | --- |
| a0〜a3 | 親 7e947508、子 dd7b3c7f、孫 3694ed54 を、親、子、孫の順に1つずつ move した。呼び手はヘッダなしの local。そのあと子に send し、子を DELETE した |
| b0〜b3 | 親 9270b020 を残し、子 5f299c1b、孫 e019999f の順に move した。呼び手は local。そのあと孫に send し、孫を DELETE した |
| c0〜c3 | 子 bcbd556c と孫 1272d4a3 を、転出の POST に `x-ccn-from: <元の parent>` を付けて move した。そのあと孫に send し、孫を DELETE した |
| d1 | 親 9270b020 を fork した。新しい id は 6a368d97 |

## 結果

### a と b（呼び手はヘッダなしの local）

- 町B に移ったセッションの parent は、3つとも `local` になった。`local` は転出の POST の呼び手で、元の `agent:tp-a/<sid8>/test` は残らなかった。
- send の後も parent は `local` のままだった（a2、b2）。
- DELETE の後、町B の行は exited になり、parent は null になった（a3、b3）。
- 町A には、移ったセッションが同じ id、state exited、parent null で残った（a1、b1）。
- move で id は変わらなかった。fork では新しい id になり、移動元は町A に idle のまま残った（d1。9270b020 から 6a368d97）。
- このため、町B の一覧だけでも、町A の一覧と合わせても、親は引けなかった。引けるのは、Claude Town が転出の前の一覧（a0、b0）を覚えている場合だけになる。
- 町A から中継（`/n/tp-b/api/sessions/<id>/messages` と DELETE）で送った send は 200 を返し、haiku の返事（OK2、OK3）が届いた。DELETE は 204 を返した。
- 移った直後のセッションは、町B で `awaitingFirst: true` になっていた。1通も届かないまま30分たつと台帳から消える。

### c（転出の POST に `x-ccn-from: <元の parent>` を付けた）

- 町B の parent は、元の値（`agent:tp-a/9bf1ce0a/test` と `agent:tp-a/bcbd556c/test`）のまま残った。町B の `?parent=agent:tp-a/bcbd556c/test` は孫を返した。send の後も変わらなかった。
- 孫の parent が指す bcbd556c は、町B では idle で、町A には同じ id の exited の行が残っていた。parent のノード名（tp-a）どおりに町A を引くと、残った exited の行に当たる。
- DELETE の後は、c でも parent が null になった（c3）。

### 過去のセッションの parent が null になる原因（main でも同じ）

- History は、SDK の `firstPrompt` の from 行から parent を導く。
- SDK の `firstPrompt` は改行を空白につぶして返す（例 `from agent:tp-a/7e947508/test via tp-a  ツールを…`）。
- `parseFromLine` の正規表現 `^from (\S+) via (\S+)\s*$` は行末を要るので、つぶれた文に合わない。
- 試験の jsonl を消した後に、この機械の履歴 100件を数えた。from 行で始まるものは 21件で、parent を導けたものは0件だった。
- 本番ノード（4323）の一覧では、exited の 93件のうち parent があるものは0件だった。

## 確かめていないこと

- 別の機械、Access の下、Cloudflare を通る中継。実測は loopback の HeaderIdentity だけ。Access の下で Claude Town が `x-ccn-from` を名乗れるかは確かめていない。
- 本番で転出の呼び手が何になるか。町B の `local` は試験の呼び手の値で、本番では呼び手の身元になるはず（コードから）。
- 30分の期限切れとノードの再起動で parent が null になること（コードから）。
- kind が pty のセッションの転出。試したのは node だけ。
- a の順番（親、子、孫）をヘッダ付きで通すこと。c からの推定になる。
- 試したのは main 086d910 と #19 の 8091334。今の main は d5bd37f、feat/pty-driver は 876fbdf に進んでいる。
