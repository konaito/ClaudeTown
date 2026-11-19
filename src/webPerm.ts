// ブラウザ版（PWA）の承認への返事。Rust の answer_permission（src-tauri/src/lib.rs）と同じ確認をしてから、ccn の permissions の口で答える。
// Rust との違い: 送信の非常停止（~/.family-computing/send-disabled）は、手元のファイルなのでブラウザからは見えず、効かない。
/** 道具の承認ではない待ち。許可を送らない */
export const NOT_TOOL_APPROVAL = ["AskUserQuestion", "ExitPlanMode"];

type Get = (path: string) => Promise<any>;
type Post = (path: string, body: unknown) => Promise<unknown>;

export async function answerPermission(get: Get, post: Post, sessionId: string, choice: string, expectId: string | null): Promise<string> {
  if (choice !== "allow" && choice !== "deny") throw new Error("choice は allow か deny");
  const detail = await get(`/sessions/${sessionId}`);
  if (detail?.state !== "waiting_permission") throw new Error("もう承認待ちではない（ほかで答えたか、終わった）");
  if (detail?.capabilities?.permissions !== true) throw new Error("このセッションは ccn から承認に答えられない（人がターミナルで開いたセッション）。そのターミナルで答えて");
  const first = Array.isArray(detail.pending) ? detail.pending[0] : undefined;
  if (!first) throw new Error("ccn に承認の要求が見当たらない");
  const req = first.requestId;
  if (typeof req !== "string") throw new Error("承認の要求に requestId が無い");
  const tool = String(first.toolName ?? "");
  if (choice === "allow") {
    if (NOT_TOOL_APPROVAL.includes(tool)) throw new Error(`${tool} の待ちは道具の承認ではないので、ここからは許可しない。ターミナルで答えて`);
    if (expectId !== req) throw new Error("承認を求めている中身が変わった。もう一度見てから答えて");
  }
  const body = choice === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "Claude Town から拒否した" };
  await post(`/sessions/${sessionId}/permissions/${req}`, body);
  return `${choice === "allow" ? "許可" : "拒否"}した（${tool}）`;
}
