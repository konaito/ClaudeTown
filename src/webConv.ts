// ブラウザ版（PWA）の会話の読み出し。Rust の conversation（src-tauri/src/lib.rs の simplify、read_messages、Conv）と同じ中身を TS に移したもの。
// ccn の GET /sessions/<id>/messages?after=N を読み、画面に出す項目（ConvItem）に縮める。
// 移していないもの: 今の動き（live、#59）。ブラウザ版では末尾の「考え中」の行を出さない。保存した会話（conversation_cache）。
import type { ConvDelta } from "./conv";
import { KEEP_CONV } from "./conv";
import type { ConvItem } from "./model";

type J = any;

/** 空白の並びを1つにして n 字に縮める（Rust の clip） */
export function clip(s: string, n: number): string {
  const t = s.split(/\s+/).filter(Boolean).join(" ");
  const cs = Array.from(t);
  return cs.length <= n ? t : cs.slice(0, n - 1).join("") + "…";
}

/** 道具の1行（Rust の tool_line） */
export function toolLine(name: string, input: J): string {
  const verb = (() => {
    switch (name) {
      case "Bash": return "コマンド";
      case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return "書く";
      case "Read": return "読む";
      case "Grep": case "Glob": return "探す";
      case "WebSearch": case "WebFetch": return "調べる";
      case "SendMessage": return "話す";
      case "Agent": case "Task": return "手伝いを呼ぶ";
    }
    if (name.includes("spawn_child")) return "子を呼ぶ";
    if (name.startsWith("mcp__")) return name.split("__").pop() ?? name;
    return name;
  })();
  let target = "";
  for (const k of ["description", "title", "command", "file_path", "pattern", "query", "url", "to"]) {
    const v = input?.[k];
    if (typeof v === "string") { target = v; break; }
  }
  if (target.includes("/") && ["Edit", "MultiEdit", "Write", "Read"].includes(name)) {
    target = target.split("/").reverse().slice(0, 2).reverse().join("/");
  }
  return target === "" ? verb : `${verb}: ${clip(target, 70)}`;
}

/** CLI が貼り付けた文に付ける包み（<pasted_content id="…">）を外す（Rust の unwrap_pasted） */
export function unwrapPasted(text: string): string {
  if (!text.includes("pasted_content")) return text.trim();
  const TAGS = ["<pasted_content", "</pasted_content"];
  let out = "";
  let rest = text;
  for (;;) {
    let best: { i: number; tag: string } | null = null;
    for (const tag of TAGS) {
      const i = rest.indexOf(tag);
      if (i >= 0 && (!best || i < best.i)) best = { i, tag };
    }
    if (!best) break;
    const { i, tag } = best;
    const tail = rest.slice(i);
    const j = tail.indexOf(">");
    const end = j >= 0 && !tail.slice(0, j).includes("\n") ? j : -1;
    const next = tail[tag.length];
    const named = next === " " || next === ">";
    if (end >= 0 && named) { out += rest.slice(0, i); rest = tail.slice(end + 1); }
    else { out += rest.slice(0, i + 1); rest = rest.slice(i + 1); }
  }
  return (out + rest).trim();
}

function userText(content: J): string {
  if (typeof content === "string") return unwrapPasted(content);
  if (Array.isArray(content)) return unwrapPasted(content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n"));
  return "";
}

/** 先頭に並んだ画像の印（[Image #3]）と、その後ろの文に分ける（Rust の split_image_marks） */
export function splitImageMarks(text: string): [string, string] {
  let i = 0;
  for (;;) {
    const m = /^\[Image #(\d+)\]/.exec(text.slice(i));
    if (!m) break;
    i += m[0].length;
    while (text[i] === " " || text[i] === "\t") i++;
  }
  return [text.slice(0, i).trimEnd(), text.slice(i)];
}

const firstLine = (v: J): string => String(typeof v === "string" ? v : "").split("\n").map((l) => l.trim()).find((l) => l) ?? "";

/**
 * ccn の messages の1件を、画面に出す0件以上の項目に縮める。考えた中身と道具の結果は捨てる。
 * node はトランスクリプトの行そのまま（type、message、timestamp）。pty は {at, type, data: {type, message, …}, seq} で、中身は data に入り、時刻は at（ms）にある
 */
export function simplify(raw: J): Omit<ConvItem, "n">[] {
  const wrapped = raw?.data && typeof raw.data === "object" && raw.message == null;
  const m: J = wrapped ? raw.data : raw;
  const at: string | number | null = wrapped ? raw.at ?? null : raw?.timestamp ?? null;
  const content = m?.message?.content;
  const out: Omit<ConvItem, "n">[] = [];
  if (m?.type === "user") {
    let text = userText(content);
    const pre = "Another Claude session sent a message:";
    if (text.startsWith(pre)) text = text.slice(pre.length).trimStart();
    // 別のセッションからのお手紙（<cross-session-message from=… from-name=…>本文</cross-session-message>）は、包みの内側の本文だけ出す
    if (text.startsWith("<cross-session-message")) {
      const rest = text.slice("<cross-session-message".length);
      const gt = rest.indexOf(">");
      const attrs = gt >= 0 ? rest.slice(0, gt) : "";
      const body = (gt >= 0 ? rest.slice(gt + 1) : "").split("</cross-session-message>")[0].trim();
      const attr = (k: string) => { const key = `${k}="`; const i = attrs.indexOf(key); return i >= 0 ? attrs.slice(i + key.length).split('"')[0] : null; };
      if (body) out.push({ role: "user", text: body, from: null, at, letter: { fromName: attr("from-name"), fromRaw: attr("from") } });
      return out;
    }
    // 道具の結果だけの user、hook やシステムの差し込み（<...> で始まる）は出さない
    if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return out;
    // 別のセッションからの文は1行目が from 行。端末に貼った画像のパスは先頭に [Image #3] が付き、from 行はその後ろに回る
    const [imgs, rest] = splitImageMarks(text);
    const nl = rest.indexOf("\n");
    const first = nl >= 0 ? rest.slice(0, nl) : rest;
    const after = nl >= 0 ? rest.slice(nl + 1) : "";
    let from: string | null = null;
    let body = text;
    if (first.startsWith("from ") && first.includes(" via ") && (nl >= 0 || imgs)) {
      const a = after.trim();
      from = first.trimEnd();
      body = !imgs ? a : !a ? imgs : `${imgs}\n${a}`;
    }
    const agentRef = from?.startsWith("from agent:") ? from.slice("from agent:".length).split(/\s+/)[0] : null;
    out.push({ role: "user", text: body, from, at, letter: agentRef != null ? { fromName: null, fromRaw: agentRef } : null });
  } else if (m?.type === "assistant" && Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === "text") {
        const t = String(c.text ?? "").trim();
        if (t) out.push({ role: "assistant", text: t, at });
      } else if (c?.type === "tool_use") {
        const name = String(c.name ?? "");
        const inp = c.input ?? {};
        let sent: ConvItem["sent"] = null;
        if (name === "SendMessage" && typeof inp.message === "string") sent = { to: inp.to ?? null, summary: typeof inp.summary === "string" ? inp.summary : firstLine(inp.message), text: inp.message };
        else if (name === "mcp__ccn__send_message") sent = { to: inp.session ?? null, peer: inp.peer ?? null, summary: firstLine(inp.text), text: inp.text ?? null };
        else if (name === "mcp__ccn__create_session" && typeof inp.prompt === "string") sent = { to: null, peer: inp.peer ?? null, summary: firstLine(inp.prompt), text: inp.prompt, create: true };
        out.push({ role: "tool", text: toolLine(name, inp), at, sent });
      }
    }
  }
  return out;
}

/** ccn の messages の1ページ */
export type MessagesPage = { messages?: J[]; next?: number; epoch?: string | null };

/** 1つのセッションの読み出しの状態（Rust の Conv） */
export type ConvState = { next: number; epoch: string | null; total: number; items: ConvItem[] };
export const newConvState = (): ConvState => ({ next: 0, epoch: null, total: 0, items: [] });

/** 1回で読むページの上限（Rust の read_messages と同じ。20ページ、200件ずつ） */
const MAX_PAGES = 20;

async function readMessages(fetchPage: (after: number) => Promise<MessagesPage>, start: number) {
  let next = start;
  const fresh: Omit<ConvItem, "n">[] = [];
  let epoch: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const v = await fetchPage(next);
    const e = typeof v.epoch === "string" ? v.epoch : null;
    if (page === 0) epoch = e;
    else if (e !== epoch) break; // ページの途中で数え方が変わった。ここまでで止め、次の呼び出しで気づく
    const msgs = v.messages ?? [];
    for (const m of msgs) fresh.push(...simplify(m));
    if (typeof v.next === "number" && v.next > next && msgs.length) next = v.next;
    else break;
    if (msgs.length < 200) break;
  }
  return { next, fresh, epoch };
}

function push(s: ConvState, fresh: Omit<ConvItem, "n">[]) {
  for (const x of fresh) s.items.push({ ...x, n: s.total++ } as ConvItem);
  if (s.items.length > KEEP_CONV) s.items.splice(0, s.items.length - KEEP_CONV);
}

/** 画面が total=since まで持っているときの差分。持っている分が古すぎる、先に進みすぎている、since が無いときは全部を reset で返す */
export function deltaSince(s: ConvState, since: number | null | undefined): ConvDelta {
  const base = s.total - s.items.length;
  if (since != null && since >= base && since <= s.total) return { items: s.items.slice(since - base), total: s.total, reset: false, live: null };
  return { items: s.items.slice(), total: s.total, reset: true, live: null };
}

/**
 * 続きを読んで s に足し、差分を返す。epoch が前と違えば after=0 から読み直して置き換える（再起動や、pty から jsonl への移り変わりで番号が変わるため）。
 * 通し番号 n は前の続きから1つ空けて振るので、画面は reset を受けて持っている分を捨てる
 */
export async function readConversation(s: ConvState, fetchPage: (after: number) => Promise<MessagesPage>, since: number | null | undefined): Promise<ConvDelta> {
  const from = s.next;
  const seen = s.epoch;
  let r = await readMessages(fetchPage, from);
  const stale = from > 0 && r.epoch != null && r.epoch !== seen;
  if (stale) {
    r = await readMessages(fetchPage, 0);
    // 読み直しが0件で、前に中身があるときは置き換えない（ccn は jsonl を読めなかったときも空で返す）
    if (!(r.fresh.length === 0 && s.items.length > 0)) {
      s.total += 1;
      s.items = [];
      s.next = r.next;
      s.epoch = r.epoch;
      push(s, r.fresh);
    }
  } else {
    s.next = r.next;
    if (r.epoch != null) s.epoch = r.epoch;
    push(s, r.fresh);
  }
  return deltaSince(s, since);
}
