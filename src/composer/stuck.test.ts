import { describe, expect, test } from "bun:test";
import { stuckMs, stuckText } from "./stuck";

describe("止めるボタンの返事", () => {
  test("stuck: true なら戻っていない時間を返す", () => {
    expect(stuckMs({ stuck: true, stuckMs: 3300 })).toBe(3300);
    expect(stuckMs({ stuck: true })).toBe(0);
  });
  test("詰まっていない返事と古い形は null", () => {
    expect(stuckMs({ stuck: false })).toBeNull();
    expect(stuckMs(undefined)).toBeNull();
    expect(stuckMs(null)).toBeNull();
    expect(stuckMs({})).toBeNull();
    expect(stuckMs({ stuck: "true", stuckMs: 5000 })).toBeNull();
  });
  test("本文は秒に丸め、1秒より短く書かない", () => {
    expect(stuckText(3300)).toContain("3秒");
    expect(stuckText(0)).toContain("1秒");
  });
});
