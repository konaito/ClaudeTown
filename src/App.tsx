import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IS_WEB, call as invoke, setFullscreen } from "./bridge";
import { pickTown, savedTown, saveTown } from "./webTown";
import { lastTermSize } from "./term/size";
import { perfMark, perfStart } from "./term/perf";
import { loadTerminal } from "./term/lazyTerminal";
import { useBench } from "./term/bench";
import { collectMail, type Mail } from "./mail";
import { flightsOf } from "./letters";
import { withGhosts } from "./ghost";
import { pollWhileVisible } from "./visible";
import { reuseAgents, reuseSnap } from "./snap";
import { kickTown, otherTownRetryMs, watchTown } from "./town";
import { SucceedError, kidsOf, startSuccessor, succeedBlock } from "./succeed";
import { Group as SplitGroup, Panel as SplitPanel, Separator, usePanelRef, type Layout } from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen, Settings, Users } from "lucide-react";
import { NewHousePane } from "./newHouse/NewHousePane";
import { NewHousehold } from "./newHouse/NewHousehold";
import { Credits } from "./credits/Credits";
import { HouseIcon } from "./icons";
import { groupSizeOf } from "./layout/params";
import { Stage } from "./canvas/Stage";
import { FamilyCanvas, Group, layoutOf } from "./canvas/FamilyCanvas";
import { Confirm, KillConfirm, SucceedConfirm } from "./confirm/Confirm";
import { NextRow } from "./NextRow";
import { useLetterMarks } from "./useLetterMarks";
import { Panel } from "./panel/Panel";
import { KillCtx, LetterCtx, SendCtx, SucceedCtx, TownCtx } from "./contexts";
import { loadPlace, savePlace } from "./newHouse/placeSetting";
import { SettingsDialog } from "./settings/SettingsDialog";
import "./App.css";
import "./mobile/mobile.css";
import { MobileShell } from "./mobile/MobileShell";
import { useMobileLayout, useVisualViewport } from "./mobile/useMobile";
import { SkinCtx, saveSkin, savedSkin, type Skin } from "./kid/pokemon";
import {
  type Agent, type Mood, type Peer, type Snapshot,
  MOOD_LABEL, NEEDS_YOU, buildTree, cardNames, moodOf,
} from "./model";
import { savedLabel } from "./conv";
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

function countDesc(childrenOf: Map<string, Agent[]>, id: string): number {
  return (childrenOf.get(id) ?? []).reduce((n, k) => n + 1 + countDesc(childrenOf, k.id), 0);
}
