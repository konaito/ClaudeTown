# キャラ素材の見本（Ninja Adventure と Noto Animated Emoji）

見本ページは同じディレクトリの index.html にある。ブラウザで開くと、案 A、B、C の状態対応と、20体を並べた見た目の例が見られる。下のほうに、2択に絞る前の候補一覧（12件）も残した。作成日は 2026-11-12。

## 3つの案と状態の対応

| 状態 | 案 A（Ninja Adventure だけ） | 案 B（Noto だけ） | 案 C（Ninja の体と Noto の頭上マーク） |
|---|---|---|---|
| はたらいてる | Walk の前向き4コマで足踏み（作業専用の動きは無いので代用） | 1f913 nerd-face | 体は案 A と同じ。1f4bb laptop |
| あなたの番 | Item（両手で掲げる）と Emote22 の赤い「!」 | 1f97a pleading | 270b raised-hand |
| まってる | Idle の前向きと Emote20 の「…」 | 1fae3 peeking | 23f3 hourglass |
| おわった | Jump を上下に弾ませ、Emote27 のハート | 1f973 partying-face | 2705 check-mark |
| ひとやすみ | Idle の前向きと Emote28 の「Zz」 | 1f634 sleep | 1f634 sleep |
| エラー | Dead と Emote3 の×目 | 1f635_200d_1f4ab dizzy-face | 2049 ⁉ |

推奨は付けていない。

## ライセンス

| 素材 | ライセンス | 商用 | 改変 | 再配布 | 帰属表示 | 確かめた一次情報 |
|---|---|---|---|---|---|---|
| Ninja Adventure Asset Pack（Pixel-boy、AAA） | CC0 1.0 | 可 | 可 | 可 | 不要（あれば嬉しいと記載） | itch.io の素材ページ、同梱の README.md と LICENSE.txt |
| Noto Animated Emoji（Google） | CC BY 4.0 | 可 | 可 | 可 | 必要 | 配布サイトの Documentation ページの FAQ「Animated Noto Emoji is licensed under CC BY 4.0.」 |

素材ファイルと出典は public/sprites/ninja/LICENSE.md と public/sprites/noto/LICENSE.md に書いた。

## Noto の形式ごとの大きさ

配布は 512px の版だけで、64px などの小さい版は無かった（404）。11種の合計は次のとおり。

| 形式 | 11種の合計 | 1種あたり |
|---|---|---|
| GIF 512px | 11.7 MB | 0.18〜2.7 MB |
| WebP 512px | 6.1 MB | 0.09〜1.05 MB |
| AVIF 512px | 0.73 MB | 14〜132 KB |
| Lottie JSON | 0.56 MB | 16〜117 KB（別に lottie-web 168 KB が要る） |
| GIF 96px（手元で縮小） | 2.6 MB | 73〜501 KB |
| WebP 96px（手元で縮小） | 1.3 MB | 21〜226 KB |

Ninja の PNG は 1枚 1KB 未満から数 KB で、public/sprites/ninja 全体（95キャラと Emote 30個、CharacterAnimated を含む）が 4.7MB。

## WKWebView での表示

macOS の Tauri と同じ WKWebView を1枚だけ開く Swift のプログラムで、bench.html に30体を並べて確かめた。スナップショットは wk/ に置いた。

| 形式 | 表示 | CPU（8秒間の平均、回ごとの幅） |
|---|---|---|
| GIF | 30/30 表示できた | 0.8〜15.6% |
| WebP | 30/30 表示できた | 0.4〜17.8% |
| AVIF | 読み込めたが、透過の部分が黒くなる | 0.4〜11.0%（file:// で測った1回目は 392%） |
| Lottie（lottie-web、SVG 描画） | 30/30 表示できた。file:// では JSON を読めず、HTTP で配ったときに表示できた | 0.1〜0.6% |
| Ninja（PNG と CSS のコマ送り） | 30/30 表示できた | 0.4〜4.1% |

CPU は回ごとのぶれが大きく、形式の間の差は言い切れない。

## ファイル

- index.html: 見本ページ
- bench.html: 30体のベンチページ。`?fmt=gif|webp|avif|lottie|ninja` で形式を切り替える
- wk/: WKWebView のスナップショット
- kenney-toon-characters.png: 前の候補一覧で使う Kenney のプレビュー画像
