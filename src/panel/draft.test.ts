import { describe, expect, test } from "bun:test";
import { clearsDraft } from "./draft";

describe("送れた後に入力欄を空にするか（#182）", () => {
  test("入力欄から送り、入力欄が送った文のままなら空にする", () => {
    expect(clearsDraft("composer", "直して", "直して")).toBe(true);
  });
  test("選択肢のボタンから送ったときは、打ちかけの文を残す", () => {
    expect(clearsDraft("choice", "はい", "打ちかけの文")).toBe(false);
    expect(clearsDraft("choice", "はい", "")).toBe(false);
  });
  test("カードのボタンから送ったときは、打ちかけの文を残す", () => {
    expect(clearsDraft("card", "続けて", "打ちかけの文")).toBe(false);
  });
  test("送っている間に入力欄へ打ち足したら、その文を残す", () => {
    expect(clearsDraft("composer", "直して", "次の")).toBe(false);
    expect(clearsDraft("composer", "直して", "直して。それと")).toBe(false);
  });
  // #304: / の補完で Enter を押すと、入力欄は「/名前 」（末尾に空白）になり、送る文は trimEnd した「/名前」になる。
  // 末尾の空白で食い違うと入力欄が空にならず、次の Enter で同じ文がもう一度送られた
  test("/ の補完で選んだ文は、末尾の空白が違っても入力欄を空にする（#304）", () => {
    expect(clearsDraft("composer", "/ui-consistency", "/ui-consistency ")).toBe(true);
  });
  test("末尾の空白だけの違いでも、打ち足した文は残す（#304）", () => {
    expect(clearsDraft("composer", "/ui-consistency", "/ui-consistency foo")).toBe(false);
  });
});
