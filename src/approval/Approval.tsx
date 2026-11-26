import { useEffect, useState } from "react";
import { Check, CircleQuestionMark, ClipboardList, Hand } from "lucide-react";
import { ICON, STROKE } from "../icons";
import { call as invoke } from "../bridge";
import { pollWhileVisible } from "../visible";
import { ScrollEdgeGradient } from "../ScrollEdgeGradient";
import { Markdown, linkify } from "../Markdown";
import type { Agent } from "../model";
import type { SessionDetail } from "../types";
import { answerText, emptyPick, type Pick, type Question } from "./answers";
import { alwaysOptions } from "./suggestions";
import { canAnswerPermission } from "../abilities";
import { isDenyRow, isReviseRow, planLabel, ptyPicks, toolLabel, type ScreenRow } from "./pty";

/**
 * 承認の中身。ブラウザ版は ccn の pending。アプリが立てたセッション（PTY）は Rust の dialog.rs が端末の画面と会話の記録から作り、
 * options（画面の番号の行）、screenPlan（画面に出た計画の本文）、blocked（ここからは答えられない理由）が付く
 */
type PendingReq = {
  requestId: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown;
  options?: ScreenRow[]; screenPlan?: string; blocked?: string | null; kind?: string;
  /** チームメイトの承認がリードの端末に出たときの、依頼元のチームメイトの名前（#317） */
  agentName?: string | null;
  /** PreToolUse の hook が ask を返したときの、画面に出た hook の理由 */
  hookNote?: string | null;
};
/** PTY のセッションで Rust に渡す答え（dialog.rs の Act） */
type Act = { type: "option"; n: number; label: string } | { type: "deny"; reason?: string } | { type: "revise"; note: string } | { type: "ask"; picks: { picked: number[]; other: string }[] };
type Answer = (choice: "allow" | "deny", extra?: { answers?: Record<string, string>; message?: string; suggestion?: number; act?: Act }) => Promise<void>;

/**
 * 承認待ちに画面から答える。中身は ccn の pending（toolName、input、requestId）。
 * 押すと Rust が、今も承認待ちで requestId が同じかを確かめてから、ccn の permissions の口で答える。
 * 質問（AskUserQuestion）は選んだ答えを、計画の確認（ExitPlanMode）は承認か見直しの頼みを、同じ口で返す（#83）。
 * 人が端末で開いたセッション（ccn から答えられない）は、その端末で答える。
 */
export function Approval({ agent, planHint, onDone, onError, onTerm }: {
  agent: Agent; onDone: (m: string) => void; onError: (m: string) => void;
  /** ターミナルのタブを開く。ここから答えられないときに出す */
  onTerm?: () => void;
  /** 会話の最後の計画の本文。ExitPlanMode の hook の入力は、計画ファイルが無いと空で来るので、そのときに出す */
  planHint?: string | null;
}) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [pending, setPending] = useState<PendingReq[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const canAnswer = canAnswerPermission(agent);
  useEffect(() => {
    let alive = true;
    const load = () => invoke<SessionDetail | null>("session_detail", { sessionId: agent.id })
      .then((d) => { if (alive) { setPending(Array.isArray(d?.pending) ? d.pending : []); setBlocked(typeof d?.blocked === "string" ? d.blocked : null); setErr(null); } })
      .catch((e) => { if (alive) setErr(String(e)); });
    const stop = pollWhileVisible(load, 2000);
    return () => { alive = false; stop(); };
  }, [agent.id]);
  const p = pending?.[0];
  // 画面の行が付いていれば PTY のセッション。答えは端末の承認の画面にキーで書く
  const pty = !!p && Array.isArray(p.options);
  const stop = blocked ?? (pty && p?.blocked) ?? null;
  const answer: Answer = async (choice, extra) => {
    setBusy(choice);
    try {
      const r = pty
        ? await invoke<string>("answer_dialog", { sessionId: agent.id, expectId: p!.requestId, act: extra?.act })
        : await invoke<string>("answer_permission", {
          sessionId: agent.id, choice, expectId: p?.requestId ?? null,
          answers: extra?.answers ?? null, message: extra?.message ?? null, suggestion: extra?.suggestion ?? null,
        });
      onDone(`${agent.name}: ${r}`);
    } catch (e) {
      onError(`${agent.name} に答えられなかった: ${e}`);
    } finally {
      setBusy(null);
    }
  };
  // PTY のセッションは Rust が画面から種類を決める（本文の無い ExitPlanMode の「Exit plan mode?」は道具の承認と同じ形）
  const kind = p?.kind === "ask" || p?.kind === "plan" || p?.kind === "tool" ? p.kind
    : p?.toolName === "AskUserQuestion" ? "ask" : p?.toolName === "ExitPlanMode" ? "plan" : "tool";
  // チームメイトの承認は、リードの端末に出てリードの欄で答える。題には依頼元のチームメイトの名前を出す
  const mate = p?.agentName || null;
  const title = kind === "ask" ? `${agent.name} が質問している` : kind === "plan" ? `${agent.name} が計画の確認を待っている`
    : mate ? `チームメイトの ${mate} が承認を待っている` : `${agent.name} が承認を待っている`;
  return (
    <div className={`approval ap-${kind}`}>
      <div className="ap-title">{(() => { const I = kind === "ask" ? CircleQuestionMark : kind === "plan" ? ClipboardList : Hand; return <I size={ICON.md} strokeWidth={STROKE} aria-hidden />; })()}{title}</div>
      {!canAnswer ? (
        <div className="hint">このセッションは人がターミナルで開いたもので、ここからは答えられない。そのターミナルで答える。</div>
      ) : stop ? (
        <>
          <div className="hint">{stop}。ターミナルの承認の画面で答える。</div>
          {onTerm && <div className="ap-btns"><button className="primary" onClick={onTerm}>ターミナルを開く</button></div>}
        </>
      ) : !p ? (
        <div className="hint">{err ?? "承認の中身を読んでいる…"}</div>
      ) : kind === "ask" ? (
        <AskForm key={p.requestId} questions={Array.isArray(p.input?.questions) ? p.input.questions : []} busy={busy} answer={answer} pty={pty} />
      ) : kind === "plan" ? (
        <PlanForm key={p.requestId} plan={String(p.input?.plan || planHint || p.screenPlan || "")} busy={busy} answer={answer} rows={pty ? p.options! : null} />
      ) : (
        <ToolForm key={p.requestId} p={p} busy={busy} answer={answer} mate={mate} />
      )}
      {canAnswer && (pending?.length ?? 0) > 1 && <div className="hint">ほかに{pending!.length - 1}件の承認が待っている。1件ずつ答える。</div>}
    </div>
  );
}

/** 道具の承認。「常に許可」は ccn が渡した提案（suggestions）のうち、返してよいものだけを出す。拒否には理由を付けられる */
function ToolForm({ p, busy, answer, mate }: { p: PendingReq; busy: "allow" | "deny" | null; answer: Answer; mate: string | null }) {
  const [reason, setReason] = useState("");
  const always = alwaysOptions(p.suggestions);
  // PTY: 画面の行をそのままボタンにする（行は道具と設定で変わる）。断るのは No の行で、理由があれば作業を止めずに伝える。
  // チームメイトの承認は、理由なしで断っても道具の結果が「別のやり方を試す」になり、作業は止まらない（2026-11-26、v2.1.332 の実機）
  const rows = Array.isArray(p.options) ? p.options : null;
  const i = p.input;
  const detail = String(i?.command ?? i?.file_path ?? i?.url ?? JSON.stringify(p.input));
  return (
    <>
      <div>
        <div className="ap-tool">{p.toolName}</div>
        {detail && <ScrollEdgeGradient className="ap-detail"><span>{linkify(detail)}</span></ScrollEdgeGradient>}
        {p.hookNote && <div className="hint ap-hook">{p.hookNote}</div>}
      </div>
      {rows ? (
        <div className="ap-btns">
          {rows.filter((r) => !isDenyRow(r.label)).map((r) => (
            <button key={r.n} className={r.label === "Yes" ? "ap-allow" : "ap-always"} disabled={!!busy} title={r.label}
              onClick={() => answer("allow", { act: { type: "option", n: r.n, label: r.label } })}>{busy === "allow" && r.label === "Yes" ? "送っている…" : toolLabel(r.label)}</button>
          ))}
          <button className="ap-deny" disabled={!!busy || !rows.some((r) => isDenyRow(r.label))} title={mate
              ? `拒否する。下の欄に理由を書くと、${mate} に伝える。空でも ${mate} の作業は止まらず、別のやり方を探す`
              : "拒否する。下の欄に理由を書くと、作業を止めずに Claude に伝える。空なら作業を止める"}
            onClick={() => answer("deny", { act: { type: "deny", reason } })}>{busy === "deny" ? "送っている…" : "拒否する"}</button>
        </div>
      ) : (
        <div className="ap-btns">
          <button className="ap-allow" disabled={!!busy} onClick={() => answer("allow")}>{busy === "allow" ? "送っている…" : "許可する"}</button>
          {always.map((o) => (
            <button key={o.index} className="ap-always" disabled={!!busy} title={o.title} onClick={() => answer("allow", { suggestion: o.index })}>{o.label}</button>
          ))}
          <button className="ap-deny" disabled={!!busy} title="拒否する。下の欄に書いた理由を Claude に伝える" onClick={() => answer("deny", { message: reason })}>{busy === "deny" ? "送っている…" : "拒否する"}</button>
        </div>
      )}
      <input className="ap-reason" placeholder="拒否の理由（任意。Claude に伝わる）" value={reason} disabled={!!busy} onChange={(e) => setReason(e.target.value)} />
    </>
  );
}

/** AskUserQuestion の質問。選択肢を押して選び、「答える」で全部の質問の答えをまとめて送る。選択肢に無い答えは「その他」に書く */
function AskForm({ questions, busy, answer, pty }: { questions: Question[]; busy: "allow" | "deny" | null; answer: Answer; pty: boolean }) {
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(emptyPick));
  // 2問以上のときは1問ずつ出す（#313）。step は今出している質問の番号。答えは全問そろってから、今までと同じ形で一度に送る
  const [step, setStep] = useState(0);
  const set = (qi: number, f: (p: Pick) => Pick) => setPicks((ps) => ps.map((p, i) => (i === qi ? f(p) : p)));
  const texts = questions.map((q, i) => answerText(q, picks[i] ?? emptyPick()));
  const ready = questions.length > 0 && texts.every((t) => !!t);
  if (!questions.length) return <div className="hint">質問の中身が読めない。ターミナルで答える。</div>;
  const many = questions.length > 1;
  const last = step === questions.length - 1;
  const q = questions[step];
  const pk = picks[step] ?? emptyPick();
  const send = () => answer("allow", pty
    ? { act: { type: "ask", picks: ptyPicks(questions, picks) } }
    : { answers: Object.fromEntries(questions.map((q, i) => [q.question, texts[i]])) });
  return (
    <>
      {many && (
        <div className="ask-steps" role="tablist" aria-label="質問">
          {questions.map((x, i) => (
            <button key={i} role="tab" aria-selected={i === step} className={`ask-step${i === step ? " on" : ""}${texts[i] ? " done" : ""}`} disabled={!!busy}
              title={texts[i] ? `答え: ${texts[i]}` : "まだ答えていない"} onClick={() => setStep(i)}>
              {texts[i] ? <Check size={ICON.sm} strokeWidth={STROKE} aria-hidden /> : <span className="ask-step-n">{i + 1}</span>}
              <span className="ask-step-label">{x.header || `質問${i + 1}`}</span>
            </button>
          ))}
          <span className="ask-step-count">{step + 1} / {questions.length}</span>
        </div>
      )}
      <div className="ask-q" key={step}>
        <div className="ask-head">{!many && q.header && <span className="ask-chip">{q.header}</span>}<span className="ask-text">{q.question}</span>{q.multiSelect && <span className="hint">（いくつでも選べる）</span>}</div>
        <div className="ask-opts" role={q.multiSelect ? "group" : "radiogroup"}>
          {(q.options ?? []).map((o) => {
            const on = pk.picked.includes(o.label);
            return (
              <button key={o.label} className={`ask-opt${on ? " on" : ""}`} role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={!!busy}
                onClick={() => {
                  set(step, (p) => ({ ...p, picked: q.multiSelect ? (on ? p.picked.filter((x) => x !== o.label) : [...p.picked, o.label]) : [o.label], other: q.multiSelect ? p.other : "" }));
                  // 1つだけ選ぶ質問は、選んだら次の質問へ進む（端末の AskUserQuestion と同じ）。最後の質問では進まず、答えるボタンで送る
                  if (!q.multiSelect && !last) setStep(step + 1);
                }}>
                <span className="ask-label">{o.label}</span>
                {o.description && <span className="ask-desc">{o.description}</span>}
              </button>
            );
          })}
        </div>
        <input className="ask-other" placeholder="その他（選択肢に無い答えを書く）" value={pk.other} disabled={!!busy}
          onChange={(e) => { const v = e.target.value; set(step, (p) => ({ picked: q.multiSelect || !v ? p.picked : [], other: v })); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && texts[step] && !last) setStep(step + 1); }} />
      </div>
      <div className="ap-btns">
        {many && step > 0 && <button className="ap-always" disabled={!!busy} onClick={() => setStep(step - 1)}>戻る</button>}
        {!last ? (
          <button className="ap-allow" disabled={!texts[step] || !!busy} title={texts[step] ? "次の質問へ" : "この質問に答えると進める"} onClick={() => setStep(step + 1)}>次へ</button>
        ) : (
          <button className="ap-allow" disabled={!ready || !!busy} title={ready ? "選んだ答えを送る" : "全部の質問に答えると送れる"} onClick={send}>{busy === "allow" ? "送っている…" : "答える"}</button>
        )}
        <button className="ap-deny" disabled={!!busy} title="質問に答えずに断る（ターミナルの Esc と同じ）" onClick={() => answer("deny", { act: { type: "deny" } })}>{busy === "deny" ? "送っている…" : "答えずに断る"}</button>
      </div>
    </>
  );
}

/** ExitPlanMode の計画。承認するか、直してほしいことを書いて計画を続けさせる */
function PlanForm({ plan, busy, answer, rows }: { plan: string; busy: "allow" | "deny" | null; answer: Answer; rows: ScreenRow[] | null }) {
  const [note, setNote] = useState("");
  // PTY: 承認の行（auto モードで進める、編集は毎回聞く など）は画面のものをボタンにする。続けて計画するには直してほしいことが要る
  if (rows) {
    const revise = rows.find((r) => isReviseRow(r.label));
    // 目立たせるのは、権限モードを替えない承認（編集は毎回聞く）。無ければ最初の行
    const primary = (rows.find((r) => r.label.startsWith("Yes, manually")) ?? rows[0])?.n;
    return (
      <>
        {plan ? <ScrollEdgeGradient className="ap-plan"><Markdown text={plan} /></ScrollEdgeGradient> : <div className="hint">計画の本文が読めない。ターミナルの承認の画面で読める。</div>}
        <textarea className="ap-note" rows={2} placeholder="直してほしいこと（「続けて計画する」で送る）" value={note} disabled={!!busy} onChange={(e) => setNote(e.target.value)} />
        <div className="ap-btns">
          {rows.filter((r) => !isReviseRow(r.label)).map((r) => (
            <button key={r.n} className={r.n === primary ? "ap-allow" : "ap-always"} disabled={!!busy || !plan} title={plan ? r.label : "計画の本文が読めるまで押せない"}
              onClick={() => answer("allow", { act: { type: "option", n: r.n, label: r.label } })}>{planLabel(r.label)}</button>
          ))}
          <button className="ap-deny" disabled={!!busy || !revise || !note.trim()} title={note.trim() ? "承認せず、上に書いたことを伝えて計画を続けさせる" : "直してほしいことを書くと押せる"}
            onClick={() => answer("deny", { act: { type: "revise", note } })}>{busy === "deny" ? "送っている…" : "続けて計画する"}</button>
        </div>
      </>
    );
  }
  return (
    <>
      {plan ? <ScrollEdgeGradient className="ap-plan"><Markdown text={plan} /></ScrollEdgeGradient> : <div className="hint">計画の本文を読んでいる…（読めるまで承認は押せない。ターミナルでも答えられる）</div>}
      <textarea className="ap-note" rows={2} placeholder="直してほしいこと（「続けて計画する」で送る。空でもよい）" value={note} disabled={!!busy} onChange={(e) => setNote(e.target.value)} />
      <div className="ap-btns">
        <button className="ap-allow" disabled={!!busy || !plan} title={plan ? "計画を承認して、作業に進ませる" : "計画の本文が読めるまで押せない"} onClick={() => answer("allow")}>{busy === "allow" ? "送っている…" : "計画を承認する"}</button>
        <button className="ap-deny" disabled={!!busy} title="承認せず、上に書いたことを伝えて計画を続けさせる" onClick={() => answer("deny", { message: note })}>{busy === "deny" ? "送っている…" : "続けて計画する"}</button>
      </div>
    </>
  );
}
