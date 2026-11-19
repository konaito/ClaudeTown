import { describe, expect, test } from "bun:test";
import { pickTown } from "./webTown";

const t = (name: string, n: number, self = false) => ({ name, self, n });

describe("pickTown（ブラウザ版の最初の町）", () => {
  test("子が最も多い町を選ぶ（入口のノードが空でも）", () => {
    expect(pickTown([t("incertotech", 0, true), t("konaito-pro", 9), t("vm", 2)], null)?.name).toBe("konaito-pro");
  });
  test("同数なら前回選んだ町", () => {
    expect(pickTown([t("incertotech", 3, true), t("konaito-pro", 3), t("vm", 1)], "konaito-pro")?.name).toBe("konaito-pro");
  });
  test("同数で前回が無ければ入口のノード", () => {
    expect(pickTown([t("konaito-pro", 0), t("incertotech", 0, true)], null)?.name).toBe("incertotech");
  });
  test("前回の町が少なければ多い町が勝つ", () => {
    expect(pickTown([t("incertotech", 0, true), t("konaito-pro", 5)], "incertotech")?.name).toBe("konaito-pro");
  });
  test("町が無ければ null", () => { expect(pickTown([], null)).toBeNull(); });
});
