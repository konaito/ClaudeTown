// ブラウザ版（PWA）の承認への返事。Rust の answer_permission と permission_body（src-tauri/src/lib.rs）と同じ確認をしてから、ccn の permissions の口で答える。
// Rust との違い: 送信の非常停止（~/.family-computing/send-disabled）は、手元のファイルなのでブラウザからは見えず、効かない。

/** ccn の GET /sessions/<id> の応答のうち、承認への返事が読む部分 */
import { canAnswerPermission } from "./abilities";

type Detail = { state?: unknown; capabilities?: { permissions?: unknown }; pending?: unknown } | null | undefined;
type Get = (path: string) => Promise<Detail>;
type Post = (path: string, body: unknown) => Promise<unknown>;

/** 拒否の理由が空のときに送る文。Rust の DENY_DEFAULT と同じ */
export const DENY_DEFAULT = "Claude Town から拒否した";
/** 計画の見直しを頼むときに、理由が空なら送る文。Rust の PLAN_DENY_DEFAULT と同じ */
export const PLAN_DENY_DEFAULT = "計画を承認しなかった。計画を見直して、もう一度確認して";

export type Pending = { requestId?: unknown; toolName?: unknown; input?: Record<string, unknown>; suggestions?: unknown };

/** 「常に許可」として返してよい提案か。Rust の allowed_suggestion と同じ（addDirectories は端末の承認の画面が残ったので返さない） */
export const allowedSuggestion = (s: { type?: unknown } | null | undefined) => s?.type === "addRules" || s?.type === "setMode";

/**
 * ccn に送る中身と、終わったときに画面に出す文。Rust の permission_body と同じ決まり。
 * AskUserQuestion の許可は全部の質問に答えがあるときだけ、元の input に answers を足して返す。
 * ExitPlanMode の許可は素の allow、拒否は計画の見直しを頼む。
 */
export function permissionBody(first: Pending, choice: string, expectId: string | null, answers: Record<string, string> | null, message: string | null, suggestion: number | null = null): { body: unknown; done: string } {
  const req = first.requestId;
  if (typeof req !== "string") throw new Error("承認の要求に requestId が無い");
  const tool = String(first.toolName ?? "");
  if (choice === "deny") {
    if (suggestion != null) throw new Error("拒否に「常に許可」は付けない");
    const msg = message?.trim() || null;
    if (tool === "ExitPlanMode") return { body: { behavior: "deny", message: msg ?? PLAN_DENY_DEFAULT }, done: "計画の見直しを頼んだ" };
    if (tool === "AskUserQuestion") return { body: { behavior: "deny", message: msg ?? DENY_DEFAULT }, done: "質問に答えずに断った" };
    return { body: { behavior: "deny", message: msg ?? DENY_DEFAULT }, done: `拒否した（${tool}）` };
  }
  if (choice !== "allow") throw new Error("choice は allow か deny");
  if (expectId !== req) throw new Error("承認を求めている中身が変わった。もう一度見てから答えて");
  if (tool === "AskUserQuestion") {
    if (!answers) throw new Error("質問への答えが無い");
    const qs: ({ question?: unknown } | null)[] = Array.isArray(first.input?.questions) ? first.input.questions : [];
    if (!qs.length) throw new Error("質問の中身が読めない。ターミナルで答えて");
    const out: Record<string, string> = {};
    for (const q of qs) {
      const text = String(q?.question ?? "");
      const a = typeof answers[text] === "string" ? answers[text].trim() : "";
      if (!a) throw new Error(`「${text}」への答えが無い`);
      out[text] = a;
    }
    return { body: { behavior: "allow", updatedInput: { ...first.input, answers: out } }, done: "質問に答えた" };
  }
  if (answers) throw new Error(`${tool} は質問ではないので、答えを送らない`);
  if (tool === "ExitPlanMode") {
    if (suggestion != null) throw new Error("計画の確認に「常に許可」は付けない");
    return { body: { behavior: "allow" }, done: "計画を承認した" };
  }
  if (suggestion == null) return { body: { behavior: "allow" }, done: `許可した（${tool}）` };
  const s = Array.isArray(first.suggestions) ? first.suggestions[suggestion] : undefined;
  if (!s || !allowedSuggestion(s)) throw new Error("この「常に許可」は今の承認の提案に無い。もう一度見てから答えて");
  return { body: { behavior: "allow", updatedPermissions: [s] }, done: `許可して、以後は聞かないようにした（${tool}）` };
}

export async function answerPermission(get: Get, post: Post, sessionId: string, choice: string, expectId: string | null, answers: Record<string, string> | null = null, message: string | null = null, suggestion: number | null = null): Promise<string> {
  if (choice !== "allow" && choice !== "deny") throw new Error("choice は allow か deny");
  const detail = await get(`/sessions/${sessionId}`);
  if (detail?.state !== "waiting_permission") throw new Error("もう承認待ちではない（ほかで答えたか、終わった）");
  if (!canAnswerPermission(detail)) throw new Error("このセッションは ccn から承認に答えられない（人がターミナルで開いたセッション）。そのターミナルで答えて");
  const first: Pending | undefined = Array.isArray(detail?.pending) ? detail.pending[0] : undefined;
  if (!first) throw new Error("ccn に承認の要求が見当たらない");
  const { body, done } = permissionBody(first, choice, expectId, answers, message, suggestion);
  await post(`/sessions/${sessionId}/permissions/${first.requestId}`, body);
  return done;
}
