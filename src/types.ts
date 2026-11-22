// Rust の命令（src-tauri/src/lib.rs）と、ブラウザ版（PWA）が中継する ccn の応答のうち、画面が読む部分の形。
// 形は実際の応答（session_ops.rs の create_session、ccn の GET /sessions/<id>）から起こした。
// どのフィールドも無いことがあるので、省略可能にしてある。足すだけで、応答の形は変えない。

/** create_session の応答。画面が読むのは id と cwd と pathFallback。pathFallback はログインシェルの PATH を取れずに立てた印（#175） */
export type CreatedSession = { id?: string; cwd?: string; pathFallback?: boolean };

/** session_detail（ccn の GET /sessions/<id>）の応答のうち、承認とモデル切り替えが読む部分。pending は読む側で配列かどうかを確かめる */
export type SessionDetail = { pending?: unknown; model?: unknown; permissionMode?: unknown; blocked?: unknown };
