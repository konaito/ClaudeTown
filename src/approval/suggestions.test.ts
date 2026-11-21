import { describe, expect, test } from "bun:test";
import { alwaysOptions } from "./suggestions";

describe("alwaysOptions", () => {
  test("addRules と setMode を出し、addDirectories は出さない。番号は元の並び", () => {
    const o = alwaysOptions([
      { type: "addDirectories", directories: ["/x"], destination: "session" },
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);
    expect(o.map((x) => x.index)).toEqual([1, 2]);
    expect(o[0].title).toBe("Bash(npm test:*) を、このプロジェクト（.claude/settings.local.json）は聞かずに許可する");
    expect(o[1].label).toBe("許可して、ファイルの編集を聞かない");
  });
  test("提案が無ければ空", () => {
    expect(alwaysOptions(undefined)).toEqual([]);
    expect(alwaysOptions([{ type: "removeRules" }])).toEqual([]);
  });
});
