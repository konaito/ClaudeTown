import { useEffect, useMemo, useRef, useState } from "react";
import type { Flight } from "./letters";
import { shownAt } from "./visible";

export const LETTER_IMG = "/sprites/noto/1f48c/64.webp";

/** 封筒の印を残す長さ。読まれたら短く、読まれないままなら長くても MARK_MAX_MS で消す */
const MARK_READ_MS = 2500;

/** 飛ぶ封筒と、頭に残る印の大きさ（px）。App.css の .letter-fly と .letter-mark に合わせる */
const FLY_SIZE = 30;

const MARK_SIZE = 24;

/** 印の中心の、カード（.fnode-body）の左上からの位置。.letter-mark の left: -9px、top: -11px と大きさから */
const MARK_OFFSET = { x: -9 + MARK_SIZE / 2, y: -11 + MARK_SIZE / 2 };

/** つなぎ線の上を進む割合。残りで印の位置へ寄せる */
const LETTER_ALONG = 0.8;

const MARK_MAX_MS = 30000;

/** 飛ばした封筒の記録を覚える数。Rust の LETTERS_MAX（300）より十分多くする */
export const SEEN_MAX = 2000;

/**
 * 届いた封筒の一覧から、新しく飛ばすもの（fresh）を選ぶ。seen は飛ばした（か、飛ばさないと決めた）封筒の id で、null はまだ決めていない。
 * loaded は町の一覧（snapshot）を一度でも受け取ったか。受け取る前の flights は、一覧が無いだけの [] なので、seen を決めない。
 * 決めると、後から届いた最近10分の封筒が全部新しい扱いになり、起動のたびに飛ばし直す（#177）。
 * seen は最初に受け取った一覧の封筒で決め、それらは飛ばさない（起動したときにすでにある記録を再生しない）。
 * 戻り値の seen を次の呼び出しに渡す。渡した seen は書き換えない
 */
export function freshFlights(seen: ReadonlySet<string> | null, flights: Flight[], loaded: boolean): { seen: Set<string> | null; fresh: Flight[] } {
  if (seen === null) return { seen: loaded ? new Set(flights.map((f) => f.id)) : null, fresh: [] };
  const next = new Set(seen);
  const fresh = flights.filter((f) => !next.has(f.id));
  for (const f of fresh) next.add(f.id);
  for (const id of next) { if (next.size <= SEEN_MAX) break; next.delete(id); }
  return { seen: next, fresh };
}

/**
 * 新しいお手紙が来たら、送り手のカードから受け手のカードへ封筒を飛ばし、受け手の頭に印を残す。
 * 封筒はカードの中心どうしを結ぶ直線を飛ぶ（親子ならつなぎ線と重なる。世帯をまたぐときは町の上を直線で飛ぶ）。
 * 動きを減らす設定（prefers-reduced-motion）なら、飛ばさずに印だけ出す。
 * 起動したときにすでにある記録は飛ばさない（古いお手紙を再生しない）。すでにあるかは、最初に受け取った町の一覧で決める。
 * loaded は町の一覧を一度でも受け取ったか。受け取る前の flights は [] なので、それで決めると届いた記録が全部新しくなる（#177）
 */
export function useLetterMarks(flights: Flight[], loaded: boolean) {
  const layer = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const [marks, setMarks] = useState<Map<string, { flight: string; until: number }>>(new Map());
  useEffect(() => {
    // 見た記録は古い順に捨て、SEEN_MAX 件までにする（#15、freshFlights）。Rust が渡すのは最近10分の最大300件なので、
    // 捨てた記録が一覧に戻ることはない。いまの一覧で捨てると、一覧の取得が一度欠けただけで同じ封筒を二度飛ばす
    const next = freshFlights(seen.current, flights, loaded);
    seen.current = next.seen;
    const fresh = next.fresh;
    if (fresh.length === 0) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    fresh.forEach((f, i) => {
      const land = () => setMarks((m) => new Map(m).set(f.to, { flight: f.id, until: Date.now() + (f.readAt ? MARK_READ_MS : MARK_MAX_MS) }));
      const a = document.querySelector(`[data-aid="${f.from}"]`)?.getBoundingClientRect();
      const toEl = document.querySelector<HTMLElement>(`[data-aid="${f.to}"]`);
      const b = toEl?.getBoundingClientRect();
      // ウィンドウが隠れている間に来たお手紙は、見えた後にまとめて飛ばさず、印だけ出す（#6）
      if (reduce || f.at < shownAt() || !a || !b || !layer.current) { land(); return; }
      const img = document.createElement("img");
      img.src = LETTER_IMG;
      img.className = "letter-fly";
      layer.current.appendChild(img);
      // 始点は送り手のカードの中心。つなぎ線（中心どうしを結ぶ線）の上を受け手の手前 LETTER_ALONG まで進み、
      // 最後の区間で、届いた後に印が残る位置（受け手のカードの左上、.letter-mark と同じ中心）へ寄せ、印と同じ大きさで止まる
      const ax = a.left + a.width / 2, ay = a.top + a.height / 2, cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      // 町は拡大縮小されるので、印の位置と大きさも同じ倍率にする
      const k = toEl && toEl.offsetWidth ? b.width / toEl.offsetWidth : 1;
      const mx = b.left + MARK_OFFSET.x * k, my = b.top + MARK_OFFSET.y * k;
      const vx = ax + (cx - ax) * LETTER_ALONG, vy = ay + (cy - ay) * LETTER_ALONG;
      const dist = Math.hypot(vx - ax, vy - ay) + Math.hypot(mx - vx, my - vy);
      const ms = Math.min(1500, Math.max(700, dist * 1.6));
      const at = (x: number, y: number, k: number) => `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${k})`;
      const anim = img.animate([
        { transform: at(ax, ay, 0.6), opacity: 0 },
        { transform: at(ax, ay, 1), opacity: 1, offset: 0.1 },
        { transform: at(vx, vy, 1), opacity: 1, offset: 0.78 },
        { transform: at(mx, my, (MARK_SIZE * k) / FLY_SIZE), opacity: 1 },
      ], { duration: ms, delay: i * 180, easing: "cubic-bezier(.4,.1,.3,1)", fill: "both" });
      // 印を出してから飛んできた封筒を消す（入れ替わりの継ぎ目を見せない）
      anim.onfinish = () => { land(); requestAnimationFrame(() => requestAnimationFrame(() => img.remove())); };
    });
  }, [flights, loaded]);
  // 読まれたら印を短くする。時間が来たら消す
  useEffect(() => {
    const read = new Map(flights.filter((f) => f.readAt).map((f) => [f.id, f.readAt!]));
    setMarks((m) => {
      let changed = false;
      const n = new Map(m);
      for (const [to, v] of m) {
        if (read.has(v.flight) && v.until > Date.now() + MARK_READ_MS) { n.set(to, { ...v, until: Date.now() + MARK_READ_MS }); changed = true; }
        if (v.until <= Date.now()) { n.delete(to); changed = true; }
      }
      return changed ? n : m;
    });
  }, [flights]);
  useEffect(() => {
    if (marks.size === 0) return;
    const t = setInterval(() => setMarks((m) => {
      const n = new Map([...m].filter(([, v]) => v.until > Date.now()));
      return n.size === m.size ? m : n;
    }), 500);
    return () => clearInterval(t);
  }, [marks.size]);
  const ids = useMemo(() => new Set(marks.keys()), [marks]);
  return { layer, marks: ids };
}
