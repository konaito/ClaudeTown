import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IS_WEB, setFullscreen } from "./bridge";
import { perfMark } from "./term/perf";
import { loadTerminal } from "./term/lazyTerminal";
import { useBench } from "./term/bench";
import { collectMail, type Mail } from "./mail";
import { flightsOf } from "./letters";
import { kickTown } from "./town";
import { Group as SplitGroup, Panel as SplitPanel, Separator, type Layout } from "react-resizable-panels";
import { Maximize, Minus, PanelLeftClose, PanelLeftOpen, Plus, Settings, Users } from "lucide-react";
import { NewHousePane } from "./newHouse/NewHousePane";
import { NewHousehold } from "./newHouse/NewHousehold";
import { Credits } from "./credits/Credits";
import { ICON, STROKE } from "./icons";
import { groupSizeOf } from "./layout/params";
import { useToasts } from "./hooks/useToasts";
import { useTown } from "./hooks/useTown";
import { usePanes } from "./hooks/usePanes";
import { useSelection } from "./hooks/useSelection";
import { useZoom } from "./hooks/useZoom";
import { useHidden } from "./hooks/useHidden";
import { useKill } from "./hooks/useKill";
import { useRestart } from "./hooks/useRestart";
import { useCardSend } from "./hooks/useCardSend";
import { useQueuedWatch } from "./hooks/useQueuedWatch";
import { useRestoreNotice } from "./hooks/useRestoreNotice";
import { supportFor } from "./session/SessionControls";
import { useCcnReservations } from "./webReserve";
import { Stage } from "./canvas/Stage";
import { FamilyCanvas, Group, layoutOf } from "./canvas/FamilyCanvas";
import { KillConfirm } from "./confirm/Confirm";
import { killPlan } from "./killPlan";
import { NextRow } from "./NextRow";
import { useLetterMarks } from "./useLetterMarks";
import { Panel } from "./panel/Panel";
import { DepthCtx, KillCtx, LetterCtx, RestartCtx, SendCtx, TownCtx } from "./contexts";
import { loadPlace, savePlace } from "./newHouse/placeSetting";
import { SettingsDialog } from "./settings/SettingsDialog";
import { showDot, useUpdateStatus } from "./settings/update";
import { loadDefaults, sameDefaults, saveDefaults } from "./session/defaults";
import "./App.css";
import "./mobile/mobile.css";
import { MobileShell } from "./mobile/MobileShell";
import { useMobileLayout, useVisualViewport } from "./mobile/useMobile";
import { SkinCtx, saveSkin, savedSkin, type Skin } from "./kid/pokemon";
import {
  type Agent, type Mood,
  MOOD_LABEL, NEEDS_YOU, buildTree, cardNames, moodOf,
} from "./model";
import type { CreatedSession } from "./types";
import { NEW_HOUSE_CAPS, hasTerminal } from "./abilities";
import { useMenu } from "./menu";

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
/** 世帯の要約の凡例に並べる順 */
const LEGEND: Mood[] = ["working", "reply", "approval", "done", "idle"];

export default function App() {
  // スマホ専用の画面（src/mobile）。取得・選択・送信の状態はこの App が持ち、下の return の並べ方だけを切り替える
  const mobile = useMobileLayout();
  useVisualViewport(mobile);
  useEffect(() => { const t = setTimeout(() => { void loadTerminal(); }, 2000); return () => clearTimeout(t); }, []);
  const { snap, err, reload } = useTown();
  const { selected, setSelected, fresh, setFresh, termReq, setTermReq, chatReq, setChatReq, composeReq, setComposeReq, focus } = useSelection();
  const { toasts, toast } = useToasts();
  const { zoom, zoomOut, zoomIn, zoomFit } = useZoom();

  // 閉じたセッション。演出が終わったら隠し、一覧から消えたら忘れる（10秒たっても消えなければ戻して失敗を出す）
  const { setHidden, agents } = useHidden(snap, toast);
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
  const depthOf = useMemo(() => (id: string) => { const t = treeRef.current; const a = t.byId.get(id); return a ? t.lineage(a).length - 1 : null; }, [shape]);
  const pick = useCallback((a: Agent) => setSelected(a.id), []);

  const { kill, killAsk, setKillAsk, killCtx } = useKill({ tree, selected, setSelected, toast, setHidden });
  const { restartCtx } = useRestart(toast);
  // お手紙（記録はこの機械の hook が書く）
  const flights = useMemo(() => flightsOf(snap?.letters ?? [], agents), [snap, agents]);
  // ブラウザ版の ccn の行で予約したモデルと権限モードを、替えられるようになったら替える（always-switch）。アプリの端末の予約は Rust が当てる（switch.rs）
  useCcnReservations(agents, supportFor, (m) => toast(m), (m) => toast(m, true));
  const letterMarks = useLetterMarks(flights, snap !== null);
  const { panelSend, cardSend } = useCardSend(toast);
  // 起動を待って預けた文が送れなかったら、パネルを開いていなくても知らせる（#184）
  const listed = useCallback((id: string) => treeRef.current.byId.has(id), []);
  useQueuedWatch(toast, listed);
  // 起動のときの端末の立て直しで戻らなかった端末を知らせる（#262）
  useRestoreNotice(toast);
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
  // お便りの通知を押したら、その子のチャットを開く（src-tauri/src/notify.rs の OPEN_EVENT、#292）。窓を前に出すのは Rust がする
  useEffect(() => {
    if (IS_WEB) return;
    let off: (() => void) | null = null;
    let live = true;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<string>("notify-open", (e) => {
      if (typeof e.payload !== "string" || !e.payload) return;
      setSelected(e.payload);
      setChatReq((n) => n + 1);
    })).then((u) => { if (live) off = u; else u(); });
    return () => { live = false; off?.(); };
  }, []);
  const openMail = useCallback((m: Mail, chat = false) => {
    setSelected(m.agent.id);
    if (chat) setChatReq((n) => n + 1);
  }, []);

  // 作ったらチャットを開いて入力欄にフォーカスする（本人の指定）。端末は右クリックや「端末へ」で開く
  const newHousehold = useCallback((r: CreatedSession | null) => {
    if (!r?.id) return;
    // ログインシェルが PATH を返さず、アプリの PATH（/usr/bin:/bin:/usr/sbin:/sbin）で立てた（#175）。次に立てるときは聞き直す
    if (r.pathFallback) toast("ログインシェルの PATH を取れなかったので、この claude は最小の PATH で動いている。bun や gh が見つからないときは立て直す", true);
    // cam usage が上限で返らず、既定のアカウントで立てた（#249）。上限に達したアカウントだと、最初の送信まで気づかない
    if (r.accountFallback) toast(r.accountFallback, true);
    setFresh({
      // 名前は一覧と同じ決め方（cardNames）。一覧に載ったときに名前が変わって見えないようにする
      id: r.id, name: cardNames([{ id: r.id, cwd: r.cwd ?? "" }]).get(r.id) ?? r.id.slice(0, 8), kind: "terminal", state: "running", cwd: r.cwd ?? "", canSend: true, parent: null,
      startedAt: Date.now(), capabilities: NEW_HOUSE_CAPS, source: IS_WEB ? "ccn" : "app",
    });
    setSelected(r.id);
    setComposeReq((n) => n + 1);
    reload.current();
  }, [toast]);

  const sel = selected ? tree.byId.get(selected) ?? (fresh?.id === selected ? fresh : null) : null;
  // 一覧に載ったら仮の姿を捨てる
  useEffect(() => { if (fresh && tree.byId.has(fresh.id)) setFresh(null); }, [tree, fresh]);
  useEffect(() => { if (sel) perfMark("listed", sel.id); }, [sel?.id]);
  useBench({ ready: !!snap, select: setSelected, focusId: (id) => { const a = tree.byId.get(id); if (a) focus(a); } });

  // メニューバー（#300）から右パネルの「状態」のタブと、入力欄のキーの一覧（? と同じ）を開く合図
  const [stateReq, setStateReq] = useState(0);
  const [helpReq, setHelpReq] = useState(0);
  const panelProps = {
    agent: sel, lineage: sel ? tree.lineage(sel) : [], termReq, chatReq, composeReq, stateReq, helpReq, sendHook: panelSend,
    onSent: (a: Agent) => { kickTown(); toast(`${a.name} に届けた`); }, onSent2: (m: string) => { kickTown(); toast(m); }, onError: (m: string) => toast(m, true),
    needs, onSelect: (a: Agent) => setSelected(a.id), onClose: () => setSelected(null),
  };

  // 3枚のペイン（#89）。左の新しい世帯のペインはヘッダーのボタンとドラッグで開け閉めする。
  // 右のチャットは、セッションを選んでいないときに閉じ、選んだら開く。閉じても Panel は残す（入力欄の下書きを Panel が持っているため）
  const { housesRef, sideRef, housesOpen, setHousesOpen, sideOpen, setSideOpen, selRef, toggleHouses } = usePanes(!!sel, mobile, HOUSES_MIN + TOWN_MIN + SIDE_MIN);
  // 設定（#92）。「新しい世帯」で親を立てる場所。null は既定（~/Documents/meta）
  const [place, setPlace] = useState<string | null>(loadPlace);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 設定を開いたときに見せる欄。メニューの「アップデートを確認…」は更新の欄まで送る
  const [settingsFocus, setSettingsFocus] = useState<"update" | null>(null);
  const openSettings = (focus: "update" | null = null) => { setSettingsFocus(focus); setSettingsOpen(true); };
  // 安定版の更新があるか（#295）。あれば歯車に点を付ける。開発版とブラウザ版では null のまま
  const [update, setUpdate] = useUpdateStatus(60_000);
  const updateDot = showDot(update);

  // メニューバー（#300）。押したら画面の既存の操作を呼ぶ。押せる・押せないは state で Rust に渡す（src/menu.ts、src-tauri/src/menu.rs）
  const [newReq, setNewReq] = useState(0);
  const [resumeReq, setResumeReq] = useState(0);
  const [creditsReq, setCreditsReq] = useState(0);
  const bump = (set: React.Dispatch<React.SetStateAction<number>>) => set((n) => n + 1);
  const openHouses = () => { const r = housesRef.current; if (r?.isCollapsed()) r.expand(); };
  const term = !!sel && hasTerminal(sel);
  useMenu({
    update: () => openSettings("update"),
    settings: () => openSettings(),
    "new-house": () => bump(setNewReq),
    resume: () => { openHouses(); bump(setResumeReq); },
    "open-chat": () => { if (sel) bump(setChatReq); },
    "open-term": () => { if (term) bump(setTermReq); },
    sidebar: toggleHouses,
    "zoom-in": zoomIn,
    "zoom-out": zoomOut,
    "zoom-fit": zoomFit,
    "tab-chat": () => { if (sel) bump(setChatReq); },
    "tab-state": () => { if (sel) bump(setStateReq); },
    "tab-term": () => { if (term) bump(setTermReq); },
    "help-keys": () => { if (sel) bump(setHelpReq); },
    credits: () => bump(setCreditsReq),
  }, { selected: !!sel, terminal: term, sidebar: housesOpen, update: update ? update.available : null });

  return (
    <SkinCtx.Provider value={skinCtx}>
    <KillCtx.Provider value={killCtx}>
    <RestartCtx.Provider value={restartCtx}>
    <SendCtx.Provider value={cardSend}>
    <LetterCtx.Provider value={letterMarks.marks}>
    <TownCtx.Provider value={agents}><DepthCtx.Provider value={depthOf}>
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
          <NewHousePane place={place} onCreated={newHousehold} onError={(m) => toast(m, true)} newReq={newReq} resumeReq={resumeReq} />
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
              <h1>Claude Town</h1>
            </div>
            <div className="top-mid" />
            <div className="top-right">
              <button className="side-toggle set-gear" onClick={() => openSettings()} aria-label={updateDot ? "設定（更新がある）" : "設定"}
                title={updateDot ? "設定（更新がある）" : "設定"} aria-haspopup="dialog">
                <Settings size={18} strokeWidth={1.8} />{updateDot && <i className="set-dot" aria-hidden />}
              </button>
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
              <NewHousehold place={place} onCreated={newHousehold} onError={(m) => toast(m, true)} />
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
              <button onClick={zoomOut} aria-label="小さくする" title="小さくする"><Minus size={ICON.md} strokeWidth={STROKE} /></button>
              <button className="zval" onClick={zoomFit} title="全体が入る大きさにする">
                {zoom === "fit" ? "全体" : `${Math.round(zoom * 100)}%`}
              </button>
              <button onClick={zoomIn} aria-label="大きくする" title="大きくする"><Plus size={ICON.md} strokeWidth={STROKE} /></button>
              <button className="fs" title="全画面" aria-label="全画面" onClick={() => setFullscreen()}><Maximize size={ICON.md} strokeWidth={STROKE} /></button>
            </div>
            <span className="hint">クリックでチャット・右クリックでターミナル</span>
            <Credits skin={skin} onSkin={(v) => { setSkin(v); saveSkin(v); }} openReq={creditsReq} />
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

      {settingsOpen && <SettingsDialog place={place} defaults={loadDefaults()} focus={settingsFocus} onSave={(p, d) => {
        // 変えた項目を知らせる
        const msgs: string[] = [];
        if (p !== place) { savePlace(p); setPlace(p); msgs.push(p ? "新しい世帯の場所を変えた" : "新しい世帯の場所を既定に戻した"); }
        if (!sameDefaults(d, loadDefaults())) { saveDefaults(d); msgs.push("新しい世帯のモデルと権限モードを変えた"); }
        toast(msgs.length ? msgs.join("。") : "設定を保存した");
      }} onClose={() => setSettingsOpen(false)} onUpdateStatus={setUpdate} />}

      {killAsk && (
        <KillConfirm agent={killAsk} plan={killPlan(tree.childrenOf, killAsk)}
          onCancel={() => setKillAsk(null)} onConfirm={() => { const a = killAsk; setKillAsk(null); kill(a); }} />
      )}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}>{t.text}</div>)}
      </div>
      <div className="letters-layer" ref={letterMarks.layer} aria-hidden />
    </div>
    </DepthCtx.Provider></TownCtx.Provider>
    </LetterCtx.Provider>
    </SendCtx.Provider>
    </RestartCtx.Provider>
    </KillCtx.Provider>
    </SkinCtx.Provider>
  );
}

