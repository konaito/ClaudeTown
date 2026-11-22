import { memo, useContext } from "react";
import { type Agent, MOOD_LABEL, houseNameOf, moodOf, nowOf, accountText, taskOf } from "../model";
import { layoutFamily, type LNode } from "../layout/layout";
import { LAYOUT, boxOf } from "../layout/params";
import { Avatar, hash as hashOf, roleOf, ROLE_LABEL } from "../kid/Avatar";
import { KillCtx, LetterCtx } from "../contexts";
import { LETTER_IMG } from "../useLetterMarks";
import { CardActions } from "../card/CardActions";
import { Since } from "../Since";
import { watchOffscreen } from "../offscreen";

/** グループ（根のセッション1つとその子孫）ごとの淡い色。名前から決まる */
const GROUP_TINTS = ["#f3f7ff", "#fff6ec", "#f1faf3", "#f8f3ff", "#fff2f5", "#eff9f9", "#fbf8ec"];

const GROUP_LINES = ["#d9e4fb", "#f6dfc4", "#d3ecd9", "#e4d8f6", "#f6d6df", "#cfe9e9", "#ece4c2"];

export function Group({ root, count, size, hasNeeds, children }: {
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

export function layoutOf(all: Agent[]) {
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

export const FamilyCanvas = memo(function FamilyCanvas({ all, result, selected, onSelect, onFocus }: CanvasProps) {
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
          <div key={n.id} ref={watchOffscreen} className={`fnode${selected === n.id ? "open" : ""} ${delay !== undefined ? "dying" : ""} ${n.depth >= 2 ? "is-mini" : ""}`}
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
