// 町に同じ状態のキャラを大勢並べ、headless の WebKit（Playwright）で開いたときの CPU 時間を測る（#7）。
// 開発版の窓は、ほかの窓やフルスクリーンの画面に隠れると WebKit が描画を止める（document.visibilityState が hidden になり、
// #6 で CSS のアニメも止まる）。本人が画面を使っている間は、開発版では測れない。headless は隠れないので、いつでも同じ条件で測れる。
//   bun scripts/bench-crowd-webkit.ts <ラベル> <ビルドした dist のディレクトリ> <人数> <state> [回数]
// 要るもの: playwright（webkit）。リポジトリの依存には入れていないので、別のディレクトリに入れて NODE_PATH で渡す。
//   例: NODE_PATH=/tmp/pw/node_modules bun scripts/bench-crowd-webkit.ts anim64 /tmp/dist-64 20 waiting_permission 3
// - dist は ?mock のブラウザ表示（src/bridge.ts）で開き、モック（scripts/mock-ccn-crowd.ts）に繋ぐ。開発版のポート 1420 は使わない
// - 窓は 1440×900、deviceScaleFactor 2（Retina の Mac と同じ）
// - CPU 時間は、WebKit のブラウザのプロセスと、その子孫全部の ps の time の和の差
// - 始める前に、画面に出ている印の数と、document.visibilityState を記録する
import { webkit } from "playwright";
import { spawnSync } from "node:child_process";

const [label, dist, nStr, state = "waiting_permission", runsStr = "3"] = process.argv.slice(2);
const N = Number(nStr), RUNS = Number(runsStr), WIN = Number(process.env.WIN ?? 30), WARM = Number(process.env.WARM ?? 15);
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4396), WEB_PORT = Number(process.env.WEB_PORT ?? 4180);
const OUT = process.env.OUT ?? "/tmp/ct-bench-crowd-webkit.jsonl";
const ROOT = new URL("..", import.meta.url).pathname;
const deadline = Date.now() + 10 * 60_000;

const mock = Bun.spawn(["bun", "run", `${ROOT}scripts/mock-ccn-crowd.ts`, String(MOCK_PORT)], {
  env: { ...process.env, FC_CROWD_N: String(N), FC_CROWD_STATE: state }, stdout: "pipe", stderr: "inherit",
});
// dist を出すだけの静的なサーバー（SPA なので、無いパスは index.html）
const web = Bun.serve({
  port: WEB_PORT, hostname: "127.0.0.1",
  async fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    const f = Bun.file(`${dist}${p === "/" ? "/index.html" : p}`);
    return (await f.exists()) ? new Response(f) : new Response(Bun.file(`${dist}/index.html`));
  },
});

const secs = (t: string) => t.split(":").reduce((a, x) => a * 60 + Number(x), 0);
function treeCpu(root: number): number {
  const rows = spawnSync("ps", ["-A", "-o", "pid=,ppid=,time="]).stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/));
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of rows) kids.set(Number(ppid), [...(kids.get(Number(ppid)) ?? []), Number(pid)]);
  const want = new Set<number>(); const st = [root];
  while (st.length) { const p = st.pop()!; want.add(p); st.push(...(kids.get(p) ?? [])); }
  return rows.filter(([pid]) => want.has(Number(pid))).reduce((a, [, , t]) => a + secs(t), 0);
}

// WebKit の本体（Playwright.app）の pid は、起動前後の差分で取る（launchServer と connect は bun では繋がらなかった）
const pgrep = () => new Set(spawnSync("pgrep", ["-f", "Playwright.app/Contents/MacOS/Playwright"]).stdout.toString().trim().split("\n").filter(Boolean).map(Number));
const before = pgrep();
const browser = await webkit.launch({ headless: true });
const pid = [...pgrep()].find((p) => !before.has(p));
try {
  if (!pid) throw new Error("WebKit の pid が見つからない");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/?mock&mockport=${MOCK_PORT}`);
  await page.waitForSelector(".fc-avatar", { timeout: 30_000 });
  await Bun.sleep(WARM * 1000);
  const seen = await page.evaluate(() => {
    const vis = (el: Element) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && r.width > 0; };
    const marks = [...document.querySelectorAll("img[src*='/sprites/noto/']")];
    return { visibility: document.visibilityState, marks: marks.length, marksInView: marks.filter(vis).length, src: [...new Set(marks.map((m) => (m as HTMLImageElement).src.replace(/^.*\/noto\//, "")))] };
  });
  await page.screenshot({ path: `/tmp/ct-bench-webkit-${label}-${N}-${state}.png` });
  for (let r = 1; r <= RUNS; r++) {
    if (Date.now() + WIN * 1000 > deadline) { console.error("10分の締切で打ち切った"); break; }
    const a = treeCpu(pid);
    await Bun.sleep(WIN * 1000);
    const b = treeCpu(pid);
    const line = JSON.stringify({ label, n: N, state, run: r, win: WIN, webkitCpu: +(b - a).toFixed(2), ...seen });
    console.log(line);
    await Bun.write(OUT, (await Bun.file(OUT).exists() ? await Bun.file(OUT).text() : "") + line + "\n");
  }
} finally {
  await browser.close();
  web.stop(true);
  mock.kill();
}
