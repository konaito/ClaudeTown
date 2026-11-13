# Claude Town のエージェント向けの決まり

本人は `/Applications/Claude Town.app`（安定版）で作業している。このリポジトリで作業する子や開発者は、次を守る。

- 起動と確認には開発版（`bun tauri dev` で起動する Claude Town Dev）だけを使う。
- 安定版を止めない、差し替えない、消さない。`pkill` や `killall` で名前を指定して止めない。開発版と安定版の実行ファイル名が同じなので、両方止まる。
- 安定版へ上げる（`scripts/release-stable.sh`）のと戻す（`scripts/rollback-stable.sh`）のは、本人か親が頼んだときだけにする。
- `src-tauri/tauri.conf.json` は開発版の設定にしてある。identifier と productName を安定版の値に戻さない。安定版の値は `src-tauri/tauri.stable.conf.json` にある。
- `hooks/fc-report.py` と `~/.family-computing/` のファイルの形は、安定版も読む。形を変えるときは、古い安定版で読めなくならないかを確かめる。

上げ方、戻し方、両版の違いは README の「安定版と開発版」に書いてある。
