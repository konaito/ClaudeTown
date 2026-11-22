import { memo, useEffect, useState } from "react";
import { elapsedText, liveSummary, msOf, type Live } from "../conv";
import { isVisible, onVisibleChange } from "../visible";

/**
 * 作業中の末尾の1行（#59）。結果がまだ無い道具か「考え中」と、その動きを始めてからの経過、ターン全体の経過を出す。
 * 1秒の時計はこの部品の中だけで回す。ほかの吹き出しは描き直さない。ウィンドウが見えていない間は止める（#6）
 */
export const LiveLine = memo(function LiveLine({ live, turnAt }: { live: Live; turnAt: number | null }) {
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
