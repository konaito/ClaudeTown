// 入力欄の補完。/ はコマンドとスキル、@ はファイルの候補を出し、Tab か Enter で決める。
import { useEffect, useMemo, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { BUILTINS, type Command } from "./commands";
import { rankCommands, tokenAt } from "./edit";
import { tagOf } from "./route";
import type { Support } from "../session/control";
import type { Search } from "./useHistorySearch";

// スキルの一覧は作業フォルダごとに1回だけ読む
const skillsByCwd = new Map<string, Command[]>();

export function useCompletion({ agent, local, text, caret, search, dismissed, ccnKind, support, replaceAll }: {
  agent: Agent;
  local: boolean;
  text: string;
  caret: number;
  search: Search | null;
  /** Esc で閉じた補完の文。この文のあいだは候補を出さない */
  dismissed: string | null;
  ccnKind: Agent["kind"];
  support: Support;
  replaceAll: (t: string, at?: number) => void;
}) {
  const [skills, setSkills] = useState<Command[]>(() => skillsByCwd.get(agent.cwd) ?? []);
  const [files, setFiles] = useState<string[]>([]);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    if (!local || !agent.cwd || skillsByCwd.has(agent.cwd)) return;
    invoke<Command[]>("slash_commands", { cwd: agent.cwd }).then((l) => { if (!Array.isArray(l)) return; skillsByCwd.set(agent.cwd, l); setSkills(l); }).catch(() => {});
  }, [agent.cwd, local]);

  const token = search ? null : tokenAt({ text, start: caret, end: caret });
  const commands = useMemo(() => [...BUILTINS, ...skills], [skills]);
  const slashItems = token?.kind === "slash" ? rankCommands(commands, token.query) : [];
  // 候補の印（#97）。行の頭のコマンドだけが CLI のコマンドになるので、文の途中の / には付けない
  const tags = slashItems.map((c) => (token?.atStart ? tagOf(c, ccnKind, support) : null));
  useEffect(() => {
    if (token?.kind !== "file" || !local || !agent.cwd) { setFiles([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      invoke<string[]>("file_suggestions", { cwd: agent.cwd, query: token.query }).then((l) => { if (alive && Array.isArray(l)) setFiles(l); }).catch(() => {});
    }, 60);
    return () => { alive = false; clearTimeout(t); };
  }, [token?.kind, token?.query, agent.cwd, local]);
  const menu = dismissed === text ? [] : token?.kind === "slash" ? slashItems : token?.kind === "file" ? files : [];
  const menuOpen = menu.length > 0;
  useEffect(() => { setPick(0); }, [token?.kind, token?.query]);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { menuRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" }); }, [pick]);

  const accept = (i = pick) => {
    if (!token) return "";
    if (token.kind === "slash") {
      const c = slashItems[i];
      if (!c) return "";
      const next = `${text.slice(0, token.from)}/${c.name} ${text.slice(token.to).replace(/^[ \t]+/, "")}`;
      replaceAll(next, token.from + c.name.length + 2);
      return next;
    }
    const f = files[i];
    if (!f) return "";
    // フォルダは続けて中を選べるように空白を付けない
    const add = f.endsWith("/") ? f : `${f} `;
    const next = `${text.slice(0, token.from)}@${add}${text.slice(token.to).replace(/^[ \t]+/, "")}`;
    replaceAll(next, token.from + 1 + add.length);
    return next;
  };

  return { token, slashItems, tags, files, menu, menuOpen, pick, setPick, menuRef, accept };
}
