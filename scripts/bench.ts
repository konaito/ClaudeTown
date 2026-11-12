// 軽さの計測（#2）。開発版を場面ごとに起動し、本体と WebKit のプロセスの CPU 時間とメモリを外から ps で測る。
//
//   bun run scripts/bench.ts [--scenes idle,hidden,minimized,terminal,talk,town] [--runs 3（場面ごとの有効な回の数）] [--secs 60] [--label before]
//                            [--renderer webgl|dom] [--letters-kb 56] [--release] [--out docs/perf]
//   bun run scripts/bench.ts --summarize docs/perf/<日付>-<名前>.jsonl   記録から表（.md）だけを作り直す
//
// 場面（どれもモックの ccn（scripts/mock-ccn-town.ts）に繋ぎ、毎回同じ町を出す）
//   idle       4世帯・10人、全員待機。何も選ばない。窓は見えている
//   hidden     idle と同じ町で、窓を隠す（NSWindow の orderOut。別のデスクトップにある、他の窓の裏にあるに近い）
//   minimized  idle と同じ町で、窓を最小化する
//   terminal   idle の町に PTY のセッションを1つ足し、決まった出力を1秒に100かたまり流す。そのターミナルを開く
//   talk       idle の町に、1000件の発言がある node のセッションを足し、チャットの欄で開く（画面に届くのは Rust が残す80件）
//   town       30世帯・100人。作業中20、承認待ち5。何も選ばない
//
// 1回の測り方
//   1. /tmp/ct-dev.lock、/tmp/claudetown-dev.lock の順に mkdir で取る（取れるまで待つ。上限3時間。片方を持ったまま10分取れなければ
//      両方外して取り直す）。1回ごとに取って、逆の順に放し、60秒空けてから次を取る
//   2. HOME を一時のディレクトリにして開発版（bun tauri dev）を起動する。お手紙の記録（letters.jsonl）は決まった大きさで仕込む
//   3. 画面が場面を用意して ready を書いたら、settle 秒待ってから secs 秒のあいだの CPU 時間の差を ps で測る
//   4. 見えているはずの場面で窓が描かれていなかった回（fps が 20 未満、visibilityState が hidden）と、
//      隠したはずの場面で見えていた回は「無効」にして、数字に入れない
//   5. 起動したプロセスの木と、モックだけを pid で止める。1回の起動は10分で打ち切る
// 結果は <out>/<日付>-<label>.jsonl に1回ずつ足し、終わったら同じ名前の .md に場面ごとの中央値と範囲を書く。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(`--${k}`);

const ALL = ["idle", "hidden", "minimized", "terminal", "talk", "town"] as const;
type Scene = (typeof ALL)[number];
const VISIBLE: Scene[] = ["idle", "terminal", "talk", "town"];
const SMALL_TOWN = ["--households", "4", "--sessions", "10"];
const MOCK_ARGS: Record<Scene, string[]> = {
  idle: SMALL_TOWN, hidden: SMALL_TOWN, minimized: SMALL_TOWN,
  terminal: [...SMALL_TOWN, "--flood", "100"],
  talk: [...SMALL_TOWN, "--talk", "1000"],
  town: ["--households", "30", "--sessions", "100", "--running", "20", "--approval", "5"],
};

// 開発版（vite の 1420）と CPU の計測を、ほかのエージェントと分け合うロック。全員この順に mkdir で取り、逆の順に rmdir する。
// FC_DEV_LOCKS（カンマ区切り）で差し替えられる（1つに戻すとき）
const LOCKS = (process.env.FC_DEV_LOCKS || "/tmp/ct-dev.lock,/tmp/claudetown-dev.lock").split(",").map((x) => x.trim()).filter(Boolean);
/** 一部を持ったまま、次が取れずにこれだけたったら、全部外して取り直す */
const PARTIAL_HOLD_MS = 10 * 60_000;
/** ロックを外してから次に取りに行くまでの間（ほかの子が先に取れるように）。FC_LOCK_GAP_S で変えられる */
const LOCK_GAP_MS = Number(process.env.FC_LOCK_GAP_S ?? 60) * 1000;
const LOCK_WAIT_MS = 3 * 3600_000;
const RUN_DEADLINE_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 4 * 60_000;
const VITE_PORT = 1420;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

type Proc = { pid: number; name: string; cpu0: number; cpu1: number; rssMB: number };
type Run = {
  label: string; scene: Scene; round: number; at: string; valid: boolean; reason: string | null;
  build: "debug" | "release"; renderer: string; secs: number; lettersKB: number; town: string;
  procs: Record<string, { cpuSec: number; cpuPct: number; rssMB: number } | null>; totalCpuPct: number | null;
  httpPerMin: Record<string, number>; fps: { ready: number | null; post: number | null }; vis: { ready: string | null; post: string | null; events: unknown[] };
  startupMs: number | null; ipcPerSec: number | null; recompiled: boolean;
};

// ---------- プロセス ----------

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}
/** ps の time（[[dd-]hh:]mm:ss.cc）を秒に */
function cpuSec(pid: number): number | null {
  const t = sh("/bin/ps", ["-o", "time=", "-p", String(pid)]);
  if (!t) return null;
  const [d, rest] = t.includes("-") ? t.split("-") : ["0", t];
  return rest.split(":").map(Number).reduce((a, x) => a * 60 + x, 0) + Number(d) * 86400;
}
const rssMB = (pid: number) => Math.round(Number(sh("/bin/ps", ["-o", "rss=", "-p", String(pid)]) || 0) / 102.4) / 10;
const startedAt = (pid: number) => { const s = sh("/bin/ps", ["-o", "lstart=", "-p", String(pid)]); return s ? Date.parse(s) : NaN; };
const comm = (pid: number) => sh("/bin/ps", ["-o", "comm=", "-p", String(pid)]);
function tree(root: number): number[] {
  const all = [root];
  for (let i = 0; i < all.length; i++) for (const k of sh("/usr/bin/pgrep", ["-P", String(all[i])]).split("\n").filter(Boolean)) all.push(Number(k));
  return all;
}
const webkitPids = () => sh("/usr/bin/pgrep", ["-f", "com.apple.WebKit.(WebContent|GPU|Networking)"]).split("\n").filter(Boolean).map(Number);
const listener = (port: number) => sh("/usr/sbin/lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).split("\n").filter(Boolean).map(Number);
/** 自分が起動したプロセスの木を、子から順に止める。3秒たって残っていれば SIGKILL */
async function killTree(root: number) {
  const pids = tree(root).reverse();
  for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch {} }
  await sleep(3000);
  for (const p of pids) { try { process.kill(p, 0); process.kill(p, "SIGKILL"); } catch {} }
}

// ---------- ロック ----------

const held: string[] = [];
const OWNER = `ct-bench ${process.pid}`;
const tryLock = (l: string) => {
  try { fs.mkdirSync(l); } catch (e: any) { if (e.code !== "EEXIST") throw e; return false; }
  fs.writeFileSync(path.join(l, "owner"), `${OWNER} ${new Date().toTimeString().slice(0, 8)}\n`);
  held.push(l);
  return true;
};
async function lock() {
  const t0 = Date.now();
  let told = 0, partialSince = 0;
  for (;;) {
    while (held.length < LOCKS.length && tryLock(LOCKS[held.length])) partialSince = Date.now();
    if (held.length === LOCKS.length) return;
    if (held.length && Date.now() - partialSince > PARTIAL_HOLD_MS) { console.log(`  ${LOCKS[held.length]} が10分取れないので、持っている分を外して取り直す`); unlock(); }
    if (Date.now() - t0 > LOCK_WAIT_MS) { unlock(); throw new Error(`${LOCKS.join("、")} が3時間取れなかった`); }
    if (Date.now() - told > 300_000) {
      const who = LOCKS.map((l) => { try { return fs.readFileSync(path.join(l, "owner"), "utf8").trim(); } catch { return fs.existsSync(l) ? "?" : "空き"; } });
      console.log(`  ロックを待っている（${Math.round((Date.now() - t0) / 60000)} 分、${LOCKS.map((l, i) => `${path.basename(l)}: ${who[i]}`).join("、")}）`);
      told = Date.now();
    }
    await sleep(15_000);
  }
}
/** 持っているロックを逆の順に外す。owner が自分のものでなければ触らない */
function unlock() {
  while (held.length) {
    const l = held.pop()!;
    try {
      const o = path.join(l, "owner");
      if (fs.readFileSync(o, "utf8").startsWith(OWNER + " ")) { fs.unlinkSync(o); fs.rmdirSync(l); }
      else console.error(`  ${l} の owner が自分ではないので外さない`);
    } catch (e) { console.error(`  ${l} を外せなかった: ${e}`); }
  }
}

// 止められたら、自分のプロセスとロックだけを片付ける
const owned = new Set<ChildProcess>();
async function cleanup() { for (const c of owned) if (c.pid) await killTree(c.pid); owned.clear(); unlock(); }
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { console.log(`\n${sig}。片付けて止める`); cleanup().finally(() => process.exit(130)); });

// ---------- 仕込み ----------

/** お手紙の記録を kb ぶん作る。時刻は24時間前にそろえ、町にお手紙の動きが出ないようにする（画面は直近10分だけ使う） */
function writeLetters(file: string, kb: number) {
  const at = Date.now() - 86400_000;
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < kb * 1024; i++) {
    const l = JSON.stringify({ at: at + i, from: `b${String(i % 97).padStart(7, "0")}`, to: `b${String((i * 7) % 97).padStart(7, "0")}`, fromName: "bench", toName: "bench", summary: `お手紙 ${i}: 進み具合の報告と、次にやることの相談` });
    lines.push(l); size += l.length + 1;
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

async function freePort(from: number) {
  for (let p = from; p < from + 30; p++) if (!listener(p).length) return p;
  throw new Error(`${from} から30個のポートが全部使われている`);
}

/** 子の標準出力に pattern が出るまで待つ */
function waitLine(c: ChildProcess, pattern: RegExp, ms: number): Promise<RegExpMatchArray> {
  return new Promise((ok, ng) => {
    let buf = "";
    const t = setTimeout(() => ng(new Error(`${ms}ms たっても ${pattern} が出なかった: ${buf.slice(-300)}`)), ms);
    c.stdout!.on("data", (d) => { buf += d; const m = buf.match(pattern); if (m) { clearTimeout(t); ok(m); } });
    c.on("exit", (code) => { clearTimeout(t); ng(new Error(`終わった（${code}）: ${buf.slice(-300)}`)); });
  });
}

const readLog = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : []);
async function waitLog(f: string, pred: (o: any) => boolean, ms: number, alive: () => boolean) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = readLog(f).find(pred);
    if (hit) return hit;
    const err = readLog(f).find((o) => o.bench === "error" || (o.bench === "scene" && o.message));
    if (err) throw new Error(`画面の計測が失敗した: ${JSON.stringify(err)}`);
    if (!alive()) throw new Error("開発版が終わった");
    await sleep(500);
  }
  return null;
}

// ---------- 1回 ----------

type Opts = { label: string; secs: number; settle: number; renderer: string; lettersKB: number; release: boolean; work: string };

async function runOnce(scene: Scene, round: number, o: Opts): Promise<Run> {
  const dir = path.join(o.work, `${scene}-${round}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".family-computing"), { recursive: true });
  writeLetters(path.join(home, ".family-computing", "letters.jsonl"), o.lettersKB);
  const perf = path.join(dir, "perf.jsonl");
  const devLog = path.join(dir, "dev.log");
  const run: Run = {
    label: o.label, scene, round, at: new Date().toISOString(), valid: false, reason: null,
    build: o.release ? "release" : "debug", renderer: o.renderer, secs: o.secs, lettersKB: o.lettersKB, town: MOCK_ARGS[scene].join(" "),
    procs: {}, totalCpuPct: null, httpPerMin: {}, fps: { ready: null, post: null }, vis: { ready: null, post: null, events: [] },
    startupMs: null, ipcPerSec: null, recompiled: false,
  };

  // モックの ccn
  const mockPort = await freePort(4470);
  const mock = spawn("bun", ["run", path.join(ROOT, "scripts/mock-ccn-town.ts"), String(mockPort), ...MOCK_ARGS[scene]], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  owned.add(mock);
  let dev: ChildProcess | null = null;
  try {
    await waitLine(mock, /ready \d+ pid \d+/, 15_000);
    await sleep(300);
    if (!listener(mockPort).includes(mock.pid!)) throw new Error(`モックのポート ${mockPort} の持ち主が自分のモック（${mock.pid}）ではない`);
    const sid = scene === "terminal" ? "f0000000-0000-4000-8000-000000000001" : scene === "talk" ? "e0000000-0000-4000-8000-000000000002" : "";

    // 開発版
    if (listener(VITE_PORT).length) throw new Error(`ロックを持っているのに ${VITE_PORT} が使われている（pid ${listener(VITE_PORT).join(",")}）。止めずに中断する`);
    const before = new Set(webkitPids());
    const wait = (o.settle + o.secs) * 1000 + 1500;
    const bench = new URLSearchParams({ bench: "scene", scene, wait: String(wait), ...(sid ? { sid } : {}), ...(o.renderer === "dom" ? { renderer: "dom" } : {}) });
    const realHome = os.homedir();
    const env = {
      ...process.env,
      PATH: `${realHome}/.cargo/bin:${process.env.PATH}`, HOME: home, CARGO_HOME: `${realHome}/.cargo`, RUSTUP_HOME: `${realHome}/.rustup`,
      FC_CCN_URL: `http://127.0.0.1:${mockPort}`, FC_PERF_LOG: perf, FC_BENCH_TOP: "1", VITE_FC_BENCH: bench.toString(),
    };
    const out = fs.openSync(devLog, "w");
    dev = spawn("bun", ["tauri", "dev", ...(o.release ? ["--release"] : [])], { cwd: ROOT, env, stdio: ["ignore", out, out] });
    owned.add(dev);
    const alive = () => dev!.exitCode === null;
    const ready = await waitLog(perf, (x) => x.bench === "scene" && x.ready, READY_TIMEOUT_MS, alive);
    if (!ready) throw new Error("場面の用意ができなかった（ready が来ない）");
    run.recompiled = /Compiling family-computing/.test(fs.readFileSync(devLog, "utf8"));
    const proc = readLog(perf).find((x) => x.bench === "proc");
    if (proc && ready.paintedAt) run.startupMs = ready.paintedAt - proc.procStartMs;
    run.fps.ready = ready.fps; run.vis.ready = ready.vis; run.renderer = ready.renderer ?? o.renderer;

    // 本体は自分が起動した木の中の family-computing。WebKit は前後の差で、本体の起動から15秒以内に始まったもの
    const app = tree(dev.pid!).find((p) => /family-computing$/.test(comm(p)));
    if (!app) throw new Error("本体のプロセスが見つからない");
    const a0 = startedAt(app);
    const fresh = webkitPids().filter((p) => !before.has(p)).filter((p) => { const d = startedAt(p) - a0; return d >= -1000 && d <= 15_000; });
    const kinds: Record<string, number[]> = { WebContent: [], GPU: [], Networking: [] };
    for (const p of fresh) { const k = sh("/bin/ps", ["-o", "command=", "-p", String(p)]).match(/com\.apple\.WebKit\.(WebContent|GPU|Networking)/)?.[1]; if (k) kinds[k].push(p); }
    if (kinds.WebContent.length !== 1 || kinds.GPU.length > 1 || kinds.Networking.length > 1)
      throw new Error(`WebKit のプロセスを決められない（WebContent ${kinds.WebContent.length}、GPU ${kinds.GPU.length}、Networking ${kinds.Networking.length}）`);
    const watch: Record<string, number> = { app, WebContent: kinds.WebContent[0] };
    if (kinds.GPU[0]) watch.GPU = kinds.GPU[0];
    if (kinds.Networking[0]) watch.Networking = kinds.Networking[0];

    await sleep(o.settle * 1000);
    const stats = async () => (await (await fetch(`http://127.0.0.1:${mockPort}/__bench/stats`)).json()).stats as Record<string, number>;
    const s0 = await stats();
    const c0: Record<string, number | null> = {};
    for (const [k, p] of Object.entries(watch)) c0[k] = cpuSec(p);
    const t0 = performance.now();
    await sleep(o.secs * 1000);
    const c1: Record<string, number | null> = {};
    for (const [k, p] of Object.entries(watch)) c1[k] = cpuSec(p);
    const dt = (performance.now() - t0) / 1000;
    const s1 = await stats();
    let total = 0;
    for (const [k, p] of Object.entries(watch)) {
      if (c0[k] == null || c1[k] == null) { run.procs[k] = null; continue; }
      const d = c1[k]! - c0[k]!;
      total += d;
      run.procs[k] = { cpuSec: +d.toFixed(2), cpuPct: +((d / dt) * 100).toFixed(2), rssMB: rssMB(p) };
    }
    run.totalCpuPct = +((total / dt) * 100).toFixed(2);
    for (const k of new Set([...Object.keys(s0), ...Object.keys(s1)])) {
      const d = (s1[k] ?? 0) - (s0[k] ?? 0);
      if (d) run.httpPerMin[k] = +((d * 60) / dt).toFixed(1);
    }

    // 見え方の判定。post は隠れた窓では遅れるので、隠す場面では無くてもよい
    const post = await waitLog(perf, (x) => x.bench === "scene" && x.post, VISIBLE.includes(scene) ? 15_000 : 5_000, alive);
    if (post) { run.fps.post = post.fps; run.vis.post = post.vis; run.vis.events = post.visEvents ?? []; run.ipcPerSec = post.ipcPerSec ?? null; }
    const bad: string[] = [];
    if (VISIBLE.includes(scene)) {
      if (ready.vis !== "visible" || (ready.fps ?? 0) < 20) bad.push(`始めに描かれていない（${ready.vis}、${ready.fps} fps）`);
      if (!post) bad.push("終わりの記録が無い");
      else if (post.vis !== "visible" || (post.fps ?? 0) < 20 || (post.visEvents ?? []).length) bad.push(`途中で描かれなくなった（${post.vis}、${post.fps} fps、見え方の変化 ${(post.visEvents ?? []).length} 回）`);
    } else {
      if (ready.vis !== "hidden") bad.push(`隠れていない（${ready.vis}、${ready.fps} fps）`);
      if (post && post.vis !== "hidden") bad.push(`途中で見えた（${post.vis}）`);
    }
    run.valid = bad.length === 0;
    run.reason = bad.join("。") || null;
  } catch (e) {
    run.valid = false;
    run.reason = String((e as Error).message ?? e);
  } finally {
    if (dev?.pid) await killTree(dev.pid);
    if (dev) owned.delete(dev);
    if (mock.pid) await killTree(mock.pid);
    owned.delete(mock);
    for (let i = 0; i < 20 && listener(VITE_PORT).length; i++) await sleep(500);
  }
  return run;
}

// ---------- 表 ----------

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const cell = (xs: number[], unit = "") => {
  if (!xs.length) return "−";
  const f = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return xs.length === 1 ? `${f(xs[0])}${unit}` : `${f(median(xs))}${unit}（${f(lo)}〜${f(hi)}）`;
};

function summarize(file: string) {
  const runs: Run[] = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const out: string[] = [];
  const first = runs[0];
  out.push(`# 軽さの計測 ${path.basename(file, ".jsonl")}`, "");
  out.push(`\`scripts/bench.ts\` の結果（${path.basename(file)} から作った表）。1回 ${first?.secs ?? "?"} 秒、ビルドは ${[...new Set(runs.map((r) => r.build))].join("、")}、お手紙の記録は ${[...new Set(runs.map((r) => r.lettersKB))].join("、")}KB。`);
  out.push("CPU は1コアに対する割合（ps の CPU 時間の差 ÷ 経過時間）。中央値（最小〜最大）。メモリは測り終えたときの RSS。無効の回は数に入れていない。", "");
  out.push("| 場面 | 有効/回 | 本体 CPU | WebContent CPU | GPU CPU | Networking CPU | 合計 CPU | 本体 RSS | WebContent RSS | GPU RSS | ccn への要求/分 | 起動から町の描画まで |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const scene of ALL) {
    const all = runs.filter((r) => r.scene === scene);
    if (!all.length) continue;
    const ok = all.filter((r) => r.valid);
    const pick = (k: string, f: "cpuPct" | "rssMB") => ok.map((r) => r.procs[k]?.[f]).filter((x): x is number => typeof x === "number");
    const http = ok.map((r) => Object.values(r.httpPerMin).reduce((a, b) => a + b, 0));
    out.push(`| ${scene} | ${ok.length}/${all.length} | ${cell(pick("app", "cpuPct"), "%")} | ${cell(pick("WebContent", "cpuPct"), "%")} | ${cell(pick("GPU", "cpuPct"), "%")} | ${cell(pick("Networking", "cpuPct"), "%")} | ${cell(ok.map((r) => r.totalCpuPct ?? NaN).filter((x) => !isNaN(x)), "%")} | ${cell(pick("app", "rssMB"), "MB")} | ${cell(pick("WebContent", "rssMB"), "MB")} | ${cell(pick("GPU", "rssMB"), "MB")} | ${cell(http)} | ${cell(ok.map((r) => r.startupMs ?? NaN).filter((x) => !isNaN(x)), "ms")} |`);
  }
  out.push("", "## 要求の内訳（有効な回の中央値、1分あたり）", "");
  for (const scene of ALL) {
    const ok = runs.filter((r) => r.scene === scene && r.valid);
    if (!ok.length) continue;
    const keys = [...new Set(ok.flatMap((r) => Object.keys(r.httpPerMin)))].sort();
    out.push(`- ${scene}: ${keys.map((k) => `${k} ${median(ok.map((r) => r.httpPerMin[k] ?? 0))}`).join("、") || "なし"}`);
  }
  const extra = runs.filter((r) => r.scene === "terminal" && r.valid);
  if (extra.length) out.push("", `terminal の描き方: ${[...new Set(extra.map((r) => r.renderer))].join("、")}。画面に届いた IPC は ${cell(extra.map((r) => r.ipcPerSec ?? NaN).filter((x) => !isNaN(x)), " 回/秒")}。`);
  const bad = runs.filter((r) => !r.valid);
  if (bad.length) {
    out.push("", "## 無効にした回", "");
    for (const r of bad) out.push(`- ${r.scene} ${r.round} 回目（${r.at}）: ${r.reason}`);
  }
  const re = runs.filter((r) => r.recompiled).length;
  if (re) out.push("", `Rust を組み直した回が ${re} 回あった（起動の時間が長くなる。CPU の区間には入らない）。`);
  const md = file.replace(/\.jsonl$/, ".md");
  fs.writeFileSync(md, out.join("\n") + "\n");
  console.log(out.join("\n"));
  return md;
}

// ---------- 入口 ----------

if (flag("summarize")) {
  summarize(path.resolve(arg("summarize", "")));
  process.exit(0);
}

const scenes = arg("scenes", ALL.join(",")).split(",").map((s) => s.trim()) as Scene[];
for (const s of scenes) if (!ALL.includes(s)) { console.error(`知らない場面: ${s}（${ALL.join("、")}）`); process.exit(2); }
const o: Opts = {
  label: arg("label", "bench"), secs: Number(arg("secs", "60")), settle: Number(arg("settle", "5")), renderer: arg("renderer", "webgl"),
  lettersKB: Number(arg("letters-kb", "56")), release: flag("release"), work: "",
};
if (o.secs + o.settle > 8 * 60) { console.error("1回10分の決まりに収まらない（secs + settle は8分まで）"); process.exit(2); }
const runs = Number(arg("runs", "3"));
const outDir = path.resolve(ROOT, arg("out", "docs/perf"));
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${today()}-${o.label}.jsonl`);
o.work = fs.mkdtempSync(path.join(os.tmpdir(), `ct-bench-${o.label}-`));
const free = Number(sh("/bin/df", ["-k", "/"]).split("\n")[1]?.split(/\s+/)[3] ?? 0) / 1024 / 1024;
if (free < 30) { console.error(`ディスクの空きが ${free.toFixed(1)}GB。30GB を切っているので測らない`); process.exit(1); }

// Rust はロックの外で先に組んでおく（ロックを持つ時間を短くする）
console.log(`Rust を組む（${o.release ? "release" : "debug"}）`);
const b = spawnSync("cargo", ["build", "--no-default-features", ...(o.release ? ["--release"] : [])], {
  cwd: path.join(ROOT, "src-tauri"), stdio: "inherit", env: { ...process.env, PATH: `${os.homedir()}/.cargo/bin:${process.env.PATH}` },
});
if (b.status !== 0) { console.error("Rust を組めなかった"); process.exit(1); }

// 場面ごとに、記録（同じ日付と label の .jsonl）にある有効な回が runs 回になるまで回す。途中で止めても、続きから再開できる。
// 窓が隠れた回などで無効が続いても終わるように、1回の呼び出しで1場面に回すのは runs の2倍まで
const done = (scene: Scene) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run) : [])
  .filter((r) => r.scene === scene && r.valid).length;
const tries: Record<string, number> = {};
console.log(`場面 ${scenes.join("、")} で、有効な回が ${runs} 回ずつになるまで測る。記録は ${path.relative(ROOT, file)}、作業の場所は ${o.work}`);
for (;;) {
  const todo = scenes.filter((s) => done(s) < runs && (tries[s] ?? 0) < runs * 2);
  if (!todo.length) break;
  for (const scene of todo) {
    const round = (tries[scene] = (tries[scene] ?? 0) + 1);
    await lock();
    let r: Run;
    try {
      const deadline = sleep(RUN_DEADLINE_MS).then(() => { throw new Error("1回10分の締切を過ぎた"); });
      r = await Promise.race([runOnce(scene, round, o), deadline]).catch(async (e) => {
        await cleanup();
        return { scene, round, valid: false, reason: String(e.message ?? e) } as Run;
      });
    } finally {
      unlock();
    }
    fs.appendFileSync(file, JSON.stringify(r) + "\n");
    const p = r.procs ?? {};
    console.log(`${scene} ${round}: ${r.valid ? "有効" : `無効（${r.reason}）`} 本体 ${p.app?.cpuPct ?? "−"}% WebContent ${p.WebContent?.cpuPct ?? "−"}% GPU ${p.GPU?.cpuPct ?? "−"}% 合計 ${r.totalCpuPct ?? "−"}% fps ${r.fps?.ready}/${r.fps?.post}`);
    // 外した直後に自分が取り直すと、待っているほかの子が入れない。間を空けてから次を取る
    if (scenes.some((s) => done(s) < runs && (tries[s] ?? 0) < runs * 2)) await sleep(LOCK_GAP_MS);
  }
}
const md = summarize(file);
console.log(`\n表: ${path.relative(ROOT, md)}`);
