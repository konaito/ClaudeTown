import { describe, expect, test } from "bun:test";
import type { Command } from "./commands";
import { skillStore } from "./skills";

const cmd = (name: string): Command => ({ name, description: name, source: "user" });
const names = (l: Command[]) => l.map((c) => c.name);

/** 手元の ~/.claude/skills の代わり。disk を書き換えると、次に読んだときの一覧が変わる */
function fakeDisk(first: string[]) {
  let disk = first;
  let calls = 0;
  let gate: Promise<void> | null = null;
  return {
    set: (l: string[]) => { disk = l; },
    hold() { let open!: () => void; gate = new Promise((r) => { open = r; }); return () => { gate = null; open(); }; },
    calls: () => calls,
    load: async (_cwd: string) => { calls++; const l = disk; if (gate) await gate; return l.map(cmd); },
  };
}

describe("skillStore", () => {
  test("起動後に足したスキルが、次に読み直したときに候補に出る", async () => {
    const d = fakeDisk(["a"]);
    const s = skillStore(d.load);
    await s.refresh("/w");
    expect(names(s.get("/w"))).toEqual(["a"]);
    d.set(["a", "product-agent-init"]);
    await s.refresh("/w");
    expect(names(s.get("/w"))).toEqual(["a", "product-agent-init"]);
  });

  test("消したスキルは、次に読み直したときに候補から消える", async () => {
    const d = fakeDisk(["a", "b"]);
    const s = skillStore(d.load);
    await s.refresh("/w");
    d.set(["a"]);
    await s.refresh("/w");
    expect(names(s.get("/w"))).toEqual(["a"]);
  });

  test("読んでいる間は前の一覧を出し、重ねて頼んでも Rust は1回だけ呼ぶ", async () => {
    const d = fakeDisk(["a"]);
    const s = skillStore(d.load);
    await s.refresh("/w");
    d.set(["a", "b"]);
    const release = d.hold();
    const p1 = s.refresh("/w");
    const p2 = s.refresh("/w");
    expect(names(s.get("/w"))).toEqual(["a"]);
    release();
    await Promise.all([p1, p2]);
    expect(d.calls()).toBe(2);
    expect(names(s.get("/w"))).toEqual(["a", "b"]);
  });

  test("中身が変わらなければ知らせない（開いている候補の並びと選択を動かさない）", async () => {
    const d = fakeDisk(["a"]);
    const s = skillStore(d.load);
    let n = 0;
    s.subscribe(() => { n++; });
    await s.refresh("/w");
    const before = s.get("/w");
    await s.refresh("/w");
    expect(n).toBe(1);
    expect(s.get("/w")).toBe(before);
  });

  test("読めなかったときは前の一覧を残す", async () => {
    let fail = false;
    const s = skillStore(async () => { if (fail) throw new Error("x"); return [cmd("a")]; });
    await s.refresh("/w");
    fail = true;
    await s.refresh("/w");
    expect(names(s.get("/w"))).toEqual(["a"]);
  });

  test("作業フォルダごとに別の一覧を持つ", async () => {
    const s = skillStore(async (cwd) => [cmd(cwd === "/x" ? "x" : "y")]);
    await Promise.all([s.refresh("/x"), s.refresh("/y")]);
    expect(names(s.get("/x"))).toEqual(["x"]);
    expect(names(s.get("/y"))).toEqual(["y"]);
  });
});
