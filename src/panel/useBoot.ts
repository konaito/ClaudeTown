import { useCallback, useEffect, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { hasTerminal } from "../abilities";
import { viaCcn } from "../session/control";

/** Rust の boot_status（src-tauri/src/composer.rs）の形 */
export type BootStatus = {
  booted: boolean;
  /** sessions/<pid>.json があるか。信頼する前は作られない */
  rowSeen: boolean;
  startedAt: number | null;
  /** 預かっている文（古い順） */
  queued: { text: string; at: number }[];
  /** 送り終えた文。error があれば送れなかった */
  done: { text: string; at: number; doneAt: number; error: string | null }[];
};

const NONE: BootStatus["queued"] = [];

/** 起動を待つ間に読み直す間隔 */
const POLL_MS = 500;
/** sessions/<pid>.json が無いまま、これより長く起動しなければ、信頼の確認の画面を疑う */
export const TRUST_SUSPECT_MS = 6000;

/**
 * 選んでいるセッションの起動の様子（アプリが立てた端末だけ）。起動していないか、預かった文がある間だけ読み直す。
 * 預かった文が送れたら onDelivered、送れなかったら onFailed を呼ぶ（このパネルを開いてから送り終えた分だけ）
 */
export function useBoot(agent: Agent | null, onDelivered: (text: string) => void, onFailed: (text: string, error: string) => void) {
  const id = agent?.id ?? null;
  const app = !!agent && hasTerminal(agent) && !viaCcn(agent);
  const [st, setSt] = useState<BootStatus | null>(null);
  const [tick, setTick] = useState(0);
  // 送り終えた文のうち、もう扱ったもの（doneAt と文で見分ける）。開いた時点で終わっていた分は扱わない
  const seen = useRef<Set<string> | null>(null);
  const cb = useRef({ onDelivered, onFailed });
  cb.current = { onDelivered, onFailed };
  const kick = useCallback(() => setTick((x) => x + 1), []);

  useEffect(() => { setSt(null); seen.current = null; }, [id]);

  useEffect(() => {
    if (!id || !app) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      let s: BootStatus | null = null;
      try { s = await invoke<BootStatus | null>("boot_status", { sessionId: id }); } catch { s = null; }
      if (stop) return;
      if (s) {
        const keyOf = (d: BootStatus["done"][number]) => `${d.doneAt}|${d.text}`;
        if (!seen.current) seen.current = new Set(s.done.map(keyOf));
        for (const d of s.done) {
          const k = keyOf(d);
          if (seen.current.has(k)) continue;
          seen.current.add(k);
          if (d.error) cb.current.onFailed(d.text, d.error); else cb.current.onDelivered(d.text);
        }
      }
      setSt(s);
      if (s && (!s.booted || s.queued.length > 0)) timer = setTimeout(run, POLL_MS);
    };
    void run();
    return () => { stop = true; if (timer) clearTimeout(timer); };
    // 町の一覧が起動中を出し直したときも読み直す
  }, [id, app, tick, agent?.booting]);

  const booting = app ? (st ? !st.booted : !!agent?.booting) : false;
  const trustSuspect = !!st && !st.booted && !st.rowSeen && st.startedAt != null && Date.now() - st.startedAt > TRUST_SUSPECT_MS;
  return { booting, queued: st?.queued.length ? st.queued : NONE, trustSuspect, kick };
}
