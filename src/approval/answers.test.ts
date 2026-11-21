import { describe, expect, test } from "bun:test";
import { answerText } from "./answers";

describe("answerText", () => {
  const one = { question: "色は？", options: [{ label: "赤" }, { label: "青" }] };
  const many = { ...one, multiSelect: true };
  test("単一選択は選んだ label、その他を書けばその文", () => {
    expect(answerText(one, { picked: ["青"], other: "" })).toBe("青");
    expect(answerText(one, { picked: ["青"], other: " 紫 " })).toBe("紫");
    expect(answerText(one, { picked: [], other: "  " })).toBe("");
  });
  test("複数選択は選んだ順に「, 」でつなぎ、その他を最後に足す", () => {
    expect(answerText(many, { picked: ["赤", "青"], other: "" })).toBe("赤, 青");
    expect(answerText(many, { picked: ["青"], other: "紫" })).toBe("青, 紫");
    expect(answerText(many, { picked: [], other: "" })).toBe("");
  });
});
