import { describe, expect, test } from "bun:test";
import { isDenyRow, isReviseRow, planLabel, ptyPicks, toolLabel } from "./pty";

// 文は 2026-11-22 に v2.1.330 の承認の画面で見たもの（src-tauri/src/dialog.rs の試験の画面と同じ）
describe("承認の画面の行の文", () => {
  test("道具の承認", () => {
    expect(toolLabel("Yes")).toBe("許可する");
    expect(toolLabel("Yes, and always allow access to /private/tmp/fc-ask-probe from this project")).toBe("許可して、以後は聞かない");
    expect(toolLabel("Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)")).toBe("許可して、編集は聞かない");
    expect(toolLabel("Yes, and switch to auto mode · auto mode handles these prompts for you")).toBe("許可して、auto モードにする");
    expect(toolLabel("Yes, something new")).toBe("Yes, something new");
    expect(isDenyRow("No")).toBe(true);
    expect(isDenyRow("No, and tell Claude what to do differently")).toBe(true);
    expect(isDenyRow("Not now")).toBe(false);
  });
  test("計画の確認", () => {
    expect(planLabel("Yes, and use auto mode")).toBe("承認する（auto モード）");
    expect(planLabel("Yes, manually approve edits")).toBe("承認する（編集は毎回聞く）");
    expect(isReviseRow("Tell Claude what to change")).toBe(true);
  });
});

describe("ptyPicks", () => {
  const qs = [
    { question: "色は？", options: [{ label: "赤" }, { label: "青" }, { label: "緑" }] },
    { question: "数は？", options: [{ label: "1" }, { label: "2" }, { label: "3" }], multiSelect: true },
  ];
  test("番号は選択肢の順に並べる", () => {
    expect(ptyPicks(qs, [{ picked: ["青"], other: "" }, { picked: ["3", "1"], other: " ほか " }])).toEqual([
      { picked: [1], other: "" }, { picked: [0, 2], other: "ほか" },
    ]);
  });
  test("単一選択で「その他」を書いたら、選んだ選択肢は送らない", () => {
    expect(ptyPicks(qs, [{ picked: ["赤"], other: "黒" }, { picked: [], other: "" }])[0]).toEqual({ picked: [], other: "黒" });
  });
});
