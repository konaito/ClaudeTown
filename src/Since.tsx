import { useEffect, useState } from "react";
import { sinceText } from "./model";
import { isVisible, onVisibleChange } from "./visible";

/**
 * 作業中の経過時間（sinceText）。この部品の中だけで時計を回し、町全体は描き直さない（#4）。
 * 1分までは1秒ごと、1時間までは30秒ごと、それより後は6分ごとに描き直す。ウィンドウが見えていない間は止め、見えたらすぐ描き直す（#6）
 */
export function Since({ at }: { at: number }) {
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
