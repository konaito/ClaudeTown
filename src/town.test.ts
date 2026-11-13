import { describe, expect, test } from "bun:test";
import { otherTownRetryMs } from "./town";

describe("otherTownRetryMs（#14）", () => {
  test("取れている町はいつもの間隔、失敗したら1分、続けて失敗したら5分", () => {
    expect(otherTownRetryMs(0, 15_000)).toBe(15_000);
    expect(otherTownRetryMs(1, 15_000)).toBe(60_000);
    expect(otherTownRetryMs(2, 15_000)).toBe(300_000);
    expect(otherTownRetryMs(9, 15_000)).toBe(300_000);
  });
});
