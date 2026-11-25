import { describe, expect, test } from "bun:test";
import { accountText, cardNames, houseNameOf, moodOf, projectFromPath, statusClass, statusLabel, targetLabel, taskOf, type Agent, type Report, type Who } from "./model";
import cases from "./naming-cases.json";
import reportCases from "./report-cases.json";

const ag = (id: string, cwd: string, over: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: "terminal", state: "idle", cwd, canSend: true, parent: null, ...over,
});

// src-tauri/src/naming.rs の shared_cases と同じ事例
describe("cardNames（src/naming-cases.json）", () => {
  // JSON の推論型は、事例ごとに無いキーを ?: undefined にするので Partial で受ける
  for (const c of cases as { name: string; sessions: Who[]; expect: Partial<Record<string, string>> }[]) {
    test(c.name, () => {
      const got = cardNames(c.sessions);
      for (const [id, want] of Object.entries(c.expect)) expect(got.get(id)).toBe(want);
    });
  }
});

describe("プロジェクトの名前", () => {
  test("worktree はパスの形でも本体の名前", () => {
    expect(projectFromPath("/Users/x/Documents/family-computing.wt/chat")).toBe("family-computing");
    expect(projectFromPath("/a/b/")).toBe("b");
    expect(projectFromPath("/a/.wt/x")).toBe("x");
  });
});

describe("houseNameOf", () => {
  test("根のカードの名前（親のプロジェクトの名前）", () => {
    const root = ag("r", "/Users/x/Documents/family-computing", { name: "family-computing" });
    expect(houseNameOf(root)).toBe("family-computing");
  });
  test("親が meta なら世帯の名前は meta。子のプロジェクトにはならない", () => {
    const names = cardNames([
      { id: "p", cwd: "/Users/x/Documents/meta" },
      { id: "c", cwd: "/Users/x/Documents/voice-clone", parent: "p" } as Who,
    ]);
    expect(houseNameOf(ag("p", "/Users/x/Documents/meta", { name: names.get("p")! }))).toBe("meta");
  });
});

describe("targetLabel", () => {
  test("同じ名前がいなければ名前だけ", () => {
    const a = ag("aaaaaaaa-1", "/tmp/a", { name: "a" });
    expect(targetLabel(a, [a, ag("bbbbbbbb-2", "/tmp/b", { name: "b" })])).toBe("a");
  });
  test("同じ名前がいたら ID の先頭8字を添える", () => {
    const a = ag("aaaaaaaa-1", "/tmp", { name: "tmp" });
    const b = ag("bbbbbbbb-2", "/tmp", { name: "tmp" });
    expect(targetLabel(a, [a, b])).toBe("tmp（aaaaaaaa）");
    expect(targetLabel(b, [a, b])).toBe("tmp（bbbbbbbb）");
  });
});

describe("アカウントの表示", () => {
  test("名前と email があれば「名前（email）」、email が無ければ名前だけ", () => {
    expect(accountText(ag("a", "/w", { account: "acct-a", accountEmail: "a@example.invalid" }))).toBe("acct-a（a@example.invalid）");
    expect(accountText(ag("a", "/w", { account: "acct-a" }))).toBe("acct-a");
  });
  test("アカウントが無い（古い ccn、選べなかったセッション）なら null", () => {
    expect(accountText(ag("a", "/w"))).toBeNull();
    expect(accountText(ag("a", "/w", { account: null, accountEmail: "a@example.invalid" }))).toBeNull();
  });
});

// 完了のカードは、状態の行（statusLabel）が「完了」を出す。上の札（taskOf）は作業の題を出し、「完了」を2回出さない（#302）
describe("完了のカードの上の札（#302）", () => {
  test("題（asked）があれば題を出し、「完了」は状態の行だけ", () => {
    const a = ag("a", "/w", { report: { asked: "カードの寄りを直して", said: "直した" } });
    expect(taskOf(a, "done")).toBe("カードの寄りを直して");
    expect(statusLabel(a, "done")).toBe("完了");
  });
  test("題が無ければ、待機と同じ既定の文（親は「全体をまとめる」、子は「おてつだい」）", () => {
    for (const a of [ag("p", "/w"), ag("c", "/w", { parent: "p" })]) {
      expect(taskOf(a, "done")).not.toBe("完了");
      expect(taskOf(a, "done")).toBe(taskOf(a, "idle"));
    }
    expect(taskOf(ag("p", "/w"), "done")).toBe("全体をまとめる");
    expect(taskOf(ag("c", "/w", { parent: "p" }), "done")).toBe("おてつだい");
  });
});

describe("起動中の札", () => {
  test("起動中は様子に関係なく「起動中」と回る輪", () => {
    expect(statusLabel({ booting: true }, "idle")).toBe("起動中");
    expect(statusClass({ booting: true }, "idle")).toBe("st st-idle st-boot");
    expect(statusLabel({}, "idle")).toBe("待機");
    expect(statusClass({ booting: false }, "working")).toBe("st st-working");
  });
});

// 承認の画面を理由なしの No か Esc で閉じると、hook は何も来ず、状態ファイルは needs_you のまま残る（#180）。
// 時刻は 2026-11-23 の実測（Esc の回）。状態ファイルの updated_at は Notification の時刻、sessions の updatedAt は Esc の後に idle へ変わった時刻
describe("承認を断った後の様子（#180）", () => {
  const caseOf = (name: string) => (reportCases as { name: string; state: Report }[]).find((c) => c.name === name)!.state;
  const denied = { ...caseOf("承認の画面を No か Esc で閉じた（この後に hook は来ない）"), updated_at: 1795364494292 };
  const asking = { ...caseOf("問いかけで止まる"), updated_at: 1795364494292 };

  test("断った後に status が idle へ変わったら、返事待ちにしない", () => {
    expect(moodOf(ag("a", "/w", { report: denied, state: "idle", lastActivityAt: 1795364498158 }))).toBe("idle");
  });

  test("承認の画面が出ている間は承認待ち", () => {
    expect(moodOf(ag("a", "/w", { report: denied, state: "waiting_permission", lastActivityAt: 1795364489000 }))).toBe("approval");
  });

  test("status が報告より後に変わっていなければ、返事待ちのまま（休んだリードの端末に出たチームメイトの承認）", () => {
    expect(moodOf(ag("a", "/w", { report: denied, state: "idle", lastActivityAt: 1795364400000 }))).toBe("reply");
    expect(moodOf(ag("a", "/w", { report: denied, state: "idle" }))).toBe("reply");
  });

  test("Stop の問いかけは、status が後で変わっても返事待ち", () => {
    expect(moodOf(ag("a", "/w", { report: asking, state: "idle", lastActivityAt: 1795364498158 }))).toBe("reply");
  });

  test("status を持たない tmux のチームメイトは、今までどおり返事待ち", () => {
    expect(moodOf(ag("a", "/w", { kind: "teammate", report: denied, state: "idle", lastActivityAt: 1795364498158 }))).toBe("reply");
  });
});
