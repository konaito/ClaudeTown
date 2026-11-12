// ccn 単体で、ターミナルのセッションを作ってから claude の入力欄（❯）が出るまでを測る（#18 の基準）。
// Claude Town を通さないので、アプリの計測（?bench）と比べると、残りがアプリの中の待ちになる。
//   bun run scripts/bench-ccn-pty.ts [回数]        既定 5 回。作ったセッションは毎回すぐ消す
// 繋ぐ先は FC_CCN_URL か ~/.config/ccn/ccn.json の port。cwd はアプリの「新しい世帯」と同じ ~/Documents/meta
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = process.env.FC_CCN_URL
  ?? `http://127.0.0.1:${JSON.parse(readFileSync(join(homedir(), ".config/ccn/ccn.json"), "utf8")).port}`;
const cwd = process.env.FC_BENCH_CWD ?? join(homedir(), "Documents/meta");
const n = Number(process.argv[2] ?? 5);

async function once(i: number) {
  const t0 = performance.now();
  const r = await fetch(`${base}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminal: true, cwd, cols: 120, rows: 40, name: `bench-ct-term-${i}` }),
  });
  if (!r.ok) throw new Error(`作れなかった ${r.status} ${await r.text()}`);
  const { id } = await r.json() as { id: string };
  const marks: Record<string, number> = { create: performance.now() - t0 };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const es = await fetch(`${base}/api/sessions/${id}/terminal`, { signal: ac.signal });
    marks.sse = performance.now() - t0;
    const reader = es.body!.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "";
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k: number;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = /^event:\s*(.*)$/m.exec(block)?.[1] ?? "";
        const data = /^data:\s*(.*)$/m.exec(block)?.[1] ?? "";
        if (ev === "size") marks.size ??= performance.now() - t0;
        if (ev === "replay" || ev === "data") {
          const b64 = JSON.parse(data).b64 as string | undefined;
          if (b64) {
            marks.firstOutput ??= performance.now() - t0;
            text += Buffer.from(b64, "base64").toString("utf8");
            if (text.includes("❯")) { marks.prompt = performance.now() - t0; break outer; }
          }
        }
      }
    }
    clearTimeout(timer);
    ac.abort();
  } finally {
    await fetch(`${base}/api/sessions/${id}`, { method: "DELETE" });
  }
  return { id, ...Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, Math.round(v)])) };
}

const rows = [];
for (let i = 0; i < n; i++) {
  const row = await once(i);
  console.log(JSON.stringify(row));
  rows.push(row);
  await new Promise((r) => setTimeout(r, 1500));
}
const med = (k: string) => {
  const v = rows.map((r: any) => r[k]).filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
console.log("中央値(ms)", JSON.stringify({ create: med("create"), size: med("size"), firstOutput: med("firstOutput"), prompt: med("prompt") }));
