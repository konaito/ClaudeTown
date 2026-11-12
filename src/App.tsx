import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { call as invoke, setFullscreen } from "./bridge";
import "./App.css";
import { Avatar, hash as hashOf, type Role } from "./kid/Avatar";
import {
  type Agent, type ConvItem, type Mood, type Peer, type Snapshot,
  MOOD_LABEL, NEEDS_YOU, buildTree, choicesOf, clip, houseNameOf, moodOf, nowOf, sinceText, taskOf,
} from "./model";
import { Markdown } from "./Markdown";

const POLL_MS = 2000;
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

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await invoke<Snapshot>("snapshot", { peer: peer || null });
        if (alive) { setSnap(s); setErr(null); }
      } catch (e) {
        if (alive) setErr(String(e));
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    const c = setInterval(() => tick((x) => x + 1), 1000);
    return () => { alive = false; clearInterval(t); clearInterval(c); };
  }, [peer]);

  const agents = snap?.agents ?? [];
  const tree = useMemo(() => buildTree(agents), [agents]);
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
  const done = useMemo(() => agents.filter((a) => moodOf(a) === "done"), [agents]);

  const local = !peer;
  const focus = useCallback(async (a: Agent) => {
    if (!local) { toast("別の機械のペインには移れない", true); return; }
    try {
      await invoke("focus_pane", { terminalId: a.terminalId ?? null, pid: a.pid ?? null });
      toast(`${a.name} のペインへ移動した`);
    } catch (e) {
      toast(`${a.name} のペインへ移れなかった: ${e}`, true);
    }
  }, [toast, local]);

  const sel = selected ? tree.byId.get(selected) ?? null : null;
  const selfPeer = peers.find((p) => p.self);

  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <header className="top">
        <div className="brand">
          <HouseIcon />
          <h1>family computing</h1>
        </div>
        <div className="top-mid">
          <select className="node" value={peer} onChange={(e) => { setPeer(e.target.value); setSelected(null); }}>
            <option value="">このMac{selfPeer ? `（${selfPeer.name}）` : ""}</option>
            {peers.filter((p) => !p.self).map((p) => (
              <option key={p.name} value={p.name} disabled={p.status !== "healthy"}>{p.name}{p.status !== "healthy" ? "（つながらない）" : ""}</option>
            ))}
          </select>
          <span className={`conn ${snap?.ccn_ok ? "ok" : "bad"}`}><i />{snap ? (snap.ccn_ok ? "接続中" : "つながらない") : "よみこみ中"}</span>
        </div>
        <div className="top-right" />
      </header>

      <div className="body">
        <div className="left">
          <NextRow needs={needs} done={done} working={counts.working} total={agents.length}
            onSelect={(a) => setSelected(a.id)} onFocus={focus} />

          {(err || (snap && !snap.ccn_ok)) && (
            <div className="banner bad">
              {err ?? snap?.ccn_error}
              <span className="hint">次: ターミナルで <code>ccn doctor</code> を実行する</span>
            </div>
          )}

          <div className="fam-head">
            <span className="fam-title"><PeopleIcon /> 家族</span>
            <span className="fam-count">{tree.families.length}家族・{agents.length}人</span>
            <span className="legend">
              {(["working", "reply", "approval", "done", "idle"] as Mood[]).map((m) => (
                <span key={m} className={`lg lg-${m}`}><i />{MOOD_LABEL[m]}{counts[m] ? ` ${counts[m]}` : ""}</span>
              ))}
            </span>
          </div>

          {snap && agents.length === 0 && snap.ccn_ok && (
            <div className="empty">いまは誰もいない。Specter で Claude Code を開くと、ここに家族がふえる。</div>
          )}
          <Stage zoom={zoom} deps={agents.length} onBlank={() => setSelected(null)}>
            {/* 並べ方は大きいグループから（一番大きいものを左、残りを右に詰める） */}
            {[...tree.families].sort((x, y) => y.all.length - x.all.length).map((f) => (
              <Group key={f.root.id} root={f.root} all={f.all} count={f.all.length}
                onRename={async (name) => {
                  try { await invoke("set_house_name", { sessionId: f.root.id, name }); toast(name ? `グループの名前を「${name}」にした` : "グループの名前を戻した"); }
                  catch (e) { toast(`グループの名前を変えられなかった: ${e}`, true); }
                }}
                hasNeeds={f.all.some((a) => NEEDS_YOU.includes(moodOf(a)))}>
                <Tree agent={f.root} depth={0} childrenOf={tree.childrenOf}
                  selected={selected} onSelect={(a) => setSelected(a.id)} onFocus={focus} />
              </Group>
            ))}
          </Stage>

          <div className="left-foot">
            <div className="zoom">
              <button onClick={() => setZoom((z) => Math.max(0.4, +(((z === "fit" ? 1 : z) - 0.1).toFixed(2))))}>−</button>
              <button className="zval" onClick={() => setZoom("fit")} title="全体が入る大きさにする">
                {zoom === "fit" ? "全体" : `${Math.round(zoom * 100)}%`}
              </button>
              <button onClick={() => setZoom((z) => Math.min(1.6, +(((z === "fit" ? 1 : z) + 0.1).toFixed(2))))}>＋</button>
              <button className="fs" title="全画面" onClick={() => setFullscreen()}>⛶</button>
            </div>
            <span className="hint">クリックで会話・右クリックでペインへ</span>
            <Credits />
          </div>
        </div>

        <Panel agent={sel} peer={peer} lineage={sel ? tree.lineage(sel) : []} onFocus={focus} canFocus={local}
          onSent={(a) => toast(`${a.name} に届けた`)} onError={(m) => toast(m, true)}
          needs={needs} onSelect={(a) => setSelected(a.id)} />
      </div>

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}>{t.text}</div>)}
      </div>
    </div>
  );
}

// ---------- 上の段 ----------

function NextRow({ needs, done, working, total, onSelect, onFocus }: {
  needs: Agent[]; done: Agent[]; working: number; total: number;
  onSelect: (a: Agent) => void; onFocus: (a: Agent) => void;
}) {
  const first = needs[0];
  const rest = [
    ...needs.slice(1).map((a) => ({ a, text: moodOf(a) === "approval" ? `${a.name}の承認待ち` : `${a.name}から返事待ち`, icon: moodOf(a) === "approval" ? "✋" : "💬" })),
    ...done.map((a) => ({ a, text: `${a.name}の報告を確認`, icon: "✓" })),
  ].slice(0, 2);
  const hidden = needs.length + done.length - 1 - rest.length;
  return (
    <div className="next-row">
      <span className="next-label">次の一手</span>
      {first ? (
        <div className={`next-main nm-${moodOf(first)}`}>
          <span className="next-icon">{moodOf(first) === "approval" ? "✋" : "💬"}</span>
          <button className="next-text" onClick={() => onSelect(first)}>
            {moodOf(first) === "approval" ? `${first.name}の承認待ちを確認する` : `${first.name}に返事する`}
          </button>
          <button className="pane-btn" onClick={() => onFocus(first)}>ペインへ ↗</button>
        </div>
      ) : (
        <div className="next-main nm-calm">
          <span className="next-text calm">
            {total === 0 ? "いまは誰もいない" : working > 0 ? `いまはあなたの番じゃない。${working}人が作業中` : "みんな待機中。頼みたい子をクリック"}
          </span>
        </div>
      )}
      {rest.length > 0 && <span className="next-sep" />}
      {rest.map(({ a, text, icon }) => (
        <button key={a.id} className="next-chip" onClick={() => onSelect(a)}><span>{icon}</span>{text}</button>
      ))}
      {hidden > 0 && <span className="next-more">ほか{hidden}件</span>}
    </div>
  );
}

// ---------- 家と木 ----------

/**
 * グループを並べる場所。一番大きいグループを左に置き、残りは右の余った幅に折り返して詰める。
 * 右に一番広い小さいグループが入る倍率が 0.6 を下回るときは、残りを下に回して大きいグループだけで幅を合わせる。
 * zoom が fit のときはこの倍率を使う（最小 0.4。それでも入らなければ横にスクロールする）。
 */
function Stage({ zoom, deps, onBlank, children }: { zoom: number | "fit"; deps: number; onBlank: () => void; children: React.ReactNode[] }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [avail, setAvail] = useState(1000);
  const [side, setSide] = useState(true);
  const [bigW, setBigW] = useState(0);
  const applied = useRef(1);
  const GAP = 28;
  useLayoutEffect(() => {
    const measure = () => {
      if (!outer.current || !inner.current) return;
      const w = outer.current.clientWidth - 36;
      // 画面上の幅は zoom をかけた後の値なので、かけている倍率で割って元の幅に戻す
      const widths = Array.from(inner.current.querySelectorAll<HTMLElement>(".group"))
        .map((g) => g.getBoundingClientRect().width / applied.current);
      const big = widths[0] ?? 1;
      const restMax = Math.max(0, ...widths.slice(1));
      const withSide = restMax ? w / (big + GAP + restMax) : w / big;
      const useSide = restMax > 0 && withSide >= 0.6;
      setSide(useSide);
      setBigW(big);
      setAvail(w);
      setFit(Math.max(0.4, Math.min(1, useSide ? withSide : w / big)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (outer.current) ro.observe(outer.current);
    return () => ro.disconnect();
  }, [deps]);
  const scale = zoom === "fit" ? fit : zoom;
  applied.current = scale;
  const width = Math.floor(avail / scale);
  const [first, ...rest] = children;
  return (
    <div className="stage" ref={outer}
      onClick={(e) => { if (!(e.target as HTMLElement).closest(".card, .mini, .pop, .g-head")) onBlank(); }}>
      <div className={`stage-inner ${side ? "side" : "below"}`} ref={inner} style={{ zoom: scale, width }}>
        {first}
        {rest.length > 0 && (
          <div className="rest" style={side ? { width: Math.max(0, width - bigW - GAP) } : undefined}>{rest}</div>
        )}
      </div>
    </div>
  );
}

/** グループ（根のセッション1つとその子孫）ごとの淡い色。名前から決まる */
const GROUP_TINTS = ["#f3f7ff", "#fff6ec", "#f1faf3", "#f8f3ff", "#fff2f5", "#eff9f9", "#fbf8ec"];
const GROUP_LINES = ["#d9e4fb", "#f6dfc4", "#d3ecd9", "#e4d8f6", "#f6d6df", "#cfe9e9", "#ece4c2"];

function Group({ root, all, count, hasNeeds, onRename, children }: {
  root: Agent; all: Agent[]; count: number; hasNeeds: boolean; onRename: (name: string) => void; children: React.ReactNode;
}) {
  const house = houseNameOf(root, all);
  const [editing, setEditing] = useState(false);
  const tint = hashOf(root.id) % GROUP_TINTS.length;
  return (
    <section className={`group ${hasNeeds ? "has-needs" : ""}`}
      style={{ background: GROUP_TINTS[tint], borderColor: hasNeeds ? undefined : GROUP_LINES[tint] }}>
      <div className="g-head" onDoubleClick={() => setEditing(true)}
        title={`ダブルクリックで名前を変える（${house.by === "human" ? "あなたが付けた名前" : house.by === "agent" ? `${root.name}が付けた名前` : "仮の名前"}）`}>
        {editing ? (
          <input className="g-input" autoFocus defaultValue={house.by === "human" ? house.name : ""} placeholder={house.name}
            maxLength={24}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onRename(e.currentTarget.value); setEditing(false); }
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={() => setEditing(false)} />
        ) : (
          <span className={`g-name ${house.by === "guess" ? "guess" : ""}`}>{house.name}</span>
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
const SHRINK = 0.86;
const MIN_SCALE = 0.6;
/** この深さから下は小さい札で描く（0=親、1=子、2=孫） */
const COMPACT_FROM = 2;

function Tree({ agent, depth, childrenOf, selected, onSelect, onFocus }: {
  agent: Agent; depth: number; childrenOf: Map<string, Agent[]>; selected: string | null;
  onSelect: (a: Agent) => void; onFocus: (a: Agent) => void;
}) {
  const kids = childrenOf.get(agent.id) ?? [];
  // どの深さでも同じ規則（カードの下に子を横に並べ、上から線でつなぐ）で描く。
  // 子の段は kidsZoomAt の倍率で縮め、入れ子で掛け合わさって自己相似になる。孫より下は小さい札にする
  const kidsZoom = kidsZoomAt(depth);
  return (
    <div className="branch">
      <Card agent={agent} depth={depth} selected={selected === agent.id} onSelect={onSelect} onFocus={onFocus} />
      {kids.length > 0 && (
        <div className="kids" style={{ zoom: kidsZoom }}>
          {kids.map((k) => (
            <Tree key={k.id} agent={k} depth={depth + 1} childrenOf={childrenOf} selected={selected} onSelect={onSelect} onFocus={onFocus} />
          ))}
        </div>
      )}
    </div>
  );
}

function Card(props: { agent: Agent; depth: number; selected: boolean; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void }) {
  const { agent, depth, selected, onSelect, onFocus } = props;
  if (depth < COMPACT_FROM) return <FullCard {...props} />;
  // 孫より下は小さい札。選んだときだけ、親や子と同じ見た目の大きさのカードを上に重ねる（周りは動かさない）
  const mood = moodOf(agent);
  const now = nowOf(agent, mood);
  return (
    <div className={`mini-wrap ${selected ? "open" : ""}`}>
      <button
        className={`mini m-${mood} ${selected ? "sel" : ""}`}
        onClick={() => onSelect(agent)}
        onContextMenu={(e) => { e.preventDefault(); onFocus(agent); }}
        title={`${agent.name}\n${MOOD_LABEL[mood]}${now ? `: ${now}` : ""}\nクリックで広げて会話・右クリックでペインへ`}
      >
        <Avatar seed={agent.name} mood={mood} role={roleOf(depth)} size={32} />
        <span className="mini-name"><i className={`dot st-${mood}`} />{agent.name}</span>
      </button>
      {selected && (
        <div className="pop" style={{ zoom: 1 / scaleAt(depth) }}>
          <FullCard {...props} />
        </div>
      )}
    </div>
  );
}

/** その深さのカードに、入れ子の zoom が掛け合わさった倍率 */
function scaleAt(depth: number): number {
  let s = 1;
  for (let d = 1; d <= depth; d++) s *= kidsZoomAt(d - 1);
  return s;
}
/** 深さ depth のノードの子の段にかける zoom。孫の段（札になる段）で大きく縮め、その下は SHRINK ずつ、MIN_SCALE で止める */
function kidsZoomAt(depth: number): number {
  const z = depth + 1 === COMPACT_FROM ? 1 : SHRINK;
  let here = 1;
  for (let d = 0; d < depth; d++) here *= d + 1 === COMPACT_FROM ? 1 : SHRINK;
  return here * z >= MIN_SCALE ? z : 1;
}

function FullCard({ agent, depth, selected, onSelect, onFocus }: {
  agent: Agent; depth: number; selected: boolean; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void;
}) {
  const mood = moodOf(agent);
  const task = taskOf(agent, mood);
  const now = nowOf(agent, mood);
  const since = mood === "working" ? sinceText(agent.report?.turn_started_at) : "";
  return (
    <button
      className={`card m-${mood} ${selected ? "sel" : ""}`}
      onClick={() => onSelect(agent)}
      onContextMenu={(e) => { e.preventDefault(); onFocus(agent); }}
      title={`${agent.name}\n${MOOD_LABEL[mood]}${now ? `: ${now}` : ""}\nクリックで会話・右クリックでペインへ`}
    >
      <div className="card-top">
        <span className="role">{ROLE_LABEL[Math.min(depth, 4)]}</span>
        <span className="task">{clip(task, 14)}</span>
      </div>
      <div className="card-main">
        <Avatar seed={agent.name} mood={mood} role={roleOf(depth)} size={48} />
        <div className="card-info">
          <span className={`st st-${mood}`}><i />{MOOD_LABEL[mood]}{since && <em>{since}</em>}</span>
          <span className="cname">{agent.name}</span>
        </div>
      </div>
    </button>
  );
}

// ---------- 右のパネル ----------

function Panel({ agent, peer, lineage, onFocus, canFocus, onSent, onError, needs, onSelect }: {
  agent: Agent | null; peer: string; lineage: Agent[]; onFocus: (a: Agent) => void; canFocus: boolean;
  onSent: (a: Agent) => void; onError: (m: string) => void; needs: Agent[]; onSelect: (a: Agent) => void;
}) {
  const [tab, setTab] = useState<"talk" | "state">("talk");
  const [items, setItems] = useState<ConvItem[]>([]);
  const [pending, setPending] = useState<ConvItem[]>([]);
  const [convErr, setConvErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const id = agent?.id;

  useEffect(() => {
    setItems([]); setPending([]); setConvErr(null); stick.current = true;
    if (!id) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await invoke<ConvItem[]>("conversation", { sessionId: id, peer: peer || null });
        if (!alive) return;
        setItems(r);
        setConvErr(null);
        setPending((p) => p.filter((x) => !r.some((y) => y.role === "user" && y.text.trim() === x.text.trim())));
      } catch (e) {
        if (alive) setConvErr(String(e));
      }
    };
    load();
    const t = setInterval(load, CONV_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [id, peer]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, pending]);

  if (!agent) {
    return (
      <aside className="panel empty-panel">
        <div className="ep">
          <p className="ep-title">子供をクリックすると、ここで話せる</p>
          {needs[0] && (
            <button className="primary" onClick={() => onSelect(needs[0])}>{needs[0].name}をひらく</button>
          )}
          <p className="hint">右クリックで、その子の Specter のペインへ移る</p>
        </div>
      </aside>
    );
  }

  const mood = moodOf(agent);
  const send = async (body: string) => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await invoke("send_message", { sessionId: agent.id, text: body, peer: peer || null });
      setPending((p) => [...p, { role: "user", text: body, pending: true, at: new Date().toISOString() }]);
      setText("");
      stick.current = true;
      onSent(agent);
    } catch (e) {
      onError(`${agent.name} に届かなかった: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const shown = collapseTools([...items, ...pending]);
  const lastAssistant = [...items].reverse().find((x) => x.role === "assistant");
  const lastIsAssistant = items.filter((x) => x.role !== "tool").slice(-1)[0]?.role === "assistant";
  const choices = lastAssistant && lastIsAssistant && mood !== "working" ? choicesOf(lastAssistant.text) : [];
  const r = agent.report;

  return (
    <aside className={`panel pm-${mood}`}>
      <div className="p-head">
        <div className="p-avatar"><Avatar seed={agent.name} mood={mood} role={roleOf(lineage.length - 1)} size={64} /></div>
        <div className="p-id">
          <div className="p-name"><span className="pn">{agent.name}</span><span className={`st st-${mood}`}><i />{MOOD_LABEL[mood]}</span></div>
          <div className="p-line">{lineage.map((a, i) => (
            <span key={a.id}>{i > 0 && <b>›</b>}<button className="lnk" onClick={() => onSelect(a)}>{a.name}</button></span>
          ))}</div>
          <div className="p-task"><DocIcon />{taskOf(agent, mood)}</div>
        </div>
        <button className="pane-btn" disabled={!canFocus} onClick={() => onFocus(agent)}>ペインへ ↗</button>
      </div>
      <div className="tabs">
        <button className={tab === "talk" ? "on" : ""} onClick={() => setTab("talk")}>会話</button>
        <button className={tab === "state" ? "on" : ""} onClick={() => setTab("state")}>状態</button>
      </div>

      {tab === "talk" ? (
        <div className="talk" ref={scroller}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {convErr && <div className="banner bad small">{convErr}</div>}
          {shown.length === 0 && !convErr && <p className="hint center">まだ会話が無い</p>}
          {shown.map((x, i) => <Bubble key={i} item={x} agent={agent} lineageDepth={lineage.length - 1} />)}
          {mood === "approval" && (
            <div className="c-warn">承認待ちはここからは答えられない。「ペインへ」で答える。{r?.needs ? `（${r.needs}）` : ""}</div>
          )}
          {choices.length > 0 && (
            <div className="choices">
              {choices.map((c) => <button key={c} className="choice" disabled={busy} onClick={() => send(c)}>{c}</button>)}
            </div>
          )}
        </div>
      ) : (
        <StateTab agent={agent} mood={mood} />
      )}

      <div className="composer">
        <div className="to">送信先: {agent.name}</div>
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
      </div>
    </aside>
  );
}

/** 道具の行が続いたら1行にまとめる */
function collapseTools(items: ConvItem[]): (ConvItem & { more?: number })[] {
  const out: (ConvItem & { more?: number })[] = [];
  for (const x of items) {
    const last = out[out.length - 1];
    if (x.role === "tool" && last?.role === "tool") {
      out[out.length - 1] = { ...x, more: (last.more ?? 0) + 1 };
    } else out.push(x);
  }
  return out;
}

function timeOf(at?: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  return isNaN(+d) ? "" : d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function Bubble({ item, agent, lineageDepth }: { item: ConvItem & { more?: number }; agent: Agent; lineageDepth: number }) {
  if (item.role === "tool") {
    return <div className="tool-line">🔧 {item.text}{item.more ? ` ほか${item.more}件` : ""}</div>;
  }
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
      <div className="mini-av"><Avatar seed={agent.name} mood="idle" role={roleOf(lineageDepth)} size={32} /></div>
      <div>
        <div className="meta"><b>{agent.name}</b>{timeOf(item.at)}</div>
        <div className="b"><Markdown text={item.text} /></div>
      </div>
    </div>
  );
}

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
    ["頼まれたこと", r?.asked ?? agent.title],
    ["最後の報告", r?.said],
    ["次の一手", r?.next],
    ["自分で残した状態", agent.selfStatus ? `${agent.selfStatus.state}: ${agent.selfStatus.note}` : null],
    ["閉じていい？", agent.closeCheck ? (agent.closeCheck.status === "ok" ? "閉じてOK" : agent.closeCheck.status === "ng" ? `まだ: ${agent.closeCheck.short ?? ""}` : "判定中") : null],
    ["作業中の時間", mood === "working" ? sinceText(r?.turn_started_at) : null],
    ["場所", agent.cwd.replace(/^\/Users\/[^/]+/, "~")],
    ["セッション", agent.id],
  ];
  return (
    <dl className="state-tab">
      {rows.filter(([, v]) => v).map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
      {!r && <p className="hint">状態 hook が入っていないので、頼まれたことと次の一手は出ない（README の「hook」を参照）。</p>}
    </dl>
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
          <br /><b>状態の印</b>: Animated emoji: Noto Animated Emoji by Google, licensed under CC BY 4.0
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
