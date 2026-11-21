import { describe, expect, test } from "bun:test";
import { simplify, toolLine, unwrapPasted, splitImageMarks, readConversation, newConvState, clip, type MessagesPage } from "./webConv";
import { KEEP_CONV } from "./conv";

// pty は { at, type, data: { type, message } }、node はトランスクリプトの行そのまま
const ptyUser = (content: unknown, at = 1000) => ({ at, type: "user", data: { type: "user", message: { role: "user", content } } });
const ptyAsst = (content: unknown[], at = 2000) => ({ at, type: "assistant", data: { type: "assistant", message: { role: "assistant", content } } });
const nodeUser = (content: unknown) => ({ type: "user", timestamp: "2026-11-19T01:02:03.000Z", message: { role: "user", content } });

describe("simplify", () => {
  test("pty は data の中身を読み、時刻は at（ms）", () => {
    expect(simplify(ptyUser("こんにちは"))).toEqual([{ role: "user", text: "こんにちは", from: null, at: 1000, letter: null }]);
  });
  test("node は行そのままで、時刻は timestamp", () => {
    expect(simplify(nodeUser("やあ"))[0].at).toBe("2026-11-19T01:02:03.000Z");
  });
  test("assistant は文と道具を分け、考えた中身は捨てる", () => {
    const out = simplify(ptyAsst([{ type: "thinking", thinking: "x" }, { type: "text", text: " 返事 " }, { type: "tool_use", name: "Read", input: { file_path: "/a/b/c.ts" } }]));
    expect(out.map((x) => [x.role, x.text])).toEqual([["assistant", "返事"], ["tool", "読む: b/c.ts"]]);
  });
  test("ExitPlanMode の道具の行には計画の本文を付ける（#83）", () => {
    const out = simplify(ptyAsst([{ type: "tool_use", name: "ExitPlanMode", input: { plan: "# 計画\n- a" } }, { type: "tool_use", name: "Read", input: { file_path: "/a/b" } }]));
    expect(out[0].plan).toBe("# 計画\n- a");
    expect(out[1].plan).toBeUndefined();
  });
  test("道具の結果だけの user と、<…> で始まる差し込みは出さない", () => {
    expect(simplify(ptyUser([{ type: "tool_result", content: "ok" }]))).toEqual([]);
    expect(simplify(ptyUser("<system-reminder>x</system-reminder>"))).toEqual([]);
    expect(simplify(ptyUser("Caveat: x"))).toEqual([]);
  });
  test("from 行は from に分け、agent: なら letter にする", () => {
    const out = simplify(ptyUser("from agent:n1/abcd1234/child via n1\n\n本文"));
    expect(out[0]).toMatchObject({ text: "本文", from: "from agent:n1/abcd1234/child via n1", letter: { fromName: null, fromRaw: "n1/abcd1234/child" } });
  });
  test("お手紙の包みは中の本文だけを出す", () => {
    const out = simplify(ptyUser('Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="べつの子">やあ</cross-session-message>\n注記'));
    expect(out).toEqual([{ role: "user", text: "やあ", from: null, at: 1000, letter: { fromName: "べつの子", fromRaw: "uds:/tmp/x.sock" } }]);
  });
  test("貼り付けの包みを外してから見る", () => {
    expect(simplify(ptyUser('<pasted_content id="a">本文</pasted_content id="a">'))[0].text).toBe("本文");
  });
  test("画像の印の後ろに from 行が回っても、from を拾う", () => {
    const out = simplify(ptyUser("[Image #1] from agent:n/ab/x via n\nこれ"));
    expect(out[0]).toMatchObject({ from: "from agent:n/ab/x via n", text: "[Image #1]\nこれ" });
  });
  test("送ったお手紙は宛先と1行目を付ける", () => {
    const out = simplify(ptyAsst([{ type: "tool_use", name: "mcp__ccn__send_message", input: { session: "s1", peer: "p", text: "\n 一行目\n二行目" } }]));
    expect(out[0]).toMatchObject({ role: "tool", text: "send_message", sent: { to: "s1", peer: "p", summary: "一行目" } });
  });
});

describe("部品", () => {
  test("toolLine: 長い文は70字で切る", () => {
    expect(toolLine("Bash", { command: "x".repeat(100) })).toBe(`コマンド: ${"x".repeat(69)}…`);
    expect(toolLine("Agent", {})).toBe("手伝いを呼ぶ");
  });
  test("clip", () => { expect(clip("a  b\nc", 10)).toBe("a b c"); });
  test("unwrapPasted: 包みでない < は残す", () => { expect(unwrapPasted("a <pasted_contentx b")).toBe("a <pasted_contentx b"); });
  test("splitImageMarks", () => {
    expect(splitImageMarks("[Image #1] [Image #2]  文")).toEqual(["[Image #1] [Image #2]", "文"]);
    expect(splitImageMarks("文 [Image #1]")).toEqual(["", "文 [Image #1]"]);
  });
});

/** 件数 n の messages を、after と epoch で返す偽の ccn（200件ずつ） */
function fakeCcn(total: () => number, epoch: () => string | null) {
  return async (after: number): Promise<MessagesPage> => {
    const t = total();
    const end = Math.min(t, after + 200);
    return { messages: Array.from({ length: Math.max(0, end - after) }, (_, i) => ptyUser(`m${after + i}`)), next: end, epoch: epoch() };
  };
}

describe("readConversation", () => {
  test("続きだけを足し、since に合わせた差分を返す", async () => {
    let total = 3;
    const s = newConvState();
    const f = fakeCcn(() => total, () => "e1");
    const a = await readConversation(s, f, null);
    expect(a).toMatchObject({ total: 3, reset: true });
    total = 5;
    const b = await readConversation(s, f, a.total);
    expect(b.reset).toBe(false);
    expect(b.items.map((x) => [x.n, x.text])).toEqual([[3, "m3"], [4, "m4"]]);
    const c = await readConversation(s, f, b.total);
    expect(c.items).toEqual([]);
  });
  test("200件を超えても、ページをまたいで全部読む", async () => {
    const s = newConvState();
    const d = await readConversation(s, fakeCcn(() => 450, () => "e"), null);
    expect(d.total).toBe(450);
    expect(d.items.length).toBe(KEEP_CONV);
    expect(d.items.at(-1)?.text).toBe("m449");
  });
  test("epoch が変わったら頭から読み直し、reset で置き換える（n は減らない）", async () => {
    let epoch = "e1";
    let total = 4;
    const s = newConvState();
    const f = fakeCcn(() => total, () => epoch);
    const a = await readConversation(s, f, null);
    epoch = "e2"; total = 2;
    const b = await readConversation(s, f, a.total);
    expect(b.reset).toBe(true);
    expect(b.items.map((x) => x.text)).toEqual(["m0", "m1"]);
    expect(b.items[0].n!).toBeGreaterThanOrEqual(a.total);
  });
  test("読み直しが空なら、前の中身を残す", async () => {
    let epoch = "e1";
    let total = 3;
    const s = newConvState();
    const f = fakeCcn(() => total, () => epoch);
    await readConversation(s, f, null);
    epoch = "e2"; total = 0;
    const b = await readConversation(s, f, null);
    expect(b.items.length).toBe(3);
  });
});
