import { Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import { perfEnd, perfMark, perfWaitingPrompt } from "../term/perf";
import { TerminalView } from "../term/lazyTerminal";
import { ScrollEdgeGradient } from "../ScrollEdgeGradient";
import { Composer } from "../composer/Composer";
import { SessionControls, useNodeSupport } from "../session/SessionControls";
import { Approval } from "../approval/Approval";
import { openPlan } from "../approval/answers";
import { Avatar, roleOf } from "../kid/Avatar";
import { type Agent, accountText, choicesOf, moodOf, statusClass, statusLabel, targetLabel, taskOf } from "../model";
import { linkify } from "../Markdown";
import { withNotes, withQueued, type PendingItem } from "../conv";
import { Bubble, collapseTools, withResults, type Shown } from "../chat/Bubble";
import { LiveLine } from "../chat/LiveLine";
import { TownCtx } from "../contexts";
import { ICON, STROKE } from "../icons";
import { CardActions } from "../card/CardActions";
import { StateTab } from "./StateTab";
import { useConversation } from "./useConversation";
import { usePanelSend } from "./usePanelSend";
import { useBoot } from "./useBoot";
import { isSlashCommand } from "../composer/edit";
import { call as invoke } from "../bridge";
import { canAnswerPermission, hasTerminal } from "../abilities";

const NO_NOTES: PendingItem[] = [];

export function Panel({ agent, lineage, termReq, chatReq, composeReq, sendHook, onSent, onSent2, onError, needs, onSelect, mobile, onBack, onClose }: {
  /** スマホ専用の画面（src/mobile）。見出しを戻るつきの1行にし、細かいボタンは出さない */
  mobile?: boolean; onBack?: () => void;
  /** 見出しの × で選ぶのをやめる（#89）。右パネルが閉じる */
  onClose?: () => void;
  agent: Agent | null; lineage: Agent[]; termReq: number; chatReq: number; composeReq: number;
  /** カードのボタン（#63）が、選んでいるセッションへの送信をこのパネルに任せる口。選んでいないセッションなら null を返す */
  sendHook: React.MutableRefObject<((id: string, text: string) => Promise<boolean> | null) | null>;
  onSent: (a: Agent) => void; onSent2: (m: string) => void; onError: (m: string) => void; needs: Agent[]; onSelect: (a: Agent) => void;
}) {
  const hasTerm = hasTerminal(agent);
  const town = useContext(TownCtx);
  const [tab, setTab] = useState<"term" | "talk" | "state">("talk");
  // セッションを選んだときと新しい世帯を作ったときはチャットを出す。右クリックなどの termReq だけ端末を開く
  useEffect(() => { setTab("talk"); }, [agent?.id, hasTerm]);
  useEffect(() => { if (termReq && hasTerm) setTab("term"); }, [termReq]);
  useEffect(() => { if (chatReq) setTab("talk"); }, [chatReq]);
  // composeReq が来たら、チャットの入力欄にフォーカスする。前に選んでいた子が端末を開いていると、
  // 最初の描画ではまだ tab が "term" で入力欄が無いので、入力欄が出てからフォーカスする
  // 入力欄は Composer（#53）の中にあり、子を替えるたびに作り直されるので、枠から textarea を探す
  const composerBox = useRef<HTMLDivElement>(null);
  const wantCompose = useRef(false);
  useEffect(() => { if (composeReq) { wantCompose.current = true; setTab("talk"); } }, [composeReq]);
  useEffect(() => {
    const el = composerBox.current?.querySelector<HTMLTextAreaElement>("textarea");
    if (!wantCompose.current || !el || el.disabled) return;
    wantCompose.current = false;
    el.focus();
    if (agent) { perfMark("composer", agent.id); if (perfWaitingPrompt(agent.id)) perfEnd(); }
  });
  // 下書きは宛先ごとに持つ。宛先を切り替えたとき、打ちかけの文が次の宛先に送られないようにする
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const text = agent ? drafts[agent.id] ?? "" : "";
  const setText = (v: string) => { if (agent) setDrafts((d) => ({ ...d, [agent.id]: v })); };
  // モデルか権限モードを替えている間（#97）。pty は claude を起動し直すので、その間は送らない
  const [switching, setSwitching] = useState(false);
  useEffect(() => { setSwitching(false); }, [agent?.id]);
  // ノードにモデルの切り替えとコマンドの口があるか（#97）。ブラウザ版（PWA）の ccn の行だけが確かめる
  const [support, markNoSupport] = useNodeSupport(agent);
  // チャットからコマンドを実行した印（#97）。画面だけで出す。セッションごとに持ち、ほかのセッションを見て戻っても残す（アプリを閉じたら消える）
  const notesBy = useRef(new Map<string, PendingItem[]>());
  const [, bumpNotes] = useState(0);
  const notes = (agent && notesBy.current.get(agent.id)) || NO_NOTES;
  const addNote = (sid: string, n: PendingItem) => { notesBy.current.set(sid, [...(notesBy.current.get(sid) ?? []), n].slice(-20)); bumpNotes((x) => x + 1); };
  // カードのボタンからの送信（#63）。描くたびに今の send に差し替える。パネルが消えたら口を外す
  const quickSend = useRef<((id: string, text: string) => Promise<boolean> | null) | null>(null);
  useEffect(() => {
    sendHook.current = (id, text) => quickSend.current?.(id, text) ?? null;
    return () => { sendHook.current = null; };
  }, [sendHook]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const id = agent?.id;
  // 作業中でチャットを開いているあいだは、会話を CONV_POLL_LIVE_MS ごとに取る。取り直しの間隔は回るたびにこの値を読む（#59）。
  // 作業中になったときも終わったときも、すぐ取り直す（終わった直後の答えを待たせない）
  const working = !!agent && moodOf(agent) === "working";
  const isFast = working && tab === "talk";

  // チャットを開いたとき（セッションを選んだ、タブを切り替えた）は、必ず一番下から始める。
  // 以前は stick を読み込みの effect でしか戻さず、タブの切り替えでは前の値が残り、容れ物も作り直されるのに items が変わらないので下へ送られなかった
  useLayoutEffect(() => { stick.current = true; }, [id, tab, chatReq]);
  const { items, live, pending, setPending, convErr, convKick } = useConversation(id, isFast, working, stick, agent?.kind !== "node");
  // claude の起動の様子（アプリが立てた端末だけ）。起動前に送った文は Rust が預かり、起動したら送る（composer.rs の send_or_queue）。
  // 送れたら「届けた」の仮の吹き出しに替え、送れなかったら理由を出して入力欄に戻す
  const boot = useBoot(agent,
    // / と ! の文は会話に user として出ないことがあるので、すぐ送ったときと同じく仮の吹き出しを足さない（usePanelSend の plain）
    (t) => { if (!(t.startsWith("!") || isSlashCommand(t))) setPending((p) => [...p, { role: "user", text: t, pending: true, at: new Date().toISOString(), after: items[items.length - 1]?.n ?? -1 }]); convKick.current(); },
    (t, e) => { onError(`${agent?.name ?? ""} に届かなかった: ${e}`); if (!text.trim()) setText(t); });
  const { busy, send } = usePanelSend({ agent, hasTerm, items, switching, support, markNoSupport, addNote, setTab, setPending, setText, stick, convKick, onSent, onError, onQueued: boot.kick });
  // 預かった文を取り消して、入力欄に戻す（打ちかけがあれば、その前に置く）
  const cancelQueued = async () => {
    if (!agent) return;
    const back = await invoke<string[] | null>("cancel_queued", { sessionId: agent.id }).catch(() => null);
    boot.kick();
    if (back?.length) setText([...back, text].filter((x) => x.trim()).join("\n"));
  };

  // 吹き出しの並びと選択肢は、会話が変わったときだけ作り直す（App の1秒の tick で描き直されても、Bubble の memo が効く）
  // -p の子は返事が出ると、送った文の仮の印が外れる（#55、answerPending）。外れた分は after の位置に置く（withNotes）
  // 作業中に打たれた文（順番待ち）は、送った文の後ろ、今の動きの行の前に出す。CLI の端末と同じ並び
  const running = !!agent && (moodOf(agent) === "working" || moodOf(agent) === "approval");
  const liveQueued = live?.queued;
  const shown = useMemo(() => {
    const { waiting, queued } = withQueued(pending.filter((x) => x.pending), liveQueued, running);
    const placed = pending.every((x) => x.pending) ? notes : [...notes, ...pending.filter((x) => !x.pending)].sort((a, b) => a.after - b.after);
    const waitBoot: Shown[] = boot.queued.map((q) => ({ role: "user", text: q.text, pending: true, waitBoot: true, at: q.at }));
    return [...collapseTools(withResults(withNotes([...items, ...waiting], placed))), ...queued, ...waitBoot];
  }, [items, pending, notes, liveQueued, running, boot.queued]);
  // 読めなかった印が出ているか。出ている間は中身の上に余白を足す（下の has-note）
  const hasNote = shown.length > 0 && !!convErr;
  // 会話の最後のまだ答えていない計画（ExitPlanMode の本文）。承認の hook の入力が空のとき、承認の欄に出す（#83）
  const lastPlan = useMemo(() => openPlan(items), [items]);
  const lastChoices = useMemo(() => {
    const lastAssistant = [...items].reverse().find((x) => x.role === "assistant");
    const lastIsAssistant = items.filter((x) => x.role === "user" || x.role === "assistant").slice(-1)[0]?.role === "assistant";
    return lastAssistant && lastIsAssistant ? choicesOf(lastAssistant.text) : [];
  }, [items]);

  // スマホでキーボードが出入りして会話の欄の高さが変わったとき、一番下にいたら下へ送り直す
  useEffect(() => {
    const vv = window.visualViewport;
    if (!mobile || !vv) return;
    const on = () => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; };
    vv.addEventListener("resize", on);
    return () => vv.removeEventListener("resize", on);
  }, [mobile]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
    // 吹き出しの高さが描画のあとに決まる分（Markdown など）を拾う
    const raf = requestAnimationFrame(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(raf);
    // 印が出て余白が付くと中身が伸びるので、一番下にいたら送り直す（開いたまま切れたとき、items は変わらない）
  }, [items, pending, id, tab, chatReq, hasNote, live, working, boot.queued.length]);

  if (!agent) {
    quickSend.current = null;
    return (
      <aside className="panel empty-panel">
        <div className="ep">
          <p className="ep-title">子供をクリックすると、ここで話せる</p>
          {needs[0] && (
            <button className="primary" onClick={() => onSelect(needs[0])}>{needs[0].name}をひらく</button>
          )}
          <p className="hint">右クリックで、その子のターミナルを開く</p>
        </div>
      </aside>
    );
  }

  const mood = moodOf(agent);
  // 見出しの札は、起動の様子を Rust から読み直した値で出す（町の一覧は2〜8秒おきなので遅れる）
  const view = { booting: boot.booting };
  // 承認の欄から答えられるか。答えられるのはブラウザ版（PWA）の ccn の行だけ。アプリが立てたセッションは、端末の承認の画面で答える
  const canAnswer = canAnswerPermission(agent);
  // 同じ名前の人が町にいたら、送信先に ID の先頭8字を添える（#36）。見出しは幅が足りず ID が切れるので名前だけにする
  const target = targetLabel(agent, town);
  quickSend.current = (to, body) => (to === agent.id ? send(body, true) : null);

  const choices = mood !== "working" ? lastChoices : [];

  return (
    <aside className={`panel pm-${mood}`}>
      {mobile ? (
        <div className="m-head">
          <button className="m-back" onClick={onBack} aria-label="一覧へ戻る"><ChevronLeft size={28} strokeWidth={2} /></button>
          <div className="p-avatar"><Avatar pick={agent.avatar} seed={agent.id} mood={mood} role={roleOf(lineage.length - 1)} size={40} /></div>
          <div className="p-id">
            <div className="p-name"><span className="pn">{agent.name}</span><span className={statusClass(view, mood)}><i />{statusLabel(view, mood)}</span></div>
            <div className="p-task">{linkify(taskOf(agent, mood))}</div>
          </div>
        </div>
      ) : (
      <div className="p-head">
        <div className="p-avatar"><Avatar pick={agent.avatar} seed={agent.id} mood={mood} role={roleOf(lineage.length - 1)} size={64} /></div>
        <div className="p-id">
          <div className="p-name">
            <span className="pn">{agent.name}</span><span className={statusClass(view, mood)}><i />{statusLabel(view, mood)}</span>
            {agent.account && <span className="acct" title={`アカウント: ${accountText(agent)}。このセッションの claude が動いているアカウント`}>{agent.account}</span>}
          </div>
          <div className="p-line">{lineage.map((a, i) => (
            <span key={a.id}>{i > 0 && <ChevronRight className="p-line-sep" size={ICON.sm} strokeWidth={STROKE} aria-hidden />}<button className="lnk" onClick={() => onSelect(a)}>{a.name}</button></span>
          ))}</div>
          <div className="p-task"><FileText className="p-task-icon" size={ICON.sm} strokeWidth={STROKE} aria-hidden /><span className="p-task-text" title={taskOf(agent, mood)}>{linkify(taskOf(agent, mood))}</span></div>
        </div>
        <div className="p-actions">
          {onClose && <button className="p-close" onClick={onClose} aria-label="チャットを閉じる" title="チャットを閉じる"><X size={16} strokeWidth={1.8} /></button>}
          {/* カードの右下と同じボタン（CARD_ACTIONS）。カードに乗せなくても押せるよう、ここにも並べる */}
          <CardActions agent={agent} place="head" />
        </div>
      </div>
      )}
      <div className="tabs">
        <button className={tab === "talk" ? "on" : ""} onClick={() => setTab("talk")}>チャット</button>
        <button className={tab === "state" ? "on" : ""} onClick={() => setTab("state")}>状態</button>
        {hasTerm && <button className={tab === "term" ? "on" : ""} onClick={() => setTab("term")}>ターミナル</button>}
      </div>
      {mood === "approval" && tab === "state" && (
        <div className="ap-float">{canAnswer ? <Approval agent={agent} planHint={lastPlan} onDone={(m) => onSent2(m)} onError={onError} onTerm={hasTerm ? () => setTab("term") : undefined} /> : <AnswerInTerminal agent={agent} onTerm={() => setTab("term")} />}</div>
      )}
      {mood === "approval" && tab === "term" && canAnswer && (
        <div className="ap-float"><Approval agent={agent} planHint={lastPlan} onDone={(m) => onSent2(m)} onError={onError} onTerm={hasTerm ? () => setTab("term") : undefined} /></div>
      )}

      {tab === "term" ? (
        <Suspense fallback={<div className="term-wrap"><div className="term" /></div>}><TerminalView sessionId={agent.id} onError={onError} /></Suspense>
      ) : tab === "talk" ? (<div className="talk-box">
        {/* 想定外の失敗で、最新の会話を取れていないときの印（起動直後や終わったセッションなど、読めなくて当たり前の場面では出ない。続けて失敗したときだけ）。会話の欄の流れに入れると欄とグラデーションの始まりがずれるので、欄の上端の中央に重ねる（position: absolute）。
            中身の失敗は title に入れる */}
        {convErr && shown.length > 0 && (
          <span className="offline-note" title={convErr}><i /><span>最新を取れていない・最後に読めた履歴</span></span>
        )}
        {/* 印が出ている間は、中身の上に印の高さぶんの余白を足す（上端まで送ったとき、いちばん古い行が印の下に入らない）。外枠とグラデーションの位置は変えない */}
        <ScrollEdgeGradient className={`talk ${hasNote ? "has-note" : ""}`} wrapClassName="seg-fill" ref={scroller}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {convErr && shown.length === 0 && <div className="banner bad small">{convErr}</div>}
          {shown.length === 0 && !convErr && <p className="hint center">まだチャットが無い</p>}
          {shown.map((x, i) => <Bubble key={x.n ?? `p${x.at ?? i}`} item={x} agent={agent} lineageDepth={lineage.length - 1} />)}
          {mood === "working" && live && <LiveLine live={live} turnAt={agent.report?.turn_started_at ?? null} />}
          {mood === "approval" && (canAnswer
            ? <Approval agent={agent} planHint={lastPlan} onDone={(m) => onSent2(m)} onError={onError} onTerm={hasTerm ? () => setTab("term") : undefined} />
            : <AnswerInTerminal agent={agent} onTerm={() => setTab("term")} />)}
          {boot.queued.length > 0 && (
            <div className="boot-wait" role="status">
              <p className="hint">{boot.trustSuspect
                ? "起動が終わらない。信頼の確認の画面で止まっているかもしれない。ターミナルで答えると、上の文を送る。"
                : "claude の起動を待っている。起動したら上の文を送る。"}</p>
              <div className="boot-wait-btns">
                {hasTerm && <button className="choice" onClick={() => setTab("term")}>ターミナルを開く</button>}
                <button className="choice" onClick={() => void cancelQueued()}>送るのをやめる</button>
              </div>
            </div>
          )}
          {choices.length > 0 && (
            <div className="choices">
              {choices.map((c) => <button key={c} className="choice" disabled={busy} onClick={() => send(c)}>{c}</button>)}
            </div>
          )}
        </ScrollEdgeGradient>
      </div>) : (
        <StateTab agent={agent} mood={mood} />
      )}

      {tab !== "term" && <div className="composer" ref={composerBox}>
        <div className="to"><span className="to-name">送信先: {target}</span>
          <SessionControls key={agent.id} agent={agent} support={support} onNoSupport={markNoSupport} onSwitching={setSwitching} onDone={onSent2} onError={onError} />
        </div>
        <Composer key={agent.id} touch={mobile} agent={agent} text={text} setText={setText} busy={busy || switching} running={mood === "working"} booting={boot.booting} support={support} onSubmit={send} onError={onError} />
      </div>}
    </aside>
  );
}

/**
 * 承認待ちで、ここからは答えられないとき（ブラウザ版の ccn の行のほか全部）。承認は端末の承認の画面で答える。
 * アプリが立てたセッションなら、ターミナルのタブを開くボタンを出す。外で起動したセッションは、起動した端末で答える
 */
function AnswerInTerminal({ agent, onTerm }: { agent: Agent; onTerm: () => void }) {
  const mine = hasTerminal(agent);
  return (
    <div className="ap ap-term">
      <p className="hint">{mine ? "承認を待っている。ターミナルの承認の画面で答える。" : "承認を待っている。このセッションは Claude Town の外で起動したので、起動した端末で答える。"}</p>
      {mine && <button className="primary" onClick={onTerm}>ターミナルを開く</button>}
    </div>
  );
}
