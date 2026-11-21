import { useEffect, useState } from "react";
import { call as invoke } from "../bridge";
import { pollWhileVisible } from "../visible";
import { ScrollEdgeGradient } from "../ScrollEdgeGradient";
import { Markdown, linkify } from "../Markdown";
import type { Agent } from "../model";
import { answerText, emptyPick, type Pick, type Question } from "./answers";
import { alwaysOptions } from "./suggestions";

type PendingReq = { requestId: string; toolName: string; input: Record<string, any>; suggestions?: unknown };
type Answer = (choice: "allow" | "deny", extra?: { answers?: Record<string, string>; message?: string; suggestion?: number }) => Promise<void>;

/**
 * 承認待ちに画面から答える。中身は ccn の pending（toolName、input、requestId）。
 * 押すと Rust が、今も承認待ちで requestId が同じかを確かめてから、ccn の permissions の口で答える。
 * 質問（AskUserQuestion）は選んだ答えを、計画の確認（ExitPlanMode）は承認か見直しの頼みを、同じ口で返す（#83）。
 * 人が端末で開いたセッション（ccn から答えられない）は、その端末で答える。
 */
export function Approval({ agent, peer, planHint, onDone, onError }: {
  agent: Agent; peer: string; onDone: (m: string) => void; onError: (m: string) => void;
  /** 会話の最後の計画の本文。ExitPlanMode の hook の入力は、計画ファイルが無いと空で来るので、そのときに出す */
  planHint?: string | null;
}) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [pending, setPending] = useState<PendingReq[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canAnswer = !!agent.capabilities?.permissions;
  useEffect(() => {
    let alive = true;
    const load = () => invoke<any>("session_detail", { sessionId: agent.id, peer: peer || null })
      .then((d) => { if (alive) { setPending(Array.isArray(d?.pending) ? d.pending : []); setErr(null); } })
      .catch((e) => { if (alive) setErr(String(e)); });
    const stop = pollWhileVisible(load, 2000);
    return () => { alive = false; stop(); };
  }, [agent.id, peer]);
  const p = pending?.[0];
  const answer: Answer = async (choice, extra) => {
    setBusy(choice);
    try {
      const r = await invoke<string>("answer_permission", {
        sessionId: agent.id, choice, expectId: p?.requestId ?? null,
        answers: extra?.answers ?? null, message: extra?.message ?? null, suggestion: extra?.suggestion ?? null, peer: peer || null,
      });
      onDone(`${agent.name}: ${r}`);
    } catch (e) {
      onError(`${agent.name} に答えられなかった: ${e}`);
    } finally {
      setBusy(null);
    }
  };
  const kind = p?.toolName === "AskUserQuestion" ? "ask" : p?.toolName === "ExitPlanMode" ? "plan" : "tool";
  const title = kind === "ask" ? `${agent.name} が質問している` : kind === "plan" ? `${agent.name} が計画の確認を待っている` : `${agent.name} が承認を待っている`;
  return (
    <div className={`approval ap-${kind}`}>
      <div className="ap-title">{kind === "ask" ? "❓" : kind === "plan" ? "📝" : "✋"} {title}</div>
      {!canAnswer ? (
        <div className="hint">このセッションは人がターミナルで開いたもので、ここからは答えられない。そのターミナルで答える。</div>
      ) : !p ? (
        <div className="hint">{err ?? "承認の中身を読んでいる…"}</div>
      ) : kind === "ask" ? (
        <AskForm key={p.requestId} questions={Array.isArray(p.input?.questions) ? p.input.questions : []} busy={busy} answer={answer} />
      ) : kind === "plan" ? (
        <PlanForm key={p.requestId} plan={String(p.input?.plan || planHint || "")} busy={busy} answer={answer} />
      ) : (
        <ToolForm key={p.requestId} p={p} busy={busy} answer={answer} />
      )}
      {canAnswer && (pending?.length ?? 0) > 1 && <div className="hint">ほかに{pending!.length - 1}件の承認が待っている。1件ずつ答える。</div>}
    </div>
  );
}

/** 道具の承認。「常に許可」は ccn が渡した提案（suggestions）のうち、返してよいものだけを出す。拒否には理由を付けられる */
function ToolForm({ p, busy, answer }: { p: PendingReq; busy: "allow" | "deny" | null; answer: Answer }) {
  const [reason, setReason] = useState("");
  const always = alwaysOptions(p.suggestions);
  const i = p.input as any;
  const detail = String(i?.command ?? i?.file_path ?? i?.url ?? JSON.stringify(p.input));
  return (
    <>
      <div>
        <div className="ap-tool">{p.toolName}</div>
        {detail && <ScrollEdgeGradient className="ap-detail"><span>{linkify(detail)}</span></ScrollEdgeGradient>}
      </div>
      <div className="ap-btns">
        <button className="ap-allow" disabled={!!busy} onClick={() => answer("allow")}>{busy === "allow" ? "送っている…" : "許可する"}</button>
        {always.map((o) => (
          <button key={o.index} className="ap-always" disabled={!!busy} title={o.title} onClick={() => answer("allow", { suggestion: o.index })}>{o.label}</button>
        ))}
        <button className="ap-deny" disabled={!!busy} title="拒否する。下の欄に書いた理由を Claude に伝える" onClick={() => answer("deny", { message: reason })}>{busy === "deny" ? "送っている…" : "拒否する"}</button>
      </div>
      <input className="ap-reason" placeholder="拒否の理由（任意。Claude に伝わる）" value={reason} disabled={!!busy} onChange={(e) => setReason(e.target.value)} />
    </>
  );
}

/** AskUserQuestion の質問。選択肢を押して選び、「答える」で全部の質問の答えをまとめて送る。選択肢に無い答えは「その他」に書く */
function AskForm({ questions, busy, answer }: { questions: Question[]; busy: "allow" | "deny" | null; answer: Answer }) {
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(emptyPick));
  const set = (qi: number, f: (p: Pick) => Pick) => setPicks((ps) => ps.map((p, i) => (i === qi ? f(p) : p)));
  const texts = questions.map((q, i) => answerText(q, picks[i] ?? emptyPick()));
  const ready = questions.length > 0 && texts.every((t) => !!t);
  if (!questions.length) return <div className="hint">質問の中身が読めない。ターミナルで答える。</div>;
  return (
    <>
      {questions.map((q, qi) => {
        const pk = picks[qi] ?? emptyPick();
        return (
          <div className="ask-q" key={qi}>
            <div className="ask-head">{q.header && <span className="ask-chip">{q.header}</span>}<span className="ask-text">{q.question}</span>{q.multiSelect && <span className="hint">（いくつでも選べる）</span>}</div>
            <div className="ask-opts" role={q.multiSelect ? "group" : "radiogroup"}>
              {(q.options ?? []).map((o) => {
                const on = pk.picked.includes(o.label);
                return (
                  <button key={o.label} className={`ask-opt${on ? " on" : ""}`} role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={!!busy}
                    onClick={() => set(qi, (p) => ({ ...p, picked: q.multiSelect ? (on ? p.picked.filter((x) => x !== o.label) : [...p.picked, o.label]) : [o.label], other: q.multiSelect ? p.other : "" }))}>
                    <span className="ask-label">{o.label}</span>
                    {o.description && <span className="ask-desc">{o.description}</span>}
                  </button>
                );
              })}
            </div>
            <input className="ask-other" placeholder="その他（選択肢に無い答えを書く）" value={pk.other} disabled={!!busy}
              onChange={(e) => { const v = e.target.value; set(qi, (p) => ({ picked: q.multiSelect || !v ? p.picked : [], other: v })); }} />
          </div>
        );
      })}
      <div className="ap-btns">
        <button className="ap-allow" disabled={!ready || !!busy} title={ready ? "選んだ答えを送る" : "全部の質問に答えると送れる"}
          onClick={() => answer("allow", { answers: Object.fromEntries(questions.map((q, i) => [q.question, texts[i]])) })}>{busy === "allow" ? "送っている…" : "答える"}</button>
        <button className="ap-deny" disabled={!!busy} title="質問に答えずに断る（ターミナルの Esc と同じ）" onClick={() => answer("deny")}>{busy === "deny" ? "送っている…" : "答えずに断る"}</button>
      </div>
    </>
  );
}

/** ExitPlanMode の計画。承認するか、直してほしいことを書いて計画を続けさせる */
function PlanForm({ plan, busy, answer }: { plan: string; busy: "allow" | "deny" | null; answer: Answer }) {
  const [note, setNote] = useState("");
  return (
    <>
      {plan ? <ScrollEdgeGradient className="ap-plan"><Markdown text={plan} /></ScrollEdgeGradient> : <div className="hint">計画の本文が無い</div>}
      <textarea className="ap-note" rows={2} placeholder="直してほしいこと（「続けて計画する」で送る。空でもよい）" value={note} disabled={!!busy} onChange={(e) => setNote(e.target.value)} />
      <div className="ap-btns">
        <button className="ap-allow" disabled={!!busy} title="計画を承認して、作業に進ませる" onClick={() => answer("allow")}>{busy === "allow" ? "送っている…" : "計画を承認する"}</button>
        <button className="ap-deny" disabled={!!busy} title="承認せず、上に書いたことを伝えて計画を続けさせる" onClick={() => answer("deny", { message: note })}>{busy === "deny" ? "送っている…" : "続けて計画する"}</button>
      </div>
    </>
  );
}
