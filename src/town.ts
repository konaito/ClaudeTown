// 町の一覧を受け取る口（#5）。Tauri では Rust の見張り（lib.rs の town_watch）が、前回と変わったときだけ Channel で送ってくる。
// ブラウザ表示（開発中の見た目の確認）では Rust が無いので、今までどおり2秒ごとに snapshot を呼ぶ。
// どちらも、ウィンドウが見えていない間は止め、見えたらすぐ1回取り直す（#6）。
import { Channel, invoke } from "@tauri-apps/api/core";
import { call } from "./bridge";
import type { Snapshot } from "./model";
import { isVisible, onVisibleChange, pollWhileVisible } from "./visible";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const BROWSER_POLL_MS = 2000;
let browserKick: (() => void) | null = null;

/** peer の町の一覧を受け取り始める。on は一覧を、fail は命令そのものの失敗を受ける。戻り値で止める */
export function watchTown(peer: string | null, on: (s: Snapshot) => void, fail: (msg: string) => void): () => void {
  if (!inTauri) {
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try { on(await call<Snapshot>("snapshot", { peer })); } catch (e) { fail(String(e)); } finally { running = false; }
    };
    browserKick = load;
    const stop = pollWhileVisible(load, BROWSER_POLL_MS);
    return () => { if (browserKick === load) browserKick = null; stop(); };
  }
  let open = true;
  let gen: Promise<number> | null = null;
  const start = () => {
    if (gen) return;
    const ch = new Channel<Snapshot>((s) => { if (open) on(s); });
    gen = invoke<number>("town_watch", { peer, onEvent: ch });
    gen.catch((e) => { gen = null; if (open) fail(String(e)); });
  };
  const stop = () => {
    const g = gen;
    gen = null;
    g?.then((generation) => invoke("town_unwatch", { generation })).catch(() => {});
  };
  if (isVisible()) start();
  const off = onVisibleChange((v) => (v ? start() : stop()));
  return () => { open = false; off(); stop(); };
}

/** すぐ取り直させる（新しい世帯を作った直後など） */
export function kickTown(): void {
  if (inTauri) invoke("town_kick").catch(() => {});
  else browserKick?.();
}
