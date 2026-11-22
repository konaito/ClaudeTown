// 町に同じ状態のキャラを大勢並べ、headless の WebKit（Playwright）で開いたときの CPU 時間を測る（#7、#12）。
// 開発版の窓は、ほかの窓やフルスクリーンの画面に隠れると WebKit が描画を止める。headless は隠れないので、いつでも同じ条件で測れる。
//   bun scripts/bench-crowd-webkit.ts <ラベル> <ビルドした dist のディレクトリ> <人数> <state> [回数]
//   state は running（作業中）、waiting_permission（承認待ち）、idle（待機）
//   例: NODE_PATH=/tmp/pw-bench/node_modules bun scripts/bench-crowd-webkit.ts after 'dist' 20 running 2
//
// 要るもの（リポジトリの依存には入れていない。別のディレクトリに入れて NODE_PATH で渡す）
//   mkdir /tmp/pw-bench && cd /tmp/pw-bench && bun add playwright-core && bunx playwright-core install webkit
//   playwright-core は Apache-2.0。WebKit は約 320MB（~/Library/Caches/ms-playwright/webkit-<版> に入る）。
//   `bunx playwright install webkit` でも入る。入っていないと webkit.launch が失敗し、この script は段の名前つきで落ちる。
//
// 仕組み
// - dist は `bun run build` の出力。Tauri の外で PROD で開くと、bridge.ts は同じオリジンの /api/sessions（ccn の口の形）を読む。
//   この script は、dist を出す静的なサーバーと、その /api/sessions を返すモックを1つのポートで動かす。別のモックのプロセスは要らない。
//   （#131 で ?mock と scripts/mock-ccn-crowd.ts を消したので、2026-11-22 までの手順では町が出ず、.fc-avatar を待って落ちていた）
// - 窓は 1440×900、deviceScaleFactor 2（Retina の Mac と同じ）。VW と VH で変えられる
// - CPU 時間は、起動後に現れた Playwright の WebKit のプロセス（UI、WebContent、GPU、Networking）ごとの ps の time の差
// - 段ごとに、始めからの経過秒を [bench +12.3s] で標準エラーに出す。止まったときは、最後の段が止まった箇所になる
// - 全体の締切は DEADLINE_MIN 分（既定 10）。段ごとの待ちにも上限を付け、超えたらその段の名前で落ちる
import { webkit } from "playwright-core";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [label, distArg, nStr, state = "running", runsStr = "3"] = process.argv.slice(2);
if (!label || !distArg || !nStr) { console.error("使い方: bun scripts/bench-crowd-webkit.ts <ラベル> <dist> <人数> <state> [回数]"); process.exit(2); }
const dist = resolve(distArg);
const N = Number(nStr), RUNS = Number(runsStr), WIN = Number(process.env.WIN ?? 30), WARM = Number(process.env.WARM ?? 15);
const VW = Number(process.env.VW ?? 1440), VH = Number(process.env.VH ?? 900);
const PORT = Number(process.env.WEB_PORT ?? 4180), HOUSE = Math.max(1, Number(process.env.HOUSE ?? 5));
const OUT = process.env.OUT ?? "/tmp/ct-bench-crowd-webkit.jsonl";
const T0 = Date.now();
const deadline = T0 + Number(process.env.DEADLINE_MIN ?? 10) * 60_000;
const stage = (s: string) => console.error(`[bench +${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`);
/** 段ごとの待ちの上限つき。超えたら段の名前で落ちる */
const within = <T>(name: string, ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`段「${name}」が ${ms / 1000} 秒で終わらない`)), ms))]);

// 町のモック。口は ccn と同じ形（GET /api/sessions）。1人目が親で、残りの HOUSE-1 人はその子
const t0 = Date.now();
const sessions = Array.from({ length: N }, (_, i) => {
  const id = `c${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`;
  const root = i - (i % HOUSE);
  const parent = i === root ? "local" : `agent:mock/c${String(root).padStart(7, "0")}/crowd`;
  return {
    id, kind: "pty", title: `crowd-${i}`, cwd: `/tmp/crowd-${i}`, pid: process.pid, parent, state: state === "working" ? "running" : state,
    startedAt: t0 + i, lastActivityAt: t0 + i,
    capabilities: { send: true, permissions: true, interrupt: true, stop: false, events: false, terminal: false },
  };
});
const pending = state === "waiting_permission" ? [{ id: "p1", tool: "Bash", summary: "ls", detail: "ls" }] : [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const web = Bun.serve({
  port: PORT, hostname: "127.0.0.1",
  async fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    if (p.startsWith("/api/")) {
      const seg = p.split("/").filter(Boolean);
      if (seg[1] === "sessions" && req.method === "GET") {
        if (!seg[2]) return json(sessions);
        const s = sessions.find((x) => x.id === seg[2]);
        if (!s) return json({ error: "unknown session" }, 404);
        if (!seg[3]) return json({ ...s, pending });
        if (seg[3] === "messages") return json({ messages: [], next: 0 });
      }
      return json({ error: "not found" }, 404);
    }
    const f = Bun.file(`${dist}${p === "/" ? "/index.html" : p}`);
    return (await f.exists()) ? new Response(f) : new Response(Bun.file(`${dist}/index.html`)); // SPA
  },
});
stage(`サーバー起動 http://127.0.0.1:${PORT} dist=${dist} n=${N} state=${state}`);

const secs = (t: string) => t.split(":").reduce((a, x) => a * 60 + Number(x), 0);
type Proc = { pid: number; time: number; rss: number; cmd: string };
/** Playwright の WebKit のプロセス。WebContent などは launchd の子（ppid 1）として立つので、親子では辿れない */
function wkProcs(): Proc[] {
  return spawnSync("ps", ["-A", "-o", "pid=,time=,rss=,command="]).stdout.toString().trim().split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m && m[4].includes("ms-playwright/webkit"))
    .map((m) => ({ pid: Number(m[1]), time: secs(m[2]), rss: Number(m[3]), cmd: m[4] }));
}
const kind = (cmd: string) => /WebContent/.test(cmd) ? "webcontent" : /\.GPU/.test(cmd) ? "gpu" : /Networking/.test(cmd) ? "net" : /Playwright\.app/.test(cmd) ? "ui" : "other";

// 起動前からいた分（別の計測の残りなど）は数えない
const before = new Set(wkProcs().map((p) => p.pid));
let browser: Awaited<ReturnType<typeof webkit.launch>> | undefined;
const mine = () => wkProcs().filter((p) => !before.has(p.pid));
try {
  stage("WebKit 起動");
  browser = await within("WebKit 起動", 60_000, webkit.launch({ headless: true }));
  stage("WebKit 起動済み");
  if (!mine().some((p) => kind(p.cmd) === "ui")) throw new Error("WebKit の UI プロセスが見つからない");
  const page = await within("newPage", 30_000, browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 }));
  page.on("pageerror", (e) => stage(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") stage(`console.error: ${m.text().slice(0, 200)}`); });
  stage("goto");
  await within("goto", 30_000, page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" }));
  stage("画面の読み込み済み。.fc-avatar を待つ");
  await page.waitForSelector(".fc-avatar", { timeout: 30_000 });
  stage(`.fc-avatar が出た。${WARM}秒ならす`);
  await Bun.sleep(WARM * 1000);
  const seen = await page.evaluate(() => {
    const vis = (el: Element) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && r.width > 0; };
    const cards = [...document.querySelectorAll(".fnode")];
    return { visibility: document.visibilityState, cards: cards.length, cardsInView: cards.filter(vis).length, offscreenMarked: cards.filter((c) => c.hasAttribute("data-offscreen")).length };
  });
  stage(`ならし済み ${JSON.stringify(seen)}`);
  await page.screenshot({ path: `/tmp/ct-bench-webkit-${label}-${N}-${state}.png` });
  for (let r = 1; r <= RUNS; r++) {
    if (Date.now() + WIN * 1000 > deadline) { console.error("締切で打ち切った"); break; }
    const a = new Map(mine().map((p) => [p.pid, p.time]));
    await Bun.sleep(WIN * 1000);
    const now = mine();
    const cpu: Record<string, number> = { ui: 0, webcontent: 0, gpu: 0, net: 0, other: 0 };
    for (const p of now) if (a.has(p.pid)) cpu[kind(p.cmd)] += p.time - a.get(p.pid)!;
    const total = Object.values(cpu).reduce((x, y) => x + y, 0);
    const rssWebContentMB = Math.round(now.filter((p) => kind(p.cmd) === "webcontent").reduce((x, p) => x + p.rss, 0) / 1024);
    const line = JSON.stringify({ label, n: N, state, vw: VW, vh: VH, run: r, win: WIN, total: +total.toFixed(2), ...Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, +v.toFixed(2)])), rssWebContentMB, procs: now.length, ...seen });
    console.log(line);
    await Bun.write(OUT, (await Bun.file(OUT).exists() ? await Bun.file(OUT).text() : "") + line + "\n");
  }
  stage("終わり");
} finally {
  await browser?.close().catch(() => {});
  web.stop(true);
}
