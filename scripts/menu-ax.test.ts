import { describe, expect, test } from "bun:test";
import { diff, keyLabel } from "./menu-ax";

describe("menu-ax（#300）", () => {
  test("AX の修飾キーを macOS の書き方にする", () => {
    expect(keyLabel("N", 0)).toBe("⌘N");
    expect(keyLabel("O", 1)).toBe("⇧⌘O");
    expect(keyLabel("H", 2)).toBe("⌥⌘H");
    expect(keyLabel("S", 4)).toBe("⌃⌘S");
    expect(keyLabel("F", 4)).toBe("⌃⌘F");
    expect(keyLabel(null, 0)).toBe("");
    expect(keyLabel("x", 8)).toBe("X");
  });

  test("最初の題は比べず、片方だけの行を出す", () => {
    const want = ["# Claude Town Dev", "設定…\t⌘,", "# 編集", "コピー\t⌘C"];
    expect(diff(want, ["# family-computing", "設定…\t⌘,", "# 編集", "コピー\t⌘C"])).toEqual([]);
    expect(diff(want, ["# family-computing", "設定…\t⌘,", "# 編集", "コピー\t⌘C", "音声入力を開始\t"])).toEqual(["+ 実物だけ: 音声入力を開始\t"]);
    expect(diff(want, ["# x", "# 編集", "コピー\t⌘C"])).toEqual(["- 木だけ: 設定…\t⌘,"]);
  });
});
