// 軽さの計測（scripts/bench.ts、#2）で使うモックのノード。毎回同じ町を出す（ID、親子、状態、開始時刻は決め打ち）。
//   bun run scripts/mock-ccn-town.ts <ポート> [オプション]
//     --households <数>   世帯（根のセッション）の数。既定 4
//     --sessions <数>     セッションの合計。既定 10。根の残りを、世帯に順に子として配る（3人目からは孫）
//     --running <数>      作業中（state=running）にする数。既定 0
//     --approval <数>     承認待ち（state=waiting_permission）にする数。既定 0
//     --flood <Hz>        先頭の世帯に PTY のセッションを1つ足し、決まった出力を1秒に Hz かたまり流し続ける（mock-ccn-flood.ts と同じ中身）。既定 0（足さない）
//     --talk <件>         先頭の世帯に node のセッションを1つ足し、件数ぶんの発言を messages で返す。既定 0（足さない）
//     --no-stream         一覧の SSE（GET /api/sessions/stream）を 404 にする（口が無い ccn を真似る）。既定は、つないだときに一覧を1回送り、
//                         あとは15秒ごとの keep-alive だけを送る（町は変わらないので）
// 起動したら「ready <ポート> pid <pid>」と、足したセッションの ID（flood <id>、talk <id>）を標準出力に書く。
// GET /__bench/stats で、起動してからの要求の数を口ごとに返す（ccn への問い合わせの回数を数える。#5、#14）。
// 口は ccn と同じ形（GET /api/peers、/api/sessions、/api/sessions/stream の SSE、/api/sessions/<id>、…/messages?after=、…/terminal の SSE、POST …/terminal/input と resize）
import { floodChunks } from "./flood-chunk";

const argv = process.argv.slice(2);
const PORT = Number(argv[0]);
if (!PORT) { console.error("ポートを渡す"); process.exit(2); }
const opt = (k: string, d: number) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const HOUSEHOLDS = opt("households", 4), SESSIONS = opt("sessions", 10), RUNNING = opt("running", 0), APPROVAL = opt("approval", 0);
const FLOOD_HZ = opt("flood", 0), TALK = opt("talk", 0);
const STREAM = !argv.includes("--no-stream");
if (HOUSEHOLDS < 1 || SESSIONS < HOUSEHOLDS || RUNNING + APPROVAL > SESSIONS) { console.error("数が合わない"); process.exit(2); }

// 開始時刻は起動の1時間前から1分ずつずらす（町の並びと経過時間の表示が毎回同じになる）
const T0 = Date.now() - 3600_000;
const caps = (terminal: boolean) => ({ send: true, permissions: true, interrupt: true, stop: true, events: false, terminal });
type S = { id: string; kind: "node" | "pty"; title: string; cwd: string; pid: number; parent: string; state: string; startedAt: number; lastActivityAt: number; capabilities: ReturnType<typeof caps> };
const idOf = (i: number) => `b${i.toString(16).padStart(7, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
const sessions: S[] = [];
const roots: S[] = [];
for (let i = 0; i < SESSIONS; i++) {
  const id = idOf(i + 1);
  let parent = "local", cwd = `/tmp/bench-town/house-${i + 1}`;
  if (i >= HOUSEHOLDS) {
    // 根の残りを世帯に順に配る。同じ世帯の3人目からは、その世帯の2人目の子（孫）にする
    const h = (i - HOUSEHOLDS) % HOUSEHOLDS, nth = Math.floor((i - HOUSEHOLDS) / HOUSEHOLDS);
    const kin = sessions.filter((s) => s.cwd.startsWith(`${roots[h].cwd}/`));
    const p = nth >= 2 && kin[0] ? kin[0] : roots[h];
    parent = `agent:bench/${p.id.slice(0, 8)}/子`;
    cwd = `${roots[h].cwd}/kid-${nth + 1}`;
  }
  // 作業中と承認待ちは、後ろ（子と孫）から割り当てる
  const fromEnd = SESSIONS - 1 - i;
  const state = fromEnd < RUNNING ? "running" : fromEnd < RUNNING + APPROVAL ? "waiting_permission" : "idle";
  const s: S = { id, kind: "node", title: cwd.split("/").pop()!, cwd, pid: 50000 + i, parent, state, startedAt: T0 + i * 60_000, lastActivityAt: T0 + i * 60_000, capabilities: caps(false) };
  sessions.push(s);
  if (i < HOUSEHOLDS) roots.push(s);
}
const extra = (tag: string, kind: "node" | "pty", n: number, state: string): S => {
  const s: S = { id: `${tag}0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, kind, title: tag, cwd: `${roots[0].cwd}/${tag === "f" ? "flood" : "talk"}`, pid: 60000 + n,
    parent: `agent:bench/${roots[0].id.slice(0, 8)}/子`, state, startedAt: T0 + 3000_000 + n, lastActivityAt: T0 + 3000_000 + n, capabilities: caps(kind === "pty") };
  sessions.push(s);
  return s;
};
const flood = FLOOD_HZ > 0 ? extra("f", "pty", 1, "running") : null;
const talk = TALK > 0 ? extra("e", "node", 2, "idle") : null;

// 長い会話。node のセッションの messages はトランスクリプトの行そのまま（type、message、timestamp）
const md = (k: number) => `## 手順 ${k}\n\n- \`src/App.tsx\` の **${k} 行目** を読んだ\n- 次は [README](https://example.com/${k}) を確かめる\n\n\`\`\`ts\nconst x${k} = ${k};\n\`\`\`\n`;
const messages = Array.from({ length: TALK }, (_, k) => {
  const timestamp = new Date(T0 + k * 1000).toISOString();
  if (k % 3 === 0) return { type: "user", message: { role: "user", content: `依頼 ${k}: この部分を直して、結果を教えて。` }, timestamp };
  if (k % 3 === 1) return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: md(k) }, { type: "tool_use", name: "Read", input: { file_path: `/tmp/bench-town/src/file-${k}.ts` } }] }, timestamp };
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `了解。${"説明の文。".repeat(20)}` }] }, timestamp };
});

const stats: Record<string, number> = {};
const count = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };

const enc = new TextEncoder();
let cols = 120, rows = 40, total = 0;
const subs = new Set<(ev: string, data: string, id?: number) => void>();
if (flood) {
  const chunk = floodChunks(FLOOD_HZ, () => cols);
  setInterval(() => {
    const u = chunk();
    total += u.length;
    const data = JSON.stringify({ b64: Buffer.from(u).toString("base64") });
    for (const f of subs) f("data", data, total);
  }, 1000 / FLOOD_HZ);
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const byId = new Map(sessions.map((s) => [s.id, s]));
Bun.serve({
  port: PORT, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const p = u.pathname.split("/").filter(Boolean);
    if (u.pathname === "/__bench/stats") return json({ since: T0 + 3600_000, stats });
    if (p[0] !== "api") { count("other"); return json({ error: "not found" }, 404); }
    if (p[1] === "peers") { count("peers"); return json([{ name: "bench", url: `http://127.0.0.1:${PORT}`, status: "healthy", self: true }]); }
    if (p[1] !== "sessions") { count("other"); return json({ error: "not found" }, 404); }
    if (!p[2]) {
      count(`sessions.${req.method}`);
      return req.method === "GET" ? json(sessions) : json({ error: "bench のモックでは作らない" }, 400);
    }
    if (p[2] === "stream" && !p[3]) {
      count("sessions.stream");
      if (!STREAM) return json({ error: "not found" }, 404);
      let ping: ReturnType<typeof setInterval>;
      const stream = new ReadableStream({
        start(c) {
          const put = (t: string) => { try { c.enqueue(enc.encode(t)); } catch { clearInterval(ping); } };
          put(`id: 1\nevent: sessions\ndata: ${JSON.stringify(sessions)}\n\n`);
          ping = setInterval(() => put(": ping\n\n"), 15_000);
        },
        cancel() { clearInterval(ping); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
    }
    const s = byId.get(p[2]);
    if (!s) { count("unknown"); return json({ error: "unknown session" }, 404); }
    if (!p[3]) {
      count(`detail.${req.method}`);
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      const pending = s.state === "waiting_permission" ? [{ requestId: `req-${s.id.slice(0, 8)}`, toolName: "Bash", input: { command: "ls -la", description: "一覧を見る" } }] : [];
      return json({ ...s, pending });
    }
    if (p[3] === "messages" && req.method === "GET") {
      count("messages");
      const list = s === talk ? messages : [];
      const after = Number(u.searchParams.get("after") ?? 0) || 0;
      const page = list.slice(after, after + 200);
      return json({ messages: page, next: after + page.length });
    }
    if (p[3] === "terminal" && !p[4]) {
      count("terminal.sse");
      let send!: (ev: string, data: string, id?: number) => void;
      const stream = new ReadableStream({
        start(c) {
          send = (ev, data, id) => { try { c.enqueue(enc.encode(`event: ${ev}\n${id != null ? `id: ${id}\n` : ""}data: ${data}\n\n`)); } catch {} };
          send("size", JSON.stringify({ cols, rows, epoch: "bench" }));
          send("replay", JSON.stringify({ b64: Buffer.from("\x1b[2J\x1b[H bench\r\n").toString("base64") }), total);
          if (s === flood) subs.add(send);
        },
        cancel() { subs.delete(send); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    if (p[3] === "terminal" && p[4] === "input") { count("terminal.input"); return json({ ok: true }); }
    if (p[3] === "terminal" && p[4] === "resize") {
      count("terminal.resize");
      const b = (await req.json()) as { cols: number; rows: number };
      if (s === flood) { cols = b.cols; rows = b.rows; }
      return json({ ok: true, cols: b.cols, rows: b.rows });
    }
    count("other");
    return json({ error: "not found" }, 404);
  },
});
console.log(`ready ${PORT} pid ${process.pid} sessions ${sessions.length}`);
if (flood) console.log(`flood ${flood.id}`);
if (talk) console.log(`talk ${talk.id}`);
