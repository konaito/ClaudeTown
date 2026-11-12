import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { call as invoke, setFullscreen } from "./bridge";
import { TerminalView, lastTermSize } from "./term/TerminalView";
import { perfMark, perfSetId, perfStart } from "./term/perf";
import { benchName, useBench } from "./term/bench";
import { collectMail, type Mail } from "./mail";
import { flightsOf, resolve, type Flight } from "./letters";
import { withGhosts } from "./ghost";
import { ScrollEdgeGradient } from "./ScrollEdgeGradient";
import { Group as SplitGroup, Panel as SplitPanel, Separator, type Layout } from "react-resizable-panels";
import "./App.css";
import { Avatar, hash as hashOf, type Role } from "./kid/Avatar";
import {
  type Agent, type ConvItem, type Mood, type Peer, type Snapshot,
  MOOD_LABEL, NEEDS_YOU, buildTree, cardNames, choicesOf, houseNameOf, moodOf, nowOf, sinceText, targetLabel, taskOf,
} from "./model";
import { Markdown } from "./Markdown";
import { chatPerf } from "./chatPerf";
import { mergeConv, savedLabel, type ConvCache, type ConvDelta } from "./conv";
import { layoutFamily, type LNode } from "./layout/layout";
import { LAYOUT, boxOf, groupSizeOf } from "./layout/params";
import { packHouseholds } from "./layout/pack";

const POLL_MS = 2000;
/** 新しい世帯の端末が開くまで、打ったキーをためておく上限の時間 */
const BOOT_TIMEOUT_MS = 12000;
/**
 * 別の町（いま見ていない ccn のノード）のお便りを取りに行く間隔。町を1つずつ順に取り、前の回が終わるまで次の回を始めない。
 * 1回は町1つにつき手元のノード経由の GET /api/sessions 1本（中継先の ccn には 15 秒に1本）。peers が healthy でない町には取りに行かない。
 * 実測（2026-11-12）: 中継で incertotech 0.42 秒、vm 0.46 秒
 */
const OTHER_TOWNS_POLL_MS = 15000;
/** 別の町の一覧が取れなかったとき、前回の町を残す長さ */
const OTHER_TOWN_KEEP_MS = 60000;
/** 右パネルの幅（px）。最小と既定。最大はウィンドウ幅の半分（maxSize="50%"） */
const SIDE_MIN = 380;
const SIDE_DEFAULT = 380;
const SPLIT_KEY = "claude-town.split";
/** 前回の境目の位置。次に起動したときも同じにする */
function savedSplit(): Layout | undefined {
  try { const v = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? "null"); return v && typeof v === "object" ? v : undefined; } catch { return undefined; }
}
function saveSplit(l: Layout) { try { localStorage.setItem(SPLIT_KEY, JSON.stringify(l)); } catch { /* 保存できなくても動きは変えない */ } }
/** 閉じる演出の長さ（ms）。CSS の kill-* と合わせる */
const KILL_MS = 1150;
/** 子孫を葉から順に倒すときのずらし（ms） */
const KILL_STAGGER = 140;

/** 閉じる操作と演出の状態。カードの × と、倒れる演出が読む */
/** いま見ている町のセッション（お手紙の送り手の名前を引くため） */
const TownCtx = createContext<Agent[]>([]);
/** 封筒の印（💌）を頭に出しているセッション */
const LetterCtx = createContext<Set<string>>(new Set());
const KillCtx = createContext<{ dying: Map<string, number>; ask: (a: Agent, instant: boolean) => void }>({ dying: new Map(), ask: () => {} });
const CONV_POLL_MS = 2500;

type Toast = { id: number; text: string; bad?: boolean };

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [peer, setPeer] = useState<string>("");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [, tick] = useState(0);

  const toast = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 6000 : 2600);
  }, []);

  useEffect(() => {
    invoke<Peer[]>("peers").then((p) => setPeers(Array.isArray(p) ? p : [])).catch(() => {});
  }, []);

  const reload = useRef<() => void>(() => {});
  // 一覧の取得が続けて失敗している数と、失敗し始めた時刻。1回の失敗では町を描き直さない
  // （2026-11-12、ノードが一瞬詰まって一覧の取得が時間切れになり、町が「0世帯・0人」になった）
  const [fail, setFail] = useState<{ n: number; since: number; msg: string } | null>(null);
  useEffect(() => {
    let alive = true;
    let running = false;
    const want = peer || null;
    setFail(null);
    // 失敗したら、同じ町の前回の一覧があればそれを出し続ける。無いときだけ、失敗した一覧（空の町と赤い帯）を出す
    const failed = (msg: string, s?: Snapshot) => {
      setFail((f) => ({ n: (f?.n ?? 0) + 1, since: f?.since ?? Date.now(), msg }));
      setSnap((prev) => (prev?.ccn_ok && (prev.peer ?? null) === want ? prev : s ?? prev));
      if (!s) setErr((e) => e ?? msg);
    };
    const load = async () => {
      // 前の回の取得が終わるまで次を始めない（時間切れまで待つ回があると、要求が積み重なる）
      if (running) return;
      running = true;
      try {
        const s = await invoke<Snapshot>("snapshot", { peer: want });
        if (!alive) return;
        if (s.ccn_ok) { setSnap(s); setErr(null); setFail(null); }
        else failed(s.ccn_error ?? "ccn につながらない", s);
      } catch (e) {
        if (alive) failed(String(e));
      } finally {
        running = false;
      }
    };
    reload.current = load;
    load();
    const t = setInterval(load, POLL_MS);
    const c = setInterval(() => tick((x) => x + 1), 1000);
    return () => { alive = false; clearInterval(t); clearInterval(c); };
  }, [peer]);

  // 閉じたセッション。演出が終わったら隠し、ccn の一覧から消えたら忘れる（10秒たっても消えなければ戻して失敗を出す）
  const [dying, setDying] = useState<Map<string, number>>(new Map());
  const [hidden, setHidden] = useState<Map<string, number>>(new Map());
  const [killAsk, setKillAsk] = useState<Agent | null>(null);
  const agents = useMemo(() => (snap?.agents ?? []).filter((a) => !hidden.has(a.id)), [snap, hidden]);
  useEffect(() => {
    if (!snap || hidden.size === 0) return;
    const present = new Set(snap.agents.map((a) => a.id));
    const now = Date.now();
    const stuck = [...hidden].filter(([id, at]) => present.has(id) && now - at > 10000).map(([id]) => id);
    const gone = [...hidden.keys()].filter((id) => !present.has(id));
    if (!stuck.length && !gone.length) return;
    setHidden((h) => { const n = new Map(h); for (const id of [...stuck, ...gone]) n.delete(id); return n; });
    if (stuck.length) toast(`止まらなかった: ${stuck.map((id) => snap.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8)).join("、")}`, true);
  }, [snap]);
  // 別の町のお便り。町の表示はいま選んだノードだけで、お便りは全部の町から集める
  const selfName = peers.find((p) => p.self)?.name ?? "このMac";
  const curTown = peer || selfName;
  const [others, setOthers] = useState<Map<string, { agents: Agent[]; at?: number } | { error: string }>>(new Map());
  useEffect(() => {
    let alive = true;
    let running = false;
    const towns: { key: string; name: string; healthy: boolean }[] = [
      { key: "", name: selfName, healthy: true },
      ...peers.filter((p) => !p.self).map((p) => ({ key: p.name, name: p.name, healthy: p.status === "healthy" })),
    ].filter((t) => t.key !== peer);
    setOthers((m) => new Map([...m].filter(([name]) => towns.some((t) => t.name === name))));
    const load = async () => {
      if (running) return;
      running = true;
      for (const t of towns) {
        let v: { agents: Agent[]; at?: number } | { error: string };
        if (!t.healthy) v = { error: "つながらない" };
        else {
          try {
            const s = await invoke<Snapshot>("snapshot", { peer: t.key || null });
            v = s.ccn_ok ? { agents: s.agents, at: Date.now() } : { error: s.ccn_error ?? "つながらない" };
          } catch (e) { v = { error: String(e) }; }
        }
        if (!alive) break;
        // 取れなかった回は、60秒以内に取れた前回の町を残す（1回の時間切れで、お便りとゴーストが消えないように）
        setOthers((m) => {
          const prev = m.get(t.name);
          if ("error" in v && prev && "agents" in prev && Date.now() - (prev.at ?? 0) < OTHER_TOWN_KEEP_MS) return m;
          return new Map(m).set(t.name, v);
        });
      }
      running = false;
    };
    load();
    const timer = setInterval(load, OTHER_TOWNS_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [peer, peers, selfName]);
  // 木を作るときだけ、転出のゴースト（別の町にいる親子の影）を足す。お便りや数には入れない
  const otherTowns = useMemo(() => [...others].flatMap(([town, v]) => ("agents" in v ? [{ town, agents: v.agents }] : [])), [others]);
  const tree = useMemo(() => buildTree(withGhosts({ town: curTown, agents }, otherTowns)), [agents, otherTowns, curTown]);
  /** ゴーストを押したら、本物がいる町に切り替えてその子を選ぶ */
  const pick = useCallback((a: Agent) => {
    if (!a.ghost) { setSelected(a.id); return; }
    setPeer(a.ghost.town === selfName ? "" : a.ghost.town);
    setSelected(a.ghost.realId);
  }, [selfName]);

  /** a とその子孫を、葉から順に止める。倒れる演出も葉から少しずつずらして出す */
  const kill = useCallback(async (a: Agent) => {
    const order: Agent[] = [];
    // ゴースト（別の町にいる本物の影）は閉じない
    const walk = (x: Agent) => { for (const k of tree.childrenOf.get(x.id) ?? []) if (!k.ghost) walk(k); order.push(x); };
    walk(a);
    const targets = order.filter((x) => x.capabilities?.stop);
    const skipped = order.filter((x) => !x.capabilities?.stop);
    setDying((m) => { const n = new Map(m); targets.forEach((x, i) => n.set(x.id, i * KILL_STAGGER)); return n; });
    if (selected && targets.some((x) => x.id === selected)) setSelected(null);
    const failed: Agent[] = [];
    for (const x of targets) {
      try { await invoke("stop_session", { sessionId: x.id, peer: peer || null }); }
      catch { failed.push(x); }
    }
    const ok = targets.filter((x) => !failed.includes(x));
    // 止まらなかった分は演出を戻す。止まった分は演出が終わったら隠す
    setDying((m) => { const n = new Map(m); for (const x of failed) n.delete(x.id); return n; });
    const last = (targets.length - 1) * KILL_STAGGER + KILL_MS;
    setTimeout(() => {
      setHidden((h) => { const n = new Map(h); for (const x of ok) n.set(x.id, Date.now()); return n; });
      setDying((m) => { const n = new Map(m); for (const x of ok) n.delete(x.id); return n; });
    }, last);
    if (failed.length) toast(`止められなかった: ${failed.map((x) => x.name).join("、")}`, true);
    else toast(`${a.name}${order.length > 1 ? ` と子孫 ${order.length - 1} 人` : ""}を閉じた`);
    if (skipped.length) toast(`ccn から止められないので残した: ${skipped.map((x) => x.name).join("、")}`, true);
  }, [tree, selected, peer, toast]);
  // お手紙。この機械の町を見ているときだけ（記録はこの機械の hook が書く）
  const flights = useMemo(() => (peer ? [] : flightsOf(snap?.letters ?? [], agents)), [snap, agents, peer]);
  const letterMarks = useLetterMarks(flights);
  const askKill = useCallback((a: Agent, instant: boolean) => { if (instant) kill(a); else setKillAsk(a); }, [kill]);
  const killCtx = useMemo(() => ({ dying, ask: askKill }), [dying, askKill]);
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

  const mails = useMemo(() => collectMail([
    { town: curTown, agents },
    ...[...others].flatMap(([town, v]) => ("agents" in v ? [{ town, agents: v.agents }] : [])),
  ]), [agents, others, curTown]);
  const unreachable = useMemo(() => [...others].filter(([, v]) => "error" in v).map(([t]) => t), [others]);
  const openMail = useCallback((m: Mail, chat = false) => {
    if (m.town !== curTown) setPeer(m.town === selfName ? "" : m.town);
    setSelected(m.agent.id);
    if (chat) setChatReq((n) => n + 1);
  }, [curTown, selfName]);

  const local = !peer;
  // 新しい世帯を作った直後、端末が開くまでに打ったキーをためておく（端末が最初の出力を受けたら流す）
  const early = useRef<{ id: string | null; text: string }>({ id: null, text: "" });
  const [booting, setBooting] = useState<string | null>(null);
  // 起動待ちをやめ、ためた文字を捨てる。why があれば、捨てた文字があるときだけ知らせる
  // （2026-11-12、本番のノードに端末の口が無く最初の出力が来ないまま booting が残り、英字が全部食われた）
  const release = useCallback((why?: string) => {
    const had = early.current.text;
    early.current = { id: null, text: "" };
    setBooting(null);
    if (why && had) toast(`${why}。打った文字（${had.length}字）は捨てた`, true);
  }, [toast]);
  useEffect(() => {
    if (!booting) return;
    // 端末が開かないまま残らないよう、時間切れで必ずやめる
    const t = setTimeout(() => release(`ターミナルが ${BOOT_TIMEOUT_MS / 1000} 秒たっても開かなかった`), BOOT_TIMEOUT_MS);
    const editable = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);
    const k = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const el = document.activeElement;
      // 端末（xterm）にフォーカスが移った後は、xterm が自分で受ける
      if ((el as HTMLElement | null)?.closest?.(".term")) return;
      // 入力欄に移ったら、横取りをやめる
      if (editable(el)) { release(); return; }
      const map: Record<string, string> = { Enter: "\r", Backspace: "\x7f", Tab: "\t", Escape: "\x1b" };
      const t = e.key.length === 1 ? e.key : map[e.key];
      if (!t) return;
      e.preventDefault();
      early.current.text += t;
    };
    window.addEventListener("keydown", k, true);
    return () => { clearTimeout(t); window.removeEventListener("keydown", k, true); };
  }, [booting, release]);
  // 押した瞬間からキーをためる（作り終わるのを待つと、その間に打ったキーが落ちる）
  const startHousehold = useCallback(() => { early.current = { id: "pending", text: "" }; setBooting("pending"); }, []);
  // 作った直後のセッション。一覧（snapshot）に載るまでは、create の応答から作った仮の姿で右パネルとターミナルを出す（#18）。
  // 一覧の取り直しを待つと、ccn が遅いときにその分だけターミナルが開かない
  const [fresh, setFresh] = useState<Agent | null>(null);
  const newHousehold = useCallback((r: any) => {
    if (!r?.id) { early.current = { id: null, text: "" }; setBooting(null); return; }
    early.current = { id: r.id, text: early.current.id === "pending" ? early.current.text : "" };
    setFresh({
      // 名前は一覧と同じ決め方（cardNames）。一覧に載ったときに名前が変わって見えないようにする
      id: r.id, name: cardNames([{ id: r.id, cwd: r.cwd ?? "" }]).get(r.id) ?? r.id.slice(0, 8), kind: "terminal", state: "running", cwd: r.cwd ?? "", canSend: true, parent: null,
      startedAt: Date.now(), capabilities: { terminal: true, send: true, stop: true },
    });
    setBooting(r.id);
    setSelected(r.id);
    setTermReq((n) => n + 1);
    reload.current();
  }, []);
  // 作った世帯に端末が無い（ノードに PTY の口がまだ無い）と分かったら、すぐやめる
  useEffect(() => {
    if (!booting || booting === "pending") return;
    const a = agents.find((x) => x.id === booting);
    if (a && !a.capabilities?.terminal) release("このノードにはターミナルの口がまだ無い。チャットの欄から話しかけて");
  }, [agents, booting, release]);
  // 別のノードや別の子を選んだら、起動待ちをやめる
  useEffect(() => { if (booting) release(); }, [peer]);
  useEffect(() => { if (booting && booting !== "pending" && selected !== booting) release(); }, [selected]);
  const takeEarly = useCallback((id: string) => {
    if (early.current.id !== id) return "";
    const t = early.current.text;
    early.current = { id: null, text: "" };
    setBooting(null);
    return t;
  }, []);

  // 右クリックや「端末へ」で、その子を選んで右パネルの端末を開く
  const [termReq, setTermReq] = useState(0);
  // お便りの「チャットへ」で、その子を選んで右パネルのチャットを開く
  const [chatReq, setChatReq] = useState(0);
  const focus = useCallback((a: Agent) => { perfStart("open", a.id); setSelected(a.id); setTermReq((n) => n + 1); }, []);
  // 前回の町を出したまま、3回続けて、または10秒以上失敗している
  const slow = !!fail && (fail.n >= 3 || Date.now() - fail.since > 10000);
  const sel = selected ? tree.byId.get(selected) ?? (fresh?.id === selected ? fresh : null) : null;
  // 一覧に載ったら仮の姿を捨てる
  useEffect(() => { if (fresh && tree.byId.has(fresh.id)) setFresh(null); }, [tree, fresh]);
  useEffect(() => { if (sel) perfMark("listed", sel.id); }, [sel?.id]);
  useBench({ ready: !!snap, select: setSelected, focusId: (id) => { const a = tree.byId.get(id); if (a) focus(a); } });
  const selfPeer = peers.find((p) => p.self);

  return (
    <KillCtx.Provider value={killCtx}>
    <LetterCtx.Provider value={letterMarks.marks}>
    <TownCtx.Provider value={agents}>
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <header className="top">
        <div className="brand">
          <HouseIcon />
          <h1>Claude Town</h1>
        </div>
        <div className="top-mid">
          <select className="node" value={peer} onChange={(e) => { setPeer(e.target.value); setSelected(null); }}>
            <option value="">このMac{selfPeer ? `（${selfPeer.name}）` : ""}</option>
            {peers.filter((p) => !p.self).map((p) => (
              <option key={p.name} value={p.name} disabled={p.status !== "healthy"}>{p.name}{p.status !== "healthy" ? "（つながらない）" : ""}</option>
            ))}
          </select>
          <span className={`conn ${!snap?.ccn_ok ? "bad" : slow ? "slow" : "ok"}`} title={fail?.msg ?? ""}><i />{snap ? (!snap.ccn_ok ? "つながらない" : slow ? "つながりにくい" : "接続中") : "よみこみ中"}</span>
        </div>
        <div className="top-right" />
      </header>

      <SplitGroup className="body" orientation="horizontal" defaultLayout={savedSplit()} onLayoutChanged={saveSplit}>
        <SplitPanel id="town" minSize="50%">
        <div className="left">
          <NextRow mails={mails} curTown={curTown} unreachable={unreachable} working={counts.working} total={agents.length} onOpen={openMail} />

          {((err && !snap?.ccn_ok) || (snap && !snap.ccn_ok)) && (
            <div className="banner bad">
              {err ?? snap?.ccn_error}
              {snap?.cached_at && <span>{savedLabel(snap.cached_at)} に保存した一覧と会話を出している</span>}
              <span className="hint">次: ターミナルで <code>ccn doctor</code> を実行する</span>
            </div>
          )}

          <div className="fam-head">
            <span className="fam-title"><PeopleIcon /> {tree.families.length}世帯・{agents.length}人</span>
            <NewHousehold disabled={!local} onStart={startHousehold} onCreated={newHousehold} onError={(m) => toast(m, true)} />
            <span className="legend">
              {(["working", "reply", "approval", "done", "idle"] as Mood[]).map((m) => (
                <span key={m} className={`lg lg-${m}`}><i />{MOOD_LABEL[m]}{counts[m] ? ` ${counts[m]}` : ""}</span>
              ))}
            </span>
          </div>

          {snap && agents.length === 0 && snap.ccn_ok && (
            <div className="empty">
              <p>町にはまだ誰もいない。最初の世帯を作ると、右にターミナルが開いてすぐ打てる（親は ~/Documents/meta で起動する）。</p>
              <NewHousehold big disabled={!local} onStart={startHousehold} onCreated={newHousehold} onError={(m) => toast(m, true)} />
            </div>
          )}
          <Stage zoom={zoom} onBlank={() => setSelected(null)} items={tree.families.map((f) => {
            const r = layoutOf(f.all);
            const size = groupSizeOf(r.metrics);
            return {
              id: f.root.id, ...size,
              node: (
                <Group root={f.root} all={f.all} count={f.all.length} size={size}
                  onRename={async (name) => {
                    try { await invoke("set_house_name", { sessionId: f.root.id, name }); toast(name ? `世帯の名前を「${name}」にした` : "世帯の名前を戻した"); }
                    catch (e) { toast(`世帯の名前を変えられなかった: ${e}`, true); }
                  }}
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
            <Credits />
          </div>
        </div>

        </SplitPanel>
        {/* 町と右パネルの境目。ドラッグで右パネルを 380px からウィンドウ幅の半分まで広げられる。ダブルクリックで既定の幅に戻る */}
        <Separator className="split-handle" />
        <SplitPanel id="side" defaultSize={SIDE_DEFAULT} minSize={SIDE_MIN} maxSize="50%">
        <Panel agent={sel} peer={peer} lineage={sel ? tree.lineage(sel) : []} descendants={sel ? descOf(tree.childrenOf, sel.id) : []} termReq={termReq} chatReq={chatReq} peers={peers} takeEarly={takeEarly} booting={booting}
          onSent={(a) => toast(`${a.name} に届けた`)} onSent2={(m) => toast(m)} onError={(m) => toast(m, true)}
          needs={needs} onSelect={(a) => setSelected(a.id)} />
        </SplitPanel>
      </SplitGroup>

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
    </KillCtx.Provider>
  );
}

function descOf(childrenOf: Map<string, Agent[]>, id: string): Agent[] {
  return (childrenOf.get(id) ?? []).filter((k) => !k.ghost).flatMap((k) => [k, ...descOf(childrenOf, k.id)]);
}

// ---------- お手紙 ----------

const LETTER_IMG = "/sprites/noto/1f48c/512.webp";
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
    fresh.forEach((f, i) => {
      seen.current!.add(f.id);
      const land = () => setMarks((m) => new Map(m).set(f.to, { flight: f.id, until: Date.now() + (f.readAt ? MARK_READ_MS : MARK_MAX_MS) }));
      const a = document.querySelector(`[data-aid="${f.from}"]`)?.getBoundingClientRect();
      const toEl = document.querySelector<HTMLElement>(`[data-aid="${f.to}"]`);
      const b = toEl?.getBoundingClientRect();
      if (reduce || !a || !b || !layer.current) { land(); return; }
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

/** 閉じる前の確認。Enter で閉じる、Esc でやめる */
function KillConfirm({ agent, descendants, onCancel, onConfirm }: { agent: Agent; descendants: number; onCancel: () => void; onConfirm: () => void }) {
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
        <div className="modal-title">{agent.name}{descendants ? ` と子孫 ${descendants} 人` : ""}を閉じる？</div>
        <p className="hint">ccn でセッションを止める。{descendants ? "子孫は孫から順に止める。" : ""}止まらなかった分は画面に残る。⌘ を押しながら × を押すと、確認なしで閉じる。</p>
        <div className="modal-btns">
          <button className="pane-btn" onClick={onCancel}>やめる（Esc）</button>
          <button className="danger" autoFocus onClick={onConfirm}>閉じる（Enter）</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 上の段 ----------

function NextRow({ mails, curTown, unreachable, working, total, onOpen }: {
  mails: Mail[]; curTown: string; unreachable: string[]; working: number; total: number;
  onOpen: (m: Mail, chat?: boolean) => void;
}) {
  // 先頭が大きい1枚、続く2件が小さいチップ、残りは「ほか N 件」。並びは src/mail.ts（親が先、その中は待ちが古い順）
  const first = mails[0];
  const rest = mails.slice(1, 3);
  const hidden = mails.length - 1 - rest.length;
  const icon = (k: Mail["kind"]) => (k === "approval" ? "✋" : k === "reply" ? "💬" : "✓");
  const away = (m: Mail) => m.town !== curTown;
  const mainText = (m: Mail) => {
    const n = m.agent.name;
    if (away(m)) return m.kind === "approval" ? `${n}が承認待ち` : m.kind === "reply" ? `${n}が返事待ち` : `${n}の報告を確認`;
    return m.kind === "approval" ? `${n}の承認待ちを確認する` : m.kind === "reply" ? `${n}に返事する` : `${n}の報告を確認する`;
  };
  const chipText = (m: Mail) => (m.kind === "approval" ? `${m.agent.name}の承認待ち` : m.kind === "reply" ? `${m.agent.name}から返事待ち` : `${m.agent.name}の報告を確認`);
  const stamp = (m: Mail) => away(m) && <span className="postmark" title={`${m.town} の町から`}>{m.town}</span>;
  return (
    <div className="next-row">
      <span className="next-label">お便り</span>
      {first ? (
        <div className={`next-main nm-${first.kind} ${away(first) ? "away" : ""}`}>
          <span className="next-icon">{icon(first.kind)}</span>
          {stamp(first)}
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
        <button key={`${m.town}/${m.agent.id}`} className={`next-chip ${away(m) ? "away" : ""}`} onClick={() => onOpen(m)}>
          <span>{icon(m.kind)}</span>{stamp(m)}{chipText(m)}
        </button>
      ))}
      {hidden > 0 && <span className="next-more">ほか{hidden}件</span>}
      {unreachable.length > 0 && <span className="next-unreach" title="この町のお便りは取れていない">{unreachable.join("、")}に届かない</span>}
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
      onClick={(e) => { if (!(e.target as HTMLElement).closest(".card, .mini, .pop, .g-head, .ghost-card, .kill-x, .letter-mark")) onBlank(); }}>
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

function Group({ root, all, count, size, hasNeeds, onRename, children }: {
  root: Agent; all: Agent[]; count: number; size: { w: number; h: number }; hasNeeds: boolean; onRename: (name: string) => void; children: React.ReactNode;
}) {
  const house = houseNameOf(root, all);
  const [editing, setEditing] = useState(false);
  const tint = hashOf(root.id) % GROUP_TINTS.length;
  return (
    <section className={`group ${hasNeeds ? "has-needs" : ""}`}
      style={{ width: size.w, height: size.h, background: GROUP_TINTS[tint], borderColor: hasNeeds ? undefined : GROUP_LINES[tint] }}>
      <div className="g-head" onDoubleClick={() => setEditing(true)}
        title={`ダブルクリックで名前を変える（${house.by === "human" ? "あなたが付けた名前" : "作業ディレクトリの名前"}）`}>
        {editing ? (
          <input className="g-input" autoFocus defaultValue={house.by === "human" ? house.name : ""} placeholder={house.name}
            maxLength={24}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onRename(e.currentTarget.value); setEditing(false); }
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={() => setEditing(false)} />
        ) : (
          <span className={`g-name `}>{house.name}</span>
        )}
        <span className="g-sub">{count}人</span>
        {hasNeeds && <span className="g-needs">あなたの番</span>}
      </div>
      {children}
    </section>
  );
}

function roleOf(depth: number): Role {
  return depth === 0 ? "parent" : depth === 1 ? "child" : "grandchild";
}
const ROLE_LABEL = ["親", "子", "孫", "ひ孫", "玄孫"];

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
  layoutCache.set(rootId, { sig, result: r });
  return r;
}

/**
 * 家族の木を、配置計算が決めた座標に置いて描く。
 * 線は、配置の検査に使ったのと同じ「親の中心から子の中心」の線分を SVG で引く。
 */
function FamilyCanvas({ all, result, selected, onSelect, onFocus }: {
  all: Agent[]; result: ReturnType<typeof layoutFamily>; selected: string | null; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void;
}) {
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
          // ゴーストへの線は点線
          const ghostEdge = !!(byId.get(n.id)?.ghost || byId.get(n.parent!)?.ghost);
          return <line key={n.id} className={ghostEdge ? "ghost-edge" : undefined} x1={p.x + ox} y1={p.y + oy} x2={n.x + ox} y2={n.y + oy} />;
        })}
      </svg>
      {result.nodes.map((n) => {
        const a = byId.get(n.id);
        if (!a) return null;
        const delay = kill.dying.get(n.id);
        return (
          <div key={n.id} className={`fnode ${selected === n.id ? "open" : ""} ${delay !== undefined ? "dying" : ""} ${n.depth >= 2 ? "is-mini" : ""}`}
            style={{ left: n.x - n.w / 2 + ox, top: n.y - n.h / 2 + oy, width: n.w, height: n.h, transition: `left ${LAYOUT.moveMs}ms ease, top ${LAYOUT.moveMs}ms ease`, ["--kd" as string]: `${delay ?? 0}ms` }}>
            {/* × はカード（札）の角を基準に置くので、カードと同じ大きさの包みに入れる（カードは overflow: hidden） */}
            <div className={`fnode-body ${n.depth >= 2 ? "k-mini" : "k-card"}`} data-aid={n.id}
              style={n.depth >= 2 ? { ["--kx-k" as string]: boxOf(n.depth, a.name).scale } : undefined}>
              {a.ghost ? <GhostCard agent={a} depth={n.depth} onSelect={onSelect} /> : <Card agent={a} depth={n.depth} selected={selected === n.id} onSelect={onSelect} onFocus={onFocus} />}
              {letters.has(n.id) && <img className="letter-mark" src={LETTER_IMG} alt="お手紙が届いた" title="お手紙が届いた" />}
              {a.capabilities?.stop && delay === undefined && (
                <button className="kill-x" title="閉じる（⌘ を押しながらで確認なし）" aria-label={`${a.name} を閉じる`}
                  onClick={(e) => { e.stopPropagation(); kill.ask(a, e.metaKey); }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>×</button>
              )}
            </div>
            {delay !== undefined && <KillFx w={n.w} h={n.h} />}
          </div>
        );
      })}
    </div>
  );
}

function Card(props: { agent: Agent; depth: number; selected: boolean; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void }) {
  const { agent, depth, selected, onSelect, onFocus } = props;
  const { dying } = useContext(KillCtx);
  if (depth <= 1) return <FullCard {...props} />;
  // 孫より下は小さい札。選んだときだけ、親や子と同じ大きさのカードを上に重ねる（周りは動かさない）
  const mood = moodOf(agent);
  const now = nowOf(agent, mood);
  const box = boxOf(depth, agent.name);
  return (
    <>
      <button
        className={`mini m-${mood} ${selected ? "sel" : ""}`}
        style={{ zoom: box.scale, width: box.w / box.scale, height: box.h / box.scale }}
        onClick={() => onSelect(agent)}
        onContextMenu={(e) => { e.preventDefault(); onFocus(agent); }}
        title={`${agent.name}\n${MOOD_LABEL[mood]}${now ? `: ${now}` : ""}\nクリックで広げてチャット・右クリックでターミナル`}
      >
        <Avatar pick={agent.avatar} seed={agent.id} mood={mood} role={roleOf(depth)} size={32} dead={dying.has(agent.id)} />
        <span className="mini-name"><i className={`dot st-${mood}`} />{agent.name}</span>
      </button>
      {selected && (
        <div className="pop">
          <FullCard {...props} />
        </div>
      )}
    </>
  );
}

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
      <img className="kill-ghost" src="/sprites/noto/1f47b/512.webp" alt="" draggable={false} />
    </div>
  );
}

/**
 * 転出のゴースト（src/ghost.ts）。別の町にいる親か子の影。半透明、点線の枠、旅行かばんの印で、閉じる演出の 👻 と分ける。
 * 押すと本物がいる町に切り替えて、その子を選ぶ。× は出さない（ここからは閉じない）。
 */
function GhostCard({ agent, depth, onSelect }: { agent: Agent; depth: number; onSelect: (a: Agent) => void }) {
  const g = agent.ghost!;
  const mini = depth >= 2;
  const box = mini ? boxOf(depth, agent.name) : { w: LAYOUT.card.w, h: LAYOUT.card.h, scale: 1 };
  const label = g.role === "parent" ? `親は ${g.town}` : `${g.town} へ転出`;
  return (
    <button className={`ghost-card ${mini ? "is-mini" : ""}`} style={{ width: box.w, height: box.h }}
      onClick={() => onSelect(agent)} title={`${agent.name}（${label}）\nクリックで ${g.town} の町に切り替える`}>
      <span className="ghost-tag"><SuitcaseIcon />{label}</span>
      <span className="ghost-body">
        <span className="ghost-av"><Avatar pick={agent.avatar} seed={agent.id} mood="idle" role={roleOf(depth)} size={mini ? 26 : 40} /></span>
        <span className="ghost-name">{agent.name}</span>
      </span>
    </button>
  );
}

function SuitcaseIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M8 7v13M16 7v13" /></svg>);
}

function FullCard({ agent, depth, selected, onSelect, onFocus }: {
  agent: Agent; depth: number; selected: boolean; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void;
}) {
  const { dying } = useContext(KillCtx);
  const mood = moodOf(agent);
  const task = taskOf(agent, mood);
  const now = nowOf(agent, mood);
  const since = mood === "working" ? sinceText(agent.report?.turn_started_at) : "";
  return (
    <button
      className={`card m-${mood} ${selected ? "sel" : ""}`}
      style={{ width: LAYOUT.card.w, height: LAYOUT.card.h }}
      onClick={() => onSelect(agent)}
      onContextMenu={(e) => { e.preventDefault(); onFocus(agent); }}
      title={`${agent.name}\n${MOOD_LABEL[mood]}${now ? `: ${now}` : ""}\nクリックでチャット・右クリックでターミナル`}
    >
      <div className="card-top">
        <span className="role">{ROLE_LABEL[Math.min(depth, 4)]}</span>
        <span className="task">{task}</span>
      </div>
      <div className="card-main">
        <Avatar pick={agent.avatar} seed={agent.id} mood={mood} role={roleOf(depth)} size={48} dead={dying.has(agent.id)} />
        <div className="card-info">
          <span className={`st st-${mood}`}><i />{MOOD_LABEL[mood]}{since && <em>{since}</em>}</span>
          <span className="cname">{agent.name}</span>
        </div>
      </div>
    </button>
  );
}

// ---------- 右のパネル ----------

function Panel({ agent, peer, lineage, descendants, termReq, chatReq, peers, takeEarly, booting, onSent, onSent2, onError, needs, onSelect }: {
  agent: Agent | null; peer: string; lineage: Agent[]; descendants: Agent[]; termReq: number; chatReq: number; peers: Peer[]; takeEarly: (id: string) => string; booting: string | null;
  onSent: (a: Agent) => void; onSent2: (m: string) => void; onError: (m: string) => void; needs: Agent[]; onSelect: (a: Agent) => void;
}) {
  const hasTerm = !!agent?.capabilities?.terminal;
  const town = useContext(TownCtx);
  const [tab, setTab] = useState<"term" | "talk" | "state">("talk");
  const [sheet, setSheet] = useState<"teleport" | null>(null);
  // セッションを選んだときはチャットを出す。右クリックなどの termReq だけ端末を開く
  useEffect(() => { setTab("talk"); setSheet(null); }, [agent?.id, hasTerm]);
  useEffect(() => { if (termReq && hasTerm) setTab("term"); }, [termReq]);
  useEffect(() => { if (chatReq) setTab("talk"); }, [chatReq]);
  const [items, setItems] = useState<ConvItem[]>([]);
  // 送ったばかりの文。after は送り始めたときに持っていた最後の番号で、これより後に届いた発言とだけ比べる
  const [pending, setPending] = useState<(ConvItem & { after: number })[]>([]);
  const [convErr, setConvErr] = useState<string | null>(null);
  // 保存してあった会話を出しているときの、保存した時刻。ccn から読めたら null に戻す
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  // 下書きは宛先ごとに持つ。宛先を切り替えたとき、打ちかけの文が次の宛先に送られないようにする
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const text = agent ? drafts[agent.id] ?? "" : "";
  const setText = (v: string) => { if (agent) setDrafts((d) => ({ ...d, [agent.id]: v })); };
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const id = agent?.id;

  // チャットを開いたとき（セッションを選んだ、タブを切り替えた）は、必ず一番下から始める。
  // 以前は stick を読み込みの effect でしか戻さず、タブの切り替えでは前の値が残り、容れ物も作り直されるのに items が変わらないので下へ送られなかった
  useLayoutEffect(() => { stick.current = true; }, [id, tab, chatReq]);
  useEffect(() => {
    setItems([]); setPending([]); setConvErr(null); setCachedAt(null); stick.current = true;
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
        if (!alive) return;
        live = true;
        since = Math.max(since ?? 0, d.total);
        if (d.reset) since = d.total;
        setConvErr(null);
        setCachedAt(null);
        if (d.reset || d.items.length) setItems((prev) => mergeConv(prev, d));
      } catch (e) {
        if (alive) setConvErr(String(e));
      }
    };
    load();
    const t = setInterval(load, CONV_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [id, peer]);

  // 送ったばかりの文は、送り始めたあとに会話に出たら仮の項目を消す（前の同じ文、「はい」や選択肢では消さない）
  useEffect(() => {
    setPending((p) => {
      if (!p.length) return p;
      const q = p.filter((x) => !items.some((y) => (y.n ?? -1) > x.after && y.role === "user" && y.text.trim() === x.text.trim()));
      return q.length === p.length ? p : q;
    });
  }, [items, pending.length]);

  // 吹き出しの並びと選択肢は、会話が変わったときだけ作り直す（App の1秒の tick で描き直されても、Bubble の memo が効く）
  const shown = useMemo(() => collapseTools([...items, ...pending]), [items, pending]);
  const lastChoices = useMemo(() => {
    const lastAssistant = [...items].reverse().find((x) => x.role === "assistant");
    const lastIsAssistant = items.filter((x) => x.role !== "tool").slice(-1)[0]?.role === "assistant";
    return lastAssistant && lastIsAssistant ? choicesOf(lastAssistant.text) : [];
  }, [items]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
    // 吹き出しの高さが描画のあとに決まる分（Markdown など）を拾う
    const raf = requestAnimationFrame(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(raf);
  }, [items, pending, id, tab, chatReq]);

  if (!agent && booting) {
    return <aside className="panel empty-panel"><div className="ep"><p className="ep-title">新しい世帯を立てている…</p><p className="hint">打ったキーはためておき、ターミナルが開いたら流す</p></div></aside>;
  }
  if (!agent) {
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
  const send = async (body: string) => {
    if (!body.trim() || busy) return;
    setBusy(true);
    const after = items[items.length - 1]?.n ?? -1;
    try {
      await invoke("send_message", { sessionId: agent.id, text: body, peer: peer || null });
      setPending((p) => [...p, { role: "user", text: body, pending: true, at: new Date().toISOString(), after }]);
      setText("");
      stick.current = true;
      onSent(agent);
    } catch (e) {
      onError(`${agent.name} に届かなかった: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const choices = mood !== "working" ? lastChoices : [];

  return (
    <aside className={`panel pm-${mood}`}>
      <div className="p-head">
        <div className="p-avatar"><Avatar pick={agent.avatar} seed={agent.id} mood={mood} role={roleOf(lineage.length - 1)} size={64} /></div>
        <div className="p-id">
          <div className="p-name"><span className="pn">{agent.name}</span><span className={`st st-${mood}`}><i />{MOOD_LABEL[mood]}</span></div>
          <div className="p-line">{lineage.map((a, i) => (
            <span key={a.id}>{i > 0 && <b>›</b>}<button className="lnk" onClick={() => onSelect(a)}>{a.name}</button></span>
          ))}</div>
          <div className="p-task"><DocIcon />{taskOf(agent, mood)}</div>
        </div>
        <div className="p-actions">
          <button className="pane-btn" disabled={!!peer} title={peer ? "別の機械のセッションの転出は、まだ出していない" : "別の機械へ移す"} onClick={() => setSheet(sheet === "teleport" ? null : "teleport")}>転出</button>
        </div>
      </div>
      {sheet === "teleport" && <Teleport agent={agent} descendants={descendants} peers={peers} onDone={(m) => { setSheet(null); onSent2(m); }} onError={onError} />}
      <div className="tabs">
        <button className={tab === "talk" ? "on" : ""} onClick={() => setTab("talk")}>チャット</button>
        <button className={tab === "state" ? "on" : ""} onClick={() => setTab("state")}>状態</button>
        {hasTerm && <button className={tab === "term" ? "on" : ""} onClick={() => setTab("term")}>ターミナル</button>}
      </div>
      {mood === "approval" && (tab === "term" || tab === "state") && (
        <div className="ap-float"><Approval agent={agent} peer={peer} onDone={(m) => onSent2(m)} onError={onError} /></div>
      )}

      {tab === "term" ? (
        <TerminalView sessionId={agent.id} peer={peer || null} onError={onError} takeEarly={takeEarly} />
      ) : tab === "talk" ? (<div className="talk-box">
        {/* 保存した履歴を出しているときの印。会話の欄の流れに入れると欄とグラデーションの始まりがずれ、タブの行は端末のタブがあると幅が足りない。
            そのため、欄の上端の中央に重ねる（position: absolute）。中身の失敗は title に入れる */}
        {convErr && shown.length > 0 ? (
          <span className="offline-note" title={convErr}><i /><span>つながらない・{cachedAt ? `${savedLabel(cachedAt)} 時点の履歴` : "最後に読めた履歴"}</span></span>
        ) : !convErr && cachedAt ? (
          <span className="offline-note wait" title="最新を読み込んでいる"><i /><span>{savedLabel(cachedAt)} 時点の履歴・更新中</span></span>
        ) : null}
        <ScrollEdgeGradient className="talk" wrapClassName="seg-fill" ref={scroller}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {convErr && shown.length === 0 && <div className="banner bad small">{convErr}</div>}
          {shown.length === 0 && !convErr && <p className="hint center">まだチャットが無い</p>}
          {shown.map((x, i) => <Bubble key={x.n ?? `p${x.at ?? i}`} item={x} agent={agent} lineageDepth={lineage.length - 1} />)}
          {mood === "approval" && (
            <Approval agent={agent} peer={peer} onDone={(m) => onSent2(m)} onError={onError} />
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

      {tab !== "term" && <div className="composer">
        <div className="to">送信先: {target}</div>
        <div className="box">
          <textarea
            value={text}
            placeholder={agent.canSend ? `${agent.name}に注文する…` : "このセッションには送れない"}
            disabled={!agent.canSend}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(text); } }}
          />
          <button className="send" disabled={!agent.canSend || busy || !text.trim()} onClick={() => send(text)} title="送る（⌘Enter）">
            <SendIcon />
          </button>
        </div>
        <div className="hint">⌘ Enter で送信・ccn で届ける</div>
      </div>}
    </aside>
  );
}

/**
 * 承認待ちに画面から答える。中身は ccn の pending（toolName、input、requestId）。
 * 押すと Rust が、今も承認待ちで requestId が同じかを確かめてから、ccn の permissions の口で答える。
 * 人が端末で開いたセッション（ccn から答えられない）は、その端末で答える。
 */
function Approval({ agent, peer, onDone, onError }: {
  agent: Agent; peer: string; onDone: (m: string) => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [pending, setPending] = useState<{ requestId: string; toolName: string; input: Record<string, unknown> }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canAnswer = !!agent.capabilities?.permissions;
  useEffect(() => {
    let alive = true;
    const load = () => invoke<any>("session_detail", { sessionId: agent.id, peer: peer || null })
      .then((d) => { if (alive) { setPending(Array.isArray(d?.pending) ? d.pending : []); setErr(null); } })
      .catch((e) => { if (alive) setErr(String(e)); });
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [agent.id, peer]);
  const p = pending?.[0];
  // 質問や計画の確認の待ちは道具の承認ではないので、許可のボタンを出さない（Rust 側でも断る）
  const notTool = !!p && ["AskUserQuestion", "ExitPlanMode"].includes(p.toolName);
  const detail = p ? String((p.input as any)?.command ?? (p.input as any)?.file_path ?? (p.input as any)?.url ?? JSON.stringify(p.input)) : "";
  const answer = async (choice: "allow" | "deny") => {
    setBusy(choice);
    try {
      const r = await invoke<string>("answer_permission", { sessionId: agent.id, choice, expectId: p?.requestId ?? null, peer: peer || null });
      onDone(`${agent.name}: ${r}`);
    } catch (e) {
      onError(`${agent.name} に答えられなかった: ${e}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="approval">
      <div className="ap-title">✋ {agent.name} が承認を待っている</div>
      {!canAnswer ? (
        <div className="hint">このセッションは人がターミナルで開いたもので、ここからは答えられない。そのターミナルで答える。</div>
      ) : p ? (
        <div>
          <div className="ap-tool">{p.toolName}</div>
          {detail && <ScrollEdgeGradient className="ap-detail"><span>{detail}</span></ScrollEdgeGradient>}
          {(pending?.length ?? 0) > 1 && <div className="hint">ほかに{pending!.length - 1}件の承認が待っている。1件ずつ答える。</div>}
        </div>
      ) : (
        <div className="hint">{err ?? "承認の中身を読んでいる…"}</div>
      )}
      {canAnswer && (
        <div className="ap-btns">
          {notTool && <div className="hint">これは質問か計画の確認の待ち。選択肢はターミナルで選ぶ。</div>}
          <button className="ap-allow" disabled={!p || notTool || !!busy} onClick={() => answer("allow")}>{busy === "allow" ? "送っている…" : "許可する"}</button>
          <button className="ap-deny" disabled={!p || !!busy} onClick={() => answer("deny")}>{busy === "deny" ? "送っている…" : "拒否する"}</button>
        </div>
      )}
    </div>
  );
}

// ---------- 新しい世帯・転出 ----------

/** 新しい世帯を作る。親は ~/Documents/meta で端末のセッションとして起動する（本人の指定） */
/** 新しい世帯を作る。最初の依頼の欄は出さず、すぐ ~/Documents/meta で親（端末のセッション）を立て、右の端末を開く */
function NewHousehold({ big, disabled, onStart, onCreated, onError }: { big?: boolean; disabled?: boolean; onStart: () => void; onCreated: (r: any) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    perfStart("new");
    setBusy(true);
    onStart();
    try {
      // 前に開いたターミナルの大きさで起動する。開いた直後に大きさを変えて、claude が全部描き直すのを省く
      const { cols, rows } = lastTermSize() ?? { cols: null, rows: null };
      const r = await invoke<any>("create_session", { cwd: null, prompt: null, parent: null, name: benchName(), cols, rows, peer: null });
      perfMark("create");
      if (r?.id) perfSetId(r.id);
      onCreated(r);
    } catch (e) { onCreated(null); onError(`世帯を作れなかった: ${e}`); } finally { setBusy(false); }
  };
  return (
    <button className={big ? "primary new-house big" : "pane-btn new-house"} disabled={disabled || busy} onClick={go}>
      {busy ? "立てている…" : big ? "最初の世帯を作る" : "＋ 新しい世帯"}
    </button>
  );
}

/**
 * 転出（ccn の teleport）。行き先のノードと move / fork を選び、下見（移動元の説明）を見てから実行する。
 * 実行は1回の要求で最大95秒かかる。行き先の下見（clone することがある）は実行の中で ccn が行う。
 */
function Teleport({ agent, descendants, peers, onDone, onError }: { agent: Agent; descendants: Agent[]; peers: Peer[]; onDone: (m: string) => void; onError: (m: string) => void }) {
  // 子孫がいれば、子孫ごと移す（2026-11-12 本人の判断）。ccn の部分木の口（subtree）を使い、先に計画（dryRun）を見せる
  const subtree = descendants.length > 0;
  const [plan, setPlan] = useState<any>(null);
  const dests = peers.filter((p) => !p.self && p.status === "healthy");
  const [to, setTo] = useState(dests[0]?.name ?? "");
  const [fork, setFork] = useState(false);
  const [info, setInfo] = useState<any>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  useEffect(() => {
    invoke<any>("teleport_info", { sessionId: agent.id, peer: null }).then(setInfo).catch((e) => setInfoErr(String(e)));
  }, [agent.id]);
  useEffect(() => {
    if (!subtree || !to) { setPlan(null); return; }
    invoke<any>("teleport", { sessionId: agent.id, to, fork, subtree: true, dryRun: true, peer: null })
      .then(setPlan).catch((e) => setPlan({ error: String(e) }));
  }, [agent.id, to, fork, subtree]);
  // 作業中か承認待ちの人が1人でもいたら押せなくする。ccn は動いているセッションを移さず、全員が止まるまで待つと終わりが読めないため
  const busyOnes = [agent, ...descendants].filter((x) => x.state === "running" || x.state === "waiting_permission");
  const running = busyOnes.length > 0;
  const go = async () => {
    setBusy(true);
    try {
      const r = await invoke<any>("teleport", { sessionId: agent.id, to, fork, subtree, dryRun: false, peer: null });
      setResult(r);
      if (subtree) {
        const moved = r?.moved?.length ?? 0, failed = r?.failed?.length ?? 0;
        onDone(`${agent.name} の世帯を ${to} へ${fork ? "複製" : "移動"}した（${moved}人${failed ? `、失敗 ${failed}人` : ""}）`);
      } else {
        onDone(`${agent.name} を ${r?.node ?? to} へ${fork ? "複製" : "移動"}した（新しい id ${String(r?.id ?? "").slice(0, 8)}）`);
      }
    } catch (e) { onError(`${agent.name} を転出できなかった: ${e}`); } finally { setBusy(false); }
  };
  return (
    <div className="sheet">
      <div className="sheet-title">{agent.name} を別の機械へ転出する</div>
      <div className="tp-row">
        <label>行き先</label>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {dests.length === 0 && <option value="">（つながっている機械が無い）</option>}
          {dests.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <label className="tp-radio"><input type="radio" checked={!fork} onChange={() => setFork(false)} />移す（ここは止める）</label>
        <label className="tp-radio"><input type="radio" checked={fork} onChange={() => setFork(true)} />複製（ここも残す）</label>
      </div>
      <div className="tp-info">
        {infoErr ? <span className="bad-text">下見できない: {infoErr}</span> : !info ? "下見している…" : (
          <>
            <div>状態: {info.state}{info.live ? "（動いている）" : ""}・作業場所: {String(info.from?.cwd ?? "").replace(/^\/Users\/[^/]+/, "~")}</div>
            <div>git: {info.git ? `${info.git.repoName}（${info.git.branch}）` : "git のリポジトリではない"}</div>
          </>
        )}
        {subtree && (
          <div className="tp-plan">
            <div><b>子孫 {descendants.length} 人も一緒に移る</b>（親子の関係は行き先でも保つ）</div>
            {plan?.error ? <div className="bad-text">計画を出せない: {plan.error}</div> : !plan ? <div className="hint">計画を出している…</div> : (
              <ul>{(plan.plan ?? []).map((m: any) => <li key={m.sourceId}>{m.title ?? m.sourceId.slice(0, 8)} → {String(m.cwd ?? "").replace(/^\/Users\/[^/]+/, "~")}</li>)}
                {(plan.skipped ?? []).map((m: any) => <li key={m.sourceId} className="bad-text">{m.sourceId.slice(0, 8)}: 対象外（{m.reason}）</li>)}</ul>
            )}
          </div>
        )}
        {running && <div className="bad-text">作業中か承認待ちの人がいるので転出できない（{busyOnes.map((x) => x.name).join("、")}）。全員が待機になってから転出する。</div>}
        <div className="hint">行き先に同じリポジトリが無ければ、ccn が行き先の ~/Documents に clone する。実行には最大95秒かかる。{agent.capabilities?.terminal ? "ターミナルのセッションは、行き先ではまだターミナルとして再開しない（ccn 側の対応待ち）。" : ""}</div>
      </div>
      {result ? (
        subtree ? (
          <div className="tp-result">
            {to} へ移した: {(result.moved ?? []).length}人。
            {(result.failed ?? []).length > 0 && <span className="bad-text"> 失敗: {(result.failed ?? []).map((f: any) => `${f.sourceId.slice(0, 8)}（${f.error}）`).join("、")}</span>}
            画面上のノードを {to} に切り替えると見える。
          </div>
        ) : (
          <div className="tp-result">行き先 {result.node} の新しい id: {result.id}{result.cloned ? "（clone した）" : ""}。画面上のノードを {result.node} に切り替えると見える。</div>
        )
      ) : (
        <div className="sheet-foot">
          <span className="hint">{subtree ? "全員を下見してから止めるので、下見で落ちたら何も変わらない" : ""}</span>
          <button className="primary" disabled={busy || !to || running || !info} onClick={go}>{busy ? "転出している…（最大95秒）" : fork ? "複製する" : "移す"}</button>
        </div>
      )}
    </div>
  );
}

/** 道具の行が続いたら1行にまとめる。まとめた行の n は最初の行の n にする（後ろに道具が増えても key が変わらない） */
function collapseTools(items: ConvItem[]): (ConvItem & { more?: number })[] {
  const out: (ConvItem & { more?: number })[] = [];
  for (const x of items) {
    const last = out[out.length - 1];
    if (x.role === "tool" && last?.role === "tool") {
      out[out.length - 1] = { ...x, n: last.n, more: (last.more ?? 0) + 1 };
    } else out.push(x);
  }
  return out;
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

type BubbleProps = { item: ConvItem & { more?: number }; agent: Agent; lineageDepth: number };
/**
 * 吹き出しは、中身か見た目に使う値が変わったときだけ描き直す（#10）。
 * agent は一覧を取るたびに別の物になるので、使う値（id、名前、絵）だけを比べる。
 * まとめた道具の行は毎回作り直すので、n と件数と文で比べる
 */
const Bubble = memo(BubbleView, (a: BubbleProps, b: BubbleProps) =>
  (a.item === b.item || (a.item.n != null && a.item.n === b.item.n && a.item.more === b.item.more && a.item.text === b.item.text && a.item.pending === b.item.pending))
  && a.lineageDepth === b.lineageDepth
  && a.agent.id === b.agent.id && a.agent.name === b.agent.name
  && a.agent.avatar?.char === b.agent.avatar?.char && a.agent.avatar?.hue === b.agent.avatar?.hue);

function BubbleView({ item, agent, lineageDepth }: BubbleProps) {
  chatPerf.bubble++;
  if (item.role === "tool" && item.sent) return <SentLetter item={item} agent={agent} lineageDepth={lineageDepth} />;
  if (item.role === "tool") {
    return <div className="tool-line">🔧 {item.text}{item.more ? ` ほか${item.more}件` : ""}</div>;
  }
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
  const rows: [string, string | null | undefined][] = [
    ["いま", nowOf(agent, mood)],
    ["頼まれたこと", r?.asked],
    ["最後の報告", r?.said],
    ["次の一手", r?.next],
    ["閉じていい？", agent.closeCheck ? (agent.closeCheck.status === "ok" ? "閉じてOK" : agent.closeCheck.status === "ng" ? `まだ: ${agent.closeCheck.short ?? ""}` : "判定中") : null],
    ["作業中の時間", mood === "working" ? sinceText(r?.turn_started_at) : null],
    ["場所", agent.cwd.replace(/^\/Users\/[^/]+/, "~")],
    ["セッション", agent.id],
  ];
  return (
    <ScrollEdgeGradient className="state-scroll" wrapClassName="seg-fill"><dl className="state-tab">
      {rows.filter(([, v]) => v).map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
      {!r && <p className="hint">状態 hook が入っていないので、頼まれたことと次の一手は出ない（README の「hook」を参照）。</p>}
    </dl></ScrollEdgeGradient>
  );
}

// ---------- 素材のクレジット ----------

function Credits() {
  const [open, setOpen] = useState(false);
  return (
    <span className="credits">
      <button className="credit-btn" onClick={() => setOpen((o) => !o)}>素材</button>
      {open && (
        <span className="credit-pop" onMouseLeave={() => setOpen(false)}>
          <b>キャラ</b>: Ninja Adventure Asset Pack（Pixel-boy、AAA）、CC0 1.0。
          <br /><b>状態の印、幽霊、お手紙</b>: Animated emoji: Noto Animated Emoji by Google, licensed under CC BY 4.0
          （creativecommons.org/licenses/by/4.0）。Source: googlefonts.github.io/noto-emoji-animation
          <br />どちらも配布元のファイルを改変せずに使い、表示のときに縮めている。
        </span>
      )}
    </span>
  );
}

// ---------- 小さい絵 ----------

function HouseIcon() {
  return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M3 11 12 3l9 8" /><path d="M5 10v10h14V10" /><path d="M10 20v-5h4v5" /></svg>);
}
function PeopleIcon() {
  return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.6" /><path d="M16 14.2c2.8.3 5 2.6 5 5.8" /></svg>);
}
function DocIcon() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 3h8l4 4v14H6z" /><path d="M9 12h6M9 16h6" /></svg>);
}
function SendIcon() {
  return (<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 11.5 20.5 4l-5 17-3.6-7.2z" /><path d="M11.9 13.8 20.5 4" stroke="#fff" strokeWidth="1.4" /></svg>);
}
