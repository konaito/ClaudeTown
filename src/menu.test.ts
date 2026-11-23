import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MENU_IDS, isMenuId, sameMenuState } from "./menu";

// Rust の menu.rs の自前の項目の id（pub(crate) const X: &str = "..."）。repo は Rust が自分で開くので画面には来ない
const rust = readFileSync(join(import.meta.dir, "../src-tauri/src/menu.rs"), "utf8");
const rustIds = [...rust.matchAll(/^pub\(crate\) const [A-Z_]+: &str = "([a-z-]+)";$/gm)].map((m) => m[1]).filter((id) => id !== "menu");

describe("メニューの id（#300）", () => {
  test("Rust の定数と画面の一覧が同じ", () => {
    expect(rustIds.length).toBeGreaterThan(10);
    expect([...MENU_IDS as readonly string[]].sort()).toEqual(rustIds.filter((id) => id !== "repo").sort());
  });

  test("知らない id と文字列でない値は受けない", () => {
    expect(isMenuId("settings")).toBe(true);
    expect(isMenuId("repo")).toBe(false);
    expect(isMenuId("quit")).toBe(false);
    expect(isMenuId(1)).toBe(false);
  });

  test("状態は4つの値で比べる", () => {
    const a = { selected: true, terminal: false, sidebar: true, update: null };
    expect(sameMenuState(a, { ...a })).toBe(true);
    expect(sameMenuState(a, { ...a, update: false })).toBe(false);
    expect(sameMenuState(a, { ...a, terminal: true })).toBe(false);
  });
});
