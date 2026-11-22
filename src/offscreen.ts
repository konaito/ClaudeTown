// 画面の外にあるカードのアニメを止める（#12）。窓が隠れたときの data-hidden（src/visible.ts）と同じ作りで、
// 見えなくなった要素に data-offscreen を付け、App.css が中の CSS アニメを止める。React の状態は使わないので、描き直しは起きない。
// 見えているかは IntersectionObserver で見る。root は付けず、ブラウザの窓（viewport）にする。
// スクロールの容れ物（.stage）や、その外の overflow: hidden で切れた部分は、交差の計算に入る。
// 観察する要素が数十あっても、observer は全体で1つを共有する（要素ごとに作ると、作る費用と、コールバックの呼び出しが要素の数だけ増える）。

type El = { toggleAttribute(name: string, force?: boolean): boolean };
type Entry = { target: unknown; isIntersecting: boolean };
type Observer = { observe(el: never): void; unobserve(el: never): void };
type Ctor = new (cb: (entries: Entry[]) => void, init?: { rootMargin?: string }) => Observer;

export const OFFSCREEN_ATTR = "data-offscreen";

/**
 * 共有の observer を持つ監視。observer は最初の watch で作る。Ctor が無い（IntersectionObserver の無い環境）ときは何もしない。
 * rootMargin は、縁の少し外まで「見えている」とみなす幅。スクロールで入ってきた瞬間に、止まった絵が見えないようにする
 */
export function createOffscreenWatcher(Observer: Ctor | undefined, rootMargin = "64px") {
  let io: Observer | null = null;
  // 同じ要素を2回 watch しても、observer への登録は1回。0回になったら外す
  const counts = new Map<unknown, number>();
  const ensure = () => (io ??= new Observer!((entries) => {
    for (const e of entries) (e.target as El).toggleAttribute(OFFSCREEN_ATTR, !e.isIntersecting);
  }, { rootMargin }));
  const watch = (el: El): (() => void) => {
    if (!Observer) return () => {};
    const n = counts.get(el) ?? 0;
    counts.set(el, n + 1);
    if (n === 0) ensure().observe(el as never);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const m = (counts.get(el) ?? 1) - 1;
      if (m > 0) { counts.set(el, m); return; }
      counts.delete(el);
      io?.unobserve(el as never);
      el.toggleAttribute(OFFSCREEN_ATTR, false);
    };
  };
  return { watch, size: () => counts.size };
}

const watcher = createOffscreenWatcher(typeof IntersectionObserver === "undefined" ? undefined : (IntersectionObserver as unknown as Ctor));

/** React 19 の ref に渡す。付けた要素を監視し、外れたら止める */
export const watchOffscreen = (el: HTMLElement | null) => (el ? watcher.watch(el) : undefined);
