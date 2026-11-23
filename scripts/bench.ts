// 軽さの計測（#2）。開発版を場面ごとに起動し、本体と WebKit のプロセスの CPU 時間とメモリを外から ps で測る。
//
//   bun run scripts/bench.ts [--scenes idle,hidden,minimized,terminal,talk,town] [--runs 3（場面ごとの有効な回の数）] [--secs 60] [--label before]
//                            [--max-tries 9（1場面に試す回数の上限。既定は runs の3倍）]
//                            [--renderer webgl|dom] [--letters-kb 56] [--release] [--out docs/perf]
//   bun run scripts/bench.ts --summarize docs/perf/<日付>-<名前>.jsonl   記録から表（.md）だけを作り直す
//   bun run scripts/bench.ts --town-check   場面ごとの町を作り、開発版の Rust（--native-list、--snapshot）で件数だけ確かめる。ロックも窓も使わない
//
// 場面（どれも合成の ~/.claude（scripts/bench-town.ts、FC_CLAUDE_HOME）で、毎回同じ町を出す。#187 でモックの ccn から移した）
//   idle       4世帯・10人、全員待機。何も選ばない。窓は見えている
//   hidden     idle と同じ町で、窓を隠す（NSWindow の orderOut。別のデスクトップにある、他の窓の裏にあるに近い）
//   minimized  idle と同じ町で、窓を最小化する
//   terminal   idle の町に、開発版が PTY で立てたセッションを1つ足す。claude の代わりに scripts/bench-flood-claude.ts（FC_CLAUDE_BIN）が
//              決まった出力を1秒に100かたまり流す。そのターミナルを開く
//   talk       idle の町に、1000件の発言がある子のセッションを足し、チャットの欄で開く（画面に届くのは Rust が残す80件）
//   town       30世帯・100人。作業中20、承認待ち5。何も選ばない
//   startup    起動の時間（#187、#16）。既定の場面には入らず、--scenes startup で選ぶ。idle と同じ町で起動し、CPU は測らない。
//              Rust の run() の入口から、画面の読み込み開始、窓の最初の描画、町の最初の描画までの時間と、起動の10秒後の RSS を取る。
//              区間の定義は scripts/lib/startup.ts と docs/perf/README.md にある
//
// 1回の測り方
//   1. ~/.local/bin/ct-lock の列に並んでロックを取る（来た順。上限3時間）。1回ごとに取って放し、次の回はまた列の後ろに並ぶ
//   2. 合成の ~/.claude（FC_CLAUDE_HOME）、hook が書くものの置き場所（FC_STATE_DIR、FC_LETTERS、FC_PERM_DIR）、アプリの分（FC_APP_HOME）を一時の場所にして
//      開発版（bun tauri dev）を起動する。HOME は分けない（README の「子が開発版で確かめるとき」）。お手紙の記録（letters.jsonl）は決まった大きさで仕込む
//   3. 画面が場面を用意して ready を書いたら、settle 秒待ってから secs 秒のあいだの CPU 時間の差を ps で測る
//   4. 見えているはずの場面で窓が描かれていなかった回（fps が 20 未満、visibilityState が hidden）と、
//      隠したはずの場面で見えていた回は「無効」にして、数字に入れない
//   5. 起動したプロセスの木と、町の sleep だけを pid で止める。1回の起動は10分で打ち切る
// 結果は <out>/<日付>-<label>.jsonl に1回ずつ足し、終わったら同じ名前の .md に場面ごとの中央値と範囲を書く。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTown, stopHolders, TOWN_DEFAULTS, type TownOpts } from "./bench-town";
import { startupSpans, type StartupSpans } from "./lib/startup";

const ROOT = path.resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(`--${k}`);

const ALL = ["idle", "hidden", "minimized", "terminal", "talk", "town", "startup"] as const;
type Scene = (typeof ALL)[number];
/** --scenes を付けないときに回す場面。startup は CPU を測らないので入れない（既存の6場面の手順と所要時間を変えない） */
const DEFAULT_SCENES: Scene[] = ["idle", "hidden", "minimized", "terminal", "talk", "town"];
const VISIBLE: Scene[] = ["idle", "terminal", "talk", "town", "startup"];
// 町の形は旧モック（mock-ccn-town.ts）の引数のまま残す。記録の town に同じ文字列が入り、過去の記録と並べられる
const SMALL_TOWN = ["--households", "4", "--sessions", "10"];
const MOCK_ARGS: Record<Scene, string[]> = {
  idle: SMALL_TOWN, hidden: SMALL_TOWN, minimized: SMALL_TOWN, startup: SMALL_TOWN,
  terminal: [...SMALL_TOWN, "--flood", "100"],
  talk: [...SMALL_TOWN, "--talk", "1000"],
  town: ["--households", "30", "--sessions", "100", "--running", "20", "--approval", "5"],
};
/** MOCK_ARGS を bench-town.ts の形に。--flood は町に書かず、開発版が代役の claude で立てる */
function townOpts(scene: Scene): TownOpts & { flood: number } {
  const a = MOCK_ARGS[scene];
  const n = (k: string, d: number) => { const i = a.indexOf(`--${k}`); return i >= 0 ? Number(a[i + 1]) : d; };
  return { households: n("households", TOWN_DEFAULTS.households), sessions: n("sessions", TOWN_DEFAULTS.sessions), running: n("running", 0), approval: n("approval", 0), talk: n("talk", 0), flood: n("flood", 0) };
}
/** terminal の場面で、代役の claude を立てる場所。旧モックの flood のセッションと同じく、先頭の世帯の下 */
const FLOOD_CWD = "/tmp/bench-town/house-1/flood";

// 開発版（vite の 1420）と CPU の計測を、ほかのエージェントと分け合うロック。来た順に渡す ~/.local/bin/ct-lock を通す
// （中で /tmp/ct-dev.lock → /tmp/claudetown-dev.lock の順に mkdir する）。FC_CT_LOCK で道具の場所を変えられる
const CT_LOCK = process.env.FC_CT_LOCK || path.join(os.homedir(), ".local/bin/ct-lock");
const LOCK_NAME = "ct-bench";
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
  startupMs: number | null; ipcPerSec: number | null; recompiled: boolean; front: string[];
  /** 町の出どころ。native は合成の ~/.claude（#187 から）。無いのはモックの ccn のころの記録 */
  source?: "native";
  /** startup の場面だけ。Rust の run() の入口からの時間（scripts/lib/startup.ts）と、起動の10秒後の RSS */
  boot?: StartupSpans & { rssAppMB10s: number | null; rssWebContentMB10s: number | null };
};
/** startup の場面で RSS を取る時点（Rust の起動から）。2026-11-13 の bench-startup.sh と同じ10秒 */
const BOOT_RSS_AFTER_MS = 10_000;

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
/** 前面のアプリの名前（窓が隠れた回の原因を見るため） */
const frontApp = () => sh("/usr/bin/lsappinfo", ["info", "-only", "name", sh("/usr/bin/lsappinfo", ["front"])]).match(/"([^"]*)"/)?.[1] ?? "?";
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

let held = false;
let waiting: ChildProcess | null = null;
/** ct-lock の列に並び、取れるまで待つ（上限3時間） */
async function lock() {
  if (!fs.existsSync(CT_LOCK)) throw new Error(`${CT_LOCK} が無い`);
  const t0 = Date.now();
  const tick = setInterval(() => console.log(`  ロックの列で待っている（${Math.round((Date.now() - t0) / 60000)} 分）`), 300_000);
  try {
    const code = await new Promise<number | null>((ok) => {
      waiting = spawn(CT_LOCK, ["acquire", LOCK_NAME, String(LOCK_WAIT_MS / 1000)], { stdio: ["ignore", "inherit", "inherit"] });
      waiting.on("exit", (c) => ok(c));
    });
    if (code !== 0) throw new Error(`ct-lock で取れなかった（${code}）`);
    held = true;
  } finally {
    clearInterval(tick);
    waiting = null;
  }
}
function unlock() {
  if (waiting) { try { waiting.kill("SIGTERM"); } catch {} }
  if (!held) return;
  spawnSync(CT_LOCK, ["release", LOCK_NAME], { stdio: "inherit" });
  held = false;
}

// 止められたら、自分のプロセス（開発版の木と、町の sleep）とロックだけを片付ける
const owned = new Set<ChildProcess>();
const holding = new Set<number>();
async function cleanup() { for (const c of owned) if (c.pid) await killTree(c.pid); owned.clear(); stopHolders([...holding]); holding.clear(); unlock(); }
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

/** 1回ぶんの置き場所を作る。合成の ~/.claude、~/.family-computing の代わり、アプリの分、代役の claude */
function prepare(dir: string, scene: Scene, lettersKB: number) {
  fs.rmSync(dir, { recursive: true, force: true });
  const claudeHome = path.join(dir, "claude");
  const shared = path.join(dir, "shared");
  const appHome = path.join(dir, "app");
  for (const d of [claudeHome, shared, appHome]) fs.mkdirSync(d, { recursive: true });
  writeLetters(path.join(shared, "letters.jsonl"), lettersKB);
  const t = townOpts(scene);
  const town = buildTown(claudeHome, t);
  // 代役の claude。開発版は PTY の中でログインシェルの PATH で起動するので、bun を絶対パスで呼ぶ
  const standIn = path.join(dir, "claude-stand-in.sh");
  fs.writeFileSync(standIn, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "scripts/bench-flood-claude.ts")}" "$@"\n`, { mode: 0o755 });
  if (t.flood) fs.mkdirSync(FLOOD_CWD, { recursive: true });
  return { claudeHome, shared, appHome, standIn, town, flood: t.flood };
}

/** 開発版に渡す環境。HOME は分けず、読む先と書く先を一時の場所に向ける */
function benchEnv(p: ReturnType<typeof prepare>, extra: Record<string, string>) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${os.homedir()}/.cargo/bin:${process.env.PATH}`,
    // hook と同じ変数で、state/、letters.jsonl、perm/ を一時の場所に向ける（本物の ~/.family-computing を読まない）
    FC_CLAUDE_HOME: p.claudeHome, FC_APP_HOME: p.appHome,
    FC_STATE_DIR: path.join(p.shared, "state"), FC_LETTERS: path.join(p.shared, "letters.jsonl"), FC_PERM_DIR: path.join(p.shared, "perm"),
    // 立て直しをしない（台帳も書かない）。cam を呼ばない（本物の利用枠を見に行かない。account.rs は選べないとき今まで通りに起動する）
    FC_NO_RESTORE: "1", FC_CAM_BIN: "/usr/bin/false",
    FC_CLAUDE_BIN: p.standIn, FC_FLOOD_HZ: String(p.flood || 100), FC_BENCH_FLOOD_PARENT: p.town.roots[0], FC_BENCH_FLOOD_CWD: FLOOD_CWD,
    ...extra,
  };
  // 隠れた窓の負荷を測る場面の数字が変わるので、取得と時計を止めない設定は外す（README）
  delete env.VITE_FC_FORCE_VISIBLE;
  return env;
}

async function runOnce(scene: Scene, round: number, o: Opts): Promise<Run> {
  const dir = path.join(o.work, `${scene}-${round}`);
  const perf = path.join(dir, "perf.jsonl");
  const devLog = path.join(dir, "dev.log");
  const run: Run = {
    label: o.label, scene, round, at: new Date().toISOString(), valid: false, reason: null,
    build: o.release ? "release" : "debug", renderer: o.renderer, secs: o.secs, lettersKB: o.lettersKB, town: MOCK_ARGS[scene].join(" "),
    procs: {}, totalCpuPct: null, httpPerMin: {}, fps: { ready: null, post: null }, vis: { ready: null, post: null, events: [] },
    startupMs: null, ipcPerSec: null, recompiled: false, front: [], source: "native",
  };

  let holders: number[] = [];
  let dev: ChildProcess | null = null;
  try {
    const p = prepare(dir, scene, o.lettersKB);
    holders = p.town.holders;
    for (const h of holders) holding.add(h);
    const sid = scene === "talk" ? p.town.talk ?? "" : "";

    // 開発版
    if (listener(VITE_PORT).length) throw new Error(`ロックを持っているのに ${VITE_PORT} が使われている（pid ${listener(VITE_PORT).join(",")}）。止めずに中断する`);
    const before = new Set(webkitPids());
    // startup は CPU を測らないので、画面の待ちは短くてよい
    const wait = scene === "startup" ? 1000 : (o.settle + o.secs) * 1000 + 1500;
    const bench = new URLSearchParams({ bench: "scene", scene, wait: String(wait), ...(sid ? { sid } : {}), ...(scene === "terminal" ? { cwd: FLOOD_CWD } : {}), ...(o.renderer === "dom" ? { renderer: "dom" } : {}) });
    const env = benchEnv(p, { FC_PERF_LOG: perf, FC_BENCH_TOP: "1", VITE_FC_BENCH: bench.toString() });
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
    run.front.push(frontApp());

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

    // 見えるはずの場面で、始めから描かれていなければ測らない（本人が全画面のアプリを前面にしているときなど。ロックを早く返す）
    const shown = VISIBLE.includes(scene);
    if (shown && (ready.vis !== "visible" || (ready.fps ?? 0) < 20)) throw new Error(`始めに描かれていない（${ready.vis}、${ready.fps} fps）。測らずに打ち切った。前面のアプリ: ${run.front.join("、")}`);

    // 起動の時間（#187）。区間は ready の行に載っているので、起動の10秒後の RSS を取って終える。CPU は測らない
    if (scene === "startup") {
      const { spans, bad } = startupSpans(proc, ready);
      const p0 = proc?.procStartMs ?? Date.now();
      while (Date.now() < p0 + BOOT_RSS_AFTER_MS) {
        if (!alive()) throw new Error("開発版が終わった");
        await sleep(Math.min(500, Math.max(0, p0 + BOOT_RSS_AFTER_MS - Date.now())));
      }
      const r = (pid: number) => rssMB(pid) || null;
      run.boot = { ...spans, rssAppMB10s: r(app), rssWebContentMB10s: r(watch.WebContent) };
      run.startupMs = spans.toTownPaintMs;
      run.valid = bad.length === 0;
      run.reason = bad.join("。") || null;
      return run;
    }
    // 見えるはずの場面で途中で隠れたら、そこで打ち切る
    const hiddenSince = async (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (shown && readLog(perf).some((x) => x.bench === "scene" && x.visChange === "hidden")) throw new Error(`途中で隠れたので打ち切った。前面のアプリ: ${frontApp()}`);
        await sleep(Math.min(1000, Math.max(0, end - Date.now())));
      }
    };
    await hiddenSince(o.settle * 1000);
    const c0: Record<string, number | null> = {};
    for (const [k, p] of Object.entries(watch)) c0[k] = cpuSec(p);
    const t0 = performance.now();
    run.front.push(frontApp());
    await hiddenSince(o.secs * 1000);
    run.front.push(frontApp());
    const c1: Record<string, number | null> = {};
    for (const [k, p] of Object.entries(watch)) c1[k] = cpuSec(p);
    const dt = (performance.now() - t0) / 1000;
    let total = 0;
    for (const [k, p] of Object.entries(watch)) {
      if (c0[k] == null || c1[k] == null) { run.procs[k] = null; continue; }
      const d = c1[k]! - c0[k]!;
      total += d;
      run.procs[k] = { cpuSec: +d.toFixed(2), cpuPct: +((d / dt) * 100).toFixed(2), rssMB: rssMB(p) };
    }
    run.totalCpuPct = +((total / dt) * 100).toFixed(2);
    // ccn への要求の数（httpPerMin）は、ccn を外したので数えない。記録の形をそろえるため空のまま残す

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
    stopHolders(holders);
    for (const h of holders) holding.delete(h);
    for (let i = 0; i < 20 && listener(VITE_PORT).length; i++) await sleep(500);
  }
  return run;
}

// ---------- 町の確かめ（--town-check） ----------

/** 場面ごとの町を作り、組んだ開発版の Rust で件数を数える。画面もロックも使わない */
function townCheck() {
  const bin = path.join(ROOT, "src-tauri/target/debug/family-computing");
  if (!fs.existsSync(bin)) { console.error(`${bin} が無い。先に cargo build する`); return false; }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ct-bench-town-"));
  let ok = true;
  for (const scene of ["idle", "talk", "town"] as Scene[]) {
    const p = prepare(path.join(base, scene), scene, 56);
    try {
      const env = benchEnv(p, {});
      const nl = JSON.parse(spawnSync(bin, ["--native-list"], { env, encoding: "utf8" }).stdout);
      const snap = JSON.parse(spawnSync(bin, ["--snapshot"], { env, encoding: "utf8", maxBuffer: 1 << 26 }).stdout);
      const agents = snap.agents as { id: string; parent: string | null; state: string }[];
      const t = townOpts(scene);
      const want = { live: t.sessions + (t.talk ? 1 : 0), roots: t.households, running: t.running, waiting: t.approval };
      const got = {
        live: nl.first.live, roots: agents.filter((a) => !a.parent).length,
        running: agents.filter((a) => a.state === "running").length, waiting: agents.filter((a) => a.state === "waiting_permission").length,
      };
      const errs = [
        ...Object.entries(want).filter(([k, v]) => (got as Record<string, number>)[k] !== v).map(([k, v]) => `${k} ${(got as Record<string, number>)[k]}（${v} のはず）`),
        ...(nl.first.jsonl_missing ? [`jsonl_missing ${nl.first.jsonl_missing}`] : []),
        ...(Object.keys(nl.unexpected ?? {}).length ? [`unexpected ${JSON.stringify(nl.unexpected)}`] : []),
        ...(snap.letters.length ? [`お手紙が ${snap.letters.length} 件出た（24時間前にそろえたので 0 のはず）`] : []),
      ];
      const conv = (nl.conversations as { lines: number }[]).map((c) => c.lines);
      console.log(`${scene}: ${JSON.stringify(got)} 会話の行 最大 ${Math.max(...conv)} ${errs.length ? `NG ${errs.join("、")}` : "OK"}`);
      if (errs.length) ok = false;
    } finally {
      stopHolders(p.town.holders);
    }
  }
  fs.rmSync(base, { recursive: true, force: true });
  return ok;
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
  for (const scene of DEFAULT_SCENES) {
    const all = runs.filter((r) => r.scene === scene);
    if (!all.length) continue;
    const ok = all.filter((r) => r.valid);
    const pick = (k: string, f: "cpuPct" | "rssMB") => ok.map((r) => r.procs[k]?.[f]).filter((x): x is number => typeof x === "number");
    const http = ok.map((r) => Object.values(r.httpPerMin).reduce((a, b) => a + b, 0));
    // 合成の ~/.claude で測った回（#187 から）は ccn に問い合わせないので、要求の数は「−」にする
    const native = ok.length > 0 && ok.every((r) => r.source === "native");
    out.push(`| ${scene} | ${ok.length}/${all.length} | ${cell(pick("app", "cpuPct"), "%")} | ${cell(pick("WebContent", "cpuPct"), "%")} | ${cell(pick("GPU", "cpuPct"), "%")} | ${cell(pick("Networking", "cpuPct"), "%")} | ${cell(ok.map((r) => r.totalCpuPct ?? NaN).filter((x) => !isNaN(x)), "%")} | ${cell(pick("app", "rssMB"), "MB")} | ${cell(pick("WebContent", "rssMB"), "MB")} | ${cell(pick("GPU", "rssMB"), "MB")} | ${native ? "−" : cell(http)} | ${cell(ok.map((r) => r.startupMs ?? NaN).filter((x) => !isNaN(x)), "ms")} |`);
  }
  if (runs.some((r) => r.valid && r.source !== "native")) out.push("", "## 要求の内訳（有効な回の中央値、1分あたり）", "");
  for (const scene of ALL) {
    const ok = runs.filter((r) => r.scene === scene && r.valid && r.source !== "native");
    if (!ok.length) continue;
    const keys = [...new Set(ok.flatMap((r) => Object.keys(r.httpPerMin)))].sort();
    out.push(`- ${scene}: ${keys.map((k) => `${k} ${median(ok.map((r) => r.httpPerMin[k] ?? 0))}`).join("、") || "なし"}`);
  }
  // 起動の時間（#187）。CPU の表とは別にする。区間の定義は docs/perf/README.md
  const boots = runs.filter((r) => r.scene === "startup");
  if (boots.length) {
    const ok = boots.filter((r) => r.valid && r.boot);
    const b = (k: keyof NonNullable<Run["boot"]>, unit: string) => cell(ok.map((r) => r.boot![k]).filter((x): x is number => typeof x === "number"), unit);
    out.push("", "## 起動の時間（startup）", "");
    out.push("Rust の run() の入口からの時間。中央値（最小〜最大）。RSS は Rust の起動の10秒後。");
    out.push("", "| 有効/回 | 画面の読み込み開始まで | 窓の最初の描画まで | 町の最初の描画まで | 本体 RSS | WebContent RSS |", "| --- | --- | --- | --- | --- | --- |");
    out.push(`| ${ok.length}/${boots.length} | ${b("toNavStartMs", "ms")} | ${b("toShellPaintMs", "ms")} | ${b("toTownPaintMs", "ms")} | ${b("rssAppMB10s", "MB")} | ${b("rssWebContentMB10s", "MB")} |`);
  }
  const extra = runs.filter((r) => r.scene === "terminal" && r.valid);
  if (extra.length) out.push("", `terminal の描き方: ${[...new Set(extra.map((r) => r.renderer))].join("、")}。画面に届いた IPC は ${cell(extra.map((r) => r.ipcPerSec ?? NaN).filter((x) => !isNaN(x)), " 回/秒")}。`);
  const bad = runs.filter((r) => !r.valid);
  if (bad.length) {
    out.push("", "## 無効にした回", "");
    for (const r of bad) out.push(`- ${r.scene} ${r.round} 回目（${r.at}）: ${r.reason}${r.front?.length ? `。前面のアプリ: ${[...new Set(r.front)].join("、")}` : ""}`);
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
if (flag("town-check")) process.exit(townCheck() ? 0 : 1);

const scenes = arg("scenes", DEFAULT_SCENES.join(",")).split(",").map((s) => s.trim()) as Scene[];
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

// 同じ記録に、条件（描き方、ビルド、秒数、お手紙の大きさ）の違う回を混ぜない。違えば label を変えてもらう
const SAME = { renderer: o.renderer, build: o.release ? "release" : "debug", secs: o.secs, lettersKB: o.lettersKB } as const;
const cond = (r: Partial<Run>) => `${r.renderer}/${r.build}/${r.secs}/${r.lettersKB}`;
if (fs.existsSync(file)) {
  const other = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run).find((r) => r.valid && cond(r) !== cond(SAME));
  if (other) { console.error(`${path.relative(ROOT, file)} には条件の違う回（${cond(other)}、今回は ${cond(SAME)}）がある。--label を変えて測る`); process.exit(2); }
}
// 場面ごとに、記録（同じ日付と label の .jsonl）にある有効な回が runs 回になるまで回す。途中で止めても、続きから再開できる。
// 窓が隠れた回などで無効が続いても終わるように、1回の呼び出しで1場面に回すのは --max-tries 回まで（既定は runs の3倍）。
// 本人が全画面のアプリ（Specter など）を前面にしている間は、見えるはずの場面が無効になる
const done = (scene: Scene) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run) : [])
  .filter((r) => r.scene === scene && r.valid).length;
const tries: Record<string, number> = {};
const maxTries = Number(arg("max-tries", String(runs * 3)));
console.log(`場面 ${scenes.join("、")} で、有効な回が ${runs} 回ずつになるまで測る。記録は ${path.relative(ROOT, file)}、作業の場所は ${o.work}`);
for (;;) {
  const todo = scenes.filter((s) => done(s) < runs && (tries[s] ?? 0) < maxTries);
  if (!todo.length) break;
  for (const scene of todo) {
    const round = (tries[scene] = (tries[scene] ?? 0) + 1);
    await lock();
    let r: Run;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, ng) => { timer = setTimeout(() => ng(new Error("1回10分の締切を過ぎた")), RUN_DEADLINE_MS); });
      r = await Promise.race([runOnce(scene, round, o), deadline]).catch(async (e) => {
        await cleanup();
        return { ...SAME, scene, round, valid: false, reason: String(e.message ?? e), source: "native" } as Run;
      });
      clearTimeout(timer);
    } finally {
      unlock();
    }
    fs.appendFileSync(file, JSON.stringify(r) + "\n");
    const p = r.procs ?? {};
    console.log(`${scene} ${round}: ${r.valid ? "有効" : `無効（${r.reason}）`} 本体 ${p.app?.cpuPct ?? "−"}% WebContent ${p.WebContent?.cpuPct ?? "−"}% GPU ${p.GPU?.cpuPct ?? "−"}% 合計 ${r.totalCpuPct ?? "−"}% fps ${r.fps?.ready}/${r.fps?.post}`);
  }
}
const md = summarize(file);
console.log(`\n表: ${path.relative(ROOT, md)}`);
process.exit(0);
