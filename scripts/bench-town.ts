// 軽さの計測（scripts/bench.ts、#2、#187）で使う合成の ~/.claude。毎回同じ町を作る（id、親子、状態、開始時刻の並びは決め打ち）。
// 消えたモックの ccn（238e712 の前の scripts/mock-ccn-town.ts）と同じ町を、Claude Code の記録の形（README の「データの取り方」）で書く。
// 作り方は src-tauri/src/native/mod.rs の testtree と同じ（sessions/<pid>.json と projects/<cwd を直した名前>/<id>.jsonl）。
//   bun run scripts/bench-town.ts <置き場所> [--households 4] [--sessions 10] [--running 0] [--approval 0] [--talk 0]
//     置き場所に町を書き、Ctrl-C まで待つ。FC_CLAUDE_HOME=<置き場所> で開発版を起動すると、この町が出る
// 町に出るのは pid が生きている行だけなので、セッションごとに /bin/sleep を1つ起動し、その pid を名乗らせる。
// sleep は1時間で自分で終わる。止めるときは、返した pid を指定する
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type TownOpts = { households: number; sessions: number; running: number; approval: number; talk: number };
export type Town = { holders: number[]; ids: string[]; roots: string[]; talk: string | null };

/** 旧モックと同じ既定。--flood は町に書かず、開発版が FC_CLAUDE_BIN の代役で立てる（bench-flood-claude.ts） */
export const TOWN_DEFAULTS: TownOpts = { households: 4, sessions: 10, running: 0, approval: 0, talk: 0 };

/** projects/ の下のディレクトリ名。英数字（ASCII）以外を全部 - にする（native/sessions.rs の project_dir_name と同じ） */
export const projectDirName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const idOf = (i: number) => `b${i.toString(16).padStart(7, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
/** 画面の state を sessions/<pid>.json の status に戻す（native/sessions.rs の state_of の逆） */
const STATUS: Record<string, string> = { running: "busy", waiting_permission: "waiting", idle: "idle" };
/** 子の最初の文に付ける from 行（native/sessions.rs の caller_of が読む形） */
export const fromLine = (parentId: string) => `from agent:bench/${parentId.slice(0, 8)}/子 via bench`;

type S = { id: string; cwd: string; parent: string | null; state: string; startedAt: number; title: string; lines: object[] };

/** 長い会話の1件。旧モックの messages と同じ中身 */
function talkLine(k: number, t0: number) {
  const md = `## 手順 ${k}\n\n- \`src/App.tsx\` の **${k} 行目** を読んだ\n- 次は [README](https://example.com/${k}) を確かめる\n\n\`\`\`ts\nconst x${k} = ${k};\n\`\`\`\n`;
  const timestamp = new Date(t0 + k * 1000).toISOString();
  if (k % 3 === 0) return { type: "user", message: { role: "user", content: `依頼 ${k}: この部分を直して、結果を教えて。` }, timestamp };
  if (k % 3 === 1) return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: md }, { type: "tool_use", id: `t${k}`, name: "Read", input: { file_path: `/tmp/bench-town/src/file-${k}.ts` } }] }, timestamp };
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `了解。${"説明の文。".repeat(20)}` }] }, timestamp };
}

/** 町の並び（pid は入れない）。旧モックの組み方をそのまま写した */
export function plan(o: TownOpts, now = Date.now()) {
  if (o.households < 1 || o.sessions < o.households || o.running + o.approval > o.sessions) throw new Error("数が合わない");
  // 開始時刻は1時間前から1分ずつずらす（町の並びと経過時間の表示が毎回同じになる）
  const T0 = now - 3600_000;
  const sessions: S[] = [];
  const roots: S[] = [];
  for (let i = 0; i < o.sessions; i++) {
    let parent: string | null = null, cwd = `/tmp/bench-town/house-${i + 1}`;
    if (i >= o.households) {
      // 根の残りを世帯に順に配る。同じ世帯の3人目からは、その世帯の2人目の子（孫）にする
      const h = (i - o.households) % o.households, nth = Math.floor((i - o.households) / o.households);
      const kin = sessions.filter((s) => s.cwd.startsWith(`${roots[h].cwd}/`));
      parent = (nth >= 2 && kin[0] ? kin[0] : roots[h]).id;
      cwd = `${roots[h].cwd}/kid-${nth + 1}`;
    }
    // 作業中と承認待ちは、後ろ（子と孫）から割り当てる
    const fromEnd = o.sessions - 1 - i;
    const state = fromEnd < o.running ? "running" : fromEnd < o.running + o.approval ? "waiting_permission" : "idle";
    const s: S = { id: idOf(i + 1), cwd, parent, state, startedAt: T0 + i * 60_000, title: cwd.split("/").pop()!, lines: [] };
    s.lines = [
      { type: "user", message: { role: "user", content: `${parent ? `${fromLine(parent)}\n\n` : ""}${s.title} の作業を進めて` }, timestamp: new Date(s.startedAt).toISOString() },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "了解。進める。" }] }, timestamp: new Date(s.startedAt + 1000).toISOString() },
    ];
    sessions.push(s);
    if (!parent) roots.push(s);
  }
  let talk: S | null = null;
  if (o.talk > 0) {
    // 先頭の世帯に、件数ぶんの発言がある子を1つ足す（旧モックの --talk）
    const lines: object[] = Array.from({ length: o.talk }, (_, k) => talkLine(k, T0));
    (lines[0] as { message: { content: string } }).message.content = `${fromLine(roots[0].id)}\n\n${(lines[0] as { message: { content: string } }).message.content}`;
    talk = { id: "e0000000-0000-4000-8000-000000000002", cwd: `${roots[0].cwd}/talk`, parent: roots[0].id, state: "idle", startedAt: T0 + 3000_000 + 2, title: "e", lines };
    sessions.push(talk);
  }
  return { sessions, roots, talk };
}

/** 町を root に書き、セッションごとに sleep を起動する。root は空のディレクトリにしておく */
export function buildTown(root: string, o: TownOpts, now = Date.now()): Town {
  const { sessions, roots, talk } = plan(o, now);
  const holders: number[] = [];
  try {
    for (const s of sessions) {
      const h = spawn("/bin/sleep", ["3600"], { stdio: "ignore" });
      if (!h.pid) throw new Error("sleep を起動できなかった");
      h.unref();
      holders.push(h.pid);
      const jsonl = path.join(root, "projects", projectDirName(s.cwd), `${s.id}.jsonl`);
      fs.mkdirSync(path.dirname(jsonl), { recursive: true });
      fs.writeFileSync(jsonl, s.lines.map((l) => JSON.stringify({ ...l, cwd: s.cwd, sessionId: s.id })).join("\n") + "\n");
      fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(root, "sessions", `${h.pid}.json`), JSON.stringify({
        pid: h.pid, sessionId: s.id, cwd: s.cwd, startedAt: s.startedAt, kind: "interactive", entrypoint: "cli",
        status: STATUS[s.state], updatedAt: s.startedAt, name: s.title,
      }));
    }
  } catch (e) {
    stopHolders(holders);
    throw e;
  }
  return { holders, ids: sessions.map((s) => s.id), roots: roots.map((s) => s.id), talk: talk?.id ?? null };
}

/** buildTown が起動した sleep を pid で止める */
export function stopHolders(pids: number[]) {
  for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch {} }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const root = argv[0];
  if (!root || root.startsWith("--")) { console.error("置き場所を渡す"); process.exit(2); }
  const opt = (k: keyof TownOpts) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : TOWN_DEFAULTS[k]; };
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) { console.error(`${root} が空ではない`); process.exit(2); }
  const t = buildTown(root, { households: opt("households"), sessions: opt("sessions"), running: opt("running"), approval: opt("approval"), talk: opt("talk") });
  console.log(`ready ${root} sessions ${t.ids.length}${t.talk ? ` talk ${t.talk}` : ""}`);
  const stop = () => { stopHolders(t.holders); process.exit(0); };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, stop);
  setInterval(() => {}, 1 << 30);
}
