// Claude Code の描き方を2通りで比べる（#20）。ccn の PTY と同じ形（bun の PTY、TERM=xterm-256color）で claude を起動し、
// 同じ依頼を出して、送られてくるバイト数とかたまりの数、claude の CPU 時間、幅を変えたときの崩れを数える。
//   bun run scripts/compare-fullscreen.ts [出力の置き場所]      既定 /tmp/ct-term-fullscreen
// 比べるのは、何も付けない起動（default）と、CLAUDE_CODE_NO_FLICKER=1 を付けた起動（fullscreen）。
// /tui fullscreen は設定を保存して以後の全部のセッションを変えるので使わない（公式の説明 terminal-config の「Switch to fullscreen rendering」）。
// 出力は <置き場所>/<方式>.jsonl に {t, b64} で残す。scripts/mock-ccn-flood.ts の FC_FLOOD_REPLAY で同じ速さで流し直せる。
import { Terminal } from "@xterm/headless";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] ?? "/tmp/ct-term-fullscreen";
mkdirSync(out, { recursive: true });
const cwd = process.env.FC_CMP_CWD ?? join(homedir(), "Documents/meta");
const PROMPT = "ツールは使わずに答えて。1から40まで、1行に1つずつ、数字と短い一言を書いて。";
const COLS = 100, ROWS = 30, NARROW = 70;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function env(extra: Record<string, string>) {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "CLAUDECODE" || k === "CLAUDE_PID" || k.startsWith("CLAUDE_CODE_")) continue;
    e[k] = v;
  }
  return { ...e, TERM: "xterm-256color", COLORTERM: "truecolor", ...extra };
}

/** pid とその子孫の CPU 時間（秒）の合計 */
async function cpuOf(pid: number): Promise<number> {
  const ps = await Bun.$`ps -axo pid=,ppid=,time=`.text();
  const rows = ps.trim().split("\n").map((l) => l.trim().split(/\s+/));
  const kids = new Map<string, string[]>();
  for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  const sec = (t: string) => t.split(":").reduce((a, x) => a * 60 + Number(x), 0);
  const time = new Map(rows.map(([p, , t]) => [p, sec(t)]));
  let sum = 0;
  const walk = (p: string) => { sum += time.get(p) ?? 0; for (const k of kids.get(p) ?? []) walk(k); };
  walk(String(pid));
  return sum;
}

/** 画面に見えている行のうち、横線（─ が10個以上続く）の長さの最大と、折り返しの続きになっている横線の数 */
function rules(t: Terminal) {
  const b = t.buffer.active;
  let max = 0, wrapped = 0;
  for (let y = 0; y < t.rows; y++) {
    const line = b.getLine(b.viewportY + y);
    const m = (line?.translateToString(true) ?? "").match(/─{10,}/);
    if (!m) continue;
    max = Math.max(max, m[0].length);
    if (line?.isWrapped) wrapped++;
  }
  return { max, wrapped };
}

async function run(name: string, extra: Record<string, string>) {
  const t = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const rec: { t: number; b64: string }[] = [];
  let text = "", last = performance.now(), phase = "start";
  const counts = { start: { bytes: 0, chunks: 0 }, answer: { bytes: 0, chunks: 0 }, resize: { bytes: 0, chunks: 0 } } as Record<string, { bytes: number; chunks: number }>;
  const t0 = performance.now();
  const proc = Bun.spawn(["claude", "--model", "haiku"], {
    cwd, env: env(extra),
    terminal: {
      cols: COLS, rows: ROWS,
      data(_term, d) {
        const u = new Uint8Array(d);
        rec.push({ t: Math.round(performance.now() - t0), b64: Buffer.from(u).toString("base64") });
        counts[phase].bytes += u.length; counts[phase].chunks++;
        const s = new TextDecoder().decode(u);
        text += s;
        t.write(u);
        last = performance.now();
      },
    },
  });
  // 入力欄が読み始める（ESC[?2004h）まで待つ。早く書くと Enter が捨てられる（ccn #26 で ccn-term が確かめた）
  for (let i = 0; i < 300 && !text.includes("\x1b[?2004h"); i++) await sleep(100);
  await sleep(1000);
  const cpu0 = await cpuOf(proc.pid);
  phase = "answer";
  const a0 = performance.now();
  proc.terminal!.write(PROMPT);
  await sleep(300);
  proc.terminal!.write("\r");
  // 出力が始まってから、6秒何も来なくなるまで（最大120秒）
  await sleep(2000);
  while (performance.now() - last < 6000 && performance.now() - a0 < 120000) await sleep(200);
  const answerMs = Math.round(last - a0);
  const cpu1 = await cpuOf(proc.pid);
  const answered = /40/.test(text);
  // 幅を変えて、3秒後の画面を見る
  phase = "resize";
  const before = rules(t);
  t.resize(NARROW, ROWS);
  proc.terminal!.resize(NARROW, ROWS);
  await sleep(3000);
  await new Promise<void>((r) => t.write("", () => r()));
  const after = rules(t);
  proc.kill();
  await proc.exited;
  writeFileSync(join(out, `${name}.jsonl`), rec.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const all = rec.reduce((a, r) => a + Buffer.from(r.b64, "base64").length, 0);
  const seq = (s: string) => text.split(s).length - 1;
  return {
    name, answered, answerMs,
    answerBytes: counts.answer.bytes, answerChunks: counts.answer.chunks,
    chunksPerSec: +(counts.answer.chunks / (answerMs / 1000)).toFixed(1), bytesPerSec: Math.round(counts.answer.bytes / (answerMs / 1000)),
    claudeCpuSec: +(cpu1 - cpu0).toFixed(2),
    resizeBytes: counts.resize.bytes, ruleBefore: before.max, ruleAfter: after.max, wrappedAfter: after.wrapped,
    altScreen: seq("\x1b[?1049h") > 0, syncBegin: seq("\x1b[?2026h"), totalBytes: all,
  };
}

const results = [];
for (const [name, extra] of [["default", {}], ["fullscreen", { CLAUDE_CODE_NO_FLICKER: "1" }]] as const) {
  const r = await run(name, extra);
  console.log(JSON.stringify(r));
  results.push(r);
  await sleep(2000);
}
writeFileSync(join(out, "summary.json"), JSON.stringify(results, null, 2));
