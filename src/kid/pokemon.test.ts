import { describe, expect, test } from "bun:test";
import LINES from "./pokemon-lines.json";
import { cropOf, lineOf, pokemonOf, spriteUrl } from "./pokemon";

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
  test("系統の一覧は #40 のときのまま（件数か並びが変わると、全世帯の系統が入れ替わる）", () => {
    const h = new Bun.CryptoHasher("sha256").update(JSON.stringify(LINES.lines)).digest("hex");
    expect(LINES.lines.length).toBe(116);
    expect(h).toBe("09daa9c7e7cbbc32ffcc229d2aa6a9fb3a4af752eed17b55e49e17016f2946f0");
  });
});

describe("ポケモンスキンの絵（2Dのドット絵）", () => {
  // JSON の推論型は number[] | string[] の和になるので、src/kid/pokemon.ts の ALL と同じ形を付ける
  const ids = [...new Set((LINES.lines as unknown as [number[], string[]][]).flatMap(([ids]) => ids))];
  const base = `https://raw.githubusercontent.com/PokeAPI/sprites/${LINES.sha}/sprites/pokemon/versions/generation-v/black-white`;
  test("全番号が、コミットで指したブラック・ホワイトのアニメか止め絵の URL になる", () => {
    expect(ids.length).toBe(348);
    expect(LINES.sha).toMatch(/^[0-9a-f]{40}$/);
    const still = new Set(LINES.still);
    for (const id of ids) {
      expect(spriteUrl(id)).toBe(still.has(id) ? `${base}/${id}.png` : `${base}/animated/${id}.gif`);
    }
    expect(spriteUrl(6)).toBe(`${base}/animated/6.gif`);
    expect(spriteUrl(906)).toBe(`${base}/906.png`);
  });
  test("止め絵の番号は38件で、どれも系統の中の番号", () => {
    expect(LINES.still.length).toBe(38);
    for (const id of LINES.still) expect(ids).toContain(id);
  });
  test("余白を切る矩形は、元の絵の中に収まる", () => {
    for (const id of ids) {
      const c = cropOf(id);
      if (!c) continue;
      const [x, y, w, h, W, H] = c;
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect(x + w).toBeLessThanOrEqual(W);
      expect(y + h).toBeLessThanOrEqual(H);
      expect(x === 0 && y === 0 && w === W && h === H).toBe(false);
    }
    expect(Object.keys(LINES.crop).length).toBe(71);
  });
});
