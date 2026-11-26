// 入力欄の補完。/ はコマンドとスキル、@ はファイルの候補を出し、Tab か Enter で決める。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { BUILTINS, type Command } from "./commands";
import { acceptFile, rankCommands, tokenAt } from "./edit";
import { skillStore } from "./skills";
import { tagOf } from "./route";
import type { Support } from "../session/control";
import type { Search } from "./useHistorySearch";

export const skills = skillStore((cwd) => invoke<Command[]>("slash_commands", { cwd }));

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
  const skillList = useSyncExternalStore(skills.subscribe, () => skills.get(agent.cwd));
  const [files, setFiles] = useState<string[]>([]);
  const [pick, setPick] = useState(0);

  const token = search ? null : tokenAt({ text, start: caret, end: caret });
  // 一覧は、まだ読んでいない作業フォルダなら最初に読み、あとは / の補完を開くたびに読み直す（#315）。
  // 起動後に ~/.claude/skills へ足したり消したりしたスキルを、再起動なしで候補に反映するため。
  // 打つたびに読むと Rust を1文字ごとに呼ぶので、開いたかどうか（真偽）だけで決める。届くまでは前の一覧を出す
  const slashOpen = token?.kind === "slash";
  useEffect(() => {
    if (!local || !agent.cwd) return;
    if (slashOpen || !skills.has(agent.cwd)) void skills.refresh(agent.cwd);
  }, [agent.cwd, local, slashOpen]);

  const commands = useMemo(() => [...BUILTINS, ...skillList], [skillList]);
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
  // 開いている間に読み直しが届いて候補が増減したら、選んでいたコマンドを新しい並びで引き直す。番号のままだと Enter で別のコマンドを送る
  const shown = useRef<{ items: Command[]; pick: number }>({ items: [], pick: 0 });
  useEffect(() => {
    const was = shown.current.items[shown.current.pick];
    if (!was) return;
    const i = slashItems.findIndex((c) => c.source === was.source && c.name === was.name);
    setPick(i >= 0 ? i : 0);
  }, [commands]);
  useEffect(() => { shown.current = { items: slashItems, pick }; });
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
    const { text: next, caret: at } = acceptFile(text, token, f);
    replaceAll(next, at);
    return next;
  };

  return { token, slashItems, tags, files, menu, menuOpen, pick, setPick, menuRef, accept };
}
