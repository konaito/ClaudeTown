// / の候補にする組み込みのコマンド。出所は https://code.claude.com/docs/en/commands（2026-11-13 に読んだ。CLI 2.1.323）。
// スキルとユーザーのコマンドは Rust（slash_commands）が手元のフォルダから読む。
// dialog は、CLI で画面（選択肢、設定、一覧）を開くもの。チャットからは操作できないので、送ったあとターミナルを開く。
// "noarg" は引数が無いときだけ画面を開くもの。

export type Command = { name: string; description: string; argumentHint?: string; source: "builtin" | "user" | "project" | "plugin"; dialog?: true | "noarg" };

type Row = [name: string, description: string, argumentHint?: string, dialog?: true | "noarg"];

const ROWS: Row[] = [
  ["add-dir", "Add a working directory for file access this session", "<path>"],
  ["advisor", "Enable or disable the advisor tool", "[model|off]", "noarg"],
  ["agents", "Print a reminder to create or manage subagents"],
  ["artifacts", "List artifacts; attach, open, or copy link", undefined, true],
  ["autocompact", "Set the auto-compact window size", "[auto|<tokens>]", "noarg"],
  ["background", "Detach session to run as a background agent", "[prompt]"],
  ["branch", "Branch the current conversation to try another path", "[name]"],
  ["btw", "Ask a side question without adding to history", "[question]", true],
  ["bug", "Report a bug or share conversation", "[report]", true],
  ["cd", "Move session to a new working directory", "<path>"],
  ["chrome", "Configure Claude in Chrome settings", undefined, true],
  ["clear", "Start a new conversation with empty context", "[name]"],
  ["color", "Set the prompt bar color for this session", "[color|default]"],
  ["compact", "Summarize conversation to free context", "[instructions]"],
  ["config", "Open Settings to adjust theme, model, etc.", "[key=value ...]", "noarg"],
  ["context", "Show context usage as a colored grid", "[all]", true],
  ["copy", "Copy last assistant response to clipboard", "[N]", true],
  ["cost", "Alias for /usage", undefined, true],
  ["diff", "Review working tree changes, including Claude's edits", undefined, true],
  ["doctor", "Setup checkup that proposes fixes"],
  ["effort", "Set effort level (low to xhigh, max, auto)", "[level|auto|status]", "noarg"],
  ["exit", "Exit the CLI"],
  ["export", "Export conversation as plain text", "[filename]", "noarg"],
  ["fast", "Toggle fast mode", "[on|off]"],
  ["feedback", "Send product feedback about Claude Code", "[report]", "noarg"],
  ["focus", "Toggle focus view of prompt, tool summary, and reply"],
  ["fork", "Copy conversation into a new background session", "[prompt]"],
  ["goal", "Keep working across turns until condition is met", "[condition|clear]"],
  ["help", "Show help and available commands", undefined, true],
  ["hooks", "View hook configurations", undefined, true],
  ["ide", "Manage IDE integrations and show status", undefined, true],
  ["init", "Initialize project with a CLAUDE.md guide"],
  ["insights", "Generate HTML report analyzing recent sessions"],
  ["keybindings", "Open keyboard shortcuts file"],
  ["list-agents", "List subagents and sessions Claude can message"],
  ["login", "Sign in to your Anthropic account", undefined, true],
  ["logout", "Sign out from your Anthropic account"],
  ["loop", "Run a prompt repeatedly while session is open", "[interval] [prompt]"],
  ["mcp", "Manage MCP server connections and OAuth", "[reconnect|enable|disable]", "noarg"],
  ["memory", "Edit CLAUDE.md, auto memory settings and entries", undefined, true],
  ["model", "Switch model and save as default", "[model]", "noarg"],
  ["output-style", "List or switch output styles", "[style]", "noarg"],
  ["permissions", "Manage allow, ask, and deny tool rules", undefined, true],
  ["plan", "Enter plan mode, optionally with a task", "[description]"],
  ["plugin", "Manage plugins", "[subcommand]", "noarg"],
  ["recap", "Generate one-line summary of the session on demand"],
  ["release-notes", "View changelog in an interactive version picker", undefined, true],
  ["reload-plugins", "Reload plugins to apply pending changes"],
  ["reload-skills", "Rescan skill and command directories"],
  ["remote-control", "Make session available for Remote Control"],
  ["rename", "Rename session; auto-generates a name if omitted", "[name]"],
  ["restart", "Restart and resume session to apply an update"],
  ["resume", "Resume by ID or name, or open session picker", "[session]", "noarg"],
  ["rewind", "Rewind conversation and/or code to a checkpoint", undefined, true],
  ["sandbox", "Toggle sandbox mode"],
  ["schedule", "Create, update, list, or run cloud scheduled tasks", "[description]"],
  ["security-review", "Analyze branch changes for security vulnerabilities"],
  ["skill-doctor", "Show each skill's context cost and usage frequency", undefined, true],
  ["skills", "List skills with filter, sort, visibility controls", undefined, true],
  ["status", "Open Settings on the Status tab", undefined, true],
  ["statusline", "Configure the status line", "[description]"],
  ["tasks", "View and manage background work in session", undefined, true],
  ["terminal-setup", "Install Shift+Enter newline keybinding in terminal"],
  ["theme", "Change color theme, including custom themes", undefined, true],
  ["tui", "Set terminal UI renderer and relaunch", "[default|fullscreen]"],
  ["usage", "Show session cost, plan limits, activity stats", undefined, true],
  ["voice", "Toggle voice dictation", "[hold|tap|off]"],
  ["workflows", "Open the workflow progress view", undefined, true],
];

export const BUILTINS: Command[] = ROWS.map(([name, description, argumentHint, dialog]) => ({ name, description, argumentHint, dialog, source: "builtin" }));

/** 送る文が、CLI で画面を開くコマンドか（送ったあとターミナルを開く） */
export function opensDialog(text: string, list: Command[]): boolean {
  const m = /^\/(\S+)(\s+\S)?/.exec(text.trim());
  if (!m) return false;
  const c = list.find((x) => x.name === m[1]);
  if (!c?.dialog) return false;
  return c.dialog === true || !m[2];
}
