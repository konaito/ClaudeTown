// 起動のときの端末の立て直しで、戻らなかった端末を知らせる（#262）。
// Rust の立て直し（session_ops.rs の restore_terminals）は起動の直後に別のスレッドで走り、画面が受け始める前に済むことがある。
// 送られてくるのを待つと取りこぼすので、画面から restore_report を呼んで取りに行く。命令は済むまで待ち、済んでいなければ done が false で返る。

import { projectFromPath } from "./model";

/** 戻らなかった端末。形は session_ops.rs の Lost */
export type Lost = { id: string; cwd: string; name?: string | null; reason: string; retry: boolean };
/** restore_report の応答 */
export type RestoreReport = { done: boolean; lost: Lost[] };

/** 知らせの一言。戻らなかった端末が無ければ null */
export function restoreNotice(lost: Lost[]): string | null {
  if (!lost.length) return null;
  const SHOW = 3;
  const one = (l: Lost) => `${l.name?.trim() || projectFromPath(l.cwd) || l.id.slice(0, 8)}（${l.reason}${l.retry ? "。次の起動でもう一度試す" : ""}）`;
  const shown = lost.length > SHOW + 1 ? lost.slice(0, SHOW) : lost;
  const rest = lost.length - shown.length;
  return `前回の端末のうち${lost.length}件を戻せなかった。${shown.map(one).join("、")}${rest ? `、ほか${rest}件` : ""}`;
}

type Visibility = { isVisible: () => boolean; onVisibleChange: (f: (v: boolean) => void) => () => void };

/** 済むまで取りに行き、戻らなかった端末があれば show に1回だけ渡す。窓が隠れていれば、見えてから渡す。戻り値で止める */
export function watchRestore(fetch: () => Promise<RestoreReport>, show: (text: string) => void, vis: Visibility): () => void {
  let alive = true;
  let off: (() => void) | null = null;
  const tell = (text: string) => {
    if (vis.isVisible()) { show(text); return; }
    off = vis.onVisibleChange((v) => {
      if (!v || !alive) return;
      off?.(); off = null; alive = false;
      show(text);
    });
  };
  const run = async () => {
    while (alive) {
      let r: RestoreReport;
      try { r = await fetch(); } catch (e) { console.warn("[restore] 立て直しの結果を取れなかった", e); return; }
      if (!alive) return;
      if (!r.done) continue;
      const text = restoreNotice(r.lost ?? []);
      if (text) tell(text);
      return;
    }
  };
  void run();
  return () => { alive = false; off?.(); off = null; };
}
