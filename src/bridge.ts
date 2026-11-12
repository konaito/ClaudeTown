// Tauri の命令を呼ぶ口。
// ブラウザで開いたとき（開発中の見た目の確認）は、URL に ?mock があればモックのノード（scripts/mock-ccn-pty.ts、127.0.0.1:4399）に直接繋ぐ。
// ?mock が無ければ public/dev-*.json を読み、送信はしない。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const MOCK = !inTauri && typeof location !== "undefined" && location.search.includes("mock") ? "http://127.0.0.1:4399/api" : null;

async function devJson<T>(name: string, fallback: T): Promise<T> {
  const r = await fetch(`/${name}`, { cache: "no-store" });
  if (!r.ok) return fallback;
  return (await r.json()) as T;
}

async function mockCall<T>(cmd: string, a: Record<string, unknown> = {}): Promise<T> {
  const j = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${MOCK}${path}`, init);
    if (!r.ok) throw new Error(await r.text());
    return r.status === 204 ? null : r.json();
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    j(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  switch (cmd) {
    case "snapshot": {
      const list = (await j("/sessions")) as Record<string, any>[];
      const live = list.filter((s) => s.state !== "exited");
      const parentOf = (s: Record<string, any>) => {
        const sid8 = typeof s.parent === "string" && s.parent.startsWith("agent:") ? s.parent.split("/")[1] : null;
        return sid8 ? live.find((x) => x.id.startsWith(sid8))?.id ?? null : null;
      };
      return {
        ccn: MOCK, peer: null, ccn_ok: true, ccn_error: null, fetched_at: Date.now(),
        agents: live.map((s) => ({ id: s.id, name: s.title, kind: s.kind, state: s.state, cwd: s.cwd, pid: s.pid, startedAt: s.startedAt, canSend: true, parent: parentOf(s), capabilities: s.capabilities })),
      } as T;
    }
    case "peers": return [{ name: "mock", url: MOCK, status: "healthy", self: true }, { name: "vm", url: "", status: "healthy", self: false }] as T;
    case "create_session": {
      const headers: Record<string, string> = a.parent ? { "x-ccn-from": `agent:mock/${String(a.parent).slice(0, 8)}/town` } : {};
      return post("/sessions", { terminal: true, cwd: a.cwd ?? "/tmp", prompt: a.prompt, name: a.name, cols: 120, rows: 40 }, headers) as T;
    }
    case "term_input": return post(`/sessions/${a.sessionId}/terminal/input`, { text: a.text }) as T;
    case "term_resize": return post(`/sessions/${a.sessionId}/terminal/resize`, { cols: a.cols, rows: a.rows }) as T;
    case "session_detail": return j(`/sessions/${a.sessionId}`) as T;
    case "teleport_info": return j(`/sessions/${a.sessionId}/teleport`) as T;
    case "teleport": return post(`/sessions/${a.sessionId}/teleport`, { to: a.to, fork: a.fork, subtree: a.subtree, dryRun: a.dryRun }) as T;
    case "stop_session": return j(`/sessions/${a.sessionId}`, { method: "DELETE" }) as T;
    case "conversation": return [] as T;
    default: console.info("[モックでは実行しない]", cmd, a); return null as T;
  }
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri) return invoke<T>(cmd, args);
  if (MOCK) return mockCall<T>(cmd, args);
  if (cmd === "snapshot") {
    const r = await fetch("/dev-snapshot.json", { cache: "no-store" });
    if (!r.ok) throw new Error("dev-snapshot.json が無い。`src-tauri/target/debug/family-computing --snapshot > public/dev-snapshot.json` で作る");
    return (await r.json()) as T;
  }
  if (cmd === "peers") return devJson<T>("dev-peers.json", [] as T);
  // ブラウザ表示では本物の会話を読めない。別のセッションの会話を見せて取り違えに見えないよう、仮の1件だけ返す
  // 見た目の確認用: ?longconv を付けると、スクロールが要る長さの仮の会話を返す
  if (cmd === "conversation" && location.search.includes("longconv")) {
    return Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `（仮の会話 ${i + 1}）スクロールの端のグラデーションを確かめるための文。` })) as T;
  }
  if (cmd === "conversation") return [{ role: "assistant", text: `（ブラウザ表示の仮の会話）${String(args?.sessionId ?? "").slice(0, 8)} の会話は、Tauri の中で ccn から読む。` }] as T;
  console.info("[ブラウザ表示なので実行しない]", cmd, args);
  return "ブラウザ表示" as T;
}

/** 端末のイベント。ev は size / replay / data / exit / error。data は ccn の JSON のまま（replay と data は { b64 }） */
export type TermEvent = { id: string; ev: string; data: any };

/** 1つのセッションの端末を開き、イベントを受ける。戻り値で閉じる */
export async function openTerminal(sessionId: string, peer: string | null, on: (e: TermEvent) => void): Promise<() => void> {
  if (inTauri) {
    const un = await listen<TermEvent>("fc-term", (m) => { if (m.payload.id === sessionId) on(m.payload); });
    await invoke("term_open", { sessionId, peer });
    return () => { un(); invoke("term_close", { sessionId }).catch(() => {}); };
  }
  if (MOCK) {
    const es = new EventSource(`${MOCK}/sessions/${sessionId}/terminal`);
    for (const ev of ["size", "replay", "data", "exit"]) {
      es.addEventListener(ev, (m) => on({ id: sessionId, ev, data: JSON.parse((m as MessageEvent).data) }));
    }
    es.onerror = () => on({ id: sessionId, ev: "error", data: { message: "モックに繋がらない" } });
    return () => es.close();
  }
  on({ id: sessionId, ev: "error", data: { message: "ブラウザ表示では端末を開けない（?mock を付けるとモックに繋ぐ）" } });
  return () => {};
}

export async function setFullscreen() {
  if (inTauri) {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen();
  }
}
