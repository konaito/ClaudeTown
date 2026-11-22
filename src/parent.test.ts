import { describe, expect, test } from "bun:test";
import { parentOfCaller } from "./model";

// ブラウザ版（src/bridge.ts の snapshot）が from 行の呼び手から親を引く規則。
// Rust の agent_sid8（src-tauri/src/lib.rs）と、claude-code-nodes の identity/agent-name.ts の parseAgent と同じにする
const A = "0123abcd-0000-4000-8000-0000000000a1";
const R = "a2a2a2a2-0000-4000-8000-0000000000a2";
const ids = [A, R];

describe("from 行の呼び手から親を引く", () => {
  test("2つ目の区切りが16進の8文字で、後ろに役割があれば、その id を親にする", () => {
    expect(parentOfCaller("agent:vm/0123abcd/lead", ids)).toBe(A);
    expect(parentOfCaller("agent:vm/0123abcd/a/b", ids)).toBe(A);
  });

  test("役割が16進に見えても sid8 として読まない（ccn は id を知らないと agent:<ノード>/<役割> を付ける）", () => {
    expect(parentOfCaller("agent:vm/a2a2/r", ids)).toBeNull();
    expect(parentOfCaller("agent:vm/a2a2a2a2", ids)).toBeNull();
  });

  test("役割が空、ノードが空、sid8 が空なら親にしない", () => {
    expect(parentOfCaller("agent:vm/0123abcd/", ids)).toBeNull();
    expect(parentOfCaller("agent:/0123abcd/r", ids)).toBeNull();
    expect(parentOfCaller("agent:n//r", ids)).toBeNull();
  });

  test("大文字の16進、agent: で始まらない呼び手、文字列でないものは親にしない", () => {
    expect(parentOfCaller("agent:vm/0123ABCD/r", ids)).toBeNull();
    expect(parentOfCaller("agent:vm/lead", ids)).toBeNull();
    expect(parentOfCaller("someone@example.com", ids)).toBeNull();
    expect(parentOfCaller(null, ids)).toBeNull();
  });
});
