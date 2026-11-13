// 町に同じ状態のキャラを大勢並べるだけのモックのノード（#7 の状態の印の CPU の比較）。端末（PTY）は起こさない。
//   bun run scripts/mock-ccn-crowd.ts [ポート]        既定 4396
//   FC_CROWD_N        人数（既定 20）
//   FC_CROWD_STATE    全員の state（既定 waiting_permission。印なしの対照は idle）
//   FC_CROWD_HOUSE    1世帯の人数（既定 5。1人目が親で、残りはその子）
//   FC_CCN_URL=http://127.0.0.1:4396 FC_APP_HOME=$(mktemp -d) bun tauri dev
// 口は ccn と同じ形（GET /api/peers、GET /api/sessions、GET /api/sessions/<id>）。書き込みの口は持たない
const PORT = Number(process.argv[2] ?? 4396);
const N = Number(process.env.FC_CROWD_N ?? 20);
const STATE = process.env.FC_CROWD_STATE ?? "waiting_permission";
const HOUSE = Math.max(1, Number(process.env.FC_CROWD_HOUSE ?? 5));
const t0 = Date.now();

const sessions = Array.from({ length: N }, (_, i) => {
  const id = `c${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`;
  const root = i - (i % HOUSE);
  const parent = i === root ? "local" : `agent:mock/c${String(root).padStart(7, "0")}/crowd`;
  return {
    id, kind: "pty", title: `crowd-${i}`, cwd: `/tmp/crowd-${i}`, pid: process.pid, parent, state: STATE,
    startedAt: t0 + i, lastActivityAt: t0 + i,
    capabilities: { send: true, permissions: true, interrupt: true, stop: false, events: false, terminal: false },
  };
});
const pending = STATE === "waiting_permission" ? [{ id: "p1", tool: "Bash", summary: "ls", detail: "ls" }] : [];

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
Bun.serve({
  port: PORT, hostname: "127.0.0.1",
  fetch(req) {
    const p = new URL(req.url).pathname.split("/").filter(Boolean);
    if (p[0] !== "api") return json({ error: "not found" }, 404);
    if (p[1] === "peers") return json([{ name: "mock", url: `http://127.0.0.1:${PORT}`, status: "healthy", self: true }]);
    if (p[1] !== "sessions" || req.method !== "GET") return json({ error: "not found" }, 404);
    if (!p[2]) return json(sessions);
    const s = sessions.find((x) => x.id === p[2]);
    if (!s) return json({ error: "unknown session" }, 404);
    if (!p[3]) return json({ ...s, pending });
    if (p[3] === "messages") return json({ messages: [], next: 0 });
    return json({ error: "not found" }, 404);
  },
});
console.log(`mock-ccn-crowd ready pid=${process.pid} port=${PORT} n=${N} state=${STATE}`);
