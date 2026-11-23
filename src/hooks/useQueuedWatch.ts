import { useEffect } from "react";
import { call as invoke } from "../bridge";
import { watchOnce, type WatchStatus } from "../panel/bootDone";

/** 預けた文を見張る間隔 */
const WATCH_MS = 1000;

/**
 * 起動を待って Rust が預かった文が送れなかったら、パネルを開いていなくてもトーストで知らせる（#184）。
 * 見張るのは預けたセッション（doneLog.watch）だけ。1周の中身は bootDone.ts の watchOnce。
 * listed はその子が町の一覧にまだいるか（claude が終わると消え、チャットを開けない）
 */
export function useQueuedWatch(toast: (text: string, bad?: boolean) => void, listed: (sid: string) => boolean) {
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      await watchOnce((id) => invoke<WatchStatus>("boot_status", { sessionId: id }), toast, listed, () => stop);
      if (!stop) timer = setTimeout(run, WATCH_MS);
    };
    void run();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [toast, listed]);
}
