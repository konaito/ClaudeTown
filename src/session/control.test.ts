import { describe, expect, test } from "bun:test";
import { CCN_NO_EFFORT, configureError, modelOptions, modeOptions, NO_SUPPORT, planOf, routeOf, supportOf } from "./control";
import { cancel, pendingOf, reserve } from "../webReserve";

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
  test("新しいノードでセッションが無い 404 は、ノードの印にしない（ccn の must() の本文）", () => {
    expect(supportOf({ status: 404, body: { error: "unknown session" } })).toBe("unknown");
  });
  test("中継の失敗やブラウザ表示の仮の値は、分からないとする", () => {
    expect(supportOf({ status: 502, body: { error: "peer unreachable" } })).toBe("unknown");
    expect(supportOf("ブラウザ表示")).toBe("unknown");
    expect(supportOf(null)).toBe("unknown");
  });
});

type A = Parameters<typeof planOf>[0];
const app = (state: A["state"]): A => ({ kind: "terminal", source: "app", state, name: "x", capabilities: { terminal: true, send: true } });
const ccn = (kind: A["kind"], state: A["state"]): A => ({ kind, source: "ccn", state, name: "x" });

describe("planOf（いつ当てるか）", () => {
  test("アプリの端末: モデルは作業中でもすぐ替える（/model は待たされずに効く、2026-11-21 に実機で確かめた）", () => {
    expect(planOf(app("idle"), "model", "sonnet", "no", false)).toEqual({ kind: "now" });
    expect(planOf(app("running"), "model", "sonnet", "no", false)).toEqual({ kind: "now" });
  });
  test("アプリの端末: 作業中に選んだモードは予約し、ターンの終わりに替える", () => {
    const p = planOf(app("running"), "mode", "acceptEdits", "no", false);
    expect(p.kind).toBe("wait");
    expect(p.kind === "wait" && p.when).toContain("ターンが終わったら");
    expect(planOf(app("idle"), "mode", "acceptEdits", "no", false)).toEqual({ kind: "now" });
  });
  test("アプリの端末: 承認待ちに選んだものは、モデルもモードも予約する（入力が承認の画面に入るため）", () => {
    for (const what of ["model", "mode"] as const) {
      const p = planOf(app("waiting_permission"), what, "plan", "no", false);
      expect(p.kind === "wait" && p.when).toContain("承認に答えたら");
    }
  });
  test("アプリの端末: dontAsk は Shift+Tab の順に無いので、届かないと出す", () => {
    const p = planOf(app("idle"), "mode", "dontAsk", "no", false);
    expect(p.kind === "none" && p.why).toContain("--permission-mode dontAsk");
  });
  test("ccn の node は承認待ちのほかはすぐ、承認待ちは予約", () => {
    expect(planOf(ccn("node", "idle"), "model", "sonnet", "yes", false)).toEqual({ kind: "now" });
    expect(planOf(ccn("node", "running"), "mode", "plan", "yes", false)).toEqual({ kind: "now" });
    expect(planOf(ccn("node", "waiting_permission"), "mode", "plan", "yes", false).kind).toBe("wait");
  });
  test("ccn の pty は作業中と承認待ちは予約し、待機で替える（起動し直すため）", () => {
    const p = planOf(ccn("pty", "running"), "model", "sonnet", "yes", false);
    expect(p.kind === "wait" && p.when).toContain("ターンが終わったら");
    expect(planOf(ccn("pty", "waiting_permission"), "model", "sonnet", "yes", false).kind).toBe("wait");
    expect(planOf(ccn("pty", "idle"), "model", "sonnet", "yes", false)).toEqual({ kind: "now" });
  });
  test("ccn: 確かめている最中と替えている最中は予約、古いノードは口が無い", () => {
    expect(planOf(ccn("node", "idle"), "model", "sonnet", "unknown", false).kind).toBe("wait");
    expect(planOf(ccn("node", "idle"), "model", "sonnet", "yes", true).kind).toBe("wait");
    expect(planOf(ccn("node", "idle"), "model", "sonnet", "no", false)).toEqual({ kind: "none", why: NO_SUPPORT });
  });
  test("外から届ける口が無いセッションは、選べるが代わりの手を出す", () => {
    const native: A = { kind: "terminal", source: "native", state: "running", name: "x" };
    const m = planOf(native, "model", "haiku", "no", false);
    expect(m.kind === "none" && m.why).toContain("/model haiku を打つ");
    const mode = planOf(native, "mode", "plan", "no", false);
    expect(mode.kind === "none" && mode.why).toContain("/plan");
    const ccnTerm = planOf(ccn("terminal", "idle"), "mode", "acceptEdits", "yes", false);
    expect(ccnTerm.kind === "none" && ccnTerm.why).toContain("Shift+Tab で acceptEdits");
    const mate = planOf({ kind: "teammate", source: "native", state: "idle", name: "x" }, "model", "haiku", "no", false);
    expect(mate.kind === "none" && mate.why).toContain("起動のときに決まり");
    const sub = planOf({ kind: "subagent", state: "idle", name: "x" }, "mode", "plan", "no", false);
    expect(sub.kind === "none" && sub.why).toContain("sub-agent");
  });
  test("effort: アプリの端末は作業中でもすぐ替え、承認待ちは予約する（/effort のピッカーは作業中も開いた、2026-11-23）", () => {
    expect(planOf(app("running"), "effort", "high", "no", false)).toEqual({ kind: "now" });
    expect(planOf(app("idle"), "effort", "low", "no", false)).toEqual({ kind: "now" });
    expect(planOf(app("waiting_permission"), "effort", "max", "no", false).kind).toBe("wait");
  });
  test("effort: ccn の行には替える口が無い", () => {
    for (const kind of ["node", "pty"] as const) expect(planOf(ccn(kind, "idle"), "effort", "high", "yes", false)).toEqual({ kind: "none", why: CCN_NO_EFFORT });
  });
  test("effort: 外のセッションには、値を付けずにピッカーで s を押す手を出す（値を付けると既定まで替わる）", () => {
    const native: A = { kind: "terminal", source: "native", state: "idle", name: "x" };
    const p = planOf(native, "effort", "xhigh", "no", false);
    expect(p.kind === "none" && p.why).toContain("/effort を開き、xhigh に動かして s を押す");
    const mate = planOf({ kind: "teammate", source: "native", state: "idle", name: "x" }, "effort", "low", "no", false);
    expect(mate.kind === "none" && mate.why).toContain("effort");
  });
  test("アプリの行でも端末が無ければ（capabilities.terminal が無い）口が無い", () => {
    expect(routeOf({ kind: "terminal", source: "app", capabilities: null })).toBe("none");
    expect(routeOf(app("idle"))).toBe("app");
    expect(routeOf(ccn("pty", "idle"))).toBe("ccn");
  });
});

describe("予約（ccn の行、src/webReserve.ts）", () => {
  test("作業中に選ぶと予約が残り、今の値を選び直すと取り消せる", () => {
    reserve("s1", "model", "haiku");
    reserve("s1", "mode", "plan");
    expect(pendingOf("s1")).toEqual({ model: "haiku", mode: "plan" });
    cancel("s1", "model");
    expect(pendingOf("s1")).toEqual({ mode: "plan" });
    cancel("s1", "mode");
    expect(pendingOf("s1")).toEqual({});
  });
  test("予約し直すと新しい値で上書きする", () => {
    reserve("s2", "model", "haiku");
    reserve("s2", "model", "opus");
    expect(pendingOf("s2")).toEqual({ model: "opus" });
    cancel("s2", "model");
  });
  test("待機になったら当てる（予約が当たる条件は planOf の now）", () => {
    reserve("s3", "model", "sonnet");
    expect(planOf(ccn("pty", "running"), "model", pendingOf("s3").model!, "yes", false).kind).toBe("wait");
    expect(planOf(ccn("pty", "idle"), "model", pendingOf("s3").model!, "yes", false).kind).toBe("now");
    cancel("s3", "model");
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
    expect(configureError({ status: 404, body: { error: "unknown session" } })).toContain("見つからなかった");
  });
});

describe("選択肢", () => {
  test("今の値が id なら先頭に足す", () => {
    expect(modelOptions("claude-sonnet-5-5").map((m) => m.value)).toEqual(["claude-sonnet-5-5", "opus", "sonnet", "haiku"]);
    expect(modelOptions("claude-sonnet-5-5")[0].label).toBe("sonnet-5-5");
    expect(modelOptions("sonnet").map((m) => m.value)).toEqual(["opus", "sonnet", "haiku"]);
    expect(modelOptions(null).map((m) => m.value)).toEqual(["opus", "sonnet", "haiku"]);
  });
  test("知らないモードも出す", () => {
    expect(modeOptions("plan")[0].value).toBe("default");
    expect(modeOptions("newMode")[0].value).toBe("newMode");
  });
});
