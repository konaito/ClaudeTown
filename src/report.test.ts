import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { moodOf, nowOf, taskOf, type Agent, type Report } from "./model";
import cases from "./report-cases.json";

// hooks/test_report_fixture.py が fc-report.py の実出力と突き合わせている見本。src-tauri/src/lib.rs の report_cases も同じものを読む
type Case = { name: string; events: unknown[]; state: Record<string, unknown> };

// Report に無く、hook だけが書くキー
const HOOK_ONLY = ["session_id", "asked_by", "cwd"];

// src/model.ts の Report のキー（型の本体の行から拾う）
const src = readFileSync(new URL("./model.ts", import.meta.url), "utf8");
const body = src.split("export type Report = {")[1].split("\n};")[0];
const REPORT_KEYS = body.split("\n").filter((l) => /^ {2}\w/.test(l)).map((l) => l.trim().split(/[?:]/)[0]);

const STR_OR_NULL = ["doing", "next", "needs"];
const STR = ["asked", "said"];
const NUM = ["tools", "turn_started_at", "updated_at", "pending_count"];
const PERM = ["tool", "summary", "detail", "id"];

const agentOf = (report: Report): Agent => ({ id: "a", name: "a", kind: "terminal", state: "idle", cwd: "/x", canSend: true, parent: null, report });

describe("Report の形（src/report-cases.json）", () => {
  test("model.ts の Report のキーを読めている", () => {
    expect(REPORT_KEYS.length).toBe(12);
    expect(REPORT_KEYS).toContain("perm_queue");
  });

  for (const c of cases as Case[]) {
    test(c.name, () => {
      const st = c.state;
      for (const k of Object.keys(st)) {
        expect(REPORT_KEYS.includes(k) || HOOK_ONLY.includes(k), `model.ts の Report に無いキー ${k}`).toBe(true);
      }
      expect(["working", "needs_you", "resting"]).toContain(st.phase as string);
      for (const k of STR) if (k in st) expect(typeof st[k]).toBe("string");
      for (const k of STR_OR_NULL) if (k in st) expect(["string", "object"]).toContain(typeof st[k]);
      for (const k of NUM) if (k in st) expect(typeof st[k]).toBe("number");
      const queue = (st.perm_queue ?? []) as Record<string, unknown>[];
      expect(Array.isArray(queue)).toBe(true);
      for (const p of queue) expect(Object.keys(p).sort()).toEqual([...PERM].sort());
      if (st.pending) expect(Object.keys(st.pending as object).sort()).toEqual([...PERM].sort());
      if ("perm_queue" in st) expect(st.pending_count).toBe(queue.length);
      // 画面が読む関数（moodOf、taskOf、nowOf）が、この形の report を扱える
      const a = agentOf(st as Report);
      const mood = moodOf(a);
      expect(typeof taskOf(a, mood)).toBe("string");
      const now = nowOf(a, mood);
      expect(now === null || typeof now === "string").toBe(true);
    });
  }
});
