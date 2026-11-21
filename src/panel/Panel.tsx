import { Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { call as invoke } from "../bridge";
import { perfEnd, perfMark, perfWaitingPrompt } from "../term/perf";
import { TerminalView } from "../term/lazyTerminal";
import { ScrollEdgeGradient } from "../ScrollEdgeGradient";
import { Composer } from "../composer/Composer";
import { SessionControls, useNodeSupport } from "../session/SessionControls";
import { commandError, routeOf } from "../composer/route";
import { isHttp, noRoute, viaCcn } from "../session/control";
import { Approval } from "../approval/Approval";
import { openPlan } from "../approval/answers";
import { BUILTINS, opensDialog } from "../composer/commands";
import { isSlashCommand } from "../composer/edit";
import { pollBackoff } from "../visible";
import { Avatar, roleOf } from "../kid/Avatar";
import { type Agent, type ConvItem, type Peer, MOOD_LABEL, accountText, choicesOf, moodOf, targetLabel, taskOf } from "../model";
import { linkify } from "../Markdown";
import { mergeConv, sameLive, savedLabel, settlePending, withNotes, type PendingItem, type ConvCache, type ConvDelta, type Live } from "../conv";
import { Bubble, collapseTools, withResults } from "../chat/Bubble";
import { LiveLine } from "../chat/LiveLine";
import { TownCtx } from "../contexts";
import { DocIcon } from "../icons";
import { Teleport } from "../teleport/Teleport";
import { CardActions } from "../card/CardActions";
import { StateTab } from "./StateTab";

const CONV_POLL_MS = 2500;

/** 会話に新しい発言が無い回が続いたときの間隔の上限（#5）。新しい発言が来るか、文を送ったら CONV_POLL_MS に戻す */
const CONV_POLL_MAX_MS = 10000;

/** 相手が作業中のあいだの会話の取り直しの間隔（#59）。延ばさずに、この間隔で取り続ける */
const CONV_POLL_LIVE_MS = 1000;

const NO_NOTES: PendingItem[] = [];

export function Panel({ agent, peer, lineage, descendants, termReq, chatReq, composeReq, peers, sendHook, onSent, onSent2, onError, needs, onSelect, mobile, onBack, onClose }: {
  /** スマホ専用の画面（src/mobile）。見出しを戻るつきの1行にし、転出と細かいボタンは出さない */
  mobile?: boolean; onBack?: () => void;
  /** 見出しの × で選ぶのをやめる（#89）。右パネルが閉じる */
  onClose?: () => void;
  agent: Agent | null; peer: string; lineage: Agent[]; descendants: Agent[]; termReq: number; chatReq: number; composeReq: number; peers: Peer[];
  /** カードのボタン（#63）が、選んでいるセッションへの送信をこのパネルに任せる口。選んでいないセッションなら null を返す */
  sendHook: React.MutableRefObject<((id: string, text: string) => Promise<boolean> | null) | null>;
  onSent: (a: Agent) => void; onSent2: (m: string) => void; onError: (m: string) => void; needs: Agent[]; onSelect: (a: Agent) => void;
}) {
  const hasTerm = !!agent?.capabilities?.terminal;
  const town = useContext(TownCtx);
  const [tab, setTab] = useState<"term" | "talk" | "state">("talk");
  const [sheet, setSheet] = useState<"teleport" | null>(null);
  // セッションを選んだときと新しい世帯を作ったときはチャットを出す。右クリックなどの termReq だけ端末を開く
  useEffect(() => { setTab("talk"); setSheet(null); }, [agent?.id, hasTerm]);
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
  const [items, setItems] = useState<ConvItem[]>([]);
  // 今の動き（#59）。中身が変わったときだけ入れ替え、末尾の行のほかは描き直さない
  const [live, setLive] = useState<Live | null>(null);
  // 送ったばかりの文。after は送り始めたときに持っていた最後の番号で、これより後に届いた発言とだけ比べる
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [convErr, setConvErr] = useState<string | null>(null);
  // 保存してあった会話を出しているときの、保存した時刻。ccn から読めたら null に戻す
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  // 下書きは宛先ごとに持つ。宛先を切り替えたとき、打ちかけの文が次の宛先に送られないようにする
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const text = agent ? drafts[agent.id] ?? "" : "";
  const setText = (v: string) => { if (agent) setDrafts((d) => ({ ...d, [agent.id]: v })); };
  const [busy, setBusy] = useState(false);
  // モデルか権限モードを替えている間（#97）。pty は claude を起動し直すので、その間は送らない
  const [switching, setSwitching] = useState(false);
  useEffect(() => { setSwitching(false); }, [agent?.id]);
  // ノードにモデルの切り替えとコマンドの口があるか（#97）
  const [support, markNoSupport] = useNodeSupport(agent, peer);
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
  // 会話をすぐ取り直させる口（文を送った直後に使う）
  const convKick = useRef<() => void>(() => {});
  const id = agent?.id;
  // 作業中でチャットを開いているあいだは、会話を CONV_POLL_LIVE_MS ごとに取る。取り直しの間隔は回るたびにこの値を読む（#59）。
  // 作業中になったときも終わったときも、すぐ取り直す（終わった直後の答えを待たせない）
  const working = !!agent && moodOf(agent) === "working";
  const isFast = working && tab === "talk";
  const fast = useRef(false);
  fast.current = isFast;
  useEffect(() => { convKick.current(); }, [working, isFast]);

  // チャットを開いたとき（セッションを選んだ、タブを切り替えた）は、必ず一番下から始める。
  // 以前は stick を読み込みの effect でしか戻さず、タブの切り替えでは前の値が残り、容れ物も作り直されるのに items が変わらないので下へ送られなかった
  useLayoutEffect(() => { stick.current = true; }, [id, tab, chatReq]);
  useEffect(() => {
    setItems([]); setPending([]); setLive(null); setConvErr(null); setCachedAt(null); stick.current = true;
    if (!id) return;
    let alive = true;
    // ccn から一度でも読めたか。読めたあとに保存分が届いても出さない
    let live = false;
    // 画面が持っている数。Rust は、これより後の発言だけを返す（#10）。増えていなければ items を変えず、描き直さない。
    // 保存分を出している間は null のままにし、読めた最初の回は全部（reset）で差し替える（保存分の番号 n と混ぜない）
    let since: number | null = null;
    // 開いた直後に保存分を出す。ネットが切れていると ccn の時間切れまで数秒かかるので、失敗を待たない
    invoke<ConvCache | null>("conversation_cache", { sessionId: id, peer: peer || null }).then((c) => {
      if (!alive || live || !c?.items.length) return;
      setItems(c.items);
      setCachedAt(c.savedAt);
    }).catch(() => {});
    const load = async () => {
      try {
        const d = await invoke<ConvDelta>("conversation", { sessionId: id, peer: peer || null, since });
        if (!alive) return false;
        live = true;
        since = Math.max(since ?? 0, d.total);
        if (d.reset) since = d.total;
        setConvErr(null);
        setCachedAt(null);
        if (d.reset || d.items.length) setItems((prev) => mergeConv(prev, d));
        const nextLive = d.live ?? null;
        setLive((prev) => (sameLive(prev, nextLive) ? prev : nextLive));
        return d.reset || d.items.length > 0;
      } catch (e) {
        if (alive) setConvErr(String(e));
        return false;
      }
    };
    const p = pollBackoff(load, () => (fast.current ? CONV_POLL_LIVE_MS : CONV_POLL_MS), () => (fast.current ? CONV_POLL_LIVE_MS : CONV_POLL_MAX_MS));
    convKick.current = p.kick;
    return () => { alive = false; p.stop(); convKick.current = () => {}; };
  }, [id, peer]);

  // 送ったばかりの文は、送り始めたあとに会話に出たら仮の項目を消す（前の同じ文、「はい」や選択肢では消さない）。
  // 後に送った文が出たら、前に送った仮の項目も消す（#69、送った順と並びを入れ替えない）
  useEffect(() => { setPending((p) => settlePending(items, p)); }, [items, pending.length]);

  // 吹き出しの並びと選択肢は、会話が変わったときだけ作り直す（App の1秒の tick で描き直されても、Bubble の memo が効く）
  const shown = useMemo(() => collapseTools(withResults(withNotes([...items, ...pending], notes))), [items, pending, notes]);
  // 保存した履歴の印が出ているか。出ている間は中身の上に余白を足す（下の has-note）
  const hasNote = shown.length > 0 && !!(convErr || cachedAt);
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
  }, [items, pending, id, tab, chatReq, hasNote, live, working]);

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
  // 同じ名前の人が町にいたら、送信先に ID の先頭8字を添える（#36）。見出しは幅が足りず ID が切れるので名前だけにする
  const target = targetLabel(agent, town);
  /** quick はカードのボタンから送るとき。入力欄の下書きは消さない */
  const send = async (body: string, quick = false) => {
    if (!body.trim() || busy || switching) return false;
    // / で始まる組み込みのコマンドの振り分け（#97、src/composer/route.ts）。使えないものは送らずに理由を出す
    // ccn を通さないセッション（#96）は端末のセッションと同じく振り分けない（送る口のほうが断る）
    const route = routeOf(body, viaCcn(agent) ? agent.kind : "terminal", support);
    if (route?.kind === "blocked") { onError(route.reason); return false; }
    setBusy(true);
    const after = items[items.length - 1]?.n ?? -1;
    // 先頭が / か ! の文は、端末のあるセッションなら入力欄へ直接貼る。ccn の send_message は from の1行を前に付けるので、
    // CLI のコマンドやシェルモードとして動かない（docs/research/cli-input.md）
    const direct = hasTerm && (body.startsWith("!") || isSlashCommand(body));
    try {
      if (route?.kind === "command") {
        const r = await invoke<unknown>("run_command", { sessionId: agent.id, text: route.text, peer: peer || null });
        if (!isHttp(r)) throw new Error("ccn の応答が読めなかった");
        const err = commandError(r);
        if (err) {
          if (noRoute(r)) markNoSupport();
          throw new Error(err);
        }
        addNote(agent.id, { role: "event", kind: "command", text: `/${route.name} を実行した${route.note ? `。${route.note}` : ""}`, at: new Date().toISOString(), after });
      } else if (direct) {
        await invoke("send_direct", { sessionId: agent.id, text: body, peer: peer || null });
        // 画面を開くコマンド（/model など）は、ターミナルで操作してもらう
        if (opensDialog(body, BUILTINS)) setTab("term");
      } else {
        await invoke("send_message", { sessionId: agent.id, text: body, peer: peer || null });
        setPending((p) => [...p, { role: "user", text: body, pending: true, at: new Date().toISOString(), after }]);
      }
      if (!quick) setText("");
      stick.current = true;
      // 返事が来るまでは間隔を縮めて取る（#5）
      convKick.current();
      onSent(agent);
      return true;
    } catch (e) {
      onError(`${agent.name} に届かなかった: ${e}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  quickSend.current = (to, body) => (to === agent.id ? send(body, true) : null);

  const choices = mood !== "working" ? lastChoices : [];

  return (
    <aside className={`panel pm-${mood}`}>
      {mobile ? (
        <div className="m-head">
          <button className="m-back" onClick={onBack} aria-label="一覧へ戻る"><svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2 2 10l8 8" /></svg></button>
          <div className="p-avatar"><Avatar pick={agent.avatar} seed={agent.id} mood={mood} role={roleOf(lineage.length - 1)} size={40} /></div>
          <div className="p-id">
            <div className="p-name"><span className="pn">{agent.name}</span><span className={`st st-${mood}`}><i />{MOOD_LABEL[mood]}</span></div>
            <div className="p-task">{linkify(taskOf(agent, mood))}</div>
          </div>
        </div>
      ) : (
      <div className="p-head">
        <div className="p-avatar"><Avatar pick={agent.avatar} seed={agent.id} mood={mood} role={roleOf(lineage.length - 1)} size={64} /></div>
        <div className="p-id">
          <div className="p-name">
            <span className="pn">{agent.name}</span><span className={`st st-${mood}`}><i />{MOOD_LABEL[mood]}</span>
            {agent.account && <span className="acct" title={`アカウント: ${accountText(agent)}。このセッションの claude が動いているアカウント`}>{agent.account}</span>}
          </div>
          <div className="p-line">{lineage.map((a, i) => (
            <span key={a.id}>{i > 0 && <b>›</b>}<button className="lnk" onClick={() => onSelect(a)}>{a.name}</button></span>
          ))}</div>
          <div className="p-task"><DocIcon />{linkify(taskOf(agent, mood))}</div>
        </div>
        <div className="p-actions">
          {onClose && <button className="p-close" onClick={onClose} aria-label="チャットを閉じる" title="チャットを閉じる"><X size={16} strokeWidth={1.8} /></button>}
          <button className="pane-btn" disabled={!!peer} title={peer ? "転出できない: 別の機械のセッションの転出は、まだ出していない" : "転出: このセッションを別の機械（ccn のノード）へ移すか、複製する"} onClick={() => setSheet(sheet === "teleport" ? null : "teleport")}>転出</button>
          {/* カードの右下と同じボタン（CARD_ACTIONS）。カードに乗せなくても押せるよう、ここにも並べる */}
          {!agent.ghost && <CardActions agent={agent} place="head" />}
        </div>
      </div>
      )}
      {!mobile && sheet === "teleport" && <Teleport agent={agent} descendants={descendants} peers={peers} onDone={(m) => { setSheet(null); onSent2(m); }} onError={onError} />}
      <div className="tabs">
        <button className={tab === "talk" ? "on" : ""} onClick={() => setTab("talk")}>チャット</button>
        <button className={tab === "state" ? "on" : ""} onClick={() => setTab("state")}>状態</button>
        {hasTerm && <button className={tab === "term" ? "on" : ""} onClick={() => setTab("term")}>ターミナル</button>}
      </div>
      {mood === "approval" && (tab === "term" || tab === "state") && (
        <div className="ap-float"><Approval agent={agent} peer={peer} planHint={lastPlan} onDone={(m) => onSent2(m)} onError={onError} /></div>
      )}

      {tab === "term" ? (
        <Suspense fallback={<div className="term-wrap"><div className="term" /></div>}><TerminalView sessionId={agent.id} peer={peer || null} onError={onError} /></Suspense>
      ) : tab === "talk" ? (<div className="talk-box">
        {/* 保存した履歴を出しているときの印。会話の欄の流れに入れると欄とグラデーションの始まりがずれ、タブの行は端末のタブがあると幅が足りない。
            そのため、欄の上端の中央に重ねる（position: absolute）。中身の失敗は title に入れる */}
        {convErr && shown.length > 0 ? (
          <span className="offline-note" title={convErr}><i /><span>つながらない・{cachedAt ? `${savedLabel(cachedAt)} 時点の履歴` : "最後に読めた履歴"}</span></span>
        ) : !convErr && cachedAt ? (
          <span className="offline-note wait" title="最新を読み込んでいる"><i /><span>{savedLabel(cachedAt)} 時点の履歴・更新中</span></span>
        ) : null}
        {/* 印が出ている間は、中身の上に印の高さぶんの余白を足す（上端まで送ったとき、いちばん古い行が印の下に入らない）。外枠とグラデーションの位置は変えない */}
        <ScrollEdgeGradient className={`talk ${hasNote ? "has-note" : ""}`} wrapClassName="seg-fill" ref={scroller}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {convErr && shown.length === 0 && <div className="banner bad small">{convErr}</div>}
          {shown.length === 0 && !convErr && <p className="hint center">まだチャットが無い</p>}
          {shown.map((x, i) => <Bubble key={x.n ?? `p${x.at ?? i}`} item={x} agent={agent} lineageDepth={lineage.length - 1} />)}
          {mood === "working" && live && <LiveLine live={live} turnAt={agent.report?.turn_started_at ?? null} />}
          {mood === "approval" && (
            <Approval agent={agent} peer={peer} planHint={lastPlan} onDone={(m) => onSent2(m)} onError={onError} />
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
          {!agent.ghost && <SessionControls key={agent.id} agent={agent} peer={peer} support={support} onNoSupport={markNoSupport} onSwitching={setSwitching} onDone={onSent2} onError={onError} />}
        </div>
        <Composer key={agent.id} touch={mobile} agent={agent} peer={peer} text={text} setText={setText} busy={busy || switching} running={mood === "working"} support={support} onSubmit={send} onError={onError} />
      </div>}
    </aside>
  );
}
