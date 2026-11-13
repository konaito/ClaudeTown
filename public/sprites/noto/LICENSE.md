# Noto Animated Emoji の出典とライセンス

- 素材名: Noto Animated Emoji（Animated Noto Emoji）
- 作者: Google
- 入手元: https://googlefonts.github.io/noto-emoji-animation/
- 取得 URL の形: https://fonts.gstatic.com/s/e/notoemoji/latest/<コードポイント>/<512.gif | 512.webp | 512.avif | lottie.json>
- 入手日: 2026-11-12
- ライセンス: CC BY 4.0（https://creativecommons.org/licenses/by/4.0/legalcode）
- 商用利用、改変、再配布ができる。帰属表示が必要。

配布サイトの Documentation ページ（https://googlefonts.github.io/noto-emoji-animation/documentation）の FAQ の原文は次のとおり。

> Can I use these animated assets commercially: for a video, for broadcast, apps, etc.?
> Animated Noto Emoji is licensed under CC BY 4.0. See the full license for all details.

## 帰属表示の文例

アプリに組み込むときは、クレジット画面か配布物の LICENSE に次の内容を書く。

> Animated emoji: Noto Animated Emoji by Google, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Source: https://googlefonts.github.io/noto-emoji-animation/

縮小や切り出しなどの改変をした場合は、改変した旨も書く。

## このディレクトリの中身

配布元の 512.webp を縮めた 64.webp を、コードポイントごとのディレクトリに置いた（2026-11-13、#7）。改変の内容は次のとおり。

- 512px を 64px に縮めた（表示は 11〜30px で、高精細の画面でも 64px で足りる）
- コマを2枚に1枚に間引き、残したコマの長さに間引いたコマの長さを足した。1周の長さは元と同じ
- 有損失の WebP（品質 80）で作り直した

作り方は `scripts/make-noto-small.sh` にある。配布元の 512.webp を、上の取得 URL の形から取り直して作る。

| コードポイント | 名前 | 使う場所 |
|---|---|---|
| 270b | raised-hand | 承認待ちの印 |
| 1f97a | pleading | 返事待ちの印 |
| 2705 | check-mark | 完了の印 |
| 1f47b | ghost | 閉じるときの演出 |
| 1f48c | love-letter | お手紙の封筒 |

2026-11-12 の調べ（docs/research/assets）では、ほかのコードポイントと GIF、AVIF、Lottie の形式も置いていた。使わないものは消した。
