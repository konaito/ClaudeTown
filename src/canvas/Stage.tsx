import { useLayoutEffect, useRef, useState } from "react";
import { LAYOUT } from "../layout/params";
import { packHouseholds } from "../layout/pack";
import { ScrollEdgeGradient } from "../ScrollEdgeGradient";

/**
 * 世帯モジュールを並べる場所（docs/design/household-packing.md、src/layout/pack.ts）。
 * 入力順（親の開始時刻、同じなら ID）に、決まった横幅の中へ上詰めで置く。大きさや状態で並べ替えない。
 * zoom が fit のときは、一番広い世帯が横幅に入る倍率にする（最小 0.4）。横幅はその倍率で割り戻した幅。
 */
export function Stage({ zoom, items, onBlank }: { zoom: number | "fit"; items: { id: string; w: number; h: number; node: React.ReactNode }[]; onBlank: () => void }) {
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
