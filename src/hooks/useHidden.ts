import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "../model";
import { pollWhileVisible } from "../visible";

/**
 * 閉じたセッションのうち、演出が終わって隠しているもの（id と隠した時刻）。一覧から消えたら忘れる。
 * 10秒たっても消えなければ戻して失敗を出す。agents は隠したものを除いた一覧
 */
export function useHidden(snap: Snapshot | null, toast: (text: string, bad?: boolean) => void) {
  const [hidden, setHidden] = useState<Map<string, number>>(new Map());
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
  return { hidden, setHidden, agents };
}
