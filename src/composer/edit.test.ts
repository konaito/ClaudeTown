import { describe, expect, test } from "bun:test";
import { backslashNewline, histDown, histUp, killToEnd, killToStart, killWordBack, killWordForward, mergeHistory, rankCommands, searchHistory, tokenAt, toLineEnd, toLineStart, wordBack, wordForward } from "./edit";
import { BUILTINS, opensDialog } from "./commands";

const at = (text: string, i = text.length) => ({ text, start: i, end: i });

describe("readline のキー", () => {
  test("Ctrl+A と Ctrl+E は改行で区切った行の頭と末尾", () => {
    expect(toLineStart(at("ab\ncd", 4))).toBe(3);
    expect(toLineEnd(at("ab\ncd\nef", 3))).toBe(5);
  });
  test("Ctrl+K は行末まで、行末では改行を消す", () => {
    expect(killToEnd(at("abc\ndef", 1))).toEqual({ from: 1, to: 3, insert: "", killed: "bc" });
    expect(killToEnd(at("abc\ndef", 3))).toEqual({ from: 3, to: 4, insert: "", killed: "\n" });
    expect(killToEnd(at("abc"))).toBeNull();
  });
  test("Ctrl+U は行頭まで、続けて押すと前の行に進む", () => {
    expect(killToStart(at("abc\ndef", 6))).toEqual({ from: 4, to: 6, insert: "", killed: "de" });
    expect(killToStart(at("abc\ndef", 4))).toEqual({ from: 3, to: 4, insert: "", killed: "\n" });
  });
  test("Ctrl+W は空白まで消す。パスは1回で消える", () => {
    expect(killWordBack(at("open src/utils/foo.ts"))?.killed).toBe("src/utils/foo.ts");
    expect(killWordBack(at("a --flag=value  "))?.killed).toBe("--flag=value  ");
  });
  test("Alt+B と Alt+F は _ . / で区切る", () => {
    const t = "src/utils/foo.ts";
    expect(wordBack(at(t))).toBe(14);
    expect(wordBack(at(t, 14))).toBe(10);
    expect(wordForward(at(t, 0))).toBe(3);
    expect(wordForward(at(t, 3))).toBe(9);
    expect(killWordForward(at(t, 3))?.killed).toBe("/utils");
  });
  test("日本語でも1語ずつ動く", () => {
    const t = "今日は良い天気です";
    const p = wordForward(at(t, 0));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(t.length);
  });
  test("\\ の直後の Enter は改行になる", () => {
    expect(backslashNewline(at("abc\\"))).toEqual({ from: 3, to: 4, insert: "\n" });
    expect(backslashNewline(at("abc"))).toBeNull();
  });
});

describe("補完の語", () => {
  test("/ は文の頭と空白の後", () => {
    expect(tokenAt(at("/com"))).toEqual({ kind: "slash", query: "com", from: 0, to: 4, atStart: true });
    expect(tokenAt(at("run tests, then /com"))?.atStart).toBe(false);
    expect(tokenAt(at("a/b"))).toBeNull();
  });
  test("@ はファイル。! のシェルモードでは / を補完しない", () => {
    expect(tokenAt(at("look @src/Ap"))).toEqual({ kind: "file", query: "src/Ap", from: 5, to: 12, atStart: false });
    expect(tokenAt(at("!ls /us"))).toBeNull();
  });
  test("コマンドは名前の頭が合うものを先に出す", () => {
    const r = rankCommands(BUILTINS, "co");
    expect(r[0].name.startsWith("co")).toBe(true);
    expect(r.every((c) => c.name.includes("co") || c.aliases?.some((a) => a.startsWith("co")))).toBe(true);
  });
  test("画面を開くコマンド", () => {
    expect(opensDialog("/model", BUILTINS)).toBe(true);
    expect(opensDialog("/model opus", BUILTINS)).toBe(false);
    expect(opensDialog("/permissions", BUILTINS)).toBe(true);
    expect(opensDialog("/compact", BUILTINS)).toBe(false);
    expect(opensDialog("hello", BUILTINS)).toBe(false);
  });
});

describe("履歴", () => {
  test("上で古いほうへ、下で打ちかけの文に戻る", () => {
    const list = ["new", "old"];
    const a = histUp({ index: -1, draft: "" }, list, "draft")!;
    expect(a.text).toBe("new");
    const b = histUp(a.st, list, a.text)!;
    expect(b.text).toBe("old");
    expect(histUp(b.st, list, b.text)).toBeNull();
    const c = histDown(b.st, list)!;
    const d = histDown(c.st, list)!;
    expect(d.text).toBe("draft");
    expect(histDown(d.st, list)).toBeNull();
  });
  test("Ctrl+R は古いほうへ探す", () => {
    const list = ["git push", "bun test", "git status"];
    expect(searchHistory(list, "git")).toBe(0);
    expect(searchHistory(list, "git", 1)).toBe(2);
    expect(searchHistory(list, "zzz")).toBe(-1);
  });
  test("手元の分を先にして重ねる", () => {
    expect(mergeHistory(["b", "a"], ["a", "c"])).toEqual(["b", "a", "c"]);
  });
});

describe("組み込みのコマンド", () => {
  test("別名でも引ける", () => {
    expect(rankCommands(BUILTINS, "reset")[0].name).toBe("clear");
    expect(opensDialog("/settings", BUILTINS)).toBe(true);
  });
  test("名前が重ならない", () => {
    expect(new Set(BUILTINS.map((c) => c.name)).size).toBe(BUILTINS.length);
  });
});
