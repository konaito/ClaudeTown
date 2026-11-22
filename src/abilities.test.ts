import { describe, expect, test } from "bun:test";
import { NEW_HOUSE_CAPS, NO_CAPS, canAnswerPermission, canInterrupt, canStop, hasTerminal, type HasCaps } from "./abilities";

const ALL = { send: true, permissions: true, interrupt: true, stop: true, terminal: true };
type Want = { stop: boolean; interrupt: boolean; answer: boolean; term: boolean };
const yes: Want = { stop: true, interrupt: true, answer: true, term: true };
const no: Want = { stop: false, interrupt: false, answer: false, term: false };

const rows: [string, HasCaps, Want][] = [
  ["native（capabilities が無い）", {}, no],
  ["native（capabilities が null）", { capabilities: null }, no],
  ["agent が null（パネルを開いていない）", null, no],
  ["agent が undefined", undefined, no],
  ["全部 true", { capabilities: ALL }, yes],
  ["全部 false（native の合成の行 NO_CAPS）", { capabilities: NO_CAPS }, no],
  ["空のオブジェクト", { capabilities: {} }, no],
  ["新しい世帯の仮の値（端末、停止、割り込み）", { capabilities: NEW_HOUSE_CAPS }, { stop: true, interrupt: true, answer: false, term: true }],
  ["送信と停止だけ true", { capabilities: { send: true, stop: true } }, { stop: true, interrupt: false, answer: false, term: false }],
  ["承認だけ true", { capabilities: { permissions: true } }, { stop: false, interrupt: false, answer: true, term: false }],
  ["割り込みだけ true", { capabilities: { interrupt: true } }, { stop: false, interrupt: true, answer: false, term: false }],
  ["端末だけ true", { capabilities: { terminal: true } }, { stop: false, interrupt: false, answer: false, term: true }],
  ["想定外の型（文字列の true、1、オブジェクト）はできない", { capabilities: { stop: "true", permissions: 1, interrupt: "yes", terminal: {} } }, no],
];

describe("abilities", () => {
  for (const [name, a, want] of rows) {
    test(name, () => {
      expect({ stop: canStop(a), interrupt: canInterrupt(a), answer: canAnswerPermission(a), term: hasTerminal(a) }).toEqual(want);
    });
  }

  test("仮の capabilities の定数の値", () => {
    expect(NEW_HOUSE_CAPS).toEqual({ terminal: true, send: true, stop: true, interrupt: true });
    expect(NO_CAPS).toEqual({ send: false, permissions: false, interrupt: false, stop: false, terminal: false });
  });
});
