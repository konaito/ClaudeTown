// Tauri の命令を呼ぶ口。
// ブラウザで開いたとき（開発中の見た目の確認）は、URL に ?mock があればモックのノード（scripts/mock-ccn-pty.ts、127.0.0.1:4399）に直接繋ぐ。
// ?mock が無ければ public/dev-*.json を読み、送信はしない。
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { perfCounters } from "./term/perf";
import { deltaOf } from "./conv";
import { cardNames, projectFromPath, type ConvItem } from "./model";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// ?mockport=<ポート> で、モック以外の口（本番のノードの前に置いた試験用の中継など）にも繋げる
const MOCK = !inTauri && typeof location !== "undefined" && location.search.includes("mock")
  ? `http://127.0.0.1:${new URLSearchParams(location.search).get("mockport") ?? "4399"}/api` : null;

const LOADED_AT = Date.now();
// 見た目の確認用: ?offline を付けると、ccn に届かない状態を真似る。一覧は保存した一覧として出し、会話は読めず、
// 保存してあった会話（?longconv と同じ仮の会話）を出す。Rust の保存（src-tauri/src/offline.rs）は通らない
const OFFLINE = !inTauri && !MOCK && typeof location !== "undefined" && location.search.includes("offline");
const OFFLINE_ERR = `ccn が 502 を返した: {"error":"peer incertotech unreachable: fetch failed","peer":"incertotech"}`;

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
        // お手紙の試し: public/dev-letters.json（無ければ空）
        letters: await fetch("/dev-letters.json", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
        // 名前は Rust の snapshot と同じ決め方（src/model.ts の cardNames）。モックでは .git を読まないので、パスの形だけで決める
        agents: (() => {
          const names = cardNames(live.map((s) => ({ id: s.id, cwd: s.cwd, title: s.title, parent: parentOf(s), startedAt: s.startedAt })));
          return live.map((s) => ({ id: s.id, name: names.get(s.id), project: s.cwd ? projectFromPath(s.cwd) : null, kind: s.kind, state: s.state, cwd: s.cwd, pid: s.pid, startedAt: s.startedAt, canSend: true, parent: parentOf(s), capabilities: s.capabilities }));
        })(),
      } as T;
    }
    case "peers": return [{ name: "mock", url: MOCK, status: "healthy", self: true }, { name: "vm", url: "", status: "healthy", self: false }] as T;
    case "create_session": {
      const headers: Record<string, string> = a.parent ? { "x-ccn-from": `agent:mock/${String(a.parent).slice(0, 8)}/town` } : {};
      // Rust の create_session と同じく、空の prompt と name は送らない（本番のノードは name: null を 400 で断る）
      const body: Record<string, unknown> = { terminal: true, cwd: a.cwd || (new URLSearchParams(location.search).get("cwd") ?? "/tmp"), cols: a.cols ?? 120, rows: a.rows ?? 40 };
      if (typeof a.prompt === "string" && a.prompt.trim()) body.prompt = a.prompt;
      if (typeof a.name === "string" && a.name.trim()) body.name = a.name;
      return post("/sessions", body, headers) as T;
    }
    case "term_input": return post(`/sessions/${a.sessionId}/terminal/input`, { text: a.text }) as T;
    case "term_resize": return post(`/sessions/${a.sessionId}/terminal/resize`, { cols: a.cols, rows: a.rows }) as T;
    case "session_detail": return j(`/sessions/${a.sessionId}`) as T;
    case "teleport_info": return j(`/sessions/${a.sessionId}/teleport`) as T;
    case "teleport": return post(`/sessions/${a.sessionId}/teleport`, { to: a.to, fork: a.fork, subtree: a.subtree, dryRun: a.dryRun }) as T;
    case "stop_session": return j(`/sessions/${a.sessionId}`, { method: "DELETE" }) as T;
    case "conversation": return deltaOf([], a.since as number | null) as T;
    default: console.info("[モックでは実行しない]", cmd, a); return null as T;
  }
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri) return invoke<T>(cmd, args);
  if (MOCK) return mockCall<T>(cmd, args);
  if (OFFLINE && cmd === "conversation_cache") {
    return { savedAt: LOADED_AT - 25 * 60 * 1000, ...(() => { const d = deltaOf(fakeConv(), null); return { total: d.total, items: d.items }; })() } as T;
  }
  // 時間切れまで待つ様子も見せる（保存した履歴を出したまま「読み込み中」になる）
  if (OFFLINE && cmd === "conversation") { await new Promise((r) => setTimeout(r, 1500)); throw new Error(OFFLINE_ERR); }
  if (cmd === "snapshot") {
    // 別の町は public/dev-snapshot-<町>.json（`--snapshot --peer <町>` で作る）。無ければ届かない町として扱う
    const town = args?.peer ? `-${args.peer}` : "";
    const r = await fetch(`/dev-snapshot${town}.json`, { cache: "no-store" });
    if (town && (!r.ok || !(r.headers.get("content-type") ?? "").includes("json"))) throw new Error(`dev-snapshot${town}.json が無い`);
    if (!r.ok) throw new Error("dev-snapshot.json が無い。`src-tauri/target/debug/family-computing --snapshot > public/dev-snapshot.json` で作る");
    const s = await r.json();
    return (OFFLINE ? { ...s, ccn_ok: false, ccn_error: OFFLINE_ERR, cached_at: LOADED_AT - 25 * 60 * 1000 } : s) as T;
  }
  if (cmd === "peers") return devJson<T>("dev-peers.json", [] as T);
  // ブラウザ表示では本物の会話を読めない。別のセッションの会話を見せて取り違えに見えないよう、仮の1件だけ返す
  // 見た目の確認用: ?longconv を付けると、スクロールが要る長さの仮の会話を返す
  // 見た目の確認用: ?conv を付けると public/dev-conversation.json（`--conversation <id>` の出力の Ok）を返す
  if (cmd === "conversation" && location.search.includes("conv") && !location.search.includes("longconv")) {
    return deltaOf(await devJson("dev-conversation.json", []), args?.since as number | null) as T;
  }
  if (cmd === "conversation" && location.search.includes("longconv")) return deltaOf(fakeConv(), args?.since as number | null) as T;
  if (cmd === "conversation") return deltaOf([{ role: "assistant", text: `（ブラウザ表示の仮の会話）${String(args?.sessionId ?? "").slice(0, 8)} の会話は、Tauri の中で ccn から読む。` }], args?.since as number | null) as T;
  console.info("[ブラウザ表示なので実行しない]", cmd, args);
  return "ブラウザ表示" as T;
}

/**
 * 見た目の確認用の仮の会話。?longconv=<件数> で件数を変える（#10 の計測は 80 件、Rust が画面へ渡す上限と同じ）
 * &grow を付けると5秒ごとに1件増える（増えた吹き出しだけ描くかを確かめる）
 */
function fakeConv(): ConvItem[] {
  const q = new URLSearchParams(location.search);
  const n = (Number(q.get("longconv")) || 24) + (q.has("grow") ? Math.floor((Date.now() - LOADED_AT) / 5000) : 0);
  // 5件ごとに、発言、返事、道具の行、送ったお手紙、受け取ったお手紙を並べる（吹き出しの種類を全部出す）
  return Array.from({ length: n }, (_, i): ConvItem => {
    const at = Date.UTC(2026, 10, 13, 0, i);
    const head = `（仮の会話 ${i + 1}）`;
    switch (i % 5) {
      case 0: return { role: "user", at, text: `${head}スクロールの端のグラデーションを確かめるための文。` };
      case 1: return { role: "assistant", at, text: `${head}**太字**と \`コード\` を含む返事。\n\n## 見出し\n- 箇条 1\n- 箇条 2` };
      case 2: return { role: "tool", at, text: `読む: ${head}src/App.tsx` };
      case 3: return { role: "tool", at, text: `話す: ${head}`, sent: { to: "uds:/tmp/cc-socks/1.sock", summary: `${head}送ったお手紙`, text: `${head}送ったお手紙の**本文**` } };
      default: return { role: "user", at, text: `${head}受け取ったお手紙の**本文**`, letter: { fromName: "別の子", fromRaw: "mock/bbbbbbbb/child" } };
    }
  });
}

/**
 * 端末のイベント。ev は size / replay / data / exit / error / input_error。
 * replay と data は { s }（出力を UTF-8 の文字列に戻したもの）。Tauri では Rust が base64 を外し、16ms ごとにまとめて送る（#9）
 */
export type TermEvent = { id: string; ev: string; data: any };

/** 1つのセッションの端末を開き、イベントを受ける。戻り値で閉じる */
export async function openTerminal(sessionId: string, peer: string | null, on: (e: TermEvent) => void): Promise<() => void> {
  if (inTauri) {
    // このターミナルだけに送る口（Channel）。前は全部のウィンドウへの emit を受けて、セッションの ID で選んでいた
    let open = true;
    const ch = new Channel<{ ev: string; data: any }>((m) => {
      perfCounters.ipc++;
      perfCounters.bytes += m.data?.s?.length ?? 0;
      if (open) on({ id: sessionId, ev: m.ev, data: m.data });
    });
    const generation = await invoke<number>("term_open", { sessionId, peer, onEvent: ch });
    return () => { open = false; invoke("term_close", { sessionId, generation }).catch(() => {}); };
  }
  if (MOCK) {
    const es = new EventSource(`${MOCK}/sessions/${sessionId}/terminal`);
    // Tauri と同じ形（{ s }）に直す。文字の途中で切れた分は TextDecoder が次に回す
    const dec = new TextDecoder();
    for (const ev of ["size", "replay", "data", "exit"]) {
      es.addEventListener(ev, (m) => {
        const d = JSON.parse((m as MessageEvent).data);
        on({ id: sessionId, ev, data: typeof d?.b64 === "string" ? { s: dec.decode(Uint8Array.from(atob(d.b64), (c) => c.charCodeAt(0)), { stream: true }) } : d });
      });
    }
    es.onerror = () => on({ id: sessionId, ev: "error", data: { message: "モックに繋がらない" } });
    return () => es.close();
  }
  on({ id: sessionId, ev: "error", data: { message: "ブラウザ表示ではターミナルを開けない（?mock を付けるとモックに繋ぐ）" } });
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
