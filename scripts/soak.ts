// 長時間の記録（#15）。開発版を別の置き場所で起動し、本体と WebKit のメモリを外から ps と footprint で記録する。
//
//   bun run scripts/soak.ts --bin <ビルドした family-computing> --mode town --hours 8
//   bun run scripts/soak.ts --bin <ビルドした family-computing> --mode reopen
//
// 開発版（bun tauri dev）を占有しないための決まり:
//   - 画面は、VITE_FC_SOAK=<mode> を付けて `bun tauri build --debug --no-bundle` でビルドしたバイナリを、
//     /tmp/ct-soak-<mode>/ に写してから起動する。vite の 1420/1421 は使わない（画面はバイナリに入っている）
//   - HOME を /tmp/ct-soak-<mode>/home にする。~/.family-computing/dev/ と letters.jsonl に触らない
//   - ccn は使わない。モックのノード（scripts/mock-ccn-pty.ts）を --port（既定 4511）で起動し、FC_CCN_URL で繋ぐ
//   - 止めるのは、このスクリプトが起動した pid だけ
//
// 町（--mode town）:
//   - モックに2世帯6人を作る。各セッションは FC_MOCK_CONV=1000 の会話を持ち、5秒ごとに1件増える
//   - 1分ごとにお手紙（sent と received）を letters.jsonl に足す。15分ごとに子を1人止めて、新しい子を1人作る
//   - 画面（src/soak.ts）は10分ごとに次のセッションを選んでチャットを開く
//   - --interval 秒（既定 600）ごとに RSS と footprint を記録する
// ターミナルの開き直し（--mode reopen）:
//   - 画面がターミナルのタブを100回開いて閉じる。10秒ごとに記録し、終わってから --after 秒（既定 120）待って記録する。全部で10分以内に収まる
//
// 結果は /tmp/ct-soak-<mode>/samples.jsonl と summary.md。ディスクの空きが 20GB を切ったら止める。
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statfsSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const MODE = arg("mode", "town")!;
const BIN = arg("bin");
const HOURS = Number(arg("hours", MODE === "town" ? "8" : "1"));
const INTERVAL_S = Number(arg("interval", MODE === "town" ? "600" : "10"));
const AFTER_S = Number(arg("after", "120"));
const PORT = Number(arg("port", MODE === "town" ? "4511" : "4512"));
const DIR = arg("dir", `/tmp/ct-soak-${MODE}`)!;
const HOME = join(DIR, "home");
const MIN_FREE_GB = 20;
/** この1分の load 以上の時間帯の記録は、判定に使わない（2026-11-13、ほかのセッションの試験で load が 400〜900 になった） */
const MAX_LOAD = 20;
if (!BIN || !existsSync(BIN)) throw new Error("--bin にビルドした family-computing を渡す");

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" }).stdout ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = `http://127.0.0.1:${PORT}/api`;

mkdirSync(join(HOME, ".family-computing"), { recursive: true });
const bin = join(DIR, "family-computing");
copyFileSync(BIN, bin);
chmodSync(bin, 0o755);
const samplesPath = join(DIR, "samples.jsonl");
const perfLog = join(DIR, "perf.log");
const letters = join(HOME, ".family-computing", "letters.jsonl");
writeFileSync(samplesPath, "");
writeFileSync(perfLog, "");

// ---------- モックのノード ----------
if (sh("/usr/sbin/lsof", ["-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"]).trim()) throw new Error(`ポート ${PORT} が使われている（--port で変える）`);
const mock = spawn("bun", ["run", join(import.meta.dir, "mock-ccn-pty.ts")], {
  env: { ...process.env, FC_MOCK_PORT: String(PORT), FC_MOCK_CONV: "1000", FC_MOCK_CONV_GROW_MS: "5000" },
  stdio: ["ignore", "ignore", "inherit"],
});
for (let i = 0; i < 50; i++) { try { await fetch(`${api}/peers`); break; } catch { await sleep(200); } }

const post = async (body: Record<string, unknown>, from?: string) => {
  const r = await fetch(`${api}/sessions`, { method: "POST", headers: { "content-type": "application/json", ...(from ? { "x-ccn-from": from } : {}) }, body: JSON.stringify({ terminal: true, cwd: "/tmp", ...body }) });
  return (await r.json()) as { id: string };
};
const live: { id: string; parent: string | null }[] = [];
let seq = 0;
const child = async (parent: string) => {
  const s = await post({ name: `子${++seq}` }, `agent:mock/${parent.slice(0, 8)}/child`);
  live.push({ id: s.id, parent });
  return s.id;
};
for (const root of ["世帯A", "世帯B"]) {
  const r = await post({ name: root });
  live.push({ id: r.id, parent: null });
  await child(r.id); await child(r.id);
}

// ---------- 開発版 ----------
const webkitPids = () => sh("/usr/bin/pgrep", ["-f", "com.apple.WebKit.(WebContent|GPU|Networking)"]).split("\n").filter(Boolean).map(Number);
const before = new Set(webkitPids());
const t0 = Date.now();
const app = spawn(bin, [], {
  // 開き直しの試験では窓を最前面に出す。裏に回ると WebKit が描画を止め、試験が進まない。町の記録は8時間なので出さない
  env: { ...process.env, HOME, FC_CCN_URL: `http://127.0.0.1:${PORT}`, FC_PERF_LOG: perfLog, ...(MODE === "reopen" ? { FC_BENCH_TOP: "1" } : {}) },
  stdio: ["ignore", "ignore", "ignore"],
});
const kinds: Record<string, number> = {};
for (let i = 0; i < 60 && !kinds.WebContent; i++) {
  await sleep(500);
  for (const p of webkitPids().filter((p) => !before.has(p))) {
    const k = sh("/bin/ps", ["-o", "command=", "-p", String(p)]).match(/com\.apple\.WebKit\.(WebContent|GPU|Networking)/)?.[1];
    if (k && !kinds[k]) kinds[k] = p;
  }
}
if (!kinds.WebContent) { stop("WebContent が見つからない"); }
const watch: Record<string, number> = { app: app.pid!, ...kinds };
console.log(`起動: ${JSON.stringify(watch)}（${DIR}）`);

// vm.loadavg は "{ 1.23 4.56 7.89 }"。括弧を外してから空白を詰める
const load1 = () => Number(sh("/usr/sbin/sysctl", ["-n", "vm.loadavg"]).replace(/[{}]/g, "").trim().split(/\s+/)[0]);
/** ps の time（[[dd-]hh:]mm:ss.cc）を秒に */
function cpuS(pid: number) {
  const t = sh("/bin/ps", ["-o", "time=", "-p", String(pid)]).trim();
  if (!t) return null;
  const [d, rest] = t.includes("-") ? t.split("-") : ["0", t];
  return Number(d) * 86400 + rest.split(":").reduce((a, x) => a * 60 + Number(x), 0);
}
/** footprint の全文を残す（何が増えたかの内訳。graphics なら canvas の面、malloc なら物の保持） */
function dumpFootprint(tag: string) {
  for (const k of ["WebContent", "GPU"]) if (watch[k]) writeFileSync(join(DIR, `footprint-${k}-${tag}.txt`), sh("/usr/bin/footprint", ["-p", String(watch[k])]));
}
function rssMB(pid: number) { const v = Number(sh("/bin/ps", ["-o", "rss=", "-p", String(pid)]).trim()); return v ? Math.round(v / 102.4) / 10 : null; }
function footMB(pid: number) { const m = sh("/usr/bin/footprint", ["-p", String(pid), "-f", "bytes"]).match(/phys_footprint: (\d+) B/); return m ? Math.round(Number(m[1]) / 1024 / 102.4) / 10 : null; }
const freeGB = () => { const s = statfsSync("/"); return (s.bavail * s.bsize) / 1024 ** 3; };

const samples: Record<string, unknown>[] = [];
function sample(note = "") {
  const load = load1();
  const r: Record<string, unknown> = { at: new Date().toISOString(), min: Math.round((Date.now() - t0) / 600) / 100, note, load, valid: load < MAX_LOAD };
  for (const [k, p] of Object.entries(watch)) { r[`${k}_rss`] = rssMB(p); r[`${k}_foot`] = footMB(p); r[`${k}_cpu`] = cpuS(p); }
  samples.push(r);
  appendFileSync(samplesPath, JSON.stringify(r) + "\n");
  writeSummary();
  console.log(`${r.min}分 WebContent ${r.WebContent_rss}MB（footprint ${r.WebContent_foot}MB） 本体 ${r.app_rss}MB ${note}`);
}
function writeSummary() {
  const keys = Object.keys(watch);
  // load の高い時間帯の記録は判定に使わない。始めと最新は、load が低かった記録から取る
  const ok = samples.filter((s) => s.valid);
  const first = ok[0] ?? samples[0], last = ok[ok.length - 1] ?? samples[samples.length - 1];
  const d = (k: string) => (last[k] != null && first[k] != null ? Math.round(((last[k] as number) - (first[k] as number)) * 10) / 10 : "−");
  const max = (k: string) => Math.max(...(ok.length ? ok : samples).map((s) => (s[k] as number) ?? 0));
  const out = [
    `# 長時間の記録（${MODE}）`, "",
    `始め ${first.at}、最新 ${last.at}（${last.min} 分）。プロセス ${JSON.stringify(watch)}`,
    `判定に使ったのは、1分の load が ${MAX_LOAD} 未満の記録（${ok.length}/${samples.length} 点）。`, "",
    "| | 始め | 最新 | 増え方 | 最大 |", "|---|---|---|---|---|",
    ...keys.flatMap((k) => [`${k}_rss`, `${k}_foot`]).map((k) => `| ${k} | ${first[k]} | ${last[k]} | ${d(k)} | ${max(k)} |`),
    "", "単位は MB。rss は ps の RSS、foot は footprint の phys_footprint。", "",
    "| 分 | load | " + keys.map((k) => `${k} rss/foot/cpu秒`).join(" | ") + " | メモ |",
    "|---|---|" + keys.map(() => "---").join("|") + "|---|",
    ...samples.map((s) => `| ${s.min} | ${s.load}${s.valid ? "" : "（除く）"} | ` + keys.map((k) => `${s[`${k}_rss`]}/${s[`${k}_foot`]}/${s[`${k}_cpu`]}`).join(" | ") + ` | ${s.note} |`),
  ];
  writeFileSync(join(DIR, "summary.md"), out.join("\n") + "\n");
}

let stopped = false;
function stop(why: string): never {
  if (!stopped) {
    stopped = true;
    console.log(`終わり: ${why}`);
    if (samples.length) { dumpFootprint("stop"); appendFileSync(join(DIR, "summary.md"), `\n終わり: ${why}\n`); }
    // 止めるのは、ここで起動した pid だけ
    try { process.kill(app.pid!, "SIGTERM"); } catch { /* もう終わっている */ }
    try { process.kill(mock.pid!, "SIGTERM"); } catch { /* もう終わっている */ }
  }
  process.exit(0);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
app.on("exit", (code) => stop(`開発版が終わった（${code}）`));

// ---------- お手紙と顔ぶれの入れ替え（町） ----------
let letterN = 0;
function letter() {
  const xs = live.filter((x) => x.parent);
  if (xs.length < 2) return;
  const a = xs[letterN % xs.length], b = live.find((x) => x.id === a.parent)!;
  const at = Date.now();
  const id = `soak${++letterN}`;
  appendFileSync(letters, JSON.stringify({ ev: "sent", id: `${id}s`, at, kind: "send", from: a.id, to: b.id, to_id: b.id, summary: `お手紙 ${letterN}` }) + "\n");
  appendFileSync(letters, JSON.stringify({ ev: "received", id: `${id}r`, at: at + 3000, to: b.id, from_sid8: a.id.slice(0, 8), summary: `お手紙 ${letterN}` }) + "\n");
}
async function churn() {
  const i = live.findIndex((x) => x.parent);
  if (i < 0) return;
  const [old] = live.splice(i, 1);
  await fetch(`${api}/sessions/${old.id}`, { method: "DELETE" }).catch(() => {});
  await child(old.parent!);
}

const perfLines = () => readFileSync(perfLog, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });

await sleep(30_000);
sample("起動から30秒");
dumpFootprint("start");

const end = t0 + HOURS * 3600_000;
if (MODE === "town") {
  const timers = [setInterval(letter, 60_000), setInterval(() => { churn().catch(() => {}); }, 15 * 60_000)];
  while (Date.now() < end) {
    await sleep(INTERVAL_S * 1000);
    if (freeGB() < MIN_FREE_GB) stop(`ディスクの空きが ${MIN_FREE_GB}GB を切った`);
    const sel = perfLines().filter((l) => l.ev === "select").length;
    const err = perfLines().find((l) => l.ev === "error");
    sample(`選んだ回数 ${sel}、生きているセッション ${live.length}、お手紙 ${letterN}${err ? `、画面の失敗 ${err.message}` : ""}`);
  }
  timers.forEach(clearInterval);
  dumpFootprint("end");
  stop(`${HOURS} 時間たった`);
} else {
  let doneAt = 0;
  let lastDump = 0;
  while (Date.now() < end) {
    await sleep(INTERVAL_S * 1000);
    const ls = perfLines();
    const err = ls.find((l) => l.ev === "error");
    if (err) stop(`画面の失敗: ${err.message}`);
    const n = Math.max(0, ...ls.filter((l) => l.ev === "reopen").map((l) => l.i));
    if (n > 0 && n % 50 === 0 && n !== lastDump) { lastDump = n; dumpFootprint(`n${n}`); }
    const done = ls.find((l) => l.ev === "done");
    if (!doneAt && done) { doneAt = Date.now(); dumpFootprint("done"); sample(`開き直し ${REOPEN_N(ls)} 回が終わった（描けた ${done.drawn}、文脈が生きていた ${done.gl}、文脈を失った知らせ ${done.lost}）`); continue; }
    sample(doneAt ? `終わってから ${Math.round((Date.now() - doneAt) / 1000)} 秒` : `開き直し ${n} 回`);
    if (doneAt && Date.now() - doneAt >= AFTER_S * 1000) { dumpFootprint("end"); stop("開き直しの後の記録が済んだ"); }
  }
  stop("時間切れ");
}
function REOPEN_N(ls: { ev?: string; i?: number }[]) { return Math.max(0, ...ls.filter((l) => l.ev === "reopen").map((l) => l.i ?? 0)); }
