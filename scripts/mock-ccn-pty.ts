// 開発用のモックのノード。ccn-pty と合意する前の「端末の口」の案（docs/design/terminal-panel.md の A2）を、bun の PTY で真似る。
// Claude Town を FC_CCN_URL=http://127.0.0.1:4399 で起動すると、本物の ccn の代わりにこれへ繋ぐ。
//
//   bun run scripts/mock-ccn-pty.ts            # 端末の中身は bash（安全）
//   FC_MOCK_CMD=claude bun run scripts/mock-ccn-pty.ts   # 端末の中身を claude の対話モードにする
//
// 口（案）:
//   GET  /api/sessions                         一覧（kind=pty、capabilities.terminal、parent、name、state）
//   GET  /api/sessions/<id>                    詳細（pending は空）
//   POST /api/sessions                         { terminal: true, cwd, prompt?, name?, cols?, rows? }。親はヘッダ x-ccn-from: agent:<node>/<sid8>/<役割>
//   GET  /api/sessions/<id>/terminal           SSE。size → replay {b64}（64KB ごと）→ data {b64} … → exit {code, reason}。id: は末尾のバイト位置。?after=<位置> で再開
//   POST /api/sessions/<id>/terminal/input     { data: base64 }
//   POST /api/sessions/<id>/terminal/resize    { cols, rows }
//   DELETE /api/sessions/<id>                  止める
//   GET  /api/peers                            自分だけ

const PORT = Number(process.env.FC_MOCK_PORT ?? 4399);
const CMD = process.env.FC_MOCK_CMD === "claude" ? ["claude"] : ["bash", "--noprofile", "--norc", "-i"];
const TAIL = 2 * 1024 * 1024;

type Sess = {
  id: string; name: string; cwd: string; parent: string | null; startedAt: number; cols: number; rows: number;
  proc: ReturnType<typeof Bun.spawn>; buf: Uint8Array[]; bufLen: number; total: number; subs: Set<(ev: string, data: string, id?: number) => void>; exited?: number;
};
const sessions = new Map<string, Sess>();
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

function start(o: { cwd: string; prompt?: string; parent?: string | null; name?: string; cols?: number; rows?: number }): Sess {
  const id = crypto.randomUUID();
  const env = { ...process.env } as Record<string, string>;
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE" || k === "CLAUDE_PID") delete env[k];
  env.PS1 = `${o.name ?? "mock"}$ `;
  const cmd = CMD[0] === "claude" ? ["claude", "--session-id", id, ...(o.prompt ? [o.prompt] : [])] : CMD;
  const s: Sess = {
    id, name: o.name ?? `mock-${id.slice(0, 4)}`, cwd: o.cwd, parent: o.parent ?? null, startedAt: Date.now(),
    cols: o.cols ?? 120, rows: o.rows ?? 40, buf: [], bufLen: 0, total: 0, subs: new Set(), proc: undefined as never,
  };
  s.proc = Bun.spawn(cmd, {
    cwd: o.cwd, env,
    terminal: {
      cols: s.cols, rows: s.rows,
      data(_t, d) {
        const u = new Uint8Array(d);
        s.buf.push(u); s.bufLen += u.length; s.total += u.length;
        while (s.bufLen > TAIL && s.buf.length > 1) s.bufLen -= s.buf.shift()!.length;
        for (const f of s.subs) f("data", JSON.stringify({ b64: b64(u) }), s.total);
      },
    },
  });
  s.proc.exited.then((code) => { s.exited = code; for (const f of s.subs) f("exit", JSON.stringify({ code, reason: "exited" })); });
  if (CMD[0] !== "claude" && o.prompt) setTimeout(() => s.proc.terminal?.write(`echo ${JSON.stringify(o.prompt)}\n`), 300);
  sessions.set(id, s);
  return s;
}

const summary = (s: Sess) => ({
  id: s.id, kind: "pty", title: s.name, cwd: s.cwd, pid: s.proc?.pid,
  parent: s.parent ?? "local",
  state: s.exited !== undefined ? "exited" : "idle", startedAt: s.startedAt, lastActivityAt: s.startedAt,
  capabilities: { send: true, permissions: true, interrupt: true, stop: true, events: false, terminal: true },
});

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-ccn-from", "access-control-allow-methods": "GET, POST, DELETE" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...CORS } });

Bun.serve({
  port: PORT, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.split("/").filter(Boolean);
    if (p[0] !== "api") return json({ error: "not found" }, 404);
    if (p[1] === "peers") return json([{ name: "mock", url: `http://127.0.0.1:${PORT}`, status: "healthy", self: true }]);
    if (p[1] !== "sessions") return json({ error: "not found" }, 404);
    const s = p[2] ? sessions.get(p[2]) : undefined;
    if (!p[2] && req.method === "GET") return json([...sessions.values()].map(summary));
    if (!p[2] && req.method === "POST") {
      const b = (await req.json()) as Record<string, unknown>;
      if (!b.terminal) return json({ error: "mock は terminal: true だけ" }, 400);
      const from = req.headers.get("x-ccn-from");
      const n = start({ cwd: String(b.cwd ?? process.env.HOME), prompt: b.prompt as string | undefined, parent: from, name: b.name as string | undefined, cols: b.cols as number, rows: b.rows as number });
      return json({ ...summary(n), parent: from ?? "local" }, 201);
    }
    if (!s) return json({ error: "unknown session" }, 404);
    if (!p[3] && req.method === "GET") return json({ ...summary(s), pending: [] });
    if (!p[3] && req.method === "DELETE") { s.proc.kill(9); return new Response(null, { status: 204, headers: CORS }); }
    if (p[3] === "teleport" && req.method === "GET") return json({ id: s.id, kind: "pty", state: "idle", live: true, title: s.name, from: { node: "mock", cwd: s.cwd, lobby: false }, git: null });
    if (p[3] === "teleport" && req.method === "POST") { await Bun.sleep(1500); return json({ id: crypto.randomUUID(), cwd: s.cwd, cloned: false, node: "vm", sourceNode: "mock", sourceId: s.id, fork: false }); }
    if (p[3] === "terminal" && !p[4] && req.method === "GET") {
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const enc = new TextEncoder();
      const send = (ev: string, data: string, id?: number) => { try { ctl.enqueue(enc.encode(`${id !== undefined ? `id: ${id}\n` : ""}event: ${ev}\ndata: ${data}\n\n`)); } catch {} };
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          send("size", JSON.stringify({ cols: s.cols, rows: s.rows }));
          const all = new Uint8Array(s.bufLen); let o = 0; for (const u of s.buf) { all.set(u, o); o += u.length; }
          const after = Number(url.searchParams.get("after") ?? NaN);
          const start0 = s.total - s.bufLen;
          if (Number.isFinite(after) && after >= start0 && after <= s.total) {
            if (after < s.total) send("data", JSON.stringify({ b64: b64(all.subarray(after - start0)) }), s.total);
          } else {
            for (let i = 0; i < all.length || i === 0; i += 64 * 1024) {
              const part = all.subarray(i, i + 64 * 1024);
              send("replay", JSON.stringify({ b64: b64(part) }), start0 + i + part.length);
              if (!all.length) break;
            }
          }
          if (s.exited !== undefined) send("exit", JSON.stringify({ code: s.exited, reason: "exited" }));
          s.subs.add(send);
        },
        cancel() { s.subs.delete(send); },
      });
      const ping = setInterval(() => send("ping", "{}"), 15000);
      req.signal.addEventListener("abort", () => { clearInterval(ping); s.subs.delete(send); });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS } });
    }
    if (p[3] === "terminal" && p[4] === "input" && req.method === "POST") {
      const b = (await req.json()) as { data?: string; text?: string };
      s.proc.terminal?.write(b.data !== undefined ? Buffer.from(b.data, "base64") : (b.text ?? ""));
      return json({ ok: true });
    }
    if (p[3] === "terminal" && p[4] === "resize" && req.method === "POST") {
      const b = (await req.json()) as { cols: number; rows: number };
      s.cols = b.cols; s.rows = b.rows; s.proc.terminal?.resize(b.cols, b.rows);
      for (const f of s.subs) f("size", JSON.stringify({ cols: s.cols, rows: s.rows }));
      return json({ ok: true });
    }
    if (p[3] === "messages" && req.method === "POST") {
      const b = (await req.json()) as { text: string };
      s.proc.terminal?.write(b.text + "\r");
      return json({ delivered: "pty" });
    }
    if (p[3] === "messages" && req.method === "GET") return json({ messages: [] });
    return json({ error: "not found" }, 404);
  },
});
console.log(`mock-ccn-pty: http://127.0.0.1:${PORT}（中身: ${CMD.join(" ")}）`);
