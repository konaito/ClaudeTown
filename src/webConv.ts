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

/** 道具の結果を画面に出す長さ（字）と行数（Rust の RESULT_CHARS と RESULT_LINES） */
const RESULT_CHARS = 1500;
const RESULT_LINES = 40;

/** 道具の結果（tool_result の content）を文にする。改行は残し、頭だけを持つ（Rust の result_text） */
export function resultText(content: J): string {
  const t = (typeof content === "string" ? content : Array.isArray(content)
    ? content.map((c: J) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[画像]" : "")).filter(Boolean).join("\n")
    : "").trim();
  let out = t.split("\n").slice(0, RESULT_LINES).join("\n");
  if (Array.from(out).length > RESULT_CHARS) out = Array.from(out).slice(0, RESULT_CHARS).join("");
  if (out.length < t.length) out += "\n…（続きは省いた）";
  return out;
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
 * ccn の messages の1件を、画面に出す0件以上の項目に縮める。考えた中身は捨てる。道具の結果は result の項目にし、push が道具の行に付ける（#83）。
 * node はトランスクリプトの行そのまま（type、message、timestamp）。pty は {at, type, data: {type, message, …}, seq} で、中身は data に入り、時刻は at（ms）にある
 */
/** ! のシェルの入力を、打った形の「!コマンド」の文に直す（Rust の bash_input と同じ、#254）。! の後ろの空白は残す。シェルの入力の行でなければ null */
export function bashInput(text: string): string | null {
  const t = text.trimStart();
  if (!t.startsWith("<bash-input>")) return null;
  const r = t.slice("<bash-input>".length);
  const end = r.lastIndexOf("</bash-input>");
  if (end < 0) return null;
  const body = r.slice(0, end).trimEnd();
  return body.trim() ? `!${body}` : null;
}
/** スラッシュコマンドの入力を、端末と同じ「/名前 引数」の文に直す（Rust の slash_command と同じ、#157）。コマンドの行でなければ null */
export function slashCommand(text: string): string | null {
  const t = text.trimStart();
  if (!t.startsWith("<command-name>") && !t.startsWith("<command-message>")) return null;
  const i = t.indexOf("<command-name>");
  if (i < 0) return null;
  let name = t.slice(i + "<command-name>".length).split("</command-name>")[0].trim();
  if (!name) return null;
  if (!name.startsWith("/")) name = `/${name}`;
  const a = t.indexOf("<command-args>");
  const r = a >= 0 ? t.slice(a + "<command-args>".length) : "";
  const end = r.lastIndexOf("</command-args>");
  const args = end >= 0 ? r.slice(0, end).trim() : "";
  return args ? `${name} ${args}` : name;
}

/** お手紙の包み（Rust の LETTER_TAGS） */
const LETTER_TAGS = ["cross-session-message", "teammate-message", "agent-message"] as const;

/** お手紙の包みで始まる文を、包みごとの項目にする。包みで始まらなければ null（Rust の letters、#253） */
function letters(text: string, at: string | number | null): Omit<ConvItem, "n">[] | null {
  const out: Omit<ConvItem, "n">[] = [];
  let rest = text;
  let found = false;
  for (;;) {
    const s = rest.trimStart();
    const tag = LETTER_TAGS.find((t) => s.startsWith(`<${t}`));
    if (!tag) break;
    found = true;
    const r = s.slice(tag.length + 1);
    const gt = r.indexOf(">");
    const attrs = gt >= 0 ? r.slice(0, gt) : "";
    const after = gt >= 0 ? r.slice(gt + 1) : "";
    const close = `</${tag}>`;
    const ci = after.indexOf(close);
    const raw = ci >= 0 ? after.slice(0, ci) : after;
    rest = ci >= 0 ? after.slice(ci + close.length) : "";
    const attr = (k: string) => { const key = `${k}="`; const i = attrs.indexOf(key); return i >= 0 ? attrs.slice(i + key.length).split('"')[0] : null; };
    let fromName: string | null;
    let fromRaw: string | null;
    if (tag === "cross-session-message") {
      fromName = attr("from-name");
      fromRaw = attr("from");
    } else {
      fromName = attr(tag === "teammate-message" ? "teammate_id" : "from") ?? "";
      fromRaw = `teammate:${fromName}`;
    }
    const body = tag === "teammate-message" ? teammateBody(raw.trim()) : raw.trim();
    if (body) out.push({ role: "user", text: body, from: null, at, letter: { fromName, fromRaw } });
  }
  return found ? out : null;
}

/** チームメイトの文の本文。決まった形の連絡（JSON の1行）を読む（Rust の teammate_body、#253） */
function teammateBody(body: string): string | null {
  let j: J = null;
  if (body.startsWith("{")) {
    try { j = JSON.parse(body.split("\n")[0]); } catch { j = null; }
  }
  const text = (k: string) => (typeof j?.[k] === "string" ? j[k].trim() : null);
  switch (typeof j?.type === "string" ? j.type : null) {
    case "idle_notification": return text("result");
    case "teammate_terminated": return text("message");
    case "shutdown_request": case "shutdown_approved": return null;
  }
  return body;
}

export function simplify(raw: J): Omit<ConvItem, "n">[] {
  const wrapped = raw?.data && typeof raw.data === "object" && raw.message == null;
  const m: J = wrapped ? raw.data : raw;
  const at: string | number | null = wrapped ? raw.at ?? null : raw?.timestamp ?? null;
  const content = m?.message?.content;
  const out: Omit<ConvItem, "n">[] = [];
  if (m?.type === "result") {
    // ターンの終わり。止めたと失敗だけを出す（Rust の simplify と同じ）
    if (m.subtype === "interrupted") out.push({ role: "event", kind: "interrupted", text: "ここで止めた", at });
    else if (m.is_error === true) {
      const t = clip(String(m.result ?? ""), 300);
      out.push({ role: "event", kind: "error", text: t ? `ターンが失敗で終わった: ${t}` : "ターンが失敗で終わった", at });
    }
    return out;
  }
  if (m?.type === "user" && Array.isArray(content) && content.some((c: J) => c?.type === "tool_result")) {
    for (const c of content) {
      if (c?.type === "tool_result" && typeof c.tool_use_id === "string") out.push({ role: "result", id: c.tool_use_id, text: resultText(c.content), error: c.is_error === true, at });
    }
    return out;
  }
  if (m?.type === "user") {
    let text = userText(content);
    // 作業中に届いた文は「… sent a message while you were working:」になる（Rust の simplify と同じ、#253）
    const pre = text.match(/^Another Claude session sent a message[^\n:]*:/);
    // 2.1.330 からは、本文の後ろに英語の注記（This came from another Claude session — …）が付く（Rust の simplify と同じ、#156）
    if (pre) text = text.slice(pre[0].length).trimStart().split("\n\nThis came from another Claude session")[0].trimEnd();
    // 別のセッションとチームメイトからのお手紙は、包みの内側の本文だけ出す
    const ls = letters(text, at);
    if (ls) return ls;
    // 止めたときに claude が書く印。吹き出しにせず、止めた印にする（Rust の simplify と同じ）
    if (text.startsWith("[Request interrupted by user")) {
      out.push({ role: "event", kind: "interrupted", text: "ここで止めた", at });
      return out;
    }
    // スラッシュコマンドの入力は「/名前 引数」の文に、! のシェルの入力は「!コマンド」の文にしてから見る。
    // そのままだと `<` で始まり、下の除外で落ちる（Rust の simplify と同じ、#157、#254）。シェルの出力は下の除外で落とす
    text = slashCommand(text) ?? bashInput(text) ?? text;
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
        const item: ConvItem = { role: "tool", text: toolLine(name, inp), at, sent, id: typeof c.id === "string" ? c.id : null };
        // 計画の確認の本文。Rust の simplify と同じ（承認の hook の tool_input は空で来ることがある、#83）
        if (name === "ExitPlanMode" && typeof inp.plan === "string" && inp.plan.trim()) item.plan = inp.plan;
        out.push(item);
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
  const start = s.total;
  for (const x of fresh) {
    // 止めた印の直後の印は重ねない（Rust の Conv::push と同じ）
    const last = s.items[s.items.length - 1];
    if (x.role === "event" && last?.role === "event" && last.kind === "interrupted") continue;
    // 道具の結果は持っている道具の行に付ける。前に渡した道具の行の結果だけ result の項目で送る（Rust の Conv::push と同じ）
    if (x.role === "result") {
      let t: ConvItem | undefined;
      for (let i = s.items.length - 1; i >= 0; i--) { const y = s.items[i]; if (y.role === "tool" && y.id === x.id && !y.result) { t = y; break; } }
      if (!t) continue;
      t.result = { text: x.text, error: !!x.error };
      if ((t.n ?? -1) >= start) continue;
    }
    s.items.push({ ...x, n: s.total++ } as ConvItem);
  }
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
