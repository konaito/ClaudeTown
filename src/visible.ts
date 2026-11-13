// ウィンドウが見えているか（#6）。見えていない間は、決まった間隔の取得と時計を止め、CSS のアニメも止める。
// 見えているかは document.visibilityState で見る。2026-11-13 に、⌘H で隠したとき hidden になり、取得が止まることを確かめた（ccn への要求が0回）。
// フォーカスが外れただけでは止めない。別のアプリで作業しながら町を横目で見る使い方があるため。

type Listener = (visible: boolean) => void;

/** 見えているかの状態と、それに合わせて止まる取得。試験のために document から切り離してある */
export function createVisibility(initial: boolean) {
  let visible = initial;
  // 最後に、隠れていた状態から見えるようになった時刻（ms）。起動してから一度も隠れていなければ 0
  let shownAt = 0;
  const subs = new Set<Listener>();
  const set = (v: boolean) => {
    if (v === visible) return;
    visible = v;
    if (v) shownAt = Date.now();
    for (const f of [...subs]) f(v);
  };
  const subscribe = (f: Listener) => { subs.add(f); return () => { subs.delete(f); }; };
  /**
   * 見えている間だけ、ms ごとに load を呼ぶ。始めたときと、見えるようになったときは、すぐ1回呼ぶ。
   * 隠れたら間隔を止める（隠れている間は一度も呼ばない）。戻り値で止める
   */
  const poll = (load: () => void, ms: number) => {
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (t !== null) return; t = setInterval(load, ms); load(); };
    const stop = () => { if (t !== null) { clearInterval(t); t = null; } };
    if (visible) start();
    const off = subscribe((v) => (v ? start() : stop()));
    return () => { off(); stop(); };
  };
  /**
   * 見えている間だけ load を呼ぶ。load が「変わった」（true）を返したら次は min 後、変わらなければ間隔を倍にする（max で止める）（#5）。
   * 前の回が終わるまで次を始めない。kick で、すぐ取り直して間隔を min に戻す（取っている最中なら、終わった直後にもう1回取る）。
   * min と max は関数でも渡せる。毎回読み直すので、相手が作業中のあいだだけ間隔を縮める、といった切り替えができる（#59）
   */
  const backoff = (load: () => Promise<boolean> | boolean, minArg: number | (() => number), maxArg: number | (() => number)) => {
    const min = () => (typeof minArg === "function" ? minArg() : minArg);
    const max = () => (typeof maxArg === "function" ? maxArg() : maxArg);
    let t: ReturnType<typeof setTimeout> | null = null;
    let on = false, busy = false, again = false, wait = min();
    const run = async () => {
      t = null;
      if (busy) { again = true; return; }
      busy = true;
      let changed = false;
      try { changed = await load(); } catch { /* 失敗は load の中で扱う */ }
      busy = false;
      if (!on) return;
      if (again) { again = false; wait = min(); run(); return; }
      wait = changed ? min() : Math.min(wait * 2, max());
      t = setTimeout(run, wait);
    };
    const clear = () => { if (t !== null) { clearTimeout(t); t = null; } };
    const start = () => { if (on) return; on = true; wait = min(); run(); };
    const stop = () => { on = false; again = false; clear(); };
    const off = subscribe((v) => (v ? start() : stop()));
    if (visible) start();
    return {
      stop: () => { off(); stop(); },
      kick: () => { if (!on) return; clear(); wait = min(); run(); },
    };
  };
  return { isVisible: () => visible, shownAt: () => shownAt, set, subscribe, poll, backoff };
}

const hasDoc = typeof document !== "undefined";
const vis = createVisibility(!hasDoc || document.visibilityState !== "hidden");
if (hasDoc) {
  const sync = () => {
    const v = document.visibilityState !== "hidden";
    // CSS のアニメは App.css の :root[data-hidden] で止める
    document.documentElement.toggleAttribute("data-hidden", !v);
    vis.set(v);
  };
  document.addEventListener("visibilitychange", sync);
  sync();
}

export const isVisible = vis.isVisible;
/** 最後に見えるようになった時刻。それより前に起きたこと（隠れている間のお手紙）は、見えた後に動きで再生しない */
export const shownAt = vis.shownAt;
export const onVisibleChange = vis.subscribe;
export const pollWhileVisible = vis.poll;
export const pollBackoff = vis.backoff;
