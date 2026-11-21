// Rust の命令（src-tauri/src/lib.rs）と ccn の応答のうち、画面が読む部分の形。
// 形は実際の応答（scripts/mock-ccn-pty.ts、lib.rs の create_session、teleport、teleport_info、session_detail）から起こした。
// どのフィールドも ccn の版によって無いことがあるので、省略可能にしてある。足すだけで、応答の形は変えない。

/** create_session の応答。画面が読むのは id と cwd だけ */
export type CreatedSession = { id?: string; cwd?: string };

/** session_detail（ccn の GET /sessions/<id>）の応答のうち、承認とモデル切り替えが読む部分。pending は読む側で配列かどうかを確かめる */
export type SessionDetail = { pending?: unknown; model?: unknown; permissionMode?: unknown };

/** teleport_info の応答 */
export type TeleportInfo = {
  state?: string;
  live?: boolean;
  from?: { cwd?: unknown };
  git?: { repoName?: string; branch?: string } | null;
};

/** teleport の dryRun（subtree）の計画の1人分。skipped では reason が付く */
export type TeleportMove = { sourceId: string; title?: string; cwd?: unknown; reason?: string };

/** teleport の dryRun の応答。error は取れなかったときに画面が自分で入れる */
export type TeleportPlan = { error?: string; plan?: TeleportMove[]; skipped?: TeleportMove[] };

/** teleport の実行の応答。subtree のときは moved と failed、1人のときは id、node、cloned */
export type TeleportResult = {
  id?: string;
  node?: string;
  cloned?: boolean;
  moved?: unknown[];
  failed?: { sourceId: string; error?: unknown }[];
};
