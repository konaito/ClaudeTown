import { describe, expect, test } from "bun:test";
import { confirmKeyAction } from "./keys";

describe("confirmKeyAction（#170）", () => {
  test("Enter で、フォーカスが「やめる」にあれば cancel", () => {
    expect(confirmKeyAction("Enter", true)).toBe("cancel");
  });

  test("Enter で、フォーカスが「やめる」以外（進めるボタンかボタン以外）なら confirm", () => {
    expect(confirmKeyAction("Enter", false)).toBe("confirm");
  });

  test("Esc はフォーカスの場所に関係なく cancel", () => {
    expect(confirmKeyAction("Escape", true)).toBe("cancel");
    expect(confirmKeyAction("Escape", false)).toBe("cancel");
  });

  test("ほかのキーは何もしない（Tab や Space はブラウザの既定に任せる）", () => {
    expect(confirmKeyAction("Tab", true)).toBeNull();
    expect(confirmKeyAction(" ", false)).toBeNull();
    expect(confirmKeyAction("a", false)).toBeNull();
  });
});
