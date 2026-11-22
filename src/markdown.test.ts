import { expect, test } from "bun:test";
import { blocks } from "./Markdown";

test("区切りの行がある | の並びは表にする", () => {
  const bs = blocks("40 枚で測った結果：\n\n| 方式 | 正しく読めた明細 |\n|---|---|\n| Vision | 71% |\n| API | 96% |\n\n次の段落");
  const t = bs.find((b) => b.kind === "table");
  expect(t?.lines).toEqual(["| 方式 | 正しく読めた明細 |", "|---|---|", "| Vision | 71% |", "| API | 96% |"]);
  expect(bs.at(-1)).toEqual({ kind: "p", lines: ["次の段落"] });
});

test("区切りの行が無い | の並びは段落のまま", () => {
  const bs = blocks("| a | b |\n| c | d |");
  expect(bs).toEqual([{ kind: "p", lines: ["| a | b |", "| c | d |"] }]);
});
