import { describe, expect, test } from "bun:test";
import { acceptFile, backslashNewline, insertPaths, isSlashCommand, quotePath, histDown, histUp, killToEnd, killToStart, killWordBack, killWordForward, mergeHistory, rankCommands, searchHistory, tokenAt, toLineEnd, toLineStart, wordBack, wordForward } from "./edit";
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

describe("画像とファイルのパス（#64）", () => {
  test("空白や記号の前に \\ を付ける。日本語はそのまま", () => {
    expect(quotePath("/Users/a/Desktop/スクリーンショット 2026-11-13 9.15.30.png")).toBe("/Users/a/Desktop/スクリーンショット\\ 2026-11-13\\ 9.15.30.png");
    expect(quotePath("/tmp/a (1)/it's.png")).toBe("/tmp/a\\ \\(1\\)/it\\'s.png");
    expect(quotePath("/tmp/plain.png")).toBe("/tmp/plain.png");
  });
  test("前後の文とくっつかないよう空白を挟む", () => {
    expect(insertPaths({ text: "", start: 0, end: 0 }, ["/a.png"])).toEqual({ from: 0, to: 0, insert: "/a.png " });
    expect(insertPaths({ text: "これを見て", start: 5, end: 5 }, ["/a.png", "/b c.png"])).toEqual({ from: 5, to: 5, insert: " /a.png /b\\ c.png " });
    expect(insertPaths({ text: "見て  です", start: 3, end: 3 }, ["/a.png"])).toEqual({ from: 3, to: 3, insert: "/a.png" });
    expect(insertPaths({ text: "x", start: 0, end: 1 }, [])).toBeNull();
  });
});

describe("パスで始まる文はコマンドにしない（#64）", () => {
  test("最初の語に2つ目の / があればパス", () => {
    expect(isSlashCommand("/model")).toBe(true);
    expect(isSlashCommand("/compact 要点だけ")).toBe(true);
    expect(isSlashCommand("/")).toBe(true);
    expect(isSlashCommand("/Users/a/.family-computing/attachments/paste-1.png これ見て")).toBe(false);
    expect(isSlashCommand("/tmp/a\\ b.png")).toBe(false);
    expect(isSlashCommand("見て /model")).toBe(false);
  });
  test("パスの途中にカーソルがあっても、コマンドの補完を出さない", () => {
    const t = "/Users/a/x.png 見て";
    expect(tokenAt({ text: t, start: 3, end: 3 })).toBeNull();
    expect(tokenAt({ text: "/mo", start: 3, end: 3 })?.kind).toBe("slash");
  });
});

// @ の候補を選んだときに入れる文（#257）。CLI 2.1.330 で、空白を含むパスを1つのパスとして読むのは @"a b.txt" の形だけだった。
// @a b.txt と @a\ b.txt は a を読み、@'a b.txt' と閉じていない @"my dir/ は何も添付しなかった（claude -p で実測）
describe("@ の候補を選ぶ（#257）", () => {
  const pick = (text: string, f: string, i = text.length) => {
    const t = tokenAt(at(text, i));
    if (!t || t.kind !== "file") throw new Error("file の語ではない");
    return acceptFile(text, t, f);
  };
  test("空白を含むファイルは @\"...\" で囲み、後ろに空白を付ける", () => {
    expect(pick("see @a", "a b.txt")).toEqual({ text: 'see @"a b.txt" ', caret: 15 });
  });
  test("空白を含まないファイルは今までどおり囲まない", () => {
    expect(pick("see @ap", "src/App.tsx")).toEqual({ text: "see @src/App.tsx ", caret: 17 });
  });
  test("空白を含まないフォルダは囲まず、空白も付けない", () => {
    expect(pick("see @sr", "src/")).toEqual({ text: "see @src/", caret: 9 });
  });
  test("空白を含むフォルダは囲み、カーソルを閉じる \" の前に置く。続けて打つと中を選べる", () => {
    const r = pick("see @my", "my dir/");
    expect(r).toEqual({ text: 'see @"my dir/"', caret: 13 });
    // 続けて打った文の語は、閉じる " までを含む
    const typed = r.text.slice(0, r.caret) + "in" + r.text.slice(r.caret);
    expect(tokenAt(at(typed, r.caret + 2))).toEqual({ kind: "file", query: "my dir/in", from: 4, to: 16, atStart: false, quoted: true });
    expect(pick(typed, "my dir/inner.txt", r.caret + 2)).toEqual({ text: 'see @"my dir/inner.txt" ', caret: 24 });
  });
  test("囲んだ語の中では、空白のないパスを選んでも囲みを保つ", () => {
    expect(pick('@"sr', "src/a.ts")).toEqual({ text: '@"src/a.ts" ', caret: 12 });
  });
  test("後ろの文は残す。フォルダのときも後ろの空白を消さない", () => {
    expect(pick("see @sr and more", "src/", 7)).toEqual({ text: "see @src/ and more", caret: 9 });
    expect(pick("see @a and more", "a b.txt", 6)).toEqual({ text: 'see @"a b.txt" and more', caret: 15 });
  });
  test("全角の空白やタブも空白として囲む", () => {
    expect(pick("@x", "x\u3000y.txt").text).toBe('@"x\u3000y.txt" ');
    expect(pick("@x", "x\ty.txt").text).toBe('@"x\ty.txt" ');
  });
  test("\" を含むパスは @\"...\" で書けないので囲まない", () => {
    expect(pick("@a", 'a"b.txt').text).toBe('@a"b.txt ');
  });
  test("閉じる \" を探すのは同じ行の中だけ", () => {
    expect(tokenAt(at('@"my d\nrest"', 6))).toEqual({ kind: "file", query: "my d", from: 0, to: 6, atStart: true, quoted: true });
    expect(tokenAt(at('@"my\nd', 6))).toBeNull();
  });
  test("閉じた \" の後ろや、閉じる \" の無い行の後ろの文は語に入れない", () => {
    expect(tokenAt(at('see @"a b.txt" x'))?.query).toBeUndefined();
    expect(tokenAt(at('@"ab more text', 4))).toEqual({ kind: "file", query: "ab", from: 0, to: 4, atStart: true, quoted: true });
  });
});
