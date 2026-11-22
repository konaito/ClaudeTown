// 入力欄の履歴。上下キーの分（同じ project）、Ctrl+R の分（全部の project）、このセッションで送った文を持つ。
import { useEffect, useMemo, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { mergeHistory, pushHistory, type HistState } from "./edit";

type History = { project: string[]; all: string[] };

// セッションごとに持つ、送った文の履歴。セッションを切り替えて戻っても残す
const sentBy = new Map<string, string[]>();

export function useHistory(agent: Agent, local: boolean) {
  const [hist, setHist] = useState<History>({ project: [], all: [] });
  const [sent, setSent] = useState<string[]>(() => sentBy.get(agent.id) ?? []);
  const histSt = useRef<HistState>({ index: -1, draft: "" });

  // 履歴は CLI と同じ ~/.claude/history.jsonl から読む（手元のセッションだけ）。上下キーの分（同じ project）は開いたときと送るたびに読む。
  // Ctrl+R の分（全部の project、1000件で約1.2MB）は、Ctrl+R を押したときだけ読む
  const loadHistory = () => {
    if (!local) return;
    invoke<History>("prompt_history", { cwd: agent.cwd || null, all: false }).then((h) => { if (Array.isArray(h?.project)) setHist((x) => ({ ...x, project: h.project })); }).catch(() => {});
  };
  const loadAll = () => {
    if (!local) return;
    invoke<History>("prompt_history", { cwd: agent.cwd || null, all: true }).then((h) => { if (Array.isArray(h?.all)) setHist((x) => ({ ...x, all: h.all })); }).catch(() => {});
  };
  useEffect(loadHistory, [agent.id, agent.cwd, local]);

  const upList = useMemo(() => mergeHistory(sent, hist.project), [sent, hist.project]);
  const searchList = useMemo(() => mergeHistory(sent, hist.all), [sent, hist.all]);
  const remember = (t: string) => { const n = pushHistory(sentBy.get(agent.id) ?? [], t); sentBy.set(agent.id, n); setSent(n); };

  return { loadHistory, loadAll, remember, histSt, upList, searchList };
}
