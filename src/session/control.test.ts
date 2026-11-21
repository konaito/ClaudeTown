import { describe, expect, test } from "bun:test";
import { configureError, lockReason, modelOptions, modeOptions, NO_SUPPORT, supportOf } from "./control";

describe("supportOf", () => {
  test("新しいノードは空の文を not_command で断る", () => {
    expect(supportOf({ status: 400, body: { error: "text must be a slash command, e.g. /compact", code: "not_command" } })).toBe("yes");
  });
  test("409 は新しいコードだけが返す", () => {
    expect(supportOf({ status: 409, body: { error: "session exited", hint: "resume" } })).toBe("yes");
  });
  test("古いノードは口が無いので 404（2026-11-21 に本番の 4323 で実測した本文）", () => {
    expect(supportOf({ status: 404, body: { error: "not found" } })).toBe("no");
  });
  test("中継の失敗やブラウザ表示の仮の値は、分からないとする", () => {
    expect(supportOf({ status: 502, body: { error: "peer unreachable" } })).toBe("unknown");
    expect(supportOf("ブラウザ表示")).toBe("unknown");
    expect(supportOf(null)).toBe("unknown");
  });
});

describe("lockReason", () => {
  test("node はいつでも替えられる（作業中も）", () => {
    expect(lockReason({ kind: "node", state: "idle" }, "yes", false)).toBeNull();
    expect(lockReason({ kind: "node", state: "running" }, "yes", false)).toBeNull();
  });
  test("pty は待機中だけ", () => {
    expect(lockReason({ kind: "pty", state: "idle" }, "yes", false)).toBeNull();
    expect(lockReason({ kind: "pty", state: "running" }, "yes", false)).toContain("作業中は替えられない");
  });
  test("承認待ちは、計画の確認を壊さないよう node も止める", () => {
    expect(lockReason({ kind: "node", state: "waiting_permission" }, "yes", false)).toContain("承認待ち");
    expect(lockReason({ kind: "pty", state: "waiting_permission" }, "yes", false)).toContain("承認待ち");
  });
  test("端末のセッションと古いノードは替えられない", () => {
    expect(lockReason({ kind: "terminal", state: "idle" }, "yes", false)).toContain("端末で起動");
    expect(lockReason({ kind: "node", state: "idle" }, "no", false)).toBe(NO_SUPPORT);
  });
  test("替えている最中は、pty だけ起動し直しと出す", () => {
    expect(lockReason({ kind: "pty", state: "idle" }, "yes", true)).toContain("起動し直している");
    expect(lockReason({ kind: "node", state: "idle" }, "yes", true)).toBe("替えている");
  });
});

describe("configureError", () => {
  test("成功は null", () => {
    expect(configureError({ status: 200, body: { id: "x", model: "sonnet" } })).toBeNull();
  });
  test("仕様書の断られ方に文言を付ける", () => {
    expect(configureError({ status: 409, body: { error: "session is busy", code: "busy" } })).toContain("止めてから替える");
    expect(configureError({ status: 409, body: { error: "session exited", hint: "resume" } })).toContain("終わっている");
    expect(configureError({ status: 409, body: { error: "model cannot be changed on this session", kind: "terminal" } })).toContain("terminal");
    expect(configureError({ status: 502, body: { error: "x", code: "restart_failed", rolledBack: true } })).toContain("前の設定に戻した");
    expect(configureError({ status: 502, body: { error: "x", code: "restart_failed", rolledBack: false } })).toContain("ターミナル");
    expect(configureError({ status: 400, body: { error: "model must be a model name" } })).toContain("model must be");
    expect(configureError({ status: 404, body: { error: "not found" } })).toBe(NO_SUPPORT);
  });
});

describe("選択肢", () => {
  test("今の値が id なら先頭に足す", () => {
    expect(modelOptions("claude-sonnet-5-5").map((m) => m.value)).toEqual(["claude-sonnet-5-5", "opus", "sonnet", "haiku"]);
    expect(modelOptions("sonnet").map((m) => m.value)).toEqual(["opus", "sonnet", "haiku"]);
    expect(modelOptions(null).map((m) => m.value)).toEqual(["opus", "sonnet", "haiku"]);
  });
  test("知らないモードも出す", () => {
    expect(modeOptions("plan")[0].value).toBe("default");
    expect(modeOptions("newMode")[0].value).toBe("newMode");
  });
});
