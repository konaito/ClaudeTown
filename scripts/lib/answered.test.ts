import { describe, expect, test } from "bun:test";
import { answered, plainLines, PROMPT } from "./answered";

const answer = Array.from({ length: 40 }, (_, i) => `${i + 1}. 一言${i + 1}`).join("\r\n");

describe("answered", () => {
  test("入力欄に打った依頼文が画面に返っただけなら false", () => {
    expect(answered(`\x1b[2K\x1b[1G> ${PROMPT}\r\n`)).toBe(false);
    expect(answered(PROMPT)).toBe(false);
  });

  test("依頼文の 40 の前後に制御列が入っても false", () => {
    expect(answered(`> 1から\x1b[31m40\x1b[39mまで、1行に1つずつ`)).toBe(false);
    expect(answered(`> 1から\x1b[3;5H40まで`)).toBe(false);
  });

  test("40 行の答えがあれば true", () => {
    expect(answered(`> ${PROMPT}\r\n⏺ ${answer}\r\n`)).toBe(true);
  });

  test("答えの行が制御列で飾られていても true", () => {
    expect(answered(`\x1b[11;3H\x1b[1m39.\x1b[22m もうすぐ\x1b[12;3H\x1b[1m40.\x1b[22m おしまい`)).toBe(true);
    expect(answered(`  39 もうすぐ\r\n  40 おしまい\r\n`)).toBe(true);
    expect(answered(`⏺ 39、もうすぐ\r\n40、おしまい`)).toBe(true);
    expect(answered(`39.\x1b[1Cもうすぐ\x1b[2;1H40.\x1b[1Cおしまい`)).toBe(true);
  });

  test("39 行で止まった答えや、40 で始まらない行は false", () => {
    const partial = answer.split("\r\n").slice(0, 39).join("\r\n");
    expect(answered(`> ${PROMPT}\r\n${partial}\r\n`)).toBe(false);
    expect(answered(`140. 多すぎ\r\n40% context left`)).toBe(false);
  });

  test("カーソルを動かした先に 40 で始まる表示（トークン数など）が出ただけなら false", () => {
    expect(answered(`\x1b[5;30H40 tokens`)).toBe(false);
    expect(answered(`\x1b[5;30H40 tokens\x1b[6;1H39. もうすぐ`)).toBe(false);
    expect(answered(`> ${PROMPT}\r\n\x1b[30;2H40 tokens · esc to interrupt`)).toBe(false);
  });
});

describe("plainLines", () => {
  test("カーソルの移動と \\r を行の切れ目にし、色と OSC は消し、右送りは空白にする", () => {
    expect(plainLines("a\x1b[1;1Hb\rc\x1b]0;title\x07d\x1b[1mx\x1b[0m\x1b[1Cy").filter(Boolean)).toEqual(["a", "b", "cdx y"]);
  });
});
