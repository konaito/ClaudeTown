import { describe, expect, test } from "bun:test";
import AGES from "./ages.json";
import { fallbackChar, type Role } from "./Avatar";

describe("Rust の割り当てが無いときの代わりの選び方", () => {
  test("同じ seed なら同じキャラ", () => {
    expect(fallbackChar("child", "abc")).toBe(fallbackChar("child", "abc"));
  });
  test("世代の目標に近い点数のキャラが多く出る", () => {
    const ages = AGES.ages as Record<string, number>;
    for (const role of ["parent", "child", "grandchild"] as Role[]) {
      const n = 3000;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += ages[fallbackChar(role, `s${i}`)];
      // Rust の試験と同じく、表の端に寄るぶん目標から10点以内
      expect(Math.abs(sum / n - AGES.targets[role])).toBeLessThan(10);
    }
  });
});
