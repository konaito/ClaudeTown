import { useEffect } from "react";
import { call as invoke } from "../bridge";
import { doneLog, headOf, sortDone } from "../panel/bootDone";
import type { BootStatus } from "../panel/useBoot";

/** 預けた文を見張る間隔 */
const WATCH_MS = 1000;

/**
 * 起動を待って Rust が預かった文が送れなかったら、パネルを開いていなくてもトーストで知らせる（#184）。
 * 見張るのは預けたセッション（doneLog.watch）だけ。開いているパネルが読んでいるセッションは、パネル（useBoot）に任せて飛ばす。
 * 送れなかった文は、そのセッションのパネルを開いたときに入力欄へ戻す（doneLog.giveBack）
 */
export function useQueuedWatch(toast: (text: string, bad?: boolean) => void) {
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      for (const [id, name] of doneLog.watching()) {
        if (doneLog.ownedByPanel(id)) continue;
        let s: BootStatus | null = null;
        try { s = await invoke<BootStatus | null>("boot_status", { sessionId: id }); } catch { s = null; }
        if (stop) return;
        if (!s) { doneLog.unwatch(id); continue; }
        // 読んでいる間にパネルが開いたら、パネルに任せる
        if (doneLog.ownedByPanel(id)) continue;
        const { failed } = sortDone(id, s.done, null, doneLog.reported);
        doneLog.claim(id, failed);
        for (const d of failed) {
          doneLog.giveBack(id, d.text);
          toast(`${name} に届かなかった（「${headOf(d.text)}」）: ${d.error}。チャットを開くと入力欄に戻る`, true);
        }
        if (s.queued.length === 0) doneLog.unwatch(id);
      }
      if (!stop) timer = setTimeout(run, WATCH_MS);
    };
    void run();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [toast]);
}
