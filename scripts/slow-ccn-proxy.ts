// ccn の前に置く、応答を遅らせる中継（#3 の確かめ用）。一覧（GET .../sessions）と会話（.../messages）だけを遅らせ、
// ほか（作成、ターミナルの SSE、入力）はそのまま流す。ccn が遅いときに画面とターミナルの入力が止まらないかを見る。
//   FC_SLOW_MS=3000 bun run scripts/slow-ccn-proxy.ts [ポート]    既定 4398
//   FC_SLOW_EVERY=3 を付けると、一覧と会話の3回に1回だけ遅らせる（ノードがときどき詰まる状態）
//   FC_SLOW_AFTER_S=20 を付けると、起動から20秒たった後は毎回遅らせる（途中から詰まり続ける状態）
//   FC_CCN_URL=http://127.0.0.1:4398 bun run tauri dev
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = process.env.FC_SLOW_TARGET
  ?? `http://127.0.0.1:${JSON.parse(readFileSync(join(homedir(), ".config/ccn/ccn.json"), "utf8")).port}`;
const delay = Number(process.env.FC_SLOW_MS ?? 3000);
const port = Number(process.argv[2] ?? 4398);
const every = Number(process.env.FC_SLOW_EVERY ?? 1);
let count = 0;
const after = process.env.FC_SLOW_AFTER_S ? Date.now() + Number(process.env.FC_SLOW_AFTER_S) * 1000 : null;
const slow = (m: string, p: string) => m === "GET" && (/\/sessions$/.test(p) || /\/messages$/.test(p) || /\/peers$/.test(p));

Bun.serve({
  port, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (slow(req.method, u.pathname) && (after ? Date.now() >= after : ++count % every === 0)) {
      console.log(`${new Date().toISOString()} 遅らせる ${req.method} ${u.pathname}`);
      await Bun.sleep(delay);
    }
    const headers = new Headers(req.headers);
    headers.delete("host");
    return fetch(target + u.pathname + u.search, { method: req.method, headers, body: req.body, redirect: "manual" });
  },
});
console.log(`遅い中継 :${port} → ${target}（${every} 回に1回 ${delay}ms）`);
