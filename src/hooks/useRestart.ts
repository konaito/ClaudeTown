import { useCallback, useMemo, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { kickTown } from "../town";
import { canRestart } from "../abilities";

/**
 * セッションの再起動（カードの「再起動」）。セッションを止め、同じ id を claude --resume で、このアプリの端末に
 * cam usage の best のアカウントで立て直す（Rust の restart_session）。id は変わらないので、選んでいるセッションはそのまま
 */
export function useRestart(toast: (text: string, bad?: boolean) => void) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const run = useCallback(async (a: Agent) => {
    if (!canRestart(a)) return;
    setBusy((s) => new Set(s).add(a.id));
    try {
      await invoke("restart_session", { sessionId: a.id });
      kickTown();
      toast(`${a.name} を再起動した`);
    } catch (e) {
      kickTown();
      toast(`再起動できなかった: ${e}`, true);
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(a.id); return n; });
    }
  }, [toast]);
  const restartCtx = useMemo(() => ({ busy, run }), [busy, run]);
  return { restartCtx };
}
