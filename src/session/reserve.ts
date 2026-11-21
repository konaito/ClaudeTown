// ブラウザ版（PWA）の ccn の行の予約（always-switch）。アプリ（Tauri）の端末の予約は Rust が持つ（src-tauri/src/switch.rs）。
// 今は替えられないときに選んだ値を、ここで持つ。一覧が届くたびに useCcnReservations が見て、替えられるようになったら ccn の PATCH で替える。
// 画面を開き直すと消える（持ち越さない）。ccn の pty は次の待機で、node は承認に答えた後に当たるので、長く持つものではない。
import { useEffect, useRef, useSyncExternalStore } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { configureError, isHttp, noRoute, planOf, type Support, type What } from "./control";

export type Pend = { model?: string; mode?: string };

const book = new Map<string, Pend>();
const subs = new Set<() => void>();
let version = 0;
const bump = () => { version++; subs.forEach((f) => f()); };

export function pendingOf(id: string): Pend {
  return book.get(id) ?? {};
}

export function reserve(id: string, what: What, value: string) {
  book.set(id, { ...pendingOf(id), [what]: value });
  bump();
}

export function cancel(id: string, what: What) {
  const p = { ...pendingOf(id) };
  delete p[what];
  if (p.model || p.mode) book.set(id, p); else book.delete(id);
  bump();
}

/** 予約が変わったら描き直す */
export function usePending(id: string): Pend {
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
  return pendingOf(id);
}

/** ccn の PATCH で替える。成功なら替えた後の値、失敗なら文言を返す */
export async function configure(agent: Agent, what: What, value: string): Promise<{ ok: true; model: string | null; mode: string | null } | { ok: false; error: string; noRoute: boolean }> {
  try {
    const r = await invoke<unknown>("configure_session", { sessionId: agent.id, model: what === "model" ? value : null, permissionMode: what === "mode" ? value : null });
    if (!isHttp(r)) return { ok: false, error: "ccn の応答が読めなかった", noRoute: false };
    const err = configureError(r);
    if (err) return { ok: false, error: err, noRoute: noRoute(r) };
    const s = (v: unknown) => (typeof v === "string" && v ? v : null);
    return { ok: true, model: s(r.body?.model), mode: s(r.body?.permissionMode) };
  } catch (e) {
    return { ok: false, error: `替えられなかった: ${e}`, noRoute: false };
  }
}

/** 一覧が届くたびに予約を見て、替えられるものを替える。App に1つだけ置く（チャットを閉じていても当たるように） */
export function useCcnReservations(agents: Agent[], supportOf: (a: Agent) => Support, onDone: (m: string) => void, onError: (m: string) => void) {
  const busy = useRef(new Set<string>());
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
  useEffect(() => {
    for (const [id, p] of book) {
      const a = agents.find((x) => x.id === id);
      // セッションが一覧から消えたら予約も捨てる
      if (!a) { book.delete(id); bump(); continue; }
      if (busy.current.has(id)) continue;
      const what: What | null = p.model ? "model" : p.mode ? "mode" : null;
      if (!what) continue;
      const value = what === "model" ? p.model! : p.mode!;
      const plan = planOf(a, what, value, supportOf(a), false);
      if (plan.kind === "none") { cancel(id, what); onError(`${a.name}: 予約を取り消した: ${plan.why}`); continue; }
      if (plan.kind !== "now") continue;
      busy.current.add(id);
      void configure(a, what, value).then((r) => {
        busy.current.delete(id);
        // 当てている間に別の値へ予約し直されていたら、そちらを残す
        if (pendingOf(id)[what] === value) cancel(id, what);
        if (r.ok) onDone(`${a.name} の${what === "model" ? "モデル" : "権限モード"}を、予約どおり ${value} にした`);
        else onError(`${a.name}: 予約の ${value} にできなかった: ${r.error}`);
      });
    }
  });
}
