import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../model";
import { kickTown, watchTown } from "../town";
import { reuseSnap } from "../snap";

/** この機械の町の一覧を、Rust の見張りから受け取る。err は一覧を読めなかった理由 */
export function useTown() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    // 一覧は Rust の見張りが、変わったときだけ送ってくる（#5）。ウィンドウが見えていない間は止まる（#6）。
    // 経過時間の表示は Since が自分で時計を回すので、ここで町全体を毎秒描き直さない（#4）。
    // 読めなかったとき（ブラウザ版で ccn に届かないとき）は、前回の一覧を出したまま赤い帯で理由を出す
    const stop = watchTown((s) => {
      if (!alive) return;
      // 中身が前回と同じなら前回のオブジェクトのまま（描き直さない）。変わらないセッションも使い回す（#4）
      setSnap((prev) => reuseSnap(prev, s)); setErr(null);
    }, (msg) => { if (alive) setErr(msg); });
    reload.current = kickTown;
    return () => { alive = false; stop(); };
  }, []);
  return { snap, err, reload };
}
