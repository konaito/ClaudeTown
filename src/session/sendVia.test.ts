import { describe, expect, test } from "bun:test";
import { sendVia } from "./sendVia";
import { NEW_HOUSE_CAPS } from "../abilities";

// 値は Rust の town_rows が付ける capabilities と同じ形（lib.rs の app_caps、native/mod.rs の caps_with_send）
const APP_CAPS = { send: true, permissions: true, interrupt: true, stop: true, terminal: true };
const SOCKET_CAPS = { send: true, permissions: false, interrupt: false, stop: false, terminal: false };
const READ_ONLY_CAPS = { ...SOCKET_CAPS, send: false };

describe("sendVia", () => {
  test("Claude Town の外で起動した受信ソケットのある行は send_direct（Rust が受信ソケットで送る、#225）", () => {
    expect(sendVia({ kind: "terminal", source: "native", capabilities: SOCKET_CAPS }, true)).toBe("send_direct");
  });
  test("アプリが立てた端末は send_or_queue（起動前なら Rust が預かる）", () => {
    expect(sendVia({ kind: "terminal", source: "app", capabilities: APP_CAPS }, true)).toBe("send_or_queue");
    expect(sendVia({ kind: "terminal", source: "app", capabilities: APP_CAPS }, false)).toBe("send_or_queue");
  });
  test("一覧に載るまでの新しい世帯も send_or_queue", () => {
    expect(sendVia({ kind: "terminal", source: "app", capabilities: NEW_HOUSE_CAPS }, true)).toBe("send_or_queue");
  });
  test("受信ソケットの無い native の行も send_direct に回し、断る理由は Rust が返す", () => {
    expect(sendVia({ kind: "terminal", source: "native", capabilities: READ_ONLY_CAPS }, true)).toBe("send_direct");
  });
  test("ブラウザ版の ccn の行は、ふつうの文を send_message", () => {
    expect(sendVia({ kind: "terminal", source: "ccn", capabilities: APP_CAPS }, true)).toBe("send_message");
    expect(sendVia({ kind: "terminal", source: "ccn", capabilities: READ_ONLY_CAPS }, true)).toBe("send_message");
  });
  test("ブラウザ版の ccn の端末の行は、/ と ! の文だけ send_direct（入力欄へ貼る）", () => {
    expect(sendVia({ kind: "terminal", source: "ccn", capabilities: APP_CAPS }, false)).toBe("send_direct");
    expect(sendVia({ kind: "terminal", source: "ccn", capabilities: READ_ONLY_CAPS }, false)).toBe("send_message");
  });
});
