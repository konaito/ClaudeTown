import { useCallback, useMemo, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent, buildTree } from "../model";
import { kickTown } from "../town";
import { canStop } from "../abilities";

/** 閉じる演出の長さ（ms）。CSS の kill-* と合わせる */
const KILL_MS = 1150;
/** 子孫を葉から順に倒すときのずらし（ms） */
const KILL_STAGGER = 140;

type Tree = ReturnType<typeof buildTree>;

/** セッションを閉じる（kill）。演出中の一覧（dying）、確認の対象（killAsk）、kill 本体を持つ */
export function useKill(h: {
  tree: Tree; selected: string | null; setSelected: (id: string | null) => void; peer: string;
  toast: (text: string, bad?: boolean) => void;
  setHidden: React.Dispatch<React.SetStateAction<Map<string, number>>>;
}) {
  const { tree, selected, setSelected, peer, toast, setHidden } = h;
  const [dying, setDying] = useState<Map<string, number>>(new Map());
  const [killAsk, setKillAsk] = useState<Agent | null>(null);
  /**
   * a とその子孫を、葉から順に止める。倒れる演出も葉から少しずつずらして出す。
   * alone なら a だけを止め、子孫は残す（引き継ぎで前任を止めるとき）。このときの知らせと選択の切り替えは呼び手が行う。全部止まったら true
   */
  const kill = useCallback(async (a: Agent, alone = false) => {
    const order: Agent[] = [];
    // ゴースト（別の町にいる本物の影）は閉じない
    const walk = (x: Agent) => { for (const k of tree.childrenOf.get(x.id) ?? []) if (!k.ghost) walk(k); order.push(x); };
    if (alone) order.push(a); else walk(a);
    const targets = order.filter(canStop);
    const skipped = order.filter((x) => !canStop(x));
    setDying((m) => { const n = new Map(m); targets.forEach((x, i) => n.set(x.id, i * KILL_STAGGER)); return n; });
    if (!alone && selected && targets.some((x) => x.id === selected)) setSelected(null);
    const failed: Agent[] = [];
    for (const x of targets) {
      try { await invoke("stop_session", { sessionId: x.id, peer: peer || null }); }
      catch { failed.push(x); }
    }
    const ok = targets.filter((x) => !failed.includes(x));
    // 一覧から消えたのをすぐ拾う。見張りは変化が無いと間隔を延ばしているため（#5）
    kickTown();
    // 止まらなかった分は演出を戻す。止まった分は演出が終わったら隠す
    setDying((m) => { const n = new Map(m); for (const x of failed) n.delete(x.id); return n; });
    const last = (targets.length - 1) * KILL_STAGGER + KILL_MS;
    setTimeout(() => {
      setHidden((hh) => { const n = new Map(hh); for (const x of ok) n.set(x.id, Date.now()); return n; });
      setDying((m) => { const n = new Map(m); for (const x of ok) n.delete(x.id); return n; });
    }, last);
    if (alone) return failed.length === 0 && skipped.length === 0;
    if (failed.length) toast(`止められなかった: ${failed.map((x) => x.name).join("、")}`, true);
    else toast(`${a.name}${order.length > 1 ? ` と子孫 ${order.length - 1} 人` : ""}を閉じた`);
    if (skipped.length) toast(`ccn から止められないので残した: ${skipped.map((x) => x.name).join("、")}`, true);
    return failed.length === 0 && skipped.length === 0;
  }, [tree, selected, peer, toast]);
  const askKill = useCallback((a: Agent, instant: boolean) => { if (instant) kill(a); else setKillAsk(a); }, [kill]);
  const killCtx = useMemo(() => ({ dying, ask: askKill }), [dying, askKill]);
  return { kill, killAsk, setKillAsk, killCtx };
}
