// 承認の「常に許可」（#83）。ccn の pending の suggestions（claude の permission_suggestions）を、ボタンの文にする。
// 返すのは Rust の allowed_suggestion と同じ addRules と setMode だけ。addDirectories は、返すと端末の承認の画面が残ったので出さない。
import { allowedSuggestion } from "../webPerm";

const WHERE: Record<string, string> = {
  session: "このセッションの間",
  localSettings: "このプロジェクト（.claude/settings.local.json）",
  projectSettings: "このプロジェクト（.claude/settings.json）",
  userSettings: "全部のプロジェクト（~/.claude/settings.json）",
};

const MODE: Record<string, string> = {
  acceptEdits: "ファイルの編集を聞かない（acceptEdits）",
  bypassPermissions: "何も聞かない（bypassPermissions）",
  default: "毎回聞く（default）",
  plan: "計画だけにする（plan）",
};

const rule = (r: any) => (r?.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r?.toolName ?? "?"));

/** 押せる提案と、元の並びでの番号。番号は Rust に渡す（Rust は pending から同じ番号の提案を取り直す） */
export function alwaysOptions(suggestions: unknown): { index: number; label: string; title: string }[] {
  if (!Array.isArray(suggestions)) return [];
  const out: { index: number; label: string; title: string }[] = [];
  suggestions.forEach((s: any, index) => {
    if (!allowedSuggestion(s)) return;
    const where = WHERE[s.destination] ?? String(s.destination ?? "");
    if (s.type === "addRules") {
      const rules = (Array.isArray(s.rules) ? s.rules : []).map(rule).join("、");
      out.push({ index, label: "許可して、以後は聞かない", title: `${rules} を、${where}は聞かずに許可する` });
    } else {
      const mode = MODE[s.mode] ?? String(s.mode ?? "");
      out.push({ index, label: `許可して、${mode.replace(/（.*）$/, "")}`, title: `${where}、権限のモードを ${mode} にする` });
    }
  });
  return out;
}
