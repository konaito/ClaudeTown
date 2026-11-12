// ccn の前に置く、ネットが切れた状態を作る中継（オフラインのキャッシュの確かめ用、src-tauri/src/offline.rs）。
// 切り替えのファイル（既定 /tmp/fc-offline）がある間は、ネットが切れたときの手元のノードと同じに振る舞う:
// 別の機械への中継（/api/n/... と /n/...）は 502、peers（Cloudflare の API から引く）は 503 を返す。手元の町はそのまま流す。
// 切り替えのファイルの中身が all なら、手元の分も含めて全部を 502 にする（手元のノードが落ちた状態）。
//   bun run scripts/offline-ccn-proxy.ts [ポート]     既定 4397
//   FC_CCN_URL=http://127.0.0.1:4397 FC_APP_HOME=$(mktemp -d) bun run tauri dev
//   touch /tmp/fc-offline で切る。echo all > /tmp/fc-offline で全部切る。rm /tmp/fc-offline で戻す
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = process.env.FC_OFFLINE_TARGET
  ?? `http://127.0.0.1:${JSON.parse(readFileSync(join(homedir(), ".config/ccn/ccn.json"), "utf8")).port}`;
const port = Number(process.argv[2] ?? 4397);
const flag = process.env.FC_OFFLINE_FLAG ?? "/tmp/fc-offline";
const mode = () => { try { return readFileSync(flag, "utf8").trim() === "all" ? "all" : "remote"; } catch { return null; } };

const remote = (p: string) => p.startsWith("/n/") || p === "/api/peers";

Bun.serve({
  port, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const m = mode();
    if (m && (m === "all" || remote(u.pathname))) {
      console.log(`${new Date().toISOString()} 切れている ${req.method} ${u.pathname}`);
      const peer = u.pathname.split("/")[2];
      return Response.json(u.pathname === "/api/peers" ? { error: "registry unreachable" } : { error: `peer ${peer} unreachable: fetch failed`, peer },
        { status: u.pathname === "/api/peers" ? 503 : 502 });
    }
    const headers = new Headers(req.headers);
    headers.delete("host");
    return fetch(target + u.pathname + u.search, { method: req.method, headers, body: req.body, redirect: "manual" });
  },
});
console.log(`切れる中継 :${port} → ${target}（${flag} があると別の機械と peers を、中身が all なら全部を断る）`);
