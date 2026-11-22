// Ctrl+R の履歴の検索。検索中は、検索欄の一致した文を入力欄に見せる。
import { useRef, useState } from "react";
import { searchHistory } from "./edit";

export type Search = { query: string; idx: number; original: string };

export function useHistorySearch({ searchList, text, ta, replaceAll, submit, loadAll }: {
  searchList: string[];
  text: string;
  ta: React.RefObject<HTMLTextAreaElement | null>;
  replaceAll: (t: string, at?: number) => void;
  submit: (body: string) => void;
  /** Ctrl+R を押したときに、全部の project の履歴を読む */
  loadAll: () => void;
}) {
  const [search, setSearch] = useState<Search | null>(null);
  // 検索を閉じたあと、検索欄の blur でもう一度閉じない（Ctrl+C でやめたのに、一致した文で上書きしないように）
  const searchEnding = useRef(false);

  const startSearch = () => { loadAll(); searchEnding.current = false; setSearch({ query: "", idx: -1, original: text }); };
  const searchMatch = search && search.idx >= 0 ? searchList[search.idx] : null;
  const runSearch = (query: string, from: number) => {
    const idx = searchHistory(searchList, query, from);
    setSearch((s) => (s ? { ...s, query, idx: idx >= 0 ? idx : query === s.query ? s.idx : -1 } : s));
  };
  const endSearch = (keep: boolean) => {
    if (!search || searchEnding.current) return;
    searchEnding.current = true;
    const t = keep && searchMatch != null ? searchMatch : search.original;
    setSearch(null);
    replaceAll(t);
    requestAnimationFrame(() => ta.current?.focus());
    return t;
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (ctrl && e.key === "r") { e.preventDefault(); if (search) runSearch(search.query, search.idx + 1); return; }
    if (e.key === "Enter") { e.preventDefault(); const t = endSearch(true); if (t) submit(t); return; }
    if (e.key === "Tab" || e.key === "Escape") { e.preventDefault(); endSearch(true); return; }
    if (ctrl && e.key === "c") { e.preventDefault(); endSearch(false); return; }
    if (e.key === "Backspace" && !search?.query) { e.preventDefault(); endSearch(false); }
  };

  return { search, startSearch, searchMatch, runSearch, endSearch, onSearchKey };
}
