import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { call as invoke, setFullscreen } from "./bridge";
import "./App.css";
import { Avatar, hash as hashOf, type Role } from "./kid/Avatar";
import {
  type Agent, type ConvItem, type Mood, type Peer, type Snapshot,
  MOOD_LABEL, NEEDS_YOU, buildTree, choicesOf, houseNameOf, moodOf, nowOf, sinceText, taskOf,
} from "./model";
import { Markdown } from "./Markdown";
import { layoutFamily, type LNode } from "./layout/layout";
import { LAYOUT, boxOf } from "./layout/params";

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
          <h1>Claude Town</h1>
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
            <span className="fam-title"><PeopleIcon /> {tree.families.length}世帯・{agents.length}人</span>
            <span className="legend">
              {(["working", "reply", "approval", "done", "idle"] as Mood[]).map((m) => (
                <span key={m} className={`lg lg-${m}`}><i />{MOOD_LABEL[m]}{counts[m] ? ` ${counts[m]}` : ""}</span>
              ))}
            </span>
          </div>

          {snap && agents.length === 0 && snap.ccn_ok && (
            <div className="empty">いまは誰もいない。Specter で Claude Code を開くと、ここに世帯がふえる。</div>
          )}
          <Stage zoom={zoom} deps={agents.map((a) => `${a.id}|${a.parent ?? ""}|${a.name}`).join(",")} onBlank={() => setSelected(null)}>
            {/* 並べ方は大きいグループから（一番大きいものを左、残りを右に詰める） */}
            {[...tree.families].sort((x, y) => y.all.length - x.all.length).map((f) => (
              <Group key={f.root.id} root={f.root} all={f.all} count={f.all.length}
                onRename={async (name) => {
                  try { await invoke("set_house_name", { sessionId: f.root.id, name }); toast(name ? `世帯の名前を「${name}」にした` : "世帯の名前を戻した"); }
                  catch (e) { toast(`世帯の名前を変えられなかった: ${e}`, true); }
                }}
                hasNeeds={f.all.some((a) => NEEDS_YOU.includes(moodOf(a)))}>
                <FamilyCanvas all={f.all} selected={selected} onSelect={(a) => setSelected(a.id)} onFocus={focus} />
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
          onSent={(a) => toast(`${a.name} に届けた`)} onSent2={(m) => toast(m)} onError={(m) => toast(m, true)}
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
function Stage({ zoom, deps, onBlank, children }: { zoom: number | "fit"; deps: string; onBlank: () => void; children: React.ReactNode[] }) {
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

/** 家族ごとに前回選んだ配置の候補（更新のたびに形が変わらないよう引き継ぐ） */
const prevArc = new Map<string, number>();

/**
 * 家族の木を、配置計算（src/layout）が決めた座標に置いて描く。
 * 配置を計算し直すのは、家族の顔ぶれ（id、親、名前）が変わったときだけ。状態や会話の更新では動かさない。
 * 線は、配置の検査に使ったのと同じ「親の中心から子の中心」の線分を SVG で引く。
 */
function FamilyCanvas({ all, selected, onSelect, onFocus }: {
  all: Agent[]; selected: string | null; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void;
}) {
  const rootId = all[0].id;
  const sig = all.map((a) => `${a.id}|${a.parent ?? ""}|${a.name}|${a.startedAt ?? 0}`).join(",");
  const result = useMemo(() => {
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
    const r = layoutFamily(nodes, { prevArcIndex: prevArc.get(rootId) });
    prevArc.set(rootId, r.arcIndex);
    if (!r.valid) console.warn("Claude Town: 配置の検査に通る候補が無かった", rootId, r.metrics, r.candidates);
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const pad = LAYOUT.framePad;
  const minX = Math.min(...result.nodes.map((n) => n.x - n.w / 2));
  const minY = Math.min(...result.nodes.map((n) => n.y - n.h / 2));
  const W = result.metrics.width + pad * 2, H = result.metrics.height + pad * 2;
  const ox = pad - minX, oy = pad - minY;
  const byId = new Map(all.map((a) => [a.id, a]));
  const pos = new Map(result.nodes.map((n) => [n.id, n]));
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
        return (
          <div key={n.id} className={`fnode ${selected === n.id ? "open" : ""}`}
            style={{ left: n.x - n.w / 2 + ox, top: n.y - n.h / 2 + oy, width: n.w, height: n.h, transition: `left ${LAYOUT.moveMs}ms ease, top ${LAYOUT.moveMs}ms ease` }}>
            <Card agent={a} depth={n.depth} selected={selected === n.id} onSelect={onSelect} onFocus={onFocus} />
          </div>
        );
      })}
    </div>
  );
}

function Card(props: { agent: Agent; depth: number; selected: boolean; onSelect: (a: Agent) => void; onFocus: (a: Agent) => void }) {
  const { agent, depth, selected, onSelect, onFocus } = props;
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
        title={`${agent.name}\n${MOOD_LABEL[mood]}${now ? `: ${now}` : ""}\nクリックで広げて会話・右クリックでペインへ`}
      >
        <Avatar seed={agent.name} mood={mood} role={roleOf(depth)} size={32} />
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
      style={{ width: LAYOUT.card.w, height: LAYOUT.card.h }}
      onClick={() => onSelect(agent)}
      onContextMenu={(e) => { e.preventDefault(); onFocus(agent); }}
      title={`${agent.name}\n${MOOD_LABEL[mood]}${now ? `: ${now}` : ""}\nクリックで会話・右クリックでペインへ`}
    >
      <div className="card-top">
        <span className="role">{ROLE_LABEL[Math.min(depth, 4)]}</span>
        <span className="task">{task}</span>
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

function Panel({ agent, peer, lineage, onFocus, canFocus, onSent, onSent2, onError, needs, onSelect }: {
  agent: Agent | null; peer: string; lineage: Agent[]; onFocus: (a: Agent) => void; canFocus: boolean;
  onSent: (a: Agent) => void; onSent2: (m: string) => void; onError: (m: string) => void; needs: Agent[]; onSelect: (a: Agent) => void;
}) {
  const [tab, setTab] = useState<"talk" | "state">("talk");
  const [items, setItems] = useState<ConvItem[]>([]);
  const [pending, setPending] = useState<ConvItem[]>([]);
  const [convErr, setConvErr] = useState<string | null>(null);
  // 下書きは宛先ごとに持つ。宛先を切り替えたとき、打ちかけの文が次の宛先に送られないようにする
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const text = agent ? drafts[agent.id] ?? "" : "";
  const setText = (v: string) => { if (agent) setDrafts((d) => ({ ...d, [agent.id]: v })); };
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
            <Approval agent={agent} canAnswer={!peer} onFocus={onFocus} onDone={(m) => onSent2(m)} onError={onError} />
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

/**
 * 承認待ちに画面から答える。中身（道具と対象）は状態 hook が PreToolUse で控えたもの。
 * 押すと Rust が、今も同じ中身で承認待ちかを確かめてから、Specter のその端末に 1（許可）か Esc（拒否）を送る。
 */
function Approval({ agent, canAnswer, onFocus, onDone, onError }: {
  agent: Agent; canAnswer: boolean; onFocus: (a: Agent) => void; onDone: (m: string) => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const p = agent.report?.pending;
  // 質問や計画の確認の待ちは道具の承認ではないので、許可のボタンを出さない（Rust 側でも断る）
  const notTool = !!p && ["AskUserQuestion", "ExitPlanMode"].includes(p.tool);
  const many = (agent.report?.pending_count ?? 0) > 1;
  const answer = async (choice: "allow" | "deny") => {
    setBusy(choice);
    try {
      const r = await invoke<string>("answer_permission", {
        sessionId: agent.id, choice, expectId: p?.id ?? null, terminalId: agent.terminalId ?? null, pid: agent.pid ?? null,
      });
      onDone(`${agent.name}: ${choice === "allow" ? "許可した" : "拒否した"}。${r}`);
    } catch (e) {
      onError(`${agent.name} に答えられなかった: ${e}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="approval">
      <div className="ap-title">✋ {agent.name} が承認を待っている</div>
      {p || many ? (
        (agent.report?.perm_queue ?? (p ? [p] : [])).map((q, i) => (
          <div key={q.id ?? i}>
            <div className="ap-tool">{q.summary}</div>
            {q.detail && <pre className="ap-detail">{q.detail}</pre>}
          </div>
        ))
      ) : (
        <div className="hint">中身が分からない（状態 hook が控える前に始まった承認か、hook に PermissionRequest が登録されていない）。ペインで確かめて答える。</div>
      )}
      <div className="ap-btns">
        {notTool && <div className="hint">これは質問か計画の確認の待ち。選択肢はペインで選ぶ。</div>}
        {many && <div className="hint">承認が{agent.report?.pending_count}件並んでいる。どれが端末に出ているか分からないので、ペインで答える。</div>}
        <button className="ap-allow" disabled={!canAnswer || !p || notTool || many || !!busy} onClick={() => answer("allow")}>{busy === "allow" ? "送っている…" : "許可する"}</button>
        <button className="ap-deny" disabled={!canAnswer || !!busy} onClick={() => answer("deny")}>{busy === "deny" ? "送っている…" : "拒否する"}</button>
        <button className="pane-btn" onClick={() => onFocus(agent)}>ペインへ ↗</button>
      </div>
      {!canAnswer && <div className="hint">別の機械のセッションには、ここからは答えられない。</div>}
    </div>
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
