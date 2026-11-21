import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../model";
import { kickTown, watchTown } from "../town";
import { reuseSnap } from "../snap";

/** いま見ている町（peer。空ならこの機械）の一覧を、Rust の見張りから受け取る。fail は一覧の取得が続けて失敗している様子 */
export function useTown(peer: string) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useRef<() => void>(() => {});
  // 一覧の取得が続けて失敗している数と、失敗し始めた時刻。1回の失敗では町を描き直さない
  // （2026-11-12、ノードが一瞬詰まって一覧の取得が時間切れになり、町が「0世帯・0人」になった）
  const [fail, setFail] = useState<{ n: number; since: number; msg: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const want = peer || null;
    setFail(null);
    // 失敗したら、同じ町の前回の一覧があればそれを出し続ける。無いときだけ、失敗した一覧（空の町と赤い帯）を出す
    const failed = (msg: string, s?: Snapshot) => {
      setFail((f) => ({ n: (f?.n ?? 0) + 1, since: f?.since ?? Date.now(), msg }));
      setSnap((prev) => (prev?.ccn_ok && (prev.peer ?? null) === want ? prev : s ?? prev));
      if (!s) setErr((e) => e ?? msg);
    };
    // 一覧は Rust の見張りが、変わったときだけ送ってくる（#5）。ウィンドウが見えていない間は止まる（#6）。
    // 経過時間の表示は Since が自分で時計を回すので、ここで町全体を毎秒描き直さない（#4）
    const stop = watchTown(want, (s) => {
      if (!alive) return;
      // 中身が前回と同じなら前回のオブジェクトのまま（描き直さない）。変わらないセッションも使い回す（#4）
      if (s.ccn_ok) { setSnap((prev) => reuseSnap(prev, s)); setErr(null); setFail(null); }
      else failed(s.ccn_error ?? "ccn につながらない", s);
    }, (msg) => { if (alive) failed(msg); });
    reload.current = kickTown;
    return () => { alive = false; stop(); };
  }, [peer]);
  return { snap, err, fail, reload };
}
