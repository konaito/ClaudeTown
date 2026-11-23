import { useCallback, useEffect, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { hasTerminal } from "../abilities";
import { viaCcn } from "../session/control";
import { doneLog, sortDone, type Done } from "./bootDone";

/** Rust の boot_status（src-tauri/src/composer.rs）の形 */
export type BootStatus = {
  booted: boolean;
  /** sessions/<pid>.json があるか。信頼する前は作られない */
  rowSeen: boolean;
  startedAt: number | null;
  /** 預かっている文（古い順） */
  queued: { text: string; at: number }[];
  /** 送り終えた文。error があれば送れなかった */
  done: Done[];
};

const NONE: BootStatus["queued"] = [];

/** 起動を待つ間に読み直す間隔 */
const POLL_MS = 500;
/** sessions/<pid>.json が無いまま、これより長く起動しなければ、信頼の確認の画面を疑う */
export const TRUST_SUSPECT_MS = 6000;

/**
 * 選んでいるセッションの起動の様子（アプリが立てた端末だけ）。起動していないか、預かった文がある間だけ読み直す。
 * 預かった文が送れたら onDelivered を呼ぶ（このパネルを開いてから送り終えた分だけ）。
 * 送れなかったら onFailed を呼ぶ。開く前に送れなかった分も、まだどこでも知らせていなければ呼ぶ（#184）。
 * 読んでいる間は、このセッションの失敗をパネルが知らせる（App の見張りは飛ばす）。kick は預けたときに呼ばれ、見張りに載せる
 */
export function useBoot(agent: Agent | null, onDelivered: (text: string) => void, onFailed: (text: string, error: string) => void) {
  const id = agent?.id ?? null;
  const app = !!agent && hasTerminal(agent) && !viaCcn(agent);
  const [st, setSt] = useState<BootStatus | null>(null);
  const [tick, setTick] = useState(0);
  // 届いた文のうち、もう扱ったもの（bootDone.ts の doneKey で見分ける）。開いた時点で届いていた分は扱わない
  const seen = useRef<Set<string> | null>(null);
  const cb = useRef({ onDelivered, onFailed });
  cb.current = { onDelivered, onFailed };
  const name = agent?.name ?? "";
  const kick = useCallback(() => { if (id) doneLog.watch(id, name); setTick((x) => x + 1); }, [id, name]);

  useEffect(() => { setSt(null); seen.current = null; }, [id]);

  useEffect(() => {
    if (!id || !app) return;
    doneLog.own(id);
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      let s: BootStatus | null = null;
      try { s = await invoke<BootStatus | null>("boot_status", { sessionId: id }); } catch { s = null; }
      if (stop) return;
      if (s) {
        const r = sortDone(id, s.done, seen.current, doneLog.reported);
        seen.current = r.handled;
        doneLog.claim(id, r.failed);
        for (const d of r.failed) cb.current.onFailed(d.text, d.error ?? "");
        for (const d of r.delivered) cb.current.onDelivered(d.text);
      }
      setSt(s);
      if (s && (!s.booted || s.queued.length > 0)) timer = setTimeout(run, POLL_MS);
    };
    void run();
    return () => { stop = true; if (timer) clearTimeout(timer); doneLog.release(id); };
    // 町の一覧が起動中を出し直したときも読み直す
  }, [id, app, tick, agent?.booting]);

  const booting = app ? (st ? !st.booted : !!agent?.booting) : false;
  const trustSuspect = !!st && !st.booted && !st.rowSeen && st.startedAt != null && Date.now() - st.startedAt > TRUST_SUSPECT_MS;
  return { booting, queued: st?.queued.length ? st.queued : NONE, trustSuspect, kick };
}
