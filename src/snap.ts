// 取り直した一覧を、前回の一覧と突き合わせる（#4）。
// 中身が同じなら前回のオブジェクトをそのまま返し、React の描き直しを起こさない。
// 変わったときも、変わっていないセッションは前回のオブジェクトを使い回し、memo したカードが描き直されないようにする。
// 取得した時刻（fetched_at）は毎回変わるので比べない。
import type { Agent, Snapshot } from "./model";

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** 前回のセッションのうち、中身が同じものは前回のオブジェクトに差し替えた並びを返す。並びも中身も同じなら prev そのもの */
export function reuseAgents(prev: Agent[] | undefined, next: Agent[]): Agent[] {
  if (!prev) return next;
  const old = new Map(prev.map((a) => [a.id, a]));
  let changed = prev.length !== next.length;
  const out = next.map((a, i) => {
    const p = old.get(a.id);
    const keep = p && same(p, a) ? p : a;
    if (keep !== prev[i]) changed = true;
    return keep;
  });
  return changed ? out : prev;
}

/** 前回の一覧と比べ、fetched_at のほかが同じなら prev を返す */
export function reuseSnap(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (!prev) return next;
  const agents = reuseAgents(prev.agents, next.agents);
  const letters = same(prev.letters ?? [], next.letters ?? []) ? prev.letters : next.letters;
  if (agents === prev.agents && letters === prev.letters && prev.ccn === next.ccn && prev.peer === next.peer
    && prev.ccn_ok === next.ccn_ok && prev.ccn_error === next.ccn_error) return prev;
  return { ...next, agents, letters };
}
