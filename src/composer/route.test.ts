import { describe, expect, test } from "bun:test";
import { BUILTINS } from "./commands";
import { commandError, NO_COMMANDS, routeOf, tagOf } from "./route";

const kind = (r: ReturnType<typeof routeOf>) => r?.kind ?? null;

describe("routeOf", () => {
  test("/ で始まらない文は振り分けない", () => {
    expect(routeOf("こんにちは", "node", "yes")).toBeNull();
    expect(routeOf("!ls", "pty", "yes")).toBeNull();
  });
  test("5つは新しいノードなら command の口へ", () => {
    for (const k of ["node", "pty"] as const) {
      expect(kind(routeOf("/compact API の決めごとは残す", k, "yes"))).toBe("command");
      expect(kind(routeOf("/clear", k, "yes"))).toBe("command");
      expect(kind(routeOf("/context", k, "yes"))).toBe("command");
    }
    expect(kind(routeOf("/cost", "node", "yes"))).toBe("command");
    expect(kind(routeOf("/usage", "node", "yes"))).toBe("command");
  });
  test("別名は元の名前に直して送る", () => {
    expect(routeOf("/reset", "node", "yes")).toEqual({ kind: "command", name: "clear", text: "/clear", note: "ここから新しい会話になる" });
    expect(routeOf("/compact  残すもの", "pty", "yes")).toMatchObject({ text: "/compact  残すもの" });
  });
  test("pty の /cost と /usage は画面が開いて止まるので使えない", () => {
    expect(routeOf("/cost", "pty", "yes")).toMatchObject({ kind: "blocked" });
    expect(routeOf("/usage", "pty", "yes")).toMatchObject({ kind: "blocked" });
  });
  test("pty の /context は出力が端末にだけ出ると添える", () => {
    expect(routeOf("/context", "pty", "yes")).toMatchObject({ kind: "command", note: "出力は端末にだけ出る。ターミナルのタブで見る" });
    expect(routeOf("/context", "node", "yes")).toMatchObject({ kind: "command", note: null });
  });
  test("古いノードでは、node は使えないと出し、pty は今までどおり端末に貼る", () => {
    expect(routeOf("/compact", "node", "no")).toEqual({ kind: "blocked", reason: `/compact は${NO_COMMANDS}` });
    expect(kind(routeOf("/compact", "pty", "no"))).toBe("legacy");
  });
  test("/model、/exit、設定に書くもの、画面を開くものは送らない", () => {
    for (const t of ["/model", "/model sonnet", "/exit", "/quit", "/config", "/settings theme=dark", "/effort high", "/fast on", "/output-style x", "/logout", "/status", "/permissions", "/resume", "/mcp"]) {
      expect(kind(routeOf(t, "pty", "yes"))).toBe("blocked");
      expect(kind(routeOf(t, "node", "yes"))).toBe("blocked");
    }
  });
  test("引数があれば画面を開かないものと、5つ以外の組み込みとスキルは今までどおり", () => {
    expect(kind(routeOf("/resume abc", "pty", "yes"))).toBe("legacy");
    expect(kind(routeOf("/init", "pty", "yes"))).toBe("legacy");
    expect(kind(routeOf("/code-review high", "pty", "yes"))).toBe("legacy");
    expect(kind(routeOf("/my-skill 引数", "node", "yes"))).toBe("legacy");
  });
  test("人が端末で起動したセッションは、今までどおり", () => {
    expect(kind(routeOf("/compact", "terminal", "yes"))).toBe("legacy");
    expect(kind(routeOf("/model", "terminal", "yes"))).toBe("legacy");
  });
});

describe("tagOf", () => {
  const c = (n: string) => BUILTINS.find((x) => x.name === n)!;
  test("候補に印を付ける", () => {
    expect(tagOf(c("compact"), "node", "yes")?.text).toBe("実行");
    expect(tagOf(c("context"), "pty", "yes")?.text).toBe("実行・出力は端末");
    expect(tagOf(c("status"), "node", "yes")).toMatchObject({ text: "ここでは使えません", off: true });
    expect(tagOf(c("cost"), "pty", "yes")).toMatchObject({ text: "ここでは使えません", off: true });
    expect(tagOf(c("effort"), "pty", "yes")).toMatchObject({ off: true });
    expect(tagOf(c("resume"), "pty", "yes")).toMatchObject({ text: "引数が要る", off: false });
    expect(tagOf(c("init"), "pty", "yes")).toBeNull();
    expect(tagOf(c("compact"), "terminal", "yes")).toBeNull();
  });
});

describe("commandError", () => {
  test("断られ方に文言を付ける", () => {
    expect(commandError({ status: 200, body: { delivered: "stdin" } })).toBeNull();
    expect(commandError({ status: 404, body: { error: "not found" } })).toBe(NO_COMMANDS);
    expect(commandError({ status: 409, body: { code: "first_message_required" } })).toContain("最初の文");
    expect(commandError({ status: 409, body: { code: "persists" } })).toContain("保存");
    expect(commandError({ status: 409, body: { error: "session exited", hint: "resume" } })).toContain("終わっている");
  });
});
