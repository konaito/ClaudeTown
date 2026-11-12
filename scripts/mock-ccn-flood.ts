// ターミナルの描画の負荷を前後で比べるための、決まった出力を流し続けるモックのノード（#8、#9）。
// 本物の claude は毎回出力が違うので、CPU の比較には使わない。ここでは claude の出力中に近い書き換え
// （スピナーの1行の描き直し、入力欄の枠の描き直し、文の追記）を、決まった間隔で流し続ける。
//   bun run scripts/mock-ccn-flood.ts [ポート]          既定 4397。FC_FLOOD_HZ（既定 100）で1秒あたりのかたまりの数を変える
//   FC_CCN_URL=http://127.0.0.1:4397 bun run tauri dev
//   FC_FLOOD_REPLAY=<file.jsonl> を付けると、決まった書き換えの代わりに、scripts/compare-fullscreen.ts が残した本物の claude の出力を
//   記録どおりの間隔で繰り返し流す（#20）
// 口は ccn と同じ形（GET /api/sessions、GET …/terminal の SSE、POST …/terminal/input と resize、GET /api/peers）。セッションは1つだけ
const PORT = Number(process.argv[2] ?? 4397);
const HZ = Number(process.env.FC_FLOOD_HZ ?? 100);
const ID = "f1000000-0000-4000-8000-000000000000";
let cols = 120, rows = 40;
const session = {
  id: ID, kind: "pty", title: "flood", cwd: "/tmp", pid: process.pid, parent: "local", state: "running",
  startedAt: Date.now(), lastActivityAt: Date.now(),
  capabilities: { send: true, permissions: true, interrupt: true, stop: true, events: false, terminal: true },
};
const enc = new TextEncoder();
const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let tick = 0, total = 0;
/** 1かたまり。毎回スピナーの行と入力欄の枠（5行）を描き直し、10回に1回は文を1行足す */
function chunk(): Uint8Array {
  tick++;
  const w = Math.max(20, cols - 2);
  let s = "\x1b[?2026h";
  if (tick % 10 === 0) s += `\x1b[6A\x1b[2K● 行 ${tick / 10}: ${"lorem ipsum dolor sit amet ".repeat(4).slice(0, w - 12)}\r\n\r\n\r\n\r\n\r\n\r\n`;
  s += `\x1b[6A\r\x1b[2K\x1b[38;5;208m${spin[tick % spin.length]}\x1b[0m Working… (${(tick / HZ).toFixed(1)}s · ↓ ${tick * 3} tokens)\r\n`;
  s += `\x1b[2K╭${"─".repeat(w)}╮\r\n\x1b[2K│ ❯ ${" ".repeat(w - 3)}│\r\n\x1b[2K╰${"─".repeat(w)}╯\r\n\x1b[2K  ? for shortcuts\r\n\x1b[2K`;
  s += "\x1b[?2026l";
  return enc.encode(s);
}
const subs = new Set<(ev: string, data: string, id?: number) => void>();
const push = (u: Uint8Array) => {
  total += u.length;
  const data = JSON.stringify({ b64: Buffer.from(u).toString("base64") });
  for (const f of subs) f("data", data, total);
};
const REPLAY = process.env.FC_FLOOD_REPLAY;
if (REPLAY) {
  const recs = (await Bun.file(REPLAY).text()).trim().split("\n").map((l) => JSON.parse(l) as { t: number; b64: string });
  const span = recs[recs.length - 1].t + 1000;
  const loop = () => {
    for (const r of recs) setTimeout(() => push(new Uint8Array(Buffer.from(r.b64, "base64"))), r.t);
    setTimeout(loop, span);
  };
  loop();
} else {
  setInterval(() => push(chunk()), 1000 / HZ);
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
Bun.serve({
  port: PORT, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const p = u.pathname;
    if (p === "/api/peers") return json([{ name: "flood", url: `http://127.0.0.1:${PORT}`, status: "healthy", self: true }]);
    if (p === "/api/sessions" && req.method === "GET") return json([session]);
    if (p === `/api/sessions/${ID}` && req.method === "GET") return json({ ...session, pending: [] });
    if (p === `/api/sessions/${ID}/messages`) return json({ messages: [], next: 0 });
    if (p === `/api/sessions/${ID}/terminal/input`) return json({ ok: true });
    if (p === `/api/sessions/${ID}/terminal/resize`) {
      const b = await req.json() as { cols: number; rows: number };
      cols = b.cols; rows = b.rows;
      return json({ ok: true, cols, rows });
    }
    if (p === `/api/sessions/${ID}/terminal`) {
      let send: (ev: string, data: string, id?: number) => void;
      const stream = new ReadableStream({
        start(c) {
          send = (ev, data, id) => c.enqueue(enc.encode(`event: ${ev}\n${id != null ? `id: ${id}\n` : ""}data: ${data}\n\n`));
          send("size", JSON.stringify({ cols, rows, epoch: "flood" }));
          send("replay", JSON.stringify({ b64: Buffer.from("\x1b[2J\x1b[H flood\r\n").toString("base64") }), total);
          subs.add(send);
        },
        cancel() { subs.delete(send); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    return json({ error: "not found" }, 404);
  },
});
console.log(`flood :${PORT}（${HZ} かたまり/秒）`);
