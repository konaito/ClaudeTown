import { afterEach, describe, expect, test } from "bun:test";
import { checkPlace, loadPlace, PLACE_KEY, savePlace } from "./placeSetting";

const roots = ["/Users/k"];
const lobby = "/Users/k/.local/share/ccn/lobby";

describe("checkPlace", () => {
  test("roots の中の絶対パスは通り、末尾の / を落とす", () => {
    expect(checkPlace(" /Users/k/Documents/x/ ", roots, lobby)).toEqual({ ok: true, path: "/Users/k/Documents/x" });
    expect(checkPlace("/Users/k", roots, lobby)).toEqual({ ok: true, path: "/Users/k" });
  });
  test("空、相対パス、~ は断る", () => {
    for (const p of ["", "  ", "Documents/x", "~/Documents/x"]) expect(checkPlace(p, roots, lobby).ok).toBe(false);
  });
  test("roots の外は断る。似た名前の別の場所（/Users/kk）も外", () => {
    expect(checkPlace("/tmp/x", roots, lobby).ok).toBe(false);
    expect(checkPlace("/Users/kk/x", roots, lobby).ok).toBe(false);
  });
  test("受け口の中は断る", () => {
    expect(checkPlace(lobby, roots, lobby).ok).toBe(false);
    expect(checkPlace(`${lobby}/sub`, roots, lobby).ok).toBe(false);
  });
  test("roots が空なら範囲では断らない", () => {
    expect(checkPlace("/tmp/x", [], null)).toEqual({ ok: true, path: "/tmp/x" });
  });
});

describe("loadPlace / savePlace", () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  afterEach(() => mem.clear());
  test("保存して読み戻せる。null で消える", () => {
    expect(loadPlace()).toBeNull();
    savePlace("/Users/k/a");
    expect(loadPlace()).toBe("/Users/k/a");
    savePlace(null);
    expect(loadPlace()).toBeNull();
  });
  test("絶対パスでない値は設定なしとして読む", () => {
    mem.set(PLACE_KEY, "relative");
    expect(loadPlace()).toBeNull();
  });
});
