import { useCallback, useMemo, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent, buildTree } from "../model";
import { kickTown } from "../town";
import { closedDescendants, killPlan } from "../killPlan";

/** 閉じる演出の長さ（ms）。CSS の kill-* と合わせる */
const KILL_MS = 1150;
/** 子孫を葉から順に倒すときのずらし（ms） */
const KILL_STAGGER = 140;

type Tree = ReturnType<typeof buildTree>;

/** セッションを閉じる（kill）。演出中の一覧（dying）、確認の対象（killAsk）、kill 本体を持つ */
export function useKill(h: {
  tree: Tree; selected: string | null; setSelected: (id: string | null) => void;
  toast: (text: string, bad?: boolean) => void;
  setHidden: React.Dispatch<React.SetStateAction<Map<string, number>>>;
}) {
  const { tree, selected, setSelected, toast, setHidden } = h;
  const [dying, setDying] = useState<Map<string, number>>(new Map());
  const [killAsk, setKillAsk] = useState<Agent | null>(null);
  /** a とその子孫を、葉から順に止める。倒れる演出も葉から少しずつずらして出す。全部止まったら true */
  const kill = useCallback(async (a: Agent) => {
    // 止める順と残す分は killPlan（#183）。sub-agent と in-process のチームメイトは止めず、親の claude と一緒に終わる
    const { stop: targets, keep: skipped, ride } = killPlan(tree.childrenOf, a);
    const delay = new Map(targets.map((x, i) => [x.id, i * KILL_STAGGER]));
    // 止められずに残す親に乗っている子は、親と一緒に残るので触らない
    const riding = ride.filter((r) => delay.has(r.with.id));
    setDying((m) => {
      const n = new Map(m);
      for (const [id, at] of delay) n.set(id, at);
      // 一緒に終わる子も、親と同じ時に倒れる演出を出す
      for (const r of riding) n.set(r.agent.id, delay.get(r.with.id) ?? 0);
      return n;
    });
    const gone = new Set([...targets.map((x) => x.id), ...riding.map((r) => r.agent.id)]);
    if (selected && gone.has(selected)) setSelected(null);
    const failed: Agent[] = [];
    // 止められなかった理由。外で起動したセッションは、記録の起動時刻が今のプロセスと合わないと断られる（#309）
    const why = new Map<string, string>();
    for (const x of targets) {
      try { await invoke("stop_session", { sessionId: x.id }); }
      catch (e) { failed.push(x); why.set(x.id, String(e)); }
    }
    const ok = targets.filter((x) => !failed.includes(x));
    const okIds = new Set(ok.map((x) => x.id));
    const ended = [...ok, ...riding.filter((r) => okIds.has(r.with.id)).map((r) => r.agent)];
    const stuck = [...failed, ...riding.filter((r) => !okIds.has(r.with.id)).map((r) => r.agent)];
    // 一覧から消えたのをすぐ拾う。見張りは変化が無いと間隔を延ばしているため（#5）
    kickTown();
    // 止まらなかった分は演出を戻す。止まった分は演出が終わったら隠す
    setDying((m) => { const n = new Map(m); for (const x of stuck) n.delete(x.id); return n; });
    const last = (targets.length - 1) * KILL_STAGGER + KILL_MS;
    setTimeout(() => {
      setHidden((hh) => { const n = new Map(hh); for (const x of ended) n.set(x.id, Date.now()); return n; });
      setDying((m) => { const n = new Map(m); for (const x of ended) n.delete(x.id); return n; });
    }, last);
    const closed = closedDescendants(a, ride, ok);
    if (failed.length) toast(`止められなかった: ${failed.map((x) => `${x.name}（${why.get(x.id)}）`).join("、")}`, true);
    else toast(`${a.name}${closed ? ` と子孫 ${closed} 人` : ""}を閉じた`);
    // 残す分のうち、kind が teammate なのは tmux のチームメイト（in-process のチームメイトは killPlan が ride に入れる）。
    // ほかの残した分とは理由が違うので、分けて出す。リードが止まった後にプロセスが残るかは未確認なので「止めていない」とだけ言う
    const mates = skipped.filter((x) => x.kind === "teammate");
    const outside = skipped.filter((x) => x.kind !== "teammate");
    if (outside.length) toast(`ここからは止められないので残した: ${outside.map((x) => x.name).join("、")}`, true);
    if (mates.length) toast(`tmux で動くチームメイトは、ここからは止められない。止めていない: ${mates.map((x) => x.name).join("、")}`, true);
    return failed.length === 0 && skipped.length === 0;
  }, [tree, selected, toast]);
  const askKill = useCallback((a: Agent, instant: boolean) => { if (instant) kill(a); else setKillAsk(a); }, [kill]);
  const killCtx = useMemo(() => ({ dying, ask: askKill }), [dying, askKill]);
  return { kill, killAsk, setKillAsk, killCtx };
}
