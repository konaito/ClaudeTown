import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULTS_KEY, loadDefaults, NO_DEFAULTS, parseDefaults, saveDefaults } from "./defaults";

describe("parseDefaults", () => {
  test("候補にある値だけを読む", () => {
    expect(parseDefaults(JSON.stringify({ model: "sonnet", permissionMode: "plan" }))).toEqual({ model: "sonnet", permissionMode: "plan" });
    expect(parseDefaults(JSON.stringify({ model: "gpt", permissionMode: "yolo" }))).toEqual(NO_DEFAULTS);
    expect(parseDefaults(JSON.stringify({ model: "opus" }))).toEqual({ model: "opus", permissionMode: null });
  });
  test("空、壊れた JSON、オブジェクトでない値は設定なし", () => {
    for (const raw of [null, "", "{", "1", "null", '"opus"']) expect(parseDefaults(raw)).toEqual(NO_DEFAULTS);
  });
});

describe("loadDefaults / saveDefaults", () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  afterEach(() => mem.clear());
  test("保存して読み戻せる。両方 null で消える", () => {
    expect(loadDefaults()).toEqual(NO_DEFAULTS);
    saveDefaults({ model: "haiku", permissionMode: "acceptEdits" });
    expect(loadDefaults()).toEqual({ model: "haiku", permissionMode: "acceptEdits" });
    saveDefaults(NO_DEFAULTS);
    expect(mem.has(DEFAULTS_KEY)).toBe(false);
  });
});
