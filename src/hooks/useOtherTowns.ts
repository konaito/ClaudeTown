import { useEffect, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent, Peer } from "../model";
import { reuseAgents } from "../snap";
import { otherTownRetryMs } from "../town";
import { pollWhileVisible } from "../visible";

/**
 * 別の町（いま見ていない ccn のノード）のお便りを取りに行く間隔。町を1つずつ順に取り、前の回が終わるまで次の回を始めない。
 * 1回は町1つにつき手元のノード経由の GET /api/sessions 1本（中継先の ccn には 15 秒に1本）。peers が healthy でない町には取りに行かない。
 * 実測（2026-11-12）: 中継で incertotech 0.42 秒、vm 0.46 秒
 */
const OTHER_TOWNS_POLL_MS = 15000;
/** 別の町の一覧が取れなかったとき、前回の町を残す長さ */
const OTHER_TOWN_KEEP_MS = 60000;

/** 別の町のセッション一覧。町の名前から、一覧か失敗の理由への対応を返す */
export function useOtherTowns(peer: string, peers: Peer[], selfName: string) {
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
  return others;
}
