import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IS_WEB, call as invoke, setFullscreen } from "./bridge";
import { pickTown, savedTown, saveTown } from "./webTown";
import { lastTermSize } from "./term/size";
import { perfMark, perfStart } from "./term/perf";
import { loadTerminal } from "./term/lazyTerminal";
import { useBench } from "./term/bench";
import { collectMail, type Mail } from "./mail";
import { flightsOf, type Flight } from "./letters";
import { withGhosts } from "./ghost";
import { ScrollEdgeGradient } from "./ScrollEdgeGradient";
import { pollWhileVisible, shownAt } from "./visible";
import { reuseAgents, reuseSnap } from "./snap";
import { kickTown, otherTownRetryMs, watchTown } from "./town";
import { SucceedError, kidsOf, startSuccessor, succeedBlock } from "./succeed";
import { Group as SplitGroup, Panel as SplitPanel, Separator, usePanelRef, type Layout } from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen, Settings, Users } from "lucide-react";
import { NewHousePane } from "./newHouse/NewHousePane";
import { NewHousehold } from "./newHouse/NewHousehold";
import { Credits } from "./credits/Credits";
import { HouseIcon, SuitcaseIcon } from "./icons";
import { Since } from "./Since";
import { Panel } from "./panel/Panel";
import { CardActions } from "./card/CardActions";
import { KillCtx, LetterCtx, SendCtx, SucceedCtx, TownCtx } from "./contexts";
import { loadPlace, savePlace } from "./newHouse/placeSetting";
import { SettingsDialog } from "./settings/SettingsDialog";
import "./App.css";
import "./mobile/mobile.css";
import { MobileShell } from "./mobile/MobileShell";
import { useMobileLayout, useVisualViewport } from "./mobile/useMobile";
import { Avatar, hash as hashOf, roleOf, ROLE_LABEL } from "./kid/Avatar";
import { SkinCtx, saveSkin, savedSkin, type Skin } from "./kid/pokemon";
import {
  type Agent, type Mood, type Peer, type Snapshot,
  MOOD_LABEL, NEEDS_YOU, accountText, buildTree, cardNames, houseNameOf, moodOf, nowOf, taskOf,
} from "./model";
import { savedLabel } from "./conv";
import { layoutFamily, type LNode } from "./layout/layout";
import { LAYOUT, boxOf, groupSizeOf } from "./layout/params";
import { packHouseholds } from "./layout/pack";
import type { CreatedSession } from "./types";

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

/** 世帯の要約の凡例に並べる順 */
const LEGEND: Mood[] = ["working", "reply", "approval", "done", "idle"];

type Toast = { id: number; text: string; bad?: boolean };

export default function App() {
  // スマホ専用の画面（src/mobile）。取得・選択・送信の状態はこの App が持ち、下の return の並べ方だけを切り替える
  const mobile = useMobileLayout();
  useVisualViewport(mobile);
  useEffect(() => { const t = setTimeout(() => { void loadTerminal(); }, 2000); return () => clearTimeout(t); }, []);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [peer, setPeer] = useState<string>("");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [zoom, setZoom] = useState<number | "fit">("fit");

  const toast = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 6000 : 2600);
  }, []);

  useEffect(() => {
    invoke<Peer[]>("peers").then((p) => setPeers(Array.isArray(p) ? p : [])).catch(() => {});
  }, []);
  // オフラインで起動したときの peers は保存した一覧（別の機械の status が cached）。町の一覧が読めるようになったら取り直す
  const snapOk = !!snap?.ccn_ok;
  useEffect(() => {
    if (snapOk && peers.some((p) => p.status === "cached")) invoke<Peer[]>("peers").then((p) => setPeers(Array.isArray(p) ? p : [])).catch(() => {});
  }, [snapOk]);

  // ブラウザ版は、最初の町を生きている子が最も多い町にする。町を選び直したら、その後は勝手に動かさない
  const touched = useRef(false);
  const chosen = useRef(false);
  useEffect(() => {
    if (!IS_WEB || chosen.current || !peers.length) return;
    chosen.current = true;
    const healthy = peers.filter((p) => p.self || p.status === "healthy");
    Promise.all(healthy.map(async (p) => {
      try { return { name: p.name, self: p.self, n: (await invoke<Agent[]>("town_agents", { peer: p.self ? null : p.name })).length }; }
      catch { return { name: p.name, self: p.self, n: -1 }; }
    })).then((counts) => {
      if (touched.current) return;
      const t = pickTown(counts.filter((c) => c.n >= 0), savedTown());
      if (!t) return;
      saveTown(t.name);
      setPeer(t.self ? "" : t.name);
    });
  }, [peers]);

  const selfPeer = peers.find((p) => p.self);
  /** 町を切り替える（上の帯の選択と、スマホの町の選択で共通） */
  const changeTown = (v: string) => { touched.current = true; setPeer(v); setSelected(null); if (IS_WEB) saveTown(v || selfPeer?.name || ""); };
  const reload = useRef<() => void>(() => {});
  // 一覧の取得が続けて失敗している数と、失敗し始めた時刻。1回の失敗では町を描き直さない
  // （2026-11-12、ノードが一瞬詰まって一覧の取得が時間切れになり、町が「0世帯・0人」になった）
  const [fail, setFail] = useState<{ n: number; since: number; msg: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const want = peer || null;
    setFail(null);
    // 失敗したら、同じ町の前回の一覧があればそれを出し続ける。無いときだけ、失敗した一覧（空の町と赤い帯）を出す
    const failed = (msg: string, s?: Snapshot) => {
      setFail((f) => ({ n: (f?.n ?? 0) + 1, since: f?.since ?? Date.now(), msg }));
      setSnap((prev) => (prev?.ccn_ok && (prev.peer ?? null) === want ? prev : s ?? prev));
      if (!s) setErr((e) => e ?? msg);
    };
    // 一覧は Rust の見張りが、変わったときだけ送ってくる（#5）。ウィンドウが見えていない間は止まる（#6）。
    // 経過時間の表示は Since が自分で時計を回すので、ここで町全体を毎秒描き直さない（#4）
    const stop = watchTown(want, (s) => {
      if (!alive) return;
      // 中身が前回と同じなら前回のオブジェクトのまま（描き直さない）。変わらないセッションも使い回す（#4）
      if (s.ccn_ok) { setSnap((prev) => reuseSnap(prev, s)); setErr(null); setFail(null); }
      else failed(s.ccn_error ?? "ccn につながらない", s);
    }, (msg) => { if (alive) failed(msg); });
    reload.current = kickTown;
    return () => { alive = false; stop(); };
  }, [peer]);

  // 閉じたセッション。演出が終わったら隠し、ccn の一覧から消えたら忘れる（10秒たっても消えなければ戻して失敗を出す）
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
  // 別の町のお便り。町の表示はいま選んだノードだけで、お便りは全部の町から集める
  const selfName = peers.find((p) => p.self)?.name ?? "このMac";
  const curTown = peer || selfName;
  const [others, setOthers] = useState<Map<string, { agents: Agent[] } | { error: string }>>(new Map());
  // 別の町の一覧が最後に取れた時刻。others に入れると取るたびに町が描き直されるので、別に持つ（#4）
  const okAt = useRef<Map<string, number>>(new Map());
  // 町ごとの、続けて失敗した回数と、次に取りに行ってよい時刻（#14）
  const retry = useRef<Map<string, { fails: number; at: number }>>(new Map());
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
        // 失敗が続いている町は、決めた時刻まで取りに行かない（前の結果を残す）
        const r = retry.current.get(t.name);
        if (r && Date.now() < r.at) continue;
        let v: { agents: Agent[] } | { error: string };
        if (!t.healthy) v = { error: "つながらない" };
        else {
          // 一覧と、前に決めたキャラの割り当てを読むだけの軽い命令（#14）。snapshot と違い、割り当ての保存も状態ファイルの読み込みもしない
          try { v = { agents: await invoke<Agent[]>("town_agents", { peer: t.key || null }) }; }
          catch (e) { v = { error: String(e) }; }
        }
        if (!alive) break;
        if ("agents" in v) { okAt.current.set(t.name, Date.now()); retry.current.delete(t.name); }
        else if (t.healthy) {
          const fails = (r?.fails ?? 0) + 1;
          retry.current.set(t.name, { fails, at: Date.now() + otherTownRetryMs(fails, OTHER_TOWNS_POLL_MS) });
        }
        // 取れなかった回は、60秒以内に取れた前回の町を残す（1回の時間切れで、お便りとゴーストが消えないように）
        // 前回と同じなら Map を作り直さない（#4）
        const got = v;
        setOthers((m) => {
          const prev = m.get(t.name);
          if ("error" in got) {
            if (prev && "agents" in prev && Date.now() - (okAt.current.get(t.name) ?? 0) < OTHER_TOWN_KEEP_MS) return m;
            if (prev && "error" in prev && prev.error === got.error) return m;
            return new Map(m).set(t.name, got);
          }
          const agents = reuseAgents(prev && "agents" in prev ? prev.agents : undefined, got.agents);
          if (prev && "agents" in prev && agents === prev.agents) return m;
          return new Map(m).set(t.name, { agents });
        });
      }
      running = false;
    };
    const stop = pollWhileVisible(load, OTHER_TOWNS_POLL_MS);
    return () => { alive = false; stop(); };
  }, [peer, peers, selfName]);
  // 木を作るときだけ、転出のゴースト（別の町にいる親子の影）を足す。お便りや数には入れない
  const otherTowns = useMemo(() => [...others].flatMap(([town, v]) => ("agents" in v ? [{ town, agents: v.agents }] : [])), [others]);
  const tree = useMemo(() => buildTree(withGhosts({ town: curTown, agents }, otherTowns)), [agents, otherTowns, curTown]);
  // キャラの見た目（いつもの / ポケモン）。ポケモンでは世帯の根で進化の系統を決めるので、ID から根を引けるようにして渡す
  const [skin, setSkin] = useState<Skin>(savedSkin);
  // 値を作り直すのは、見た目か親子の形が変わったときだけにする。snapshot のたびに作り直すと、全員の Avatar が描き直される
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const shape = useMemo(() => tree.families.map((f) => f.all.map((a) => `${a.id}<${a.parent ?? ""}`).join(",")).join(";"), [tree]);
  const skinCtx = useMemo(() => ({
    skin,
    // 根が転出のゴーストなら、相手の町にいる本物の ID で引く。親の町と子の町で系統をそろえるため
    rootOf: (id: string) => { const t = treeRef.current; const a = t.byId.get(id); const r = a ? t.lineage(a)[0] : null; return r ? r.ghost?.realId ?? r.id : id; },
  }), [skin, shape]);
  /** ゴーストを押したら、本物がいる町に切り替えてその子を選ぶ */
  const pick = useCallback((a: Agent) => {
    if (!a.ghost) { setSelected(a.id); return; }
    setPeer(a.ghost.town === selfName ? "" : a.ghost.town);
    setSelected(a.ghost.realId);
  }, [selfName]);

  /**
   * a とその子孫を、葉から順に止める。倒れる演出も葉から少しずつずらして出す。
   * alone なら a だけを止め、子孫は残す（引き継ぎで前任を止めるとき）。このときの知らせと選択の切り替えは呼び手が行う。全部止まったら true
   */
  const kill = useCallback(async (a: Agent, alone = false) => {
    const order: Agent[] = [];
    // ゴースト（別の町にいる本物の影）は閉じない
    const walk = (x: Agent) => { for (const k of tree.childrenOf.get(x.id) ?? []) if (!k.ghost) walk(k); order.push(x); };
    if (alone) order.push(a); else walk(a);
    const targets = order.filter((x) => x.capabilities?.stop);
    const skipped = order.filter((x) => !x.capabilities?.stop);
    setDying((m) => { const n = new Map(m); targets.forEach((x, i) => n.set(x.id, i * KILL_STAGGER)); return n; });
    if (!alone && selected && targets.some((x) => x.id === selected)) setSelected(null);
    const failed: Agent[] = [];
    for (const x of targets) {
      try { await invoke("stop_session", { sessionId: x.id, peer: peer || null }); }
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
    if (alone) return failed.length === 0 && skipped.length === 0;
    if (failed.length) toast(`止められなかった: ${failed.map((x) => x.name).join("、")}`, true);
    else toast(`${a.name}${order.length > 1 ? ` と子孫 ${order.length - 1} 人` : ""}を閉じた`);
    if (skipped.length) toast(`ccn から止められないので残した: ${skipped.map((x) => x.name).join("、")}`, true);
    return failed.length === 0 && skipped.length === 0;
  }, [tree, selected, peer, toast]);
  // お手紙。この機械の町を見ているときだけ（記録はこの機械の hook が書く）
  const flights = useMemo(() => (peer ? [] : flightsOf(snap?.letters ?? [], agents)), [snap, agents, peer]);
  const letterMarks = useLetterMarks(flights);
  const askKill = useCallback((a: Agent, instant: boolean) => { if (instant) kill(a); else setKillAsk(a); }, [kill]);
  const killCtx = useMemo(() => ({ dying, ask: askKill }), [dying, askKill]);
  // 引き継ぎ（src/succeed.ts）。確認を挟んでから、ccn に後継を立てさせる。新しい ccn は前任の停止と子の付け替えまで行う。
  // 古い ccn では、後継が1通目を受け取ったら、ここで前任だけを止める
  const [succeedAsk, setSucceedAsk] = useState<Agent | null>(null);
  // 引き継げなかったときの、閉じるまで残る知らせ（枠の残るアカウントが無いとき。次に空く時刻を読めるように、消えるトーストにしない）
  const [succeedNote, setSucceedNote] = useState<{ title: string; text: string } | null>(null);
  const [succeeding, setSucceeding] = useState<Set<string>>(new Set());
  // 同じ前任で二重に走らせない（確認の Enter の連打、カードと見出しの両方からの操作）。後継が2人立つと、同じ作業が二重に進む
  const succeedRun = useRef<Set<string>>(new Set());
  // 後継が立つまでの間に本人がほかを選んだら、選択を後継へ移さない。待った後の値を読むので ref で持つ
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const succeed = async (a0: Agent) => {
    if (succeedRun.current.has(a0.id)) return;
    // 確認を出している間に一覧が変わることがあるので、今の木の姿で見直す
    const a = tree.byId.get(a0.id) ?? a0;
    const why = succeedBlock(a, !peer);
    if (why) { toast(`${a.name} を引き継げない: ${why}`, true); return; }
    const mark = (on: boolean) => {
      if (on) succeedRun.current.add(a.id); else succeedRun.current.delete(a.id);
      setSucceeding(new Set(succeedRun.current));
    };
    mark(true);
    toast(`${a.name} の後継を立てている…`);
    try {
      const { cols, rows } = lastTermSize() ?? { cols: null, rows: null };
      const r = await startSuccessor({ agent: a, kids: kidsOf(tree.childrenOf.get(a.id) ?? []), cols, rows }, {
        call: invoke, sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), now: Date.now,
      });
      // 一覧に載るまでは、作成の応答から作った仮の姿で右パネルを出す（新しい世帯と同じ）
      const show = (term: boolean) => {
        setFresh({
          id: r.id, name: a.name, kind: "terminal", state: "running", cwd: r.cwd, canSend: true, parent: a.parent,
          startedAt: Date.now(), capabilities: { terminal: true, send: true, stop: true },
        });
        setSelected(r.id);
        if (term) setTermReq((n) => n + 1);
      };
      kickTown();
      if (r.kind === "waiting") {
        // 後継は生きているが、1通目をまだ受け取っていない。端末で確認の画面に止まっていることがあるので、端末を開いて見せる。前任は止めない
        show(true);
        toast(`${a.name} の後継（${r.id.slice(0, 8)}）は起動したが、引き継ぎの文をまだ受け取っていない。ターミナルを見る。${a.name} は止めていないので、後継が動いたら閉じる`, true);
        return;
      }
      // 前任を選んでいたら、選択を後継へ移す（右パネルを空にしない）
      if (selectedNow.current === a.id) show(false);
      const id8 = r.id.slice(0, 8);
      if (r.kind === "ccn") {
        // 新しい ccn。後継の起動、子の付け替え、前任の停止まで ccn が済ませている
        let stopped = r.stopped;
        // 止まった前任は、一覧から消えるまで隠す。10秒たっても残っていれば、上の見張りが「止まらなかった」と出す。
        // ccn が止められなかったときだけ、ここから1回止める
        if (stopped) setHidden((h) => new Map(h).set(a.id, Date.now()));
        else stopped = await kill(a, true);
        kickTown();
        // 付け替わった子の数は、町に出ていた子で数える（ccn の adopted には、止まって30分以内の子も入る）。
        // 済んでいた引き継ぎ（already が付く）は、どの子が付け替わったかが分からないので書かない
        const before = (tree.childrenOf.get(a.id) ?? []).filter((k) => !k.ghost);
        const moved = before.filter((k) => r.adopted.includes(k.id)).length;
        const left = r.already === undefined ? before.length - moved : 0;
        const kids = `${moved ? `。子 ${moved} 人も後継の下に付けた` : ""}${left ? `。子 ${left} 人は付け替わらず、別の世帯に分かれる` : ""}`;
        if (r.already) toast(`${a.name} は、すでに後継（${id8}）に引き継がれている`);
        else if (stopped) toast(`${a.name} を後継（${id8}）へ引き継いだ${kids}${r.account ? `（アカウント: ${r.account}）` : ""}`, left > 0);
        else toast(`${a.name} の後継（${id8}）は立ったが、${a.name} を止められなかった。手で閉じる`, true);
        return;
      }
      // 古い ccn。後継が1通目を受け取ったので、前任だけを止める（子孫は止めない）
      const stopped = await kill(a, true);
      const note = r.depthChecked ? "" : "（前任の深さが ccn に無く、深さは比べていない）";
      if (stopped) toast(`${a.name} を後継（${id8}）へ引き継いだ${note}`);
      else toast(`${a.name} の後継（${id8}）は立ったが、${a.name} を止められなかった。手で閉じる${note}`, true);
    } catch (e) {
      if (e instanceof SucceedError && e.kind === "no_account") setSucceedNote({ title: `${a.name} を引き継げなかった`, text: e.message });
      else toast(`${a.name} を引き継げなかった: ${e instanceof Error ? e.message : e}`, true);
    } finally {
      mark(false);
    }
  };
  const local = !peer;
  const succeedCtx = useMemo(() => ({ local, busy: succeeding, ask: setSucceedAsk }), [local, succeeding]);
  // カードのボタンから文を送る（#63）。選んでいるセッションなら、右パネルの送信（仮の吹き出しと会話の取り直し）に任せる。
  // ほかのセッションは send_message で送り、トーストを出す。参照を変えないよう ref を通し、町を描き直させない（#10）
  const panelSend = useRef<((id: string, text: string) => Promise<boolean> | null) | null>(null);
  const sendImpl = useRef<(a: Agent, text: string) => Promise<boolean>>(async () => false);
  sendImpl.current = async (a, text) => {
    const viaPanel = panelSend.current?.(a.id, text);
    if (viaPanel) return viaPanel;
    try {
      await invoke("send_message", { sessionId: a.id, text, peer: peer || null });
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

  // 作った直後のセッション。一覧（snapshot）に載るまでは、create の応答から作った仮の姿で右パネルを出す（#18）。
  // 一覧の取り直しを待つと、ccn が遅いときにその分だけ右パネルが出ない
  const [fresh, setFresh] = useState<Agent | null>(null);
  // 作ったらチャットを開いて入力欄にフォーカスする（本人の指定）。端末は右クリックや「端末へ」で開く
  const newHousehold = useCallback((r: CreatedSession | null) => {
    if (!r?.id) return;
    setFresh({
      // 名前は一覧と同じ決め方（cardNames）。一覧に載ったときに名前が変わって見えないようにする
      id: r.id, name: cardNames([{ id: r.id, cwd: r.cwd ?? "" }]).get(r.id) ?? r.id.slice(0, 8), kind: "terminal", state: "running", cwd: r.cwd ?? "", canSend: true, parent: null,
      startedAt: Date.now(), capabilities: { terminal: true, send: true, stop: true },
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
  // 前回の町を出したまま、3回続けて、または10秒以上失敗している
  const slow = !!fail && (fail.n >= 3 || Date.now() - fail.since > 10000);
  const sel = selected ? tree.byId.get(selected) ?? (fresh?.id === selected ? fresh : null) : null;
  // 一覧に載ったら仮の姿を捨てる
  useEffect(() => { if (fresh && tree.byId.has(fresh.id)) setFresh(null); }, [tree, fresh]);
  useEffect(() => { if (sel) perfMark("listed", sel.id); }, [sel?.id]);
  useBench({ ready: !!snap, select: setSelected, focusId: (id) => { const a = tree.byId.get(id); if (a) focus(a); } });

  const connView = { cls: (!snap?.ccn_ok ? "bad" : slow ? "slow" : "ok") as "ok" | "slow" | "bad", label: snap ? (!snap.ccn_ok ? "つながらない" : slow ? "つながりにくい" : "接続中") : "よみこみ中", msg: fail?.msg ?? "" };
  const panelProps = {
    agent: sel, peer, lineage: sel ? tree.lineage(sel) : [], descendants: sel ? descOf(tree.childrenOf, sel.id) : [], termReq, chatReq, composeReq, peers, sendHook: panelSend,
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
    <SucceedCtx.Provider value={succeedCtx}>
    <SendCtx.Provider value={cardSend}>
    <LetterCtx.Provider value={letterMarks.marks}>
    <TownCtx.Provider value={agents}>
    <div className={`app${mobile ? " mobile" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      {mobile ? (
        <MobileShell tree={tree} peers={peers} peer={peer} selfName={selfName} snap={snap} err={err} conn={connView} counts={counts} total={agents.length}
          open={sel} mails={mails} curTown={curTown} unreachable={unreachable} onTown={changeTown} onPick={pick} onMail={(m) => openMail(m, true)} onBack={() => setSelected(null)}
          chat={(back) => <Panel {...panelProps} mobile onBack={back} />} />
      ) : (<>
      {/* 右のチャットが閉じている間は、左の幅と開閉だけを保存し、チャットの幅は前に保存した値を残す（0 を保存すると、次に開いたときのチャットの幅が最小に戻る） */}
      <SplitGroup className="body" orientation="horizontal" defaultLayout={savedSplit()} onLayoutChanged={(l) => saveSplit(sideRef.current?.isCollapsed() ? keepSide(l, savedSplit()) : l)}>
        <SplitPanel id="houses" panelRef={housesRef} collapsible collapsedSize={0} defaultSize={HOUSES_DEFAULT} minSize={HOUSES_MIN} maxSize="30%"
          onResize={() => setHousesOpen(!housesRef.current?.isCollapsed())}>
          <NewHousePane disabled={!local} place={place} onCreated={newHousehold} onError={(m) => toast(m, true)} />
        </SplitPanel>
        <Separator className={`split-handle${housesOpen ? "" : " closed"}`} />
        <SplitPanel id="town" minSize={TOWN_MIN}>
        <div className="left">
          {/* アプリのヘッダー。#89 で窓の上から中央のペインの最上部へ移した（本人の指定）。ノードの選択と接続の表示は、前の実装のまま */}
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
            <div className="top-mid">
              <select className="node" value={peer} onChange={(e) => changeTown(e.target.value)}>
                <option value="">{IS_WEB && selfPeer ? selfPeer.name : `このMac${selfPeer ? `（${selfPeer.name}）` : ""}`}</option>
                {peers.filter((p) => !p.self).map((p) => (
                  <option key={p.name} value={p.name} disabled={p.status !== "healthy"}>{p.name}{p.status !== "healthy" ? "（つながらない）" : ""}</option>
                ))}
              </select>
              <span className={`conn ${!snap?.ccn_ok ? "bad" : slow ? "slow" : "ok"}`} title={fail?.msg ?? ""}><i />{snap ? (!snap.ccn_ok ? "つながらない" : slow ? "つながりにくい" : "接続中") : "よみこみ中"}</span>
            </div>
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
          <NextRow mails={mails} curTown={curTown} unreachable={unreachable} working={counts.working} total={agents.length} onOpen={openMail} />

          {((err && !snap?.ccn_ok) || (snap && !snap.ccn_ok)) && (
            <div className="banner bad">
              {err ?? snap?.ccn_error}
              {snap?.cached_at && <span>{savedLabel(snap.cached_at)} に保存した一覧と会話を出している</span>}
              <span className="hint">次: ターミナルで <code>ccn doctor</code> を実行する</span>
            </div>
          )}

          {snap && agents.length === 0 && snap.ccn_ok && (
            <div className="empty">
              <p>町にはまだ誰もいない。最初の世帯を作ると、右にチャットが開いてすぐ打てる（親は {place ? place.replace(/^\/Users\/[^/]+/, "~") : "~/Documents/meta"} で起動する。設定で変えられる）。</p>
              <NewHousehold disabled={!local} place={place} onCreated={newHousehold} onError={(m) => toast(m, true)} />
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
      {succeedAsk && (
        <SucceedConfirm agent={succeedAsk} parent={succeedAsk.parent ? tree.byId.get(succeedAsk.parent) ?? null : null}
          kids={(tree.childrenOf.get(succeedAsk.id) ?? []).length}
          onCancel={() => setSucceedAsk(null)} onConfirm={() => { const a = succeedAsk; setSucceedAsk(null); succeed(a); }} />
      )}
      {succeedNote && (
        <Confirm title={succeedNote.title} ok="閉じる" single onCancel={() => setSucceedNote(null)} onConfirm={() => setSucceedNote(null)}>{succeedNote.text}</Confirm>
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}>{t.text}</div>)}
      </div>
      <div className="letters-layer" ref={letterMarks.layer} aria-hidden />
    </div>
    </TownCtx.Provider>
    </LetterCtx.Provider>
    </SendCtx.Provider>
    </SucceedCtx.Provider>
    </KillCtx.Provider>
    </SkinCtx.Provider>
  );
}

function descOf(childrenOf: Map<string, Agent[]>, id: string): Agent[] {
  return (childrenOf.get(id) ?? []).filter((k) => !k.ghost).flatMap((k) => [k, ...descOf(childrenOf, k.id)]);
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
      ccn でセッションを止める。{descendants ? "子孫は孫から順に止める。" : ""}止まらなかった分は画面に残る。⌘ を押しながら 🐺 を押すと、確認なしで閉じる。
    </Confirm>
  );
}

/** 引き継ぐ前の確認。前任を止める操作を含むので、閉じるときと同じ形で確かめる。parent は前任の親（根なら null）、kids は前任の子の数 */
function SucceedConfirm({ agent, parent, kids, onCancel, onConfirm }: { agent: Agent; parent: Agent | null; kids: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm title={`${agent.name} を後継に引き継ぐ？`} ok="引き継ぐ" onCancel={onCancel} onConfirm={onConfirm}>
      利用上限で止まったときに使う。同じ会話を複製した後継を、{parent ? `${parent.name} の下に` : "世帯の親として"}立てる。アカウントは ccn が枠の残るものを選ぶ。
      後継が起動したのを確かめてから、{agent.name} を止める。後継が立たなかったら止めない。
      {kids ? `子 ${kids} 人は止めない。ccn が子を後継の下に付け替える（古い ccn では付け替わらず、子は別の世帯に分かれる）。` : ""}
    </Confirm>
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
      onClick={(e) => { if (!(e.target as HTMLElement).closest(".card, .mini, .pop, .g-head, .ghost-card, .card-acts, .letter-mark")) onBlank(); }}>
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
            {/* 右下のボタンはカード（札）の縁を基準に置くので、カードと同じ大きさの包みに入れる（カードは overflow: hidden） */}
            <div className={`fnode-body ${n.depth >= 2 ? "k-mini" : "k-card"}`} data-aid={n.id}
              style={n.depth >= 2 ? { ["--kx-k" as string]: boxOf(n.depth, a.name).scale } : undefined}>
              {a.ghost ? <GhostCard agent={a} depth={n.depth} onSelect={onSelect} /> : <Card agent={a} depth={n.depth} selected={selected === n.id} onSelect={onSelect} onFocus={onFocus} />}
              {letters.has(n.id) && <img className="letter-mark" src={LETTER_IMG} alt="お手紙が届いた" title="お手紙が届いた" />}
              {/* 孫より下の小さい札には付けない。選んだときに重なる大きいカード（.pop）の中で付ける（Card） */}
              {!a.ghost && n.depth <= 1 && delay === undefined && <CardActions agent={a} />}
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
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __fcRenders?: typeof renders }).__fcRenders = renders;

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
 * 転出のゴースト（src/ghost.ts）。別の町にいる親か子の影。半透明、点線の枠、旅行かばんの印で、閉じる演出の 👻 と分ける。
 * 押すと本物がいる町に切り替えて、その子を選ぶ。右下のボタンは出さない（ここからは閉じない）。
 */
const GhostCard = memo(function GhostCard({ agent, depth, onSelect }: { agent: Agent; depth: number; onSelect: (a: Agent) => void }) {
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
});

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
