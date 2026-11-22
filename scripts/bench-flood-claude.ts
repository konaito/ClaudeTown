// 軽さの計測（scripts/bench.ts の terminal の場面、#2、#8、#187）で、FC_CLAUDE_BIN に渡す claude の代役。
// 本物の claude は毎回出力が違い、利用枠も使うので、決まった書き換え（flood-chunk.ts）を1秒に FC_FLOOD_HZ（既定 100）かたまり流し続ける。
// 開発版が PTY の中で `<代役> --session-id <id> [--name <名前>]` と起動する。PATH はログインシェルのものになるので、
// bench.ts は bun の絶対パスでこれを呼ぶ sh を FC_CLAUDE_BIN にする。
// 起動したら FC_CLAUDE_HOME（合成の ~/.claude）に sessions/<pid>.json（作業中）と会話の jsonl を書く。
// FC_BENCH_FLOOD_PARENT に親の id があれば、最初の文に from 行を付けてその子にする（旧モックの --flood と同じく、先頭の世帯の子）。
// FC_CLAUDE_HOME が無ければ何も書かない（本物の ~/.claude には書かない）
import fs from "node:fs";
import path from "node:path";
import { floodChunks } from "./flood-chunk";
import { fromLine, projectDirName } from "./bench-town";

const argv = process.argv.slice(2);
const at = argv.indexOf("--session-id");
const id = at >= 0 ? argv[at + 1] : crypto.randomUUID();
const HZ = Number(process.env.FC_FLOOD_HZ ?? 100);
const home = process.env.FC_CLAUDE_HOME;
const parent = process.env.FC_BENCH_FLOOD_PARENT;
// 置き場所は FC_BENCH_FLOOD_CWD があればその文字列（/tmp は /private/tmp へのリンクなので、process.cwd() だと開発版に渡した文字列と変わる）
const cwd = process.env.FC_BENCH_FLOOD_CWD || process.cwd();
const now = Date.now();

if (home) {
  const jsonl = path.join(home, "projects", projectDirName(cwd), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(jsonl), { recursive: true });
  fs.writeFileSync(jsonl, JSON.stringify({ type: "user", message: { role: "user", content: `${parent ? `${fromLine(parent)}\n\n` : ""}出力を流し続けて` }, timestamp: new Date(now).toISOString(), cwd, sessionId: id }) + "\n");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  // updatedAt を startedAt より進めておく（起動済みの印。composer.rs の gate_of）
  fs.writeFileSync(path.join(home, "sessions", `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: id, cwd, startedAt: now, kind: "interactive", entrypoint: "cli", status: "busy", updatedAt: now + 1, name: "flood",
  }));
}

let cols = process.stdout.columns || 120;
process.stdout.on("resize", () => { cols = process.stdout.columns || cols; });
process.stdout.write("\x1b[2J\x1b[H bench\r\n");
const chunk = floodChunks(HZ, () => cols);
setInterval(() => process.stdout.write(chunk()), 1000 / HZ);
// 打たれた文字は読み捨てる（PTY の入力が詰まらないように）
process.stdin.on("data", () => {});
for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
