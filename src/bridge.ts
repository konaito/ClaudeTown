// Tauri の命令を呼ぶ口。
// ビルドしたブラウザ版（PWA、town.fybe.jp）は Tauri の外で動き、同じオリジンの /api を web/ の Worker が ccn へ中継する。
// アプリ（Tauri）は ccn を使わないが、ブラウザ版の扱いは本人が決めるまで今のまま残す（下の WEB の分岐、webConv.ts、webPerm.ts）。
// 開発中にブラウザで開いたとき（見た目の確認）は、public/dev-*.json を読み、送信はしない。
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { perfCounters } from "./term/perf";
import { deltaOf } from "./conv";
import { answerPermission } from "./webPerm";
import { newConvState, readConversation, type ConvState } from "./webConv";
import { cardNames, projectFromPath, type ConvItem } from "./model";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// ビルドした版（PWA）。Tauri の外で、ccn と同じオリジンの /api に直接つなぐ（ccn は別オリジンからの要求を 403 で断る）。
// 本番では Worker（web/）が、この道を Access のリンクトークンを付けて ccn に中継する
const WEB = !inTauri && import.meta.env.PROD && typeof location !== "undefined";
const API = WEB ? `${location.origin}/api` : null;

export const IS_WEB = WEB;
const LOADED_AT = Date.now();

async function devJson<T>(name: string, fallback: T): Promise<T> {
  const r = await fetch(`/${name}`, { cache: "no-store" });
  if (!r.ok) return fallback;
  return (await r.json()) as T;
}

const WEB_CONVS = new Map<string, ConvState>();
const WEB_CONV_RUN = new Map<string, Promise<unknown>>();

/** ブラウザ版（PWA）の命令。ccn の口を、同じオリジンの /api（web/ の Worker の中継）で呼ぶ。Rust と同じ形で返す */
async function webCall<T>(cmd: string, a: Record<string, unknown> = {}): Promise<T> {
  const base = API!;
  const j = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${base}${path}`, { credentials: "same-origin", ...init });
    if (!r.ok) throw new Error(await r.text());
    return r.status === 204 ? null : r.json();
  };
  const raw = async (path: string, method: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { credentials: "same-origin", method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const t = await r.text();
    let parsed: unknown = t;
    try { parsed = JSON.parse(t); } catch { /* 文字列のまま */ }
    return { status: r.status, body: parsed };
  };
  const post = (path: string, body: unknown) =>
    j(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  switch (cmd) {
    case "snapshot": {
      const list = (await j("/sessions")) as Record<string, any>[];
      const live = list.filter((s) => s.state !== "exited");
      const parentOf = (s: Record<string, any>) => {
        const sid8 = typeof s.parent === "string" && s.parent.startsWith("agent:") ? s.parent.split("/")[1] : null;
        return sid8 ? live.find((x) => x.id.startsWith(sid8))?.id ?? null : null;
      };
      // 名前は Rust の snapshot と同じ決め方（src/model.ts の cardNames）。.git は読めないので、パスの形だけで決める
      const names = cardNames(live.map((s) => ({ id: s.id, cwd: s.cwd, title: s.title })));
      return {
        fetched_at: Date.now(), letters: [], sources: null,
        agents: live.map((s) => ({ id: s.id, name: names.get(s.id), project: s.cwd ? projectFromPath(s.cwd) : null, kind: s.kind, source: "ccn", state: s.state, cwd: s.cwd, pid: s.pid, startedAt: s.startedAt, canSend: true, parent: parentOf(s), capabilities: s.capabilities, account: s.account ?? null, accountEmail: s.accountEmail ?? null })),
      } as T;
    }
    case "create_session": {
      // Rust の create_session と同じ引数。ccn は空の name を 400 で断るので送らない
      const body: Record<string, unknown> = { terminal: true, cols: a.cols ?? 120, rows: a.rows ?? 40 };
      if (typeof a.cwd === "string" && a.cwd) body.cwd = a.cwd;
      if (typeof a.name === "string" && a.name.trim()) body.name = a.name;
      return post("/sessions", body) as T;
    }
    case "term_input": return post(`/sessions/${a.sessionId}/terminal/input`, { text: a.text }) as T;
    case "term_resize": return post(`/sessions/${a.sessionId}/terminal/resize`, { cols: a.cols, rows: a.rows }) as T;
    case "session_detail": return j(`/sessions/${a.sessionId}`) as T;
    // 新しい世帯のペイン（#89）の材料。Rust の house_places と同じ形で返す。places は古い ccn に無い（404）ので null にする
    case "house_places": {
      const opt = (path: string) => fetch(`${base}${path}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const [host, sessions, places] = await Promise.all([opt("/host"), j("/sessions"), opt("/places?limit=300")]);
      return { roots: host?.roots ?? [], lobby: host?.lobby ?? null, sessions, places: places?.places ?? null } as T;
    }
    // 場所のリポジトリ名（#99）は .git を読む Rust にしか取れない。ブラウザ版では空にして、ディレクトリ名だけを出す
    case "place_repos": return {} as T;
    // Rust の send_direct と同じく、貼り付けてから Enter を押す
    case "send_direct": {
      await post(`/sessions/${a.sessionId}/terminal/input`, { text: `\x1b[200~${String(a.text)}\x1b[201~` });
      await new Promise((r) => setTimeout(r, 150));
      return post(`/sessions/${a.sessionId}/terminal/input`, { text: "\r" }) as T;
    }
    case "interrupt_session": return post(`/sessions/${a.sessionId}/interrupt`, {}) as T;
    // モデルと権限モード（#97）。HTTP の応答を { status, body } で返す（断られた理由は画面が status と code で決める）
    case "session_controls": return raw(`/sessions/${a.sessionId}/command`, "POST", { text: "" }) as T;
    case "configure_session": {
      const body: Record<string, unknown> = {};
      if (a.model) body.model = a.model;
      if (a.permissionMode) body.permissionMode = a.permissionMode;
      if (!Object.keys(body).length) throw new Error("替えるものが無い");
      return raw(`/sessions/${a.sessionId}`, "PATCH", body) as T;
    }
    case "run_command": return raw(`/sessions/${a.sessionId}/command`, "POST", { text: a.text }) as T;
    case "stop_session": return j(`/sessions/${a.sessionId}`, { method: "DELETE" }) as T;
    case "conversation": {
      // Rust の代わりに、ここで ccn の messages を読んで縮める（src/webConv.ts）。同じ会話への取得は1本ずつ順に通す
      const key = String(a.sessionId);
      const st = WEB_CONVS.get(key) ?? newConvState();
      WEB_CONVS.set(key, st);
      const run = (WEB_CONV_RUN.get(key) ?? Promise.resolve()).catch(() => {}).then(() =>
        readConversation(st, (after) => j(`/sessions/${a.sessionId}/messages?after=${after}`), a.since as number | null | undefined));
      WEB_CONV_RUN.set(key, run);
      return (await run) as T;
    }
    // Rust の代わりに、承認の安全確認をここで行う（src/webPerm.ts）
    case "answer_permission": return answerPermission((path) => j(path), (path, body) => post(path, body), String(a.sessionId), String(a.choice), (a.expectId as string | null) ?? null, (a.answers as Record<string, string> | null) ?? null, (a.message as string | null) ?? null, (a.suggestion as number | null) ?? null) as T;
    case "send_message": {
      if (!String(a.text ?? "").trim()) throw new Error("文が空");
      const r = await j(`/sessions/${a.sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: a.text }) });
      return JSON.stringify(r) as T;
    }
    default: console.info("[ブラウザ版では実行しない]", cmd, a); return null as T;
  }
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri) return invoke<T>(cmd, args);
  if (WEB) return webCall<T>(cmd, args);
  if (cmd === "snapshot") {
    const r = await fetch("/dev-snapshot.json", { cache: "no-store" });
    if (!r.ok) throw new Error("dev-snapshot.json が無い。`src-tauri/target/debug/family-computing --snapshot > public/dev-snapshot.json` で作る");
    return (await r.json()) as T;
  }
  // 見た目の確認用: public/dev-house-places.json（Rust の house_places の出力）。無ければ空の一覧
  if (cmd === "house_places") return devJson<T>("dev-house-places.json", { roots: [], lobby: null, sessions: [], places: null } as T);
  if (cmd === "place_repos") return devJson<T>("dev-place-repos.json", {} as T);
  // ブラウザ表示では本物の会話を読めない。別のセッションの会話を見せて取り違えに見えないよう、仮の1件だけ返す
  // 見た目の確認用: ?longconv を付けると、スクロールが要る長さの仮の会話を返す
  // 見た目の確認用: ?conv を付けると public/dev-conversation.json（`--conversation <id>` の出力の Ok）を返す
  // 中身が { items, live } のときは live（今の動きと順番待ち）も返す
  if (cmd === "conversation" && location.search.includes("conv") && !location.search.includes("longconv")) {
    const j = await devJson<ConvItem[] | { items: ConvItem[]; live?: unknown }>("dev-conversation.json", []);
    if (Array.isArray(j)) return deltaOf(j, args?.since as number | null) as T;
    return { ...deltaOf(j.items, args?.since as number | null), live: j.live ?? null } as T;
  }
  if (cmd === "conversation" && location.search.includes("longconv")) return deltaOf(fakeConv(), args?.since as number | null) as T;
  if (cmd === "conversation") return deltaOf([{ role: "assistant", text: `（ブラウザ表示の仮の会話）${String(args?.sessionId ?? "").slice(0, 8)} の会話は、アプリの中で Claude Code の記録から読む。` }], args?.since as number | null) as T;
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
 * replay と data は { s }（出力を UTF-8 の文字列に戻したもの）。Tauri では Rust が PTY の出力を文字列にし、16ms ごとにまとめて送る（#9）
 */
/** 端末のイベントの中身。ev ごとに入るものが違い、無いこともあるので全部省略可能にしてある */
export type TermData = { cols?: number; rows?: number; s?: string; reason?: string; code?: number; message?: string };
export type TermEvent = { id: string; ev: string; data: TermData };

/** 1つのセッションの端末を開き、イベントを受ける。戻り値で閉じる */
export async function openTerminal(sessionId: string, on: (e: TermEvent) => void): Promise<() => void> {
  if (inTauri) {
    // このターミナルだけに送る口（Channel）
    let open = true;
    const ch = new Channel<{ ev: string; data: TermData }>((m) => {
      perfCounters.ipc++;
      perfCounters.bytes += m.data?.s?.length ?? 0;
      if (open) on({ id: sessionId, ev: m.ev, data: m.data });
    });
    const generation = await invoke<number>("term_open", { sessionId, onEvent: ch });
    return () => { open = false; invoke("term_close", { sessionId, generation }).catch(() => {}); };
  }
  if (WEB) {
    const es = new EventSource(`${API}/sessions/${sessionId}/terminal`);
    // Tauri と同じ形（{ s }）に直す。文字の途中で切れた分は TextDecoder が次に回す
    const dec = new TextDecoder();
    for (const ev of ["size", "replay", "data", "exit"]) {
      es.addEventListener(ev, (m) => {
        const d = JSON.parse((m as MessageEvent).data);
        on({ id: sessionId, ev, data: typeof d?.b64 === "string" ? { s: dec.decode(Uint8Array.from(atob(d.b64), (c) => c.charCodeAt(0)), { stream: true }) } : d });
      });
    }
    es.onerror = () => on({ id: sessionId, ev: "error", data: { message: "ccn に繋がらない" } });
    return () => es.close();
  }
  on({ id: sessionId, ev: "error", data: { message: "ブラウザ表示ではターミナルを開けない" } });
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

/** 文字列をクリップボードに入れる。アプリでは Tauri の clipboard-manager（Rust 側で書く）を使う。
 * WebKit の navigator.clipboard は人の操作の中からしか書けず、開発版で計測のコードから呼ぶと NotAllowedError になった（PR #73） */
export async function copyText(text: string) {
  if (inTauri) await writeText(text);
  else await navigator.clipboard.writeText(text);
}

export type FileDrop = { type: "enter" | "over" | "leave" | "drop"; paths?: string[] };

/** 窓にファイルを落としたとき（#64）。Tauri はドロップを窓で受け、手元のパスを渡す（webview の drop イベントにはパスが無い）。
 * ブラウザ表示では何もしない。返した関数で聞くのをやめる */
export function onFileDrop(handler: (e: FileDrop) => void): () => void {
  if (!inTauri) return () => {};
  let off: (() => void) | null = null;
  let done = false;
  getCurrentWindow().onDragDropEvent((e) => handler(e.payload as FileDrop)).then((u) => { if (done) u(); else off = u; }).catch(() => {});
  return () => { done = true; off?.(); };
}
