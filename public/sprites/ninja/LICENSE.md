# Ninja Adventure Asset Pack の出典とライセンス

- 素材名: Ninja Adventure - Asset Pack
- 作者: Pixel-boy（https://pixel-boy.itch.io/）、AAA（https://www.instagram.com/challenger.aaa/）
- 入手元: https://pixel-boy.itch.io/ninja-adventure-asset-pack
- 入手日: 2026-11-12。itch.io の「Ninja Adventure - Asset Pack.zip」（89MB、2026-03-29 更新の版）
- ライセンス: CC0 1.0 Universal（https://creativecommons.org/publicdomain/zero/1.0/）
- 商用利用、改変、再配布ができる。帰属表示は不要。

パックに同梱の README.md の原文は次のとおり。

> They are released under the Creative Commons Zero (CC0) license.
> You can use any and all of the assets found in this package in your own games, even commercial ones. Attribution is not required but appreciated.

同梱の LICENSE.txt の全文は LICENSE-CC0.txt、README.md の原本は README-original.md に置いた。

## このディレクトリの中身

- characters/: パックの Actor/Character から、人に見える55体（大人22、子供33）の SeparateAnim/Idle.png、Walk.png、Dead.png と Faceset.png を、改変せずに複製した。
- 2026-11-13（#16）に、アプリで使っていない Faceset.png を消した。残りの PNG から色のプロファイル（sRGB）などの描画に使わない部分を外した（`scripts/strip-sprites.sh`）。画素は変えていない。年齢の印象を付けたときに見た顔は、パックの元のファイルにある。
- characters-animated/: パックの Actor/CharacterAnimated をそのまま複製した。
- emote/: パックの Ui/Emote（emote1.png から emote30.png、14x13px）を複製した。
- 改変は加えていない。
