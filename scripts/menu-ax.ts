// メニューバー（#300）を、動いている開発版から AX（System Events）で読み、Rust の木（family-computing --menu-tree）と比べる。
// 画面はクリックせず、キーも送らない。読むのと押すのは、渡した pid のプロセスのメニューだけにする（名前で探さない。安定版と開発版は実行ファイル名が同じ）。
//
//   bun scripts/menu-ax.ts dump <pid>                    実物のメニューを1行ずつ出す（文言、キー、押せるか）
//   bun scripts/menu-ax.ts check <pid>                   実物と木を比べ、違う行を出す。違いが無ければ終了コード 0
//   bun scripts/menu-ax.ts press <pid> <メニュー> <項目>  AX でその項目を押す（AXPress）
//
// AX の許可が無いとき（安定版の端末から走らせると、責任プロセスの Claude Town に許可が無い）は、開発版を FC_MENU_CTL=<ファイル> と
// FC_PERF_LOG=<ファイル> を付けて起動し、アプリの中から読んで押す（src-tauri/src/menu.rs の start_dev_ctl）。
//   bun scripts/menu-ax.ts ctl-dump <ctl> <perf>                   アプリの中から読んだメニュー（押せるか、隠れた代わりの項目も出す）
//   bun scripts/menu-ax.ts ctl-check <ctl> <perf>                  それを木と比べる（隠れた代わりの項目は除く）
//   bun scripts/menu-ax.ts ctl-press <ctl> <perf> <メニュー> <項目>  NSMenu の performActionForItemAtIndex で押す
//
// pid は開発版のアプリ（src-tauri/target/debug/family-computing）のもので、`bun tauri dev` の pid ではない。
// 木は同じ作業ツリーの src-tauri/target/debug/family-computing --menu-tree から取る。先に cargo build か bun tauri dev で組んでおく。
// 走らせるプロセス（ターミナルなど）に、システム設定のアクセシビリティの許可が要る。
// macOS が自分で足す項目（編集の音声入力と絵文字、ウインドウの窓の一覧、ヘルプの検索欄など）は、check で「実物だけにある行」として出る
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(ROOT, "src-tauri/target/debug/family-computing");

type AxItem = { title: string; key: string; on: boolean };
type AxMenu = { title: string; items: AxItem[] };

function osa(js: string): string {
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", js], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`osascript が失敗した: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** AXMenuItemCmdModifiers（1 Shift、2 Option、4 Control、8 Command なし）と AXMenuItemCmdChar から、macOS の書き方（⌃⌥⇧⌘ の順）にする */
export function keyLabel(ch: string | null, mods: number | null): string {
  if (!ch) return "";
  const m = mods ?? 0;
  return `${m & 4 ? "⌃" : ""}${m & 2 ? "⌥" : ""}${m & 1 ? "⇧" : ""}${m & 8 ? "" : "⌘"}${ch.toUpperCase()}`;
}

function readMenus(pid: number): AxMenu[] {
  const js = `
    const se = Application("System Events");
    const p = se.processes.whose({ unixId: ${pid} })[0];
    const attr = (el, n) => { try { return el.attributes.byName(n).value(); } catch (e) { return null; } };
    const out = [];
    const bar = p.menuBars[0].menuBarItems();
    // 0 番は Apple のメニュー
    for (let i = 1; i < bar.length; i++) {
      const items = bar[i].menus[0].menuItems().map((it) => {
        let title = ""; try { title = it.title() || ""; } catch (e) {}
        let on = false; try { on = it.enabled(); } catch (e) {}
        return { title, ch: attr(it, "AXMenuItemCmdChar"), mods: attr(it, "AXMenuItemCmdModifiers"), on };
      });
      out.push({ title: bar[i].title(), items });
    }
    JSON.stringify(out);
  `;
  const raw = JSON.parse(osa(js)) as { title: string; items: { title: string; ch: string | null; mods: number | null; on: boolean }[] }[];
  return raw.map((m) => ({ title: m.title, items: m.items.map((it) => ({ title: it.title, key: keyLabel(it.ch, it.mods), on: it.on })) }));
}

/** 木と同じ書き方の行（「# 題」、「---」、「文言\tキー」）。区切りは AX では題が空の項目 */
function lines(menus: AxMenu[], withState: boolean): string[] {
  const out: string[] = [];
  for (const m of menus) {
    out.push(`# ${m.title}`);
    for (const it of m.items) out.push(it.title ? `${it.title}\t${it.key}${withState ? `\t${it.on ? "on" : "off"}` : ""}` : "---");
  }
  return out;
}

function treeLines(): string[] {
  const r = spawnSync(BIN, ["--menu-tree"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${BIN} --menu-tree が失敗した: ${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

/** 実物（got）と木（want）の差。最初のメニューの題は、bun tauri dev では実行ファイル名になるので比べない */
export function diff(want: string[], got: string[]): string[] {
  const norm = (ls: string[]) => ls.map((l, i) => (i === 0 && l.startsWith("# ") ? "# (アプリ名)" : l));
  const w = norm(want), g = norm(got);
  const out: string[] = [];
  // 行の並びを LCS で突き合わせ、片方だけにある行を出す
  const n = w.length, m = g.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = w[i] === g[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && w[i] === g[j]) { i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) out.push(`+ 実物だけ: ${g[j++]}`);
    else out.push(`- 木だけ: ${w[i++]}`);
  }
  return out;
}

function press(pid: number, menu: string, item: string) {
  const js = `
    const se = Application("System Events");
    const p = se.processes.whose({ unixId: ${pid} })[0];
    const bar = p.menuBars[0].menuBarItems();
    let hit = null;
    for (let i = 1; i < bar.length; i++) if (bar[i].title() === ${JSON.stringify(menu)}) hit = bar[i];
    if (!hit) throw new Error("メニューが無い");
    const it = hit.menus[0].menuItems.byName(${JSON.stringify(item)});
    if (!it.enabled()) throw new Error("押せない項目");
    it.actions.byName("AXPress").perform();
    "ok";
  `;
  return osa(js);
}

/** FC_MENU_CTL のファイルに命令を書き、FC_PERF_LOG に結果の行が出るまで待つ */
async function ctl(ctlFile: string, perf: string, req: Record<string, string>): Promise<{ lines?: string[]; ok?: boolean; error?: string }> {
  const fs = await import("node:fs");
  const n = `${Date.now()}-${Math.random()}`;
  fs.writeFileSync(ctlFile, JSON.stringify({ n, ...req }));
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const hit = fs.readFileSync(perf, "utf8").split("\n").filter((l) => l.includes('"menu-ctl"')).map((l) => JSON.parse(l)).find((o) => o.req?.n === n);
    if (hit) return hit.res;
  }
  throw new Error("10秒待っても結果が無い（FC_MENU_CTL と FC_PERF_LOG を付けて起動した開発版か）");
}

/** アプリの中から読んだ行を、木と同じ書き方にする（隠れた代わりの項目を除き、押せるかを外す） */
export function ctlLines(lines: string[]): string[] {
  return lines.filter((l) => !l.endsWith("\thidden")).map((l) => (l.startsWith("# ") || l === "---" ? l : l.split("\t").slice(0, 2).join("\t")));
}

if (import.meta.main && process.argv[2]?.startsWith("ctl-")) {
  const [cmd, ctlFile, perf, ...rest] = process.argv.slice(2);
  if (!ctlFile || !perf) { console.error("使い方: bun scripts/menu-ax.ts ctl-dump|ctl-check <ctl> <perf> / ctl-press <ctl> <perf> <メニュー> <項目>"); process.exit(2); }
  const res = cmd === "ctl-press" ? await ctl(ctlFile, perf, { op: "press", menu: rest[0], item: rest[1] }) : await ctl(ctlFile, perf, { op: "dump" });
  if (res.error) { console.error(res.error); process.exit(1); }
  if (cmd === "ctl-press") console.log("ok");
  else if (cmd === "ctl-dump") console.log((res.lines ?? []).join("\n"));
  else {
    const d = diff(treeLines(), ctlLines(res.lines ?? []));
    console.log(d.length ? d.join("\n") : "木と実物が同じ");
    process.exit(d.length ? 1 : 0);
  }
} else if (import.meta.main) {
  const [cmd, pidArg, ...rest] = process.argv.slice(2);
  const pid = Number(pidArg);
  if (!cmd || !Number.isInteger(pid) || pid <= 1) {
    console.error("使い方: bun scripts/menu-ax.ts dump|check <pid> / press <pid> <メニュー> <項目>");
    process.exit(2);
  }
  if (cmd === "dump") {
    console.log(lines(readMenus(pid), true).join("\n"));
  } else if (cmd === "check") {
    const d = diff(treeLines(), lines(readMenus(pid), false));
    console.log(d.length ? d.join("\n") : "木と実物が同じ");
    process.exit(d.length ? 1 : 0);
  } else if (cmd === "press") {
    console.log(press(pid, rest[0], rest[1]));
  } else {
    console.error(`知らない命令: ${cmd}`);
    process.exit(2);
  }
}
