# 画面の外のアニメと足踏み（#12）

## 画面の外のアニメ（実装済み）
- `src/offscreen.ts` が、全体で共有する IntersectionObserver を1つ持つ。`.fnode`（カードと札）ごとに observe し、見えなくなったら `data-offscreen` を付ける。
- `App.css` が、`data-offscreen` の付いた `.fnode` の中のアニメを止める。閉じる演出（`.dying`）は止めない。
- root は指定せず viewport にした。町のスクロールの容れ物と、`overflow: hidden` で切れた部分は交差の計算に入る。rootMargin は 64px。
- 試験は `src/offscreen.test.ts`。observer の共有、印の付け外し、解除、重複登録を fake で見る。

## 足踏み（fc-step）の扱い: 測れなかったので実装しない
`scripts/bench-crowd-webkit.ts` で、作業中の町（60体と20体）を直す前後で測ろうとしたが、数字が1つも取れなかった。
- 実行は、バックグラウンドの起動が 120 秒で外れ、スクリプトの 10 分の締切（`deadline`）に達して打ち切られた。ログは「10分の締切で打ち切った」の1行だけで、測定の行は出ていない。
- 原因は調べていない（Playwright の WebKit の起動か、`waitForSelector` の待ちで時間を使った可能性があるが、確かめていない）。
- 全体の時間の上限（75分）に達したため、再実行していない。

そのため、全員で1つのタイマーにそろえる案は測っていない。CSS のまま残す。画面の外のアニメを止めた効果の CPU も測っていない。
