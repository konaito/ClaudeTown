import { describe, expect, test } from "bun:test";
import { simplify, toolLine, unwrapPasted, splitImageMarks, readConversation, newConvState, clip, resultText, type MessagesPage } from "./webConv";
import { KEEP_CONV } from "./conv";
import convCases from "./conv-cases.json";

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
  test("スラッシュコマンドの入力は「/名前 引数」の吹き出しにする（#157）", () => {
    expect(simplify(ptyUser("<command-message>merge</command-message>\n<command-name>/merge</command-name>"))).toEqual([{ role: "user", text: "/merge", from: null, at: 1000, letter: null }]);
    expect(simplify(ptyUser("<command-name>/login</command-name>\n            <command-message>login</command-message>\n            <command-args></command-args>"))[0].text).toBe("/login");
    expect(simplify(ptyUser("<command-message>surf</command-message>\n<command-name>/surf</command-name>\n<command-args>https://a.example/x <b>強</b></command-args>"))[0].text).toBe("/surf https://a.example/x <b>強</b>");
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

describe("道具の結果とターンの終わり（#83）", () => {
  const tool = (id: string) => ptyAsst([{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }]);
  const res = (id: string, err = false) => ptyUser([{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "a\nb" }], is_error: err }]);
  const page = (msgs: unknown[]) => { let sent = false; return async () => { if (sent) return { messages: [], next: msgs.length, epoch: "e" }; sent = true; return { messages: msgs, next: msgs.length, epoch: "e" }; }; };
  test("同じ読み出しの結果は道具の行に付き、後から来た結果だけ result の項目になる", async () => {
    const s = newConvState();
    const a = await readConversation(s, page([tool("t1"), res("t1"), tool("t2")]), null);
    expect(a.items.map((x) => [x.role, x.result?.text ?? null])).toEqual([["tool", "a\nb"], ["tool", null]]);
    const all = [tool("t1"), res("t1"), tool("t2"), res("t2", true), res("none")];
    const b = await readConversation(s, async (after) => ({ messages: all.slice(after), next: all.length, epoch: "e" }), a.total);
    expect(b.items.map((x) => [x.role, x.id, x.error])).toEqual([["result", "t2", true]]);
    expect(s.items[1].result).toEqual({ text: "a\nb", error: true });
  });
  test("止めたと失敗したターンは event、成功は出さない", () => {
    const r = (data: unknown) => simplify({ at: 1, type: "result", data });
    expect(r({ type: "result", subtype: "interrupted", is_error: true, result: "" })[0]).toMatchObject({ role: "event", kind: "interrupted" });
    expect(r({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error" })[0].text).toContain("API Error");
    expect(r({ type: "result", subtype: "success", is_error: false, result: "ok" })).toEqual([]);
  });
  test("結果は頭の40行だけ持つ", () => {
    const t = resultText(Array.from({ length: 100 }, (_, i) => String(i)).join("\n"));
    expect(t.endsWith("…（続きは省いた）")).toBe(true);
    expect(t.split("\n").length).toBe(41);
    expect(resultText([{ type: "text", text: "a" }, { type: "image" }])).toBe("a\n[画像]");
  });
});

describe("-p の子を止めたとき（#83）", () => {
  test("止めた印の文と続く失敗の result は、止めた印1つになる", async () => {
    const msgs = [
      { type: "user", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
      { type: "result", subtype: "error_during_execution", is_error: true, result: "" },
    ];
    const s = newConvState();
    const d = await readConversation(s, async () => ({ messages: msgs, next: 2, epoch: "e" }), null);
    expect(d.items.map((x) => [x.role, x.kind])).toEqual([["event", "interrupted"]]);
  });
});

// src-tauri/src/conversation.rs の shared_cases と同じ事例。TS 側の出力は JSON を通して、undefined の項目を落としてから比べる
describe("会話の整形（src/conv-cases.json）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (fn: string, a: any[]): unknown => {
    switch (fn) {
      case "clip": return clip(a[0], a[1]);
      case "tool_line": return toolLine(a[0], a[1]);
      case "result_text": return resultText(a[0]);
      case "unwrap_pasted": return unwrapPasted(a[0]);
      case "split_image_marks": return splitImageMarks(a[0]);
      case "simplify": return simplify(a[0]);
    }
    throw new Error(`知らない関数: ${fn}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of convCases as { name: string; fn: string; args: any[]; expect: unknown }[]) {
    test(c.name, () => {
      expect(JSON.parse(JSON.stringify(run(c.fn, c.args)))).toEqual(c.expect);
    });
  }
});
