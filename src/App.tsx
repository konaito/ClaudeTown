import { Suspense, createContext, lazy, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IS_WEB, call as invoke, setFullscreen } from "./bridge";
import { perfEnd, perfMark, perfStart, perfWaitingPrompt } from "./term/perf";
import { useBench } from "./term/bench";
import { collectMail, type Mail } from "./mail";
import { flightsOf, resolve, type Flight } from "./letters";
import { ScrollEdgeGradient } from "./ScrollEdgeGradient";
import { Composer } from "./composer/Composer";
import { SessionControls, supportFor, useNodeSupport } from "./session/SessionControls";
import { useCcnReservations } from "./session/reserve";
import { commandError, routeOf } from "./composer/route";
import { isHttp, noRoute, viaCcn } from "./session/control";
import { Approval } from "./approval/Approval";
import { openPlan } from "./approval/answers";
import { BUILTINS, opensDialog } from "./composer/commands";
import { isSlashCommand } from "./composer/edit";
import { isVisible, onVisibleChange, pollBackoff, pollWhileVisible, shownAt } from "./visible";
import { reuseSnap } from "./snap";
import { kickTown, watchTown } from "./town";
import { Group as SplitGroup, Panel as SplitPanel, Separator, usePanelRef, type Layout } from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen, Settings, Users, X } from "lucide-react";
import { NewHousePane, createHousehold } from "./newHouse/NewHousePane";
import { loadPlace, placeFailure, savePlace } from "./newHouse/placeSetting";
import { SettingsDialog } from "./settings/SettingsDialog";
import "./App.css";
import "./mobile/mobile.css";
import { MobileShell } from "./mobile/MobileShell";
import { useMobileLayout, useVisualViewport } from "./mobile/useMobile";
import { Avatar, hash as hashOf, roleOf, ROLE_LABEL, type Role } from "./kid/Avatar";
import { SkinCtx, saveSkin, savedSkin, type Skin } from "./kid/pokemon";
import {
  type Agent, type ConvItem, type Mood, type Snapshot,
  MOOD_LABEL, NEEDS_YOU, accountText, buildTree, cardNames, choicesOf, houseNameOf, moodOf, nowOf, sinceText, targetLabel, taskOf,
} from "./model";
import { Markdown, linkify } from "./Markdown";
import { chatPerf } from "./chatPerf";
import { elapsedText, liveSummary, mergeConv, msOf, sameLive, settlePending, withNotes, type PendingItem, type ConvDelta, type Live } from "./conv";
import { layoutFamily, type LNode } from "./layout/layout";
import { LAYOUT, boxOf, groupSizeOf } from "./layout/params";
import { packHouseholds } from "./layout/pack";

/** 右パネルの幅（px）。最小と既定。最大はウィンドウ幅の半分（maxSize="50%"） */
const SIDE_MIN = 380;
const SIDE_DEFAULT = 380;
/** 左の新しい世帯のペイン（#89）の幅（px）。既定と最小。最大はウィンドウ幅の 30%。本人が決めていないので仮置き */
const HOUSES_DEFAULT = 300;
const HOUSES_MIN = 200;
/** 町の最小の幅（px）。3枚が 900px（tauri.conf.json の minWidth）の窓に収まるようにする。#89 より前は窓の 50% */
const TOWN_MIN = 240;
/**
 * 前回の境目の位置。次に起動したときも同じにする。#89 で3枚（houses、town、side）にしたので、キーを変えた。
 * 前のキー（claude-town.split、town と side の2枚）は、戻したときの古い安定版が読むので書き換えない
 */
const SPLIT_KEY = "claude-town.split3";
function savedSplit(): Layout | undefined {
  try { const v = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? "null"); return v && typeof v === "object" ? v : undefined; } catch { return undefined; }
}
/** チャット（side）が閉じている間の並び l に、前に保存したチャットの幅を戻す。町（town）の幅で釣り合わせる。前の値が無ければ l のまま */
function keepSide(l: Layout, prev: Layout | undefined): Layout {
  const side = prev?.side ?? 0;
  if (!side || l.houses === undefined) return l;
  return { houses: l.houses, town: Math.max(0, 100 - l.houses - side), side };
}
function saveSplit(l: Layout) { try { localStorage.setItem(SPLIT_KEY, JSON.stringify(l)); } catch { /* 保存できなくても動きは変えない */ } }
/** 閉じる演出の長さ（ms）。CSS の kill-* と合わせる */
const KILL_MS = 1150;
/** 子孫を葉から順に倒すときのずらし（ms） */
const KILL_STAGGER = 140;

/**
 * カードの右下のボタン（#63）。左から並べる順に書く。送る文を足し替えるときはここだけを直す。
 * 右パネルの見出しにも、同じ定義から同じボタンを並べる（CardActions の place）。
 * kind が kill のボタンはセッションを閉じる（前のカードの × と同じ動き）。send のボタンは text をチャットの送信と同じ口で送る。
 * 見本は本人のスクショ（2026-11-13）。角丸のカードの右下の縁に、角丸の四角いボタンが縁にまたがって並ぶ
 */
type CardAction = { key: string; icon: string; name: string } & ({ kind: "kill" } | { kind: "send"; text: string });
const CARD_ACTIONS: CardAction[] = [
  { key: "kill", icon: "🐺", name: "閉じる", kind: "kill" },
  { key: "howdy", icon: "🚪", name: "様子を聞く", kind: "send", text: "調子どうですか" },
  { key: "go", icon: "👍", name: "許可する", kind: "send", text: "許可します、やってくださいお願いします。" },
];
/** true ならカードの右下のボタンをいつも出す。false ならカードに乗せたときと、選んでいるカードだけに出す */
const CARD_ACTIONS_ALWAYS = false;
/** 押したあとの反応（ボタンの一瞬の変化）の長さ（ms）。CSS の card-act-* と合わせる */
const CARD_ACT_FLASH_MS = 700;

/** 世帯の要約の凡例に並べる順 */
const LEGEND: Mood[] = ["working", "reply", "approval", "done", "idle"];

/** いま見ている町のセッション（お手紙の送り手の名前を引くため） */
const TownCtx = createContext<Agent[]>([]);
/** 封筒の印（💌）を頭に出しているセッション */
const LetterCtx = createContext<Set<string>>(new Set());
/** 閉じる操作と演出の状態。カードの 🐺 と、倒れる演出が読む */
const KillCtx = createContext<{ dying: Map<string, number>; ask: (a: Agent, instant: boolean) => void }>({ dying: new Map(), ask: () => {} });
/** カードのボタンから文を送る口（#63）。値は App で一度だけ作り、町の描き直しの合図にしない（#10） */
const SendCtx = createContext<(a: Agent, text: string) => Promise<boolean>>(async () => false);
const CONV_POLL_MS = 2500;
/** 会話に新しい発言が無い回が続いたときの間隔の上限（#5）。新しい発言が来るか、文を送ったら CONV_POLL_MS に戻す */
const CONV_POLL_MAX_MS = 10000;
/** 相手が作業中のあいだの会話の取り直しの間隔（#59）。延ばさずに、この間隔で取り続ける */
const CONV_POLL_LIVE_MS = 1000;

type Toast = { id: number; text: string; bad?: boolean };

// ターミナル（xterm と WebGL の addon）は起動のときに読まず、町を出した後に読む（#16）。
// 起動から町を描くまでに解く JS を減らす。最初に開くときに待たないよう、起動の2秒後に先に読んでおく
const loadTerminal = () => import("./term/TerminalView");
const TerminalView = lazy(() => loadTerminal().then((m) => ({ default: m.TerminalView })));

export default function App() {
  // スマホ専用の画面（src/mobile）。取得・選択・送信の状態はこの App が持ち、下の return の並べ方だけを切り替える
  const mobile = useMobileLayout();
  useVisualViewport(mobile);
  useEffect(() => { const t = setTimeout(() => { void loadTerminal(); }, 2000); return () => clearTimeout(t); }, []);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [zoom, setZoom] = useState<number | "fit">("fit");

  const toast = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 6000 : 2600);
  }, []);

  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    // 一覧は Rust の見張りが、変わったときだけ送ってくる（#5）。ウィンドウが見えていない間は止まる（#6）。
    // 経過時間の表示は Since が自分で時計を回すので、ここで町全体を毎秒描き直さない（#4）。
    // 読めなかったとき（ブラウザ版で ccn に届かないとき）は、前回の一覧を出したまま赤い帯で理由を出す
    const stop = watchTown((s) => {
      if (!alive) return;
      // 中身が前回と同じなら前回のオブジェクトのまま（描き直さない）。変わらないセッションも使い回す（#4）
      setSnap((prev) => reuseSnap(prev, s)); setErr(null);
    }, (msg) => { if (alive) setErr(msg); });
    reload.current = kickTown;
    return () => { alive = false; stop(); };
  }, []);

  // 閉じたセッション。演出が終わったら隠し、一覧から消えたら忘れる（10秒たっても消えなければ戻して失敗を出す）
  const [dying, setDying] = useState<Map<string, number>>(new Map());
  const [hidden, setHidden] = useState<Map<string, number>>(new Map());
  const [killAsk, setKillAsk] = useState<Agent | null>(null);
  const agents = useMemo(() => (snap?.agents ?? []).filter((a) => !hidden.has(a.id)), [snap, hidden]);
  // 隠したセッションがある間だけ、1秒ごとに下の判定を回す。一覧が前回と同じなら snap は変わらず（#4）、判定が動かないため
  const [sweep, setSweep] = useState(0);
  const hasHidden = hidden.size > 0;
  useEffect(() => (hasHidden ? pollWhileVisible(() => setSweep((n) => n + 1), 1000) : undefined), [hasHidden]);
  useEffect(() => {
    if (!snap || hidden.size === 0) return;
    const present = new Set(snap.agents.map((a) => a.id));
    const now = Date.now();
    const stuck = [...hidden].filter(([id, at]) => present.has(id) && now - at > 10000).map(([id]) => id);
    const gone = [...hidden.keys()].filter((id) => !present.has(id));
    if (!stuck.length && !gone.length) return;
    setHidden((h) => { const n = new Map(h); for (const id of [...stuck, ...gone]) n.delete(id); return n; });
    if (stuck.length) toast(`止まらなかった: ${stuck.map((id) => snap.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8)).join("、")}`, true);
  }, [snap, sweep]);
  const tree = useMemo(() => buildTree(agents), [agents]);
  // キャラの見た目（いつもの / ポケモン）。ポケモンでは世帯の根で進化の系統を決めるので、ID から根を引けるようにして渡す
  const [skin, setSkin] = useState<Skin>(savedSkin);
  // 値を作り直すのは、見た目か親子の形が変わったときだけにする。snapshot のたびに作り直すと、全員の Avatar が描き直される
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const shape = useMemo(() => tree.families.map((f) => f.all.map((a) => `${a.id}<${a.parent ?? ""}`).join(",")).join(";"), [tree]);
  const skinCtx = useMemo(() => ({
    skin,
    rootOf: (id: string) => { const t = treeRef.current; const a = t.byId.get(id); const r = a ? t.lineage(a)[0] : null; return r ? r.id : id; },
  }), [skin, shape]);
  const pick = useCallback((a: Agent) => setSelected(a.id), []);

  /** a とその子孫を、葉から順に止める。倒れる演出も葉から少しずつずらして出す。全部止まったら true */
  const kill = useCallback(async (a: Agent) => {
    const order: Agent[] = [];
    const walk = (x: Agent) => { for (const k of tree.childrenOf.get(x.id) ?? []) walk(k); order.push(x); };
    walk(a);
    const targets = order.filter((x) => x.capabilities?.stop);
    const skipped = order.filter((x) => !x.capabilities?.stop);
    setDying((m) => { const n = new Map(m); targets.forEach((x, i) => n.set(x.id, i * KILL_STAGGER)); return n; });
    if (selected && targets.some((x) => x.id === selected)) setSelected(null);
    const failed: Agent[] = [];
    for (const x of targets) {
      try { await invoke("stop_session", { sessionId: x.id }); }
      catch { failed.push(x); }
    }
    const ok = targets.filter((x) => !failed.includes(x));
    // 一覧から消えたのをすぐ拾う。見張りは変化が無いと間隔を延ばしているため（#5）
    kickTown();
    // 止まらなかった分は演出を戻す。止まった分は演出が終わったら隠す
    setDying((m) => { const n = new Map(m); for (const x of failed) n.delete(x.id); return n; });
    const last = (targets.length - 1) * KILL_STAGGER + KILL_MS;
    setTimeout(() => {
      setHidden((h) => { const n = new Map(h); for (const x of ok) n.set(x.id, Date.now()); return n; });
      setDying((m) => { const n = new Map(m); for (const x of ok) n.delete(x.id); return n; });
    }, last);
    if (failed.length) toast(`止められなかった: ${failed.map((x) => x.name).join("、")}`, true);
    else toast(`${a.name}${order.length > 1 ? ` と子孫 ${order.length - 1} 人` : ""}を閉じた`);
    if (skipped.length) toast(`Claude Town の外で起動したので、ここからは止められない。残した: ${skipped.map((x) => x.name).join("、")}`, true);
    return failed.length === 0 && skipped.length === 0;
  }, [tree, selected, toast]);
  // お手紙（記録はこの機械の hook が書く）
  const flights = useMemo(() => flightsOf(snap?.letters ?? [], agents), [snap, agents]);
  // ブラウザ版の ccn の行で予約したモデルと権限モードを、替えられるようになったら替える（always-switch）。アプリの端末の予約は Rust が当てる
  useCcnReservations(agents, supportFor, (m) => toast(m), (m) => toast(m, true));
  const letterMarks = useLetterMarks(flights);
  const askKill = useCallback((a: Agent, instant: boolean) => { if (instant) kill(a); else setKillAsk(a); }, [kill]);
  const killCtx = useMemo(() => ({ dying, ask: askKill }), [dying, askKill]);
  // カードのボタンから文を送る（#63）。選んでいるセッションなら、右パネルの送信（仮の吹き出しと会話の取り直し）に任せる。
  // ほかのセッションは端末の入力欄へ貼って送り（ブラウザ版の ccn の行は send_message）、トーストを出す。参照を変えないよう ref を通し、町を描き直させない（#10）
  const panelSend = useRef<((id: string, text: string) => Promise<boolean> | null) | null>(null);
  const sendImpl = useRef<(a: Agent, text: string) => Promise<boolean>>(async () => false);
  sendImpl.current = async (a, text) => {
    const viaPanel = panelSend.current?.(a.id, text);
    if (viaPanel) return viaPanel;
    try {
      if (viaCcn(a)) await invoke("send_message", { sessionId: a.id, text });
      else await invoke("send_direct", { sessionId: a.id, text });
      kickTown();
      toast(`${a.name} に届けた`);
      return true;
    } catch (e) {
      toast(`${a.name} に届かなかった: ${e}`, true);
      return false;
    }
  };
  const cardSend = useCallback((a: Agent, text: string) => sendImpl.current(a, text), []);
  const counts = useMemo(() => {
    const c: Record<Mood, number> = { approval: 0, reply: 0, working: 0, done: 0, idle: 0 };
    for (const a of agents) c[moodOf(a)]++;
    return c;
  }, [agents]);
  const needs = useMemo(
    () => agents.filter((a) => NEEDS_YOU.includes(moodOf(a)))
      .sort((a, b) => Number(moodOf(a) !== "approval") - Number(moodOf(b) !== "approval")),
    [agents],
  );

  const mails = useMemo(() => collectMail([{ town: "", agents }]), [agents]);
  const openMail = useCallback((m: Mail, chat = false) => {
    setSelected(m.agent.id);
    if (chat) setChatReq((n) => n + 1);
  }, []);

  // 作った直後のセッション。一覧（snapshot）に載るまでは、create の応答から作った仮の姿で右パネルを出す（#18）
  const [fresh, setFresh] = useState<Agent | null>(null);
  // 作ったらチャットを開いて入力欄にフォーカスする（本人の指定）。端末は右クリックや「端末へ」で開く
  const newHousehold = useCallback((r: any) => {
    if (!r?.id) return;
    setFresh({
      // 名前は一覧と同じ決め方（cardNames）。一覧に載ったときに名前が変わって見えないようにする
      id: r.id, name: cardNames([{ id: r.id, cwd: r.cwd ?? "" }]).get(r.id) ?? r.id.slice(0, 8), kind: "terminal", state: "running", cwd: r.cwd ?? "", canSend: true, parent: null,
      startedAt: Date.now(), capabilities: { terminal: true, send: true, stop: true, interrupt: true }, source: IS_WEB ? "ccn" : "app",
    });
    setSelected(r.id);
    setComposeReq((n) => n + 1);
    reload.current();
  }, []);

  // 右クリックや「端末へ」で、その子を選んで右パネルの端末を開く
  const [termReq, setTermReq] = useState(0);
  // お便りの「チャットへ」で、その子を選んで右パネルのチャットを開く
  const [chatReq, setChatReq] = useState(0);
  // 新しい世帯を作ったとき、右パネルのチャットを開いて入力欄にフォーカスする
  const [composeReq, setComposeReq] = useState(0);
  const focus = useCallback((a: Agent) => { perfStart("open", a.id); setSelected(a.id); setTermReq((n) => n + 1); }, []);
  const sel = selected ? tree.byId.get(selected) ?? (fresh?.id === selected ? fresh : null) : null;
  // 一覧に載ったら仮の姿を捨てる
  useEffect(() => { if (fresh && tree.byId.has(fresh.id)) setFresh(null); }, [tree, fresh]);
  useEffect(() => { if (sel) perfMark("listed", sel.id); }, [sel?.id]);
  useBench({ ready: !!snap, select: setSelected, focusId: (id) => { const a = tree.byId.get(id); if (a) focus(a); } });

  const panelProps = {
    agent: sel, lineage: sel ? tree.lineage(sel) : [], termReq, chatReq, composeReq, sendHook: panelSend,
    onSent: (a: Agent) => { kickTown(); toast(`${a.name} に届けた`); }, onSent2: (m: string) => { kickTown(); toast(m); }, onError: (m: string) => toast(m, true),
    needs, onSelect: (a: Agent) => setSelected(a.id), onClose: () => setSelected(null),
  };

  // 3枚のペイン（#89）。左の新しい世帯のペインはヘッダーのボタンとドラッグで開け閉めする。
  // 右のチャットは、セッションを選んでいないときに閉じ、選んだら開く。閉じても Panel は残す（入力欄の下書きを Panel が持っているため）
  const housesRef = usePanelRef();
  const sideRef = usePanelRef();
  const [housesOpen, setHousesOpen] = useState(true);
  const [sideOpen, setSideOpen] = useState(false);
  const hasSel = !!sel;
  const selRef = useRef(hasSel);
  selRef.current = hasSel;
  useLayoutEffect(() => {
    const r = sideRef.current;
    if (!r || mobile) return;
    if (hasSel && r.isCollapsed()) r.expand();
    else if (!hasSel && !r.isCollapsed()) r.collapse();
  }, [hasSel, mobile]);
  // 設定（#92）。「＋ 新しい世帯」で親を立てる場所。null は既定（~/Documents/meta）
  const [place, setPlace] = useState<string | null>(loadPlace);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toggleHouses = () => { const r = housesRef.current; if (!r) return; if (r.isCollapsed()) r.expand(); else r.collapse(); };

  return (
    <SkinCtx.Provider value={skinCtx}>
    <KillCtx.Provider value={killCtx}>
    <SendCtx.Provider value={cardSend}>
    <LetterCtx.Provider value={letterMarks.marks}>
    <TownCtx.Provider value={agents}>
    <div className={`app${mobile ? " mobile" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      {mobile ? (
        <MobileShell tree={tree} snap={snap} err={err} counts={counts} total={agents.length}
          open={sel} mails={mails} onPick={pick} onMail={(m) => openMail(m, true)} onBack={() => setSelected(null)}
          chat={(back) => <Panel {...panelProps} mobile onBack={back} />} />
      ) : (<>
      {/* 右のチャットが閉じている間は、左の幅と開閉だけを保存し、チャットの幅は前に保存した値を残す（0 を保存すると、次に開いたときのチャットの幅が最小に戻る） */}
      <SplitGroup className="body" orientation="horizontal" defaultLayout={savedSplit()} onLayoutChanged={(l) => saveSplit(sideRef.current?.isCollapsed() ? keepSide(l, savedSplit()) : l)}>
        <SplitPanel id="houses" panelRef={housesRef} collapsible collapsedSize={0} defaultSize={HOUSES_DEFAULT} minSize={HOUSES_MIN} maxSize="30%"
          onResize={() => setHousesOpen(!housesRef.current?.isCollapsed())}>
          <NewHousePane place={place} onCreated={newHousehold} onError={(m) => toast(m, true)} />
        </SplitPanel>
        <Separator className={`split-handle${housesOpen ? "" : " closed"}`} />
        <SplitPanel id="town" minSize={TOWN_MIN}>
        <div className="left">
          {/* アプリのヘッダー。#89 で窓の上から中央のペインの最上部へ移した（本人の指定） */}
          <header className="top">
            <div className="brand">
              {/* 左の新しい世帯のペインの開け閉め（#89）。アイコンは lucide の panel-left-close / panel-left-open（ISC）。置き場所は仮置き */}
              <button className="side-toggle" onClick={toggleHouses} aria-label={housesOpen ? "新しい世帯のペインを閉じる" : "新しい世帯のペインを開く"}
                title={housesOpen ? "新しい世帯のペインを閉じる" : "新しい世帯のペインを開く"} aria-expanded={housesOpen}>
                {housesOpen ? <PanelLeftClose size={18} strokeWidth={1.8} /> : <PanelLeftOpen size={18} strokeWidth={1.8} />}
              </button>
              <HouseIcon />
              <h1>Claude Town</h1>
            </div>
            <div className="top-mid" />
            <div className="top-right">
              <button className="side-toggle" onClick={() => setSettingsOpen(true)} aria-label="設定" title="設定" aria-haspopup="dialog"><Settings size={18} strokeWidth={1.8} /></button>
            </div>
          </header>

          {/* 世帯の要約。#89 でお便りの上へ移した（本人の指定） */}
          <div className="fam-head">
            <span className="fam-title"><Users size={20} strokeWidth={1.8} aria-hidden /> {tree.families.length}世帯・{agents.length}人</span>
            {/* 凡例は数が 0 の項目を出さない。全部 0 なら凡例ごと出さない（本人の確認、#89） */}
            {LEGEND.some((m) => counts[m]) && (
              <span className="legend">
                {LEGEND.filter((m) => counts[m]).map((m) => (
                  <span key={m} className={`lg lg-${m}`}><i />{MOOD_LABEL[m]} {counts[m]}</span>
                ))}
              </span>
            )}
          </div>
          <NextRow mails={mails} working={counts.working} total={agents.length} onOpen={openMail} />

          {err && <div className="banner bad">{err}</div>}

          {snap && agents.length === 0 && (
            <div className="empty">
              <p>町にはまだ誰もいない。最初の世帯を作ると、右にチャットが開いてすぐ打てる（親は {place ? place.replace(/^\/Users\/[^/]+/, "~") : "~/Documents/meta"} で起動する。設定で変えられる）。</p>
              <NewHousehold big place={place} onCreated={newHousehold} onError={(m) => toast(m, true)} />
            </div>
          )}
          <Stage zoom={zoom} onBlank={() => setSelected(null)} items={tree.families.map((f) => {
            const r = layoutOf(f.all);
            const size = groupSizeOf(r.metrics);
            return {
              id: f.root.id, ...size,
              node: (
                <Group root={f.root} count={f.all.length} size={size}
                  hasNeeds={f.all.some((a) => NEEDS_YOU.includes(moodOf(a)))}>
                  <FamilyCanvas all={f.all} result={r} selected={selected} onSelect={pick} onFocus={focus} />
                </Group>
              ),
            };
          })} />

          <div className="left-foot">
            <div className="zoom">
              <button onClick={() => setZoom((z) => Math.max(0.4, +(((z === "fit" ? 1 : z) - 0.1).toFixed(2))))}>−</button>
              <button className="zval" onClick={() => setZoom("fit")} title="全体が入る大きさにする">
                {zoom === "fit" ? "全体" : `${Math.round(zoom * 100)}%`}
              </button>
              <button onClick={() => setZoom((z) => Math.min(1.6, +(((z === "fit" ? 1 : z) + 0.1).toFixed(2))))}>＋</button>
              <button className="fs" title="全画面" onClick={() => setFullscreen()}>⛶</button>
            </div>
            <span className="hint">クリックでチャット・右クリックでターミナル</span>
            <Credits skin={skin} onSkin={(v) => { setSkin(v); saveSkin(v); }} />
          </div>
        </div>

        </SplitPanel>
        {/* 町と右パネルの境目。ドラッグで右パネルを 380px からウィンドウ幅の半分まで広げられる。ダブルクリックで既定の幅に戻る。
            右パネルを最小より細くドラッグすると閉じ、選ぶのをやめる（#89） */}
        <Separator className={`split-handle side-sep${sideOpen ? "" : " closed"}`} />
        <SplitPanel id="side" panelRef={sideRef} collapsible collapsedSize={0} defaultSize={SIDE_DEFAULT} minSize={SIDE_MIN} maxSize="50%"
          onResize={() => { const closed = !!sideRef.current?.isCollapsed(); setSideOpen(!closed); if (closed && selRef.current) setSelected(null); }}>
        <Panel {...panelProps} />
        </SplitPanel>
      </SplitGroup>
      </>)}

      {settingsOpen && <SettingsDialog place={place} onSave={(p) => { savePlace(p); setPlace(p); toast(p ? "新しい世帯の場所を変えた" : "新しい世帯の場所を既定に戻した"); }} onClose={() => setSettingsOpen(false)} />}

      {killAsk && (
        <KillConfirm agent={killAsk} descendants={countDesc(tree.childrenOf, killAsk.id)}
          onCancel={() => setKillAsk(null)} onConfirm={() => { const a = killAsk; setKillAsk(null); kill(a); }} />
      )}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}>{t.text}</div>)}
      </div>
      <div className="letters-layer" ref={letterMarks.layer} aria-hidden />
    </div>
    </TownCtx.Provider>
    </LetterCtx.Provider>
    </SendCtx.Provider>
    </KillCtx.Provider>
    </SkinCtx.Provider>
  );
}

// ---------- お手紙 ----------

const LETTER_IMG = "/sprites/noto/1f48c/64.webp";
/** 封筒の印を残す長さ。読まれたら短く、読まれないままなら長くても MARK_MAX_MS で消す */
const MARK_READ_MS = 2500;
/** 飛ぶ封筒と、頭に残る印の大きさ（px）。App.css の .letter-fly と .letter-mark に合わせる */
const FLY_SIZE = 30;
const MARK_SIZE = 24;
/** 印の中心の、カード（.fnode-body）の左上からの位置。.letter-mark の left: -9px、top: -11px と大きさから */
const MARK_OFFSET = { x: -9 + MARK_SIZE / 2, y: -11 + MARK_SIZE / 2 };
/** つなぎ線の上を進む割合。残りで印の位置へ寄せる */
const LETTER_ALONG = 0.8;
const MARK_MAX_MS = 30000;
/** 飛ばした封筒の記録を覚える数。Rust の LETTERS_MAX（300）より十分多くする */
const SEEN_MAX = 2000;

/**
 * 新しいお手紙が来たら、送り手のカードから受け手のカードへ封筒を飛ばし、受け手の頭に印を残す。
 * 封筒はカードの中心どうしを結ぶ直線を飛ぶ（親子ならつなぎ線と重なる。世帯をまたぐときは町の上を直線で飛ぶ）。
 * 動きを減らす設定（prefers-reduced-motion）なら、飛ばさずに印だけ出す。
 * 起動したときにすでにある記録は飛ばさない（古いお手紙を再生しない）。
 */
function useLetterMarks(flights: Flight[]) {
  const layer = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const [marks, setMarks] = useState<Map<string, { flight: string; until: number }>>(new Map());
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(flights.map((f) => f.id));
      return;
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const fresh = flights.filter((f) => !seen.current!.has(f.id));
    // 見た記録は古い順に捨て、SEEN_MAX 件までにする（#15）。Rust が渡すのは最近10分の最大300件なので、
    // 捨てた記録が一覧に戻ることはない。いまの一覧で捨てると、一覧の取得が一度欠けただけで同じ封筒を二度飛ばす
    for (const f of fresh) seen.current.add(f.id);
    for (const id of seen.current) { if (seen.current.size <= SEEN_MAX) break; seen.current.delete(id); }
    fresh.forEach((f, i) => {
      const land = () => setMarks((m) => new Map(m).set(f.to, { flight: f.id, until: Date.now() + (f.readAt ? MARK_READ_MS : MARK_MAX_MS) }));
      const a = document.querySelector(`[data-aid="${f.from}"]`)?.getBoundingClientRect();
      const toEl = document.querySelector<HTMLElement>(`[data-aid="${f.to}"]`);
      const b = toEl?.getBoundingClientRect();
      // ウィンドウが隠れている間に来たお手紙は、見えた後にまとめて飛ばさず、印だけ出す（#6）
      if (reduce || f.at < shownAt() || !a || !b || !layer.current) { land(); return; }
      const img = document.createElement("img");
      img.src = LETTER_IMG;
      img.className = "letter-fly";
      layer.current.appendChild(img);
      // 始点は送り手のカードの中心。つなぎ線（中心どうしを結ぶ線）の上を受け手の手前 LETTER_ALONG まで進み、
      // 最後の区間で、届いた後に印が残る位置（受け手のカードの左上、.letter-mark と同じ中心）へ寄せ、印と同じ大きさで止まる
      const ax = a.left + a.width / 2, ay = a.top + a.height / 2, cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      // 町は拡大縮小されるので、印の位置と大きさも同じ倍率にする
      const k = toEl && toEl.offsetWidth ? b.width / toEl.offsetWidth : 1;
      const mx = b.left + MARK_OFFSET.x * k, my = b.top + MARK_OFFSET.y * k;
      const vx = ax + (cx - ax) * LETTER_ALONG, vy = ay + (cy - ay) * LETTER_ALONG;
      const dist = Math.hypot(vx - ax, vy - ay) + Math.hypot(mx - vx, my - vy);
      const ms = Math.min(1500, Math.max(700, dist * 1.6));
      const at = (x: number, y: number, k: number) => `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${k})`;
      const anim = img.animate([
        { transform: at(ax, ay, 0.6), opacity: 0 },
        { transform: at(ax, ay, 1), opacity: 1, offset: 0.1 },
        { transform: at(vx, vy, 1), opacity: 1, offset: 0.78 },
        { transform: at(mx, my, (MARK_SIZE * k) / FLY_SIZE), opacity: 1 },
      ], { duration: ms, delay: i * 180, easing: "cubic-bezier(.4,.1,.3,1)", fill: "both" });
      // 印を出してから飛んできた封筒を消す（入れ替わりの継ぎ目を見せない）
      anim.onfinish = () => { land(); requestAnimationFrame(() => requestAnimationFrame(() => img.remove())); };
    });
  }, [flights]);
  // 読まれたら印を短くする。時間が来たら消す
  useEffect(() => {
    const read = new Map(flights.filter((f) => f.readAt).map((f) => [f.id, f.readAt!]));
    setMarks((m) => {
      let changed = false;
      const n = new Map(m);
      for (const [to, v] of m) {
        if (read.has(v.flight) && v.until > Date.now() + MARK_READ_MS) { n.set(to, { ...v, until: Date.now() + MARK_READ_MS }); changed = true; }
        if (v.until <= Date.now()) { n.delete(to); changed = true; }
      }
      return changed ? n : m;
    });
  }, [flights]);
  useEffect(() => {
    if (marks.size === 0) return;
    const t = setInterval(() => setMarks((m) => {
      const n = new Map([...m].filter(([, v]) => v.until > Date.now()));
      return n.size === m.size ? m : n;
    }), 500);
    return () => clearInterval(t);
  }, [marks.size]);
  const ids = useMemo(() => new Set(marks.keys()), [marks]);
  return { layer, marks: ids };
}

function countDesc(childrenOf: Map<string, Agent[]>, id: string): number {
  return (childrenOf.get(id) ?? []).reduce((n, k) => n + 1 + countDesc(childrenOf, k.id), 0);
}

/** セッションを止める操作の前の確認。Enter で進める、Esc でやめる。ok は進めるボタンの名前。single なら、やめるボタンを出さない（読んで閉じるだけの知らせ） */
function Confirm({ title, ok, danger, single, onCancel, onConfirm, children }: { title: string; ok: string; danger?: boolean; single?: boolean; onCancel: () => void; onConfirm: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onCancel, onConfirm]);
  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <p className="hint">{children}</p>
        <div className="modal-btns">
          {!single && <button className="pane-btn" onClick={onCancel}>やめる（Esc）</button>}
          <button className={danger ? "danger" : "primary"} autoFocus onClick={onConfirm}>{ok}（Enter）</button>
        </div>
      </div>
    </div>
  );
}

/** 閉じる前の確認 */
function KillConfirm({ agent, descendants, onCancel, onConfirm }: { agent: Agent; descendants: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm title={`${agent.name}${descendants ? ` と子孫 ${descendants} 人` : ""}を閉じる？`} ok="閉じる" danger onCancel={onCancel} onConfirm={onConfirm}>
      このアプリが立てた claude を止める。{descendants ? "子孫は孫から順に止める。" : ""}Claude Town の外で起動したセッションと、止まらなかった分は画面に残る。⌘ を押しながら 🐺 を押すと、確認なしで閉じる。
    </Confirm>
  );
}

// ---------- 上の段 ----------

function NextRow({ mails, working, total, onOpen }: {
  mails: Mail[]; working: number; total: number;
  onOpen: (m: Mail, chat?: boolean) => void;
}) {
  // 先頭が大きい1枚、続く2件が小さいチップ、残りは「ほか N 件」。並びは src/mail.ts（親が先、その中は待ちが古い順）
  const first = mails[0];
  const rest = mails.slice(1, 3);
  const hidden = mails.length - 1 - rest.length;
  const icon = (k: Mail["kind"]) => (k === "approval" ? "✋" : k === "reply" ? "💬" : "✓");
  const mainText = (m: Mail) => {
    const n = m.agent.name;
    return m.kind === "approval" ? `${n}の承認待ちを確認する` : m.kind === "reply" ? `${n}に返事する` : `${n}の報告を確認する`;
  };
  const chipText = (m: Mail) => (m.kind === "approval" ? `${m.agent.name}の承認待ち` : m.kind === "reply" ? `${m.agent.name}から返事待ち` : `${m.agent.name}の報告を確認`);
  return (
    <div className="next-row">
      <span className="next-label">お便り</span>
      {first ? (
        <div className={`next-main nm-${first.kind}`}>
          <span className="next-icon">{icon(first.kind)}</span>
          <button className="next-text" onClick={() => onOpen(first)}>{mainText(first)}</button>
          <button className="pane-btn" onClick={() => onOpen(first, true)}>チャットへ</button>
        </div>
      ) : (
        <div className="next-main nm-calm">
          <span className="next-text calm">
            {total === 0 ? "いまは誰もいない" : working > 0 ? `いまはあなたの番じゃない。${working}人が作業中` : "みんな待機中。頼みたい子をクリック"}
          </span>
        </div>
      )}
      {rest.length > 0 && <span className="next-sep" />}
      {rest.map((m) => (
        <button key={m.agent.id} className="next-chip" onClick={() => onOpen(m)}>
          <span>{icon(m.kind)}</span>{chipText(m)}
        </button>
      ))}
      {hidden > 0 && <span className="next-more">ほか{hidden}件</span>}
    </div>
  );
}

// ---------- 家と木 ----------

/**
 * 世帯モジュールを並べる場所（docs/design/household-packing.md、src/layout/pack.ts）。
 * 入力順（親の開始時刻、同じなら ID）に、決まった横幅の中へ上詰めで置く。大きさや状態で並べ替えない。
 * zoom が fit のときは、一番広い世帯が横幅に入る倍率にする（最小 0.4）。横幅はその倍率で割り戻した幅。
 */
function Stage({ zoom, items, onBlank }: { zoom: number | "fit"; items: { id: string; w: number; h: number; node: React.ReactNode }[]; onBlank: () => void }) {
  const outer = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(1000);
  useLayoutEffect(() => {
    const measure = () => { if (outer.current) setAvail(outer.current.clientWidth - 36); };
    measure();
    const ro = new ResizeObserver(measure);
    if (outer.current) ro.observe(outer.current);
    return () => ro.disconnect();
  }, []);
  const widest = Math.max(1, ...items.map((b) => b.w));
  const fit = Math.max(0.4, Math.min(1, avail / widest));
  const scale = zoom === "fit" ? fit : zoom;
  const width = Math.floor(avail / scale);
  const packed = packHouseholds(items.map(({ id, w, h }) => ({ id, w, h })), width, LAYOUT.group.gap);
  const at = new Map(packed.items.map((p) => [p.id, p]));
  return (
    <ScrollEdgeGradient className="stage" wrapClassName="seg-fill stage-bg" strength="town" ref={outer}
      onClick={(e) => { if (!(e.target as HTMLElement).closest(".card, .mini, .pop, .g-head, .card-acts, .letter-mark")) onBlank(); }}>
      <div className="stage-inner" style={{ zoom: scale, width, height: packed.height + 20 }}>
        {items.map((b) => {
          const p = at.get(b.id)!;
          return (
            <div key={b.id} className="slot"
              style={{ left: p.x, top: p.y, width: b.w, height: b.h, transition: `left ${LAYOUT.moveMs}ms ease, top ${LAYOUT.moveMs}ms ease` }}>
              {b.node}
            </div>
          );
        })}
      </div>
    </ScrollEdgeGradient>
  );
}

/** グループ（根のセッション1つとその子孫）ごとの淡い色。名前から決まる */
const GROUP_TINTS = ["#f3f7ff", "#fff6ec", "#f1faf3", "#f8f3ff", "#fff2f5", "#eff9f9", "#fbf8ec"];
const GROUP_LINES = ["#d9e4fb", "#f6dfc4", "#d3ecd9", "#e4d8f6", "#f6d6df", "#cfe9e9", "#ece4c2"];

function Group({ root, count, size, hasNeeds, children }: {
  root: Agent; count: number; size: { w: number; h: number }; hasNeeds: boolean; children: React.ReactNode;
}) {
  const tint = hashOf(root.id) % GROUP_TINTS.length;
  return (
    <section className={`group ${hasNeeds ? "has-needs" : ""}`}
      style={{ width: size.w, height: size.h, background: GROUP_TINTS[tint], borderColor: hasNeeds ? undefined : GROUP_LINES[tint] }}>
      <div className="g-head" title="親のプロジェクトのディレクトリの名前">
        <span className="g-name">{houseNameOf(root)}</span>
        <span className="g-sub">{count}人</span>
        {hasNeeds && <span className="g-needs">あなたの番</span>}
      </div>
      {children}
    </section>
  );
}


/**
 * 家族の木を、配置計算（src/layout）が決めた座標に置いて描く。
 * 配置を計算し直すのは、家族の顔ぶれ（id、親、名前）が変わったときだけ。状態や会話の更新では動かさない。
 * 線は、配置の検査に使ったのと同じ「親の中心から子の中心」の線分を SVG で引く。
 */
/**
 * 世帯の中の配置を計算する（src/layout/layout.ts）。顔ぶれ（id、親、名前、開始時刻）が変わったときだけ計算し直し、
 * 状態や会話の更新では動かさない。前に選んだ候補は引き継がず、顔ぶれだけで決める。
 */
const layoutCache = new Map<string, { sig: string; result: ReturnType<typeof layoutFamily> }>();
/** 覚えておく世帯の数。町に一度に出る世帯より十分多くする */
const LAYOUT_CACHE_MAX = 64;
function layoutOf(all: Agent[]) {
  const rootId = all[0].id;
  const sig = all.map((a) => `${a.id}|${a.parent ?? ""}|${a.name}|${a.startedAt ?? 0}`).join(",");
  const hit = layoutCache.get(rootId);
  if (hit && hit.sig === sig) return hit.result;
  const inFam = new Set(all.map((a) => a.id));
  const depthOf = new Map<string, number>();
  const d = (a: Agent): number => {
    if (depthOf.has(a.id)) return depthOf.get(a.id)!;
    const p = a.parent && inFam.has(a.parent) ? all.find((x) => x.id === a.parent) : undefined;
    const v = p ? d(p) + 1 : 0;
    depthOf.set(a.id, v);
    return v;
  };
  const nodes: LNode[] = all.map((a) => {
    const b = boxOf(d(a), a.name);
    return { id: a.id, parent: a.parent && inFam.has(a.parent) ? a.parent : null, order: a.startedAt ?? 0, w: b.w, h: b.h };
  });
  // 前に選んだ候補は引き継がない。引き継ぐと、子が増えるのを見ていた町と後から開いた町で形が変わる（docs/design/geometric-layout.md）
  const r = layoutFamily(nodes);
  if (!r.valid) console.warn("Claude Town: 配置の検査に通る候補が無かった", rootId, r.metrics, r.candidates);
  layoutCache.delete(rootId);
  layoutCache.set(rootId, { sig, result: r });
  // 閉じた世帯の分を捨てる（#15）。Map は入れた順なので、計算し直していない古い世帯から消す
  while (layoutCache.size > LAYOUT_CACHE_MAX) layoutCache.delete(layoutCache.keys().next().value!);
  return r;
}

/**
 * 家族の木を、配置計算が決めた座標に置いて描く。
 * 線は、配置の検査に使ったのと同じ「親の中心から子の中心」の線分を SVG で引く。
 */
type CanvasProps = { all: Agent[]; result: ReturnType<typeof layoutFamily>; selected: string | null; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void };
/** 世帯の顔ぶれ（all の中身のオブジェクト）、配置、選択、手が同じなら描き直さない（#4）。all は木を作り直すたびに新しい配列になるので、中身で比べる */
const sameCanvas = (a: CanvasProps, b: CanvasProps) => a.result === b.result && a.selected === b.selected && a.onSelect === b.onSelect && a.onFocus === b.onFocus
  && a.all.length === b.all.length && a.all.every((x, i) => x === b.all[i]);
const FamilyCanvas = memo(function FamilyCanvas({ all, result, selected, onSelect, onFocus }: CanvasProps) {
  if (import.meta.env.DEV) renders.canvas++;
  const pad = LAYOUT.framePad;
  const minX = Math.min(...result.nodes.map((n) => n.x - n.w / 2));
  const minY = Math.min(...result.nodes.map((n) => n.y - n.h / 2));
  const W = result.metrics.width + pad * 2, H = result.metrics.height + pad * 2;
  const ox = pad - minX, oy = pad - minY;
  const byId = new Map(all.map((a) => [a.id, a]));
  const pos = new Map(result.nodes.map((n) => [n.id, n]));
  const kill = useContext(KillCtx);
  const letters = useContext(LetterCtx);
  return (
    <div className="canvas" style={{ width: W, height: H }} data-valid={result.valid} data-arc={result.arcIndex}
      data-metrics={JSON.stringify({ o: result.metrics.overlaps, c: result.metrics.crossings, t: result.metrics.edgeThroughNode, i: result.metrics.interleave, s: Number(result.metrics.s.toFixed(3)) })}>
      {!result.valid && <span className="layout-warn" title={JSON.stringify(result.metrics)}>配置が重なっている</span>}
      <svg className="edges" width={W} height={H}>
        {result.nodes.filter((n) => n.parent).map((n) => {
          const p = pos.get(n.parent!)!;
          return <line key={n.id} x1={p.x + ox} y1={p.y + oy} x2={n.x + ox} y2={n.y + oy} />;
        })}
      </svg>
      {result.nodes.map((n) => {
        const a = byId.get(n.id);
        if (!a) return null;
        const delay = kill.dying.get(n.id);
        return (
          <div key={n.id} className={`fnode ${selected === n.id ? "open" : ""} ${delay !== undefined ? "dying" : ""} ${n.depth >= 2 ? "is-mini" : ""}`}
            style={{ left: n.x - n.w / 2 + ox, top: n.y - n.h / 2 + oy, width: n.w, height: n.h, transition: `left ${LAYOUT.moveMs}ms ease, top ${LAYOUT.moveMs}ms ease`, ["--kd" as string]: `${delay ?? 0}ms` }}>
            {/* 右下のボタンはカード（札）の縁を基準に置くので、カードと同じ大きさの包みに入れる（カードは overflow: hidden） */}
            <div className={`fnode-body ${n.depth >= 2 ? "k-mini" : "k-card"}`} data-aid={n.id}
              style={n.depth >= 2 ? { ["--kx-k" as string]: boxOf(n.depth, a.name).scale } : undefined}>
              <Card agent={a} depth={n.depth} selected={selected === n.id} onSelect={onSelect} onFocus={onFocus} />
              {letters.has(n.id) && <img className="letter-mark" src={LETTER_IMG} alt="お手紙が届いた" title="お手紙が届いた" />}
              {/* 孫より下の小さい札には付けない。選んだときに重なる大きいカード（.pop）の中で付ける（Card） */}
              {n.depth <= 1 && delay === undefined && <CardActions agent={a} />}
            </div>
            {delay !== undefined && <KillFx w={n.w} h={n.h} />}
          </div>
        );
      })}
    </div>
  );
}, sameCanvas);

/** 描き直しの回数（開発版だけ数える）。待機中に増えないことを確かめる（#4）。ブラウザでは window.__fcRenders で読む */
const renders = { canvas: 0, card: 0 };
if (import.meta.env.DEV && typeof window !== "undefined") (window as any).__fcRenders = renders;

const Card = memo(function Card(props: { agent: Agent; depth: number; selected: boolean; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void }) {
  const { agent, depth, selected, onSelect, onFocus } = props;
  const { dying } = useContext(KillCtx);
  if (depth <= 1) return <FullCard {...props} />;
  // 孫より下は小さい札。選んだときだけ、親や子と同じ大きさのカードを上に重ねる（周りは動かさない）
  const mood = moodOf(agent);
  const now = nowOf(agent, mood);
  const acct = accountText(agent);
  const box = boxOf(depth, agent.name);
  return (
    <>
      <button
        className={`mini m-${mood} ${selected ? "sel" : ""}`}
        style={{ zoom: box.scale, width: box.w / box.scale, height: box.h / box.scale }}
        onClick={() => onSelect(agent)}
        onContextMenu={(e) => { e.preventDefault(); onFocus(agent); }}
        title={`${agent.name}\n${MOOD_LABEL[mood]}${now ? `: ${now}` : ""}${acct ? `\nアカウント: ${acct}` : ""}\nクリックで広げてチャット・右クリックでターミナル`}
      >
        <Avatar pick={agent.avatar} seed={agent.id} mood={mood} role={roleOf(depth)} size={32} dead={dying.has(agent.id)} />
        <span className="mini-name"><i className={`dot st-${mood}`} />{agent.name}</span>
      </button>
      {selected && (
        <div className="pop">
          <FullCard {...props} />
          {!dying.has(agent.id) && <CardActions agent={agent} />}
        </div>
      )}
    </>
  );
});

/**
 * カードの右下のボタン（#63）。並びと送る文は CARD_ACTIONS で決める。出し入れは CSS（.fnode:hover と .fnode.open）で行い、描き直さない。
 * 押してもカードの選択や右パネルの切り替えが起きないよう、クリックはここで止める。
 * place が head なら、右パネルの見出しに、いつも見える形で並べる（動きはカードと同じ）。
 * ボタンに乗せたときの説明は title で出す（WebView の標準のツールチップ）。押せるときは何をするか、押せないときは押せない理由を書く
 */
const CardActions = memo(function CardActions({ agent, place = "card" }: { agent: Agent; place?: "card" | "head" }) {
  const kill = useContext(KillCtx);
  const send = useContext(SendCtx);
  // 押したあとの一瞬の反応。key は押したボタン、ok は届いたか
  const [flash, setFlash] = useState<{ key: string; ok: boolean } | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const canSend = agent.canSend;
  const canStop = !!agent.capabilities?.stop;
  const press = async (act: CardAction, e: React.MouseEvent) => {
    e.stopPropagation();
    if (act.kind === "kill") { if (canStop) kill.ask(agent, e.metaKey); return; }
    if (!canSend || sending) return;
    setSending(act.key);
    const ok = await send(agent, act.text);
    setSending(null);
    setFlash({ key: act.key, ok });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(null), CARD_ACT_FLASH_MS);
  };
  return (
    <div className={`card-acts ${place === "head" ? "in-head" : CARD_ACTIONS_ALWAYS ? "always" : ""}`}
      onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {CARD_ACTIONS.map((act) => {
        const off = act.kind === "kill" ? !canStop : !canSend;
        const title = act.kind === "kill"
          ? (canStop ? `${act.name}: このセッションを止める。子孫がいれば一緒に止める（⌘ を押しながらで確認なし）` : "閉じられない: Claude Town の外で起動したセッション")
          : (canSend ? `${act.name}: 「${act.text}」を送る` : `${act.name}を送れない: Claude Town の外で起動したセッション`);
        const fx = flash?.key === act.key ? (flash.ok ? "sent" : "failed") : sending === act.key ? "sending" : "";
        return (
          <button key={act.key} type="button" className={`card-act ca-${act.key} ${off ? "off" : ""} ${fx}`}
            aria-disabled={off} title={title} aria-label={`${agent.name}: ${title}`}
            onClick={(e) => press(act, e)}>
            <span aria-hidden>{act.icon}</span>
          </button>
        );
      })}
    </div>
  );
});

/**
 * 人狼の「夜に襲われる」風の演出。暗くなる → 赤い爪痕の3本線が順に走る → 倒れて灰色 → 幽霊が昇って消える。
 * 爪痕は本人の見本（/tmp/fc-claw-ref.png）どおりの約55度の太い赤線3本を、等間隔に置く。引く向きは右上の端から左下の端へ（2026-11-12 に上から下へ変えた）。ずらしは右の線から 70ms ずつ。
 * 太さはノードの高さの 5.5%。ノードの角丸の内側で切れる（.kill-fx の overflow: hidden）。
 */
const CLAW = { color: "#E8352B", angleDeg: 55, width: 0.055, starts: [0.11, 0.37, 0.63] };
function KillFx({ w, h }: { w: number; h: number }) {
  const dx = h / Math.tan((CLAW.angleDeg * Math.PI) / 180);
  return (
    <div className="kill-fx" aria-hidden>
      <div className="kill-night" />
      <svg className="kill-claws" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {CLAW.starts.map((s, i) => {
          // 上から下へ引く: 描き始め（x1, y1）を右上の端、描き終わり（x2, y2）を左下の端にする。線の位置と角度は見本のまま
          const x2 = s * w, y2 = h + 2, x1 = x2 + dx, y1 = -2;
          const len = Math.hypot(x2 - x1, y2 - y1);
          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLAW.color} strokeWidth={Math.max(2, h * CLAW.width)} strokeLinecap="butt"
              style={{ strokeDasharray: len, strokeDashoffset: len, ["--cl" as string]: `${len}`, ["--cd" as string]: `${(CLAW.starts.length - 1 - i) * 70}ms` }} />
          );
        })}
      </svg>
      <img className="kill-ghost" src="/sprites/noto/1f47b/64.webp" alt="" draggable={false} />
    </div>
  );
}

/**
 * 作業中の経過時間（sinceText）。この部品の中だけで時計を回し、町全体は描き直さない（#4）。
 * 1分までは1秒ごと、1時間までは30秒ごと、それより後は6分ごとに描き直す。ウィンドウが見えていない間は止め、見えたらすぐ描き直す（#6）
 */
function Since({ at }: { at: number }) {
  const [, bump] = useState(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const plan = () => {
      const age = Date.now() - at;
      t = setTimeout(() => { t = null; bump((x) => x + 1); plan(); }, age < 60_000 ? 1000 : age < 3_600_000 ? 30_000 : 360_000);
    };
    const stop = () => { if (t !== null) { clearTimeout(t); t = null; } };
    const off = onVisibleChange((v) => { stop(); if (v) { bump((x) => x + 1); plan(); } });
    if (isVisible()) plan();
    return () => { off(); stop(); };
  }, [at]);
  return <>{sinceText(at)}</>;
}

function FullCard({ agent, depth, selected, onSelect, onFocus }: {
  agent: Agent; depth: number; selected: boolean; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void;
}) {
  const { dying } = useContext(KillCtx);
  if (import.meta.env.DEV) renders.card++;
  const mood = moodOf(agent);
  const task = taskOf(agent, mood);
  const now = nowOf(agent, mood);
  const started = mood === "working" ? agent.report?.turn_started_at : null;
  const acct = accountText(agent);
  return (
    <button
      className={`card m-${mood} ${selected ? "sel" : ""}`}
      style={{ width: LAYOUT.card.w, height: LAYOUT.card.h }}
      onClick={() => onSelect(agent)}
      onContextMenu={(e) => { e.preventDefault(); onFocus(agent); }}
      title={`${agent.name}\n${MOOD_LABEL[mood]}${now ? `: ${now}` : ""}${acct ? `\nアカウント: ${acct}` : ""}\nクリックでチャット・右クリックでターミナル`}
    >
      <div className="card-top">
        <span className="role">{ROLE_LABEL[Math.min(depth, 4)]}</span>
        <span className="task">{task}</span>
      </div>
      <div className="card-main">
        <Avatar pick={agent.avatar} seed={agent.id} mood={mood} role={roleOf(depth)} size={48} dead={dying.has(agent.id)} />
        <div className="card-info">
          {/* このセッションの claude が動いているアカウント（cam のコマンド名）。ccn が載せたときだけ出す */}
          {agent.account && <span className="cacct">{agent.account}</span>}
          <span className={`st st-${mood}`}><i />{MOOD_LABEL[mood]}{started ? <em><Since at={started} /></em> : null}</span>
          <span className="cname">{agent.name}</span>
        </div>
      </div>
    </button>
  );
}

// ---------- 右のパネル ----------

const NO_NOTES: PendingItem[] = [];

function Panel({ agent, lineage, termReq, chatReq, composeReq, sendHook, onSent, onSent2, onError, needs, onSelect, mobile, onBack, onClose }: {
  /** スマホ専用の画面（src/mobile）。見出しを戻るつきの1行にし、細かいボタンは出さない */
  mobile?: boolean; onBack?: () => void;
  /** 見出しの × で選ぶのをやめる（#89）。右パネルが閉じる */
  onClose?: () => void;
  agent: Agent | null; lineage: Agent[]; termReq: number; chatReq: number; composeReq: number;
  /** カードのボタン（#63）が、選んでいるセッションへの送信をこのパネルに任せる口。選んでいないセッションなら null を返す */
  sendHook: React.MutableRefObject<((id: string, text: string) => Promise<boolean> | null) | null>;
  onSent: (a: Agent) => void; onSent2: (m: string) => void; onError: (m: string) => void; needs: Agent[]; onSelect: (a: Agent) => void;
}) {
  const hasTerm = !!agent?.capabilities?.terminal;
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
  const [items, setItems] = useState<ConvItem[]>([]);
  // 今の動き（#59）。中身が変わったときだけ入れ替え、末尾の行のほかは描き直さない
  const [live, setLive] = useState<Live | null>(null);
  // 送ったばかりの文。after は送り始めたときに持っていた最後の番号で、これより後に届いた発言とだけ比べる
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [convErr, setConvErr] = useState<string | null>(null);
  // 下書きは宛先ごとに持つ。宛先を切り替えたとき、打ちかけの文が次の宛先に送られないようにする
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const text = agent ? drafts[agent.id] ?? "" : "";
  const setText = (v: string) => { if (agent) setDrafts((d) => ({ ...d, [agent.id]: v })); };
  const [busy, setBusy] = useState(false);
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
    setItems([]); setPending([]); setLive(null); setConvErr(null); stick.current = true;
    if (!id) return;
    let alive = true;
    // 画面が持っている数。Rust は、これより後の発言だけを返す（#10）。増えていなければ items を変えず、描き直さない
    let since: number | null = null;
    const load = async () => {
      try {
        const d = await invoke<ConvDelta>("conversation", { sessionId: id, since });
        if (!alive) return false;
        since = Math.max(since ?? 0, d.total);
        if (d.reset) since = d.total;
        setConvErr(null);
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
  }, [id]);

  // 送ったばかりの文は、送り始めたあとに会話に出たら仮の項目を消す（前の同じ文、「はい」や選択肢では消さない）。
  // 後に送った文が出たら、前に送った仮の項目も消す（#69、送った順と並びを入れ替えない）
  useEffect(() => { setPending((p) => settlePending(items, p)); }, [items, pending.length]);

  // 吹き出しの並びと選択肢は、会話が変わったときだけ作り直す（App の1秒の tick で描き直されても、Bubble の memo が効く）
  const shown = useMemo(() => collapseTools(withResults(withNotes([...items, ...pending], notes))), [items, pending, notes]);
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
  // 承認の欄から答えられるか。答えられるのはブラウザ版（PWA）の ccn の行だけ。アプリが立てたセッションは、端末の承認の画面で答える
  const canAnswer = !!agent.capabilities?.permissions;
  // 同じ名前の人が町にいたら、送信先に ID の先頭8字を添える（#36）。見出しは幅が足りず ID が切れるので名前だけにする
  const target = targetLabel(agent, town);
  /** quick はカードのボタンから送るとき。入力欄の下書きは消さない */
  const send = async (body: string, quick = false) => {
    if (!body.trim() || busy || switching) return false;
    // / で始まる組み込みのコマンドの振り分け（#97、src/composer/route.ts）。使えないものは送らずに理由を出す。
    // ブラウザ版（PWA）の ccn の行のほかは、端末のセッションと同じく振り分けない
    const route = routeOf(body, viaCcn(agent) ? agent.kind : "terminal", support);
    if (route?.kind === "blocked") { onError(route.reason); return false; }
    setBusy(true);
    const after = items[items.length - 1]?.n ?? -1;
    // アプリが立てたセッションは、どの文も端末の入力欄へ貼って Enter を押す（CLI に打ったのと同じ）。
    // ブラウザ版の ccn の行では、先頭が / か ! の文だけを入力欄へ貼る。ccn の send_message は from の1行を前に付けるので、
    // CLI のコマンドやシェルモードとして動かない（docs/research/cli-input.md）
    const plain = !(body.startsWith("!") || isSlashCommand(body));
    const direct = hasTerm && (!viaCcn(agent) || !plain);
    try {
      if (route?.kind === "command") {
        const r = await invoke<unknown>("run_command", { sessionId: agent.id, text: route.text });
        if (!isHttp(r)) throw new Error("ccn の応答が読めなかった");
        const err = commandError(r);
        if (err) {
          if (noRoute(r)) markNoSupport();
          throw new Error(err);
        }
        addNote(agent.id, { role: "event", kind: "command", text: `/${route.name} を実行した${route.note ? `。${route.note}` : ""}`, at: new Date().toISOString(), after });
      } else if (direct) {
        await invoke("send_direct", { sessionId: agent.id, text: body });
        // 画面を開くコマンド（/model など）は、ターミナルで操作してもらう
        if (!plain && opensDialog(body, BUILTINS)) setTab("term");
        if (plain) setPending((p) => [...p, { role: "user", text: body, pending: true, at: new Date().toISOString(), after }]);
      } else {
        await invoke("send_message", { sessionId: agent.id, text: body });
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
        <div className="ap-float">{canAnswer ? <Approval agent={agent} planHint={lastPlan} onDone={(m) => onSent2(m)} onError={onError} /> : <AnswerInTerminal agent={agent} onTerm={() => setTab("term")} />}</div>
      )}
      {mood === "approval" && tab === "term" && canAnswer && (
        <div className="ap-float"><Approval agent={agent} planHint={lastPlan} onDone={(m) => onSent2(m)} onError={onError} /></div>
      )}

      {tab === "term" ? (
        <Suspense fallback={<div className="term-wrap"><div className="term" /></div>}><TerminalView sessionId={agent.id} onError={onError} /></Suspense>
      ) : tab === "talk" ? (<div className="talk-box">
        {/* 会話を読めなかったときの印。会話の欄の流れに入れると欄とグラデーションの始まりがずれるので、欄の上端の中央に重ねる（position: absolute）。
            中身の失敗は title に入れる */}
        {convErr && shown.length > 0 && (
          <span className="offline-note" title={convErr}><i /><span>読めない・最後に読めた履歴</span></span>
        )}
        {/* 印が出ている間は、中身の上に印の高さぶんの余白を足す（上端まで送ったとき、いちばん古い行が印の下に入らない）。外枠とグラデーションの位置は変えない */}
        <ScrollEdgeGradient className={`talk ${hasNote ? "has-note" : ""}`} wrapClassName="seg-fill" ref={scroller}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {convErr && shown.length === 0 && <div className="banner bad small">{convErr}</div>}
          {shown.length === 0 && !convErr && <p className="hint center">まだチャットが無い</p>}
          {shown.map((x, i) => <Bubble key={x.n ?? `p${x.at ?? i}`} item={x} agent={agent} lineageDepth={lineage.length - 1} />)}
          {mood === "working" && live && <LiveLine live={live} turnAt={agent.report?.turn_started_at ?? null} />}
          {mood === "approval" && (canAnswer
            ? <Approval agent={agent} planHint={lastPlan} onDone={(m) => onSent2(m)} onError={onError} />
            : <AnswerInTerminal agent={agent} onTerm={() => setTab("term")} />)}
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
        <Composer key={agent.id} touch={mobile} agent={agent} text={text} setText={setText} busy={busy || switching} running={mood === "working"} support={support} onSubmit={send} onError={onError} />
      </div>}
    </aside>
  );
}

/**
 * 承認待ちで、ここからは答えられないとき（ブラウザ版の ccn の行のほか全部）。承認は端末の承認の画面で答える。
 * アプリが立てたセッションなら、ターミナルのタブを開くボタンを出す。外で起動したセッションは、起動した端末で答える
 */
function AnswerInTerminal({ agent, onTerm }: { agent: Agent; onTerm: () => void }) {
  const mine = !!agent.capabilities?.terminal;
  return (
    <div className="ap ap-term">
      <p className="hint">{mine ? "承認を待っている。ターミナルの承認の画面で答える。" : "承認を待っている。このセッションは Claude Town の外で起動したので、起動した端末で答える。"}</p>
      {mine && <button className="primary" onClick={onTerm}>ターミナルを開く</button>}
    </div>
  );
}

// ---------- 新しい世帯 ----------

/** 町が空のときの「最初の世帯を作る」。最初の依頼の欄は出さず、すぐ ~/Documents/meta で親（端末のセッション）を立て、右のチャットを開く。
 *  ふだんの作る口は左の新しい世帯のペイン（#89、src/newHouse） */
function NewHousehold({ big, place, onCreated, onError }: { big?: boolean; place: string | null; onCreated: (r: any) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      // 前に開いたターミナルの大きさで起動する。開いた直後に大きさを変えて、claude が全部描き直すのを省く（createHousehold の中）
      onCreated(await createHousehold(place));
    } catch (e) { onCreated(null); onError(placeFailure(place, e)); } finally { setBusy(false); }
  };
  return (
    <button className={big ? "primary new-house big" : "pane-btn new-house"} disabled={busy} onClick={go}>
      {busy ? "立てている…" : big ? "最初の世帯を作る" : "＋ 新しい世帯"}
    </button>
  );
}


/**
 * 作業中の末尾の1行（#59）。結果がまだ無い道具か「考え中」と、その動きを始めてからの経過、ターン全体の経過を出す。
 * 1秒の時計はこの部品の中だけで回す。ほかの吹き出しは描き直さない。ウィンドウが見えていない間は止める（#6）
 */
const LiveLine = memo(function LiveLine({ live, turnAt }: { live: Live; turnAt: number | null }) {
  const [, bump] = useState(0);
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (t === null) t = setInterval(() => bump((x) => x + 1), 1000); };
    const stop = () => { if (t !== null) { clearInterval(t); t = null; } };
    const off = onVisibleChange((v) => { if (v) { bump((x) => x + 1); start(); } else stop(); });
    if (isVisible()) start();
    return () => { off(); stop(); };
  }, []);
  const sum = liveSummary(live);
  const now = Date.now();
  const turn = turnAt ?? msOf(live.turn_at);
  return (
    <div className="live-line" aria-live="off">
      <div className="ll-main">
        <i className="ll-dot" />
        <span className="ll-label">{sum.label}</span>
        <span className="ll-time">
          {sum.since != null && <>{elapsedText(now - sum.since)}</>}
          {turn != null && <>{sum.since != null ? " · " : ""}このターン {elapsedText(now - turn)}</>}
        </span>
      </div>
      {sum.heads.map((h, i) => <div key={i} className="ll-head">{h}</div>)}
    </div>
  );
});

/** 道具の行が続いたら1行にまとめる。まとめた行の n は最初の行の n にする（後ろに道具が増えても key が変わらない） */
type Shown = ConvItem & { more?: number; group?: ConvItem[]; done?: number };
function collapseTools(items: ConvItem[]): Shown[] {
  const out: Shown[] = [];
  for (const x of items) {
    const last = out[out.length - 1];
    if (x.role === "tool" && last?.role === "tool") {
      const group = [...(last.group ?? [last]), x];
      out[out.length - 1] = { ...x, n: last.n, more: (last.more ?? 0) + 1, group, done: group.filter((g) => g.result).length };
    } else out.push(x.role === "tool" ? { ...x, group: [x], done: x.result ? 1 : 0 } : x);
  }
  return out;
}

/**
 * 後から届いた道具の結果（role が result の項目）を、同じ id の道具の行に付け直し、結果の項目は外す（#83）。
 * Rust は、同じ読み出しで届いた結果を初めから道具の行に付けて渡す
 */
function withResults(items: ConvItem[]): ConvItem[] {
  if (!items.some((x) => x.role === "result")) return items;
  const late = new Map<string, { text: string; error: boolean }>();
  for (const x of items) if (x.role === "result" && x.id) late.set(x.id, { text: x.text, error: !!x.error });
  return items.filter((x) => x.role !== "result").map((x) => (x.role === "tool" && !x.result && x.id && late.has(x.id) ? { ...x, result: late.get(x.id) } : x));
}

/** 時刻の書式。toLocaleTimeString は呼ぶたびに ICU の書式を作り直すので、1つを使い回す（#10） */
const HM = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
/** at は node のセッションなら ISO の文字列、pty のセッションなら ms の数 */
function timeOf(at?: string | number | null): string {
  chatPerf.time++;
  if (!at) return "";
  const d = new Date(at);
  return isNaN(+d) ? "" : HM.format(d);
}

type BubbleProps = { item: Shown; agent: Agent; lineageDepth: number };
/**
 * 吹き出しは、中身か見た目に使う値が変わったときだけ描き直す（#10）。
 * agent は一覧を取るたびに別の物になるので、使う値（id、名前、cwd、絵）だけを比べる。
 * まとめた道具の行は毎回作り直すので、n と件数と文で比べる
 */
const Bubble = memo(BubbleView, (a: BubbleProps, b: BubbleProps) =>
  (a.item === b.item || (a.item.n != null && a.item.n === b.item.n && a.item.more === b.item.more && a.item.done === b.item.done && a.item.text === b.item.text && a.item.pending === b.item.pending))
  && a.lineageDepth === b.lineageDepth
  && a.agent.id === b.agent.id && a.agent.name === b.agent.name && a.agent.cwd === b.agent.cwd
  && a.agent.avatar?.char === b.agent.avatar?.char && a.agent.avatar?.hue === b.agent.avatar?.hue);

/**
 * 道具の行。結果が届いた道具があれば、押すと開いて、道具ごとの1行と結果の頭を出す（#83）。
 * 続いた道具は1行にまとめたまま（「ほか N 件」）。結果が1つも無いうちは開けない
 */
function ToolLine({ item }: { item: Shown }) {
  const group = item.group ?? [item];
  const head = <>🔧 {linkify(item.text)}{item.more ? ` ほか${item.more}件` : ""}</>;
  if (!item.done) return <div className="tool-line">{head}</div>;
  const bad = group.some((g) => g.result?.error);
  return (
    <details className="tool-line tool-open">
      <summary>{head}{bad && <span className="tl-bad">失敗あり</span>}</summary>
      <div className="tl-list">
        {group.map((g, i) => (
          <div key={g.id ?? i} className="tl-item">
            <div className="tl-name">{linkify(g.text)}{g.result?.error && <span className="tl-bad">失敗</span>}</div>
            {g.result ? (g.result.text ? <pre className={`tl-out${g.result.error ? " bad" : ""}`}>{g.result.text}</pre> : <div className="hint">（出力なし）</div>) : <div className="hint">結果を待っている</div>}
          </div>
        ))}
      </div>
    </details>
  );
}

function BubbleView({ item, agent, lineageDepth }: BubbleProps) {
  chatPerf.bubble++;
  if (item.role === "tool" && item.sent) return <SentLetter item={item} agent={agent} lineageDepth={lineageDepth} />;
  if (item.role === "tool") return <ToolLine item={item} />;
  if (item.role === "event") return <div className={`turn-event te-${item.kind ?? "error"}`}>{item.kind === "interrupted" ? "⏹ " : item.kind === "command" ? "" : "⚠️ "}{item.text}<span className="te-at">{timeOf(item.at)}</span></div>;
  if (item.role === "result") return null;
  if (item.role === "user" && item.letter) return <LetterBubble item={item} />;
  if (item.role === "user") {
    const who = item.from ? fromLabel(item.from) : null;
    return (
      <div className={`msg me ${item.pending ? "pending" : ""}`}>
        <div className="meta">{who && <span className="from">{who}</span>}{item.pending ? "届けた・まだ読まれていない" : timeOf(item.at)}</div>
        <div className="b"><Markdown text={item.text} /></div>
      </div>
    );
  }
  return (
    <div className="msg kid">
      <div className="mini-av"><Avatar pick={agent.avatar} seed={agent.id} mood="idle" role={roleOf(lineageDepth)} size={32} /></div>
      <div>
        <div className="meta"><b>{agent.name}</b>{timeOf(item.at)}</div>
        <div className="b"><Markdown text={item.text} /></div>
      </div>
    </div>
  );
}

/** お手紙の相手（送り手か宛先）を町の一覧から引く。見つからなければ null */
function useLetterPeer(raw: string | null | undefined, name?: string | null): Agent | null {
  const town = useContext(TownCtx);
  const sid8 = raw?.match(/^[^/\s]+\/([0-9a-f]{8})/i)?.[1] ?? null;
  const id = resolve(raw, town) ?? resolve(sid8, town) ?? resolve(name, town);
  return (id && town.find((a) => a.id === id)) || null;
}

/**
 * 受け取ったお手紙。並びは普通の発言と同じ（顔、名前と時刻、吹き出し）で、吹き出しの色だけ肌色にする（2026-11-12 本人の指示）。
 * 顔は送り手のキャラ（町と同じ絵）。送り手が町にいなければ、名前から決まる仮の顔
 */
function LetterBubble({ item }: { item: ConvItem }) {
  const raw = item.letter?.fromRaw ?? null;
  const who = useLetterPeer(raw, item.letter?.fromName);
  const name = who?.name ?? item.letter?.fromName ?? raw?.match(/^[^/\s]+\/([0-9a-f]{8})/i)?.[1] ?? "別のセッション";
  return <LetterView pick={who?.avatar} seed={who?.id ?? name} role={who?.parent ? "child" : "parent"} name={name} at={item.at} text={item.text} />;
}

/** 送ったお手紙。このセッション自身の発言として出し、名前の行に宛先（→ 名前）を添える。吹き出しは肌色 */
function SentLetter({ item, agent, lineageDepth }: { item: ConvItem; agent: Agent; lineageDepth: number }) {
  const s = item.sent!;
  const who = useLetterPeer(s.to ?? null, s.to ?? null);
  const to = s.create ? "新しい子" : who?.name ?? (s.to ? String(s.to).replace(/^uds:.*\/(\d+)\.sock$/, "pid $1") : "相手");
  return <LetterView pick={agent.avatar} seed={agent.id} role={roleOf(lineageDepth)} name={agent.name} to={`→ ${to}${s.peer ? `（${s.peer}）` : ""}`} at={item.at} text={s.text || s.summary || ""} />;
}

type LetterViewProps = { pick?: Agent["avatar"]; seed: string; role: Role; name: string; to?: string; at?: string | number | null; text: string };
/**
 * お手紙の吹き出しの見た目。お手紙の相手は町の一覧（TownCtx）から引くので、一覧を取るたびに上の2つは描き直される。
 * 見た目に使う値が変わらなければ、ここで止める（#10）
 */
const LetterView = memo(function LetterView({ pick, seed, role, name, to, at, text }: LetterViewProps) {
  chatPerf.bubble++;
  return (
    <div className="msg kid letter">
      <div className="mini-av"><Avatar pick={pick} seed={seed} mood="idle" role={role} size={32} /></div>
      <div>
        <div className="meta"><b>{name}</b>{to && <span className="to">{to}</span>}{timeOf(at)}</div>
        <div className="b"><Markdown text={text} /></div>
      </div>
    </div>
  );
}, (a, b) => a.seed === b.seed && a.role === b.role && a.name === b.name && a.to === b.to && a.at === b.at && a.text === b.text
  && a.pick?.char === b.pick?.char && a.pick?.hue === b.pick?.hue);

function fromLabel(from: string): string {
  // "from agent:<名前> via <ノード>" / "from local via <ノード>" / "from <メール> via <ノード>"
  const m = from.match(/^from (\S+) via (\S+)/);
  if (!m) return from;
  if (m[1] === "local") return "このアプリから";
  if (m[1].startsWith("agent:")) return `${m[1].slice(6)} から`;
  return `${m[2]} から`;
}

function StateTab({ agent, mood }: { agent: Agent; mood: Mood }) {
  const r = agent.report;
  const rows: [string, React.ReactNode][] = [
    ["いま", nowOf(agent, mood)],
    ["頼まれたこと", r?.asked],
    ["最後の報告", r?.said],
    ["次の一手", r?.next],
    ["閉じていい？", agent.closeCheck ? (agent.closeCheck.status === "ok" ? "閉じてOK" : agent.closeCheck.status === "ng" ? `まだ: ${agent.closeCheck.short ?? ""}` : "判定中") : null],
    ["作業中の時間", mood === "working" && r?.turn_started_at ? <Since at={r.turn_started_at} /> : null],
    ["アカウント", accountText(agent)],
    ["場所", agent.cwd.replace(/^\/Users\/[^/]+/, "~")],
    ["セッション", agent.id],
  ];
  return (
    <ScrollEdgeGradient className="state-scroll" wrapClassName="seg-fill"><dl className="state-tab">
      {rows.filter(([, v]) => v).map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{typeof v === "string" ? linkify(v) : v}</dd></div>))}
      {!r && <p className="hint">状態 hook が入っていないので、頼まれたことと次の一手は出ない（README の「hook」を参照）。</p>}
    </dl></ScrollEdgeGradient>
  );
}

// ---------- 素材のクレジット ----------

/** 素材の表示と、キャラの見た目（いつもの / ポケモン）の切り替え。見た目で使う素材が変わるので同じ所に置く */
function Credits({ skin, onSkin }: { skin: Skin; onSkin: (s: Skin) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="credits">
      <button className="credit-btn" onClick={() => setOpen((o) => !o)}>素材</button>
      {open && (
        <span className="credit-pop" onMouseLeave={() => setOpen(false)}>
          <span className="skin-pick" title="ポケモンでは、親を最終進化、子を2段目、孫を1段目で描く">
            キャラの見た目
            {([["default", "いつもの"], ["pokemon", "ポケモン"]] as const).map(([v, label]) => (
              <button key={v} className={skin === v ? "on" : ""} onClick={() => onSkin(v)}>{label}</button>
            ))}
          </span>
          <b>キャラ</b>: Ninja Adventure Asset Pack（Pixel-boy、AAA）、CC0 1.0。
          <br /><b>状態の印、幽霊、お手紙</b>: Animated emoji: Noto Animated Emoji by Google, licensed under CC BY 4.0
          （creativecommons.org/licenses/by/4.0）。Source: googlefonts.github.io/noto-emoji-animation
          <br />キャラは配布元のファイルのまま表示のときに縮めている。Noto は 64px に縮め、コマを半分に間引いた。
          {skin === "pokemon" && (<>
            <br /><b>ポケモン（キャラの見た目で選んだとき）</b>: ブラック・ホワイトの形の2Dのドット絵（アニメ GIF と止め絵）を、PokeAPI/sprites（github.com/PokeAPI/sprites）の配布から
            {"表示中のキャラの分だけ実行時に読む。このアプリには画像を含めない。Pokémon © Nintendo / Creatures Inc. / GAME FREAK inc."}
          </>)}
        </span>
      )}
    </span>
  );
}

// ---------- 小さい絵 ----------

function HouseIcon() {
  return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M3 11 12 3l9 8" /><path d="M5 10v10h14V10" /><path d="M10 20v-5h4v5" /></svg>);
}
function DocIcon() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 3h8l4 4v14H6z" /><path d="M9 12h6M9 16h6" /></svg>);
}
