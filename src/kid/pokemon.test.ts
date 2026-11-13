import { describe, expect, test } from "bun:test";
import LINES from "./pokemon-lines.json";
import { lineOf, pokemonOf } from "./pokemon";

describe("ポケモンスキンの割り当て", () => {
  test("一覧は3段の系統だけで、図鑑番号と英名がそろっている", () => {
    expect(LINES.lines.length).toBeGreaterThan(100);
    for (const [ids, names] of LINES.lines) {
      expect(ids.length).toBe(3);
      expect(names.length).toBe(3);
    }
  });
  test("同じ世帯の親・子・孫は、同じ系統の3段目・2段目・1段目", () => {
    for (const root of ["aaaa-1", "bbbb-2", "c"]) {
      const l = lineOf(root);
      expect([pokemonOf(root, "grandchild").id, pokemonOf(root, "child").id, pokemonOf(root, "parent").id]).toEqual(l.ids);
    }
  });
  test("リザードンの系統なら、親がリザードン、子がリザード、孫がヒトカゲ", () => {
    const i = LINES.lines.findIndex(([, names]) => names[0] === "charmander");
    expect(LINES.lines[i]).toEqual([[4, 5, 6], ["charmander", "charmeleon", "charizard"]]);
    const root = Array.from({ length: 100000 }, (_, k) => `r${k}`).find((r) => lineOf(r).ids[0] === 4)!;
    expect(root).toBeDefined();
    expect(pokemonOf(root, "parent").name).toBe("charizard");
    expect(pokemonOf(root, "child").name).toBe("charmeleon");
    expect(pokemonOf(root, "grandchild").name).toBe("charmander");
  });
  test("同じ根なら何度引いても同じ系統", () => {
    expect(lineOf("root-x")).toEqual(lineOf("root-x"));
  });
  test("根が違えば、系統は散らばる", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => lineOf(`r${i}`).ids[0]));
    expect(seen.size).toBeGreaterThan(60);
  });
});
