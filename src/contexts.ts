import { createContext } from "react";
import type { Agent } from "./model";

/** いま見ている町のセッション（お手紙の送り手の名前を引くため） */
export const TownCtx = createContext<Agent[]>([]);

/** 封筒の印（💌）を頭に出しているセッション */
export const LetterCtx = createContext<Set<string>>(new Set());

/** 閉じる操作と演出の状態。カードの 🐺 と、倒れる演出が読む */
export const KillCtx = createContext<{ dying: Map<string, number>; ask: (a: Agent, instant: boolean) => void }>({ dying: new Map(), ask: () => {} });

/** 引き継ぎの操作（🤝）。local は手元のノードの町を見ているか。busy は、いま引き継いでいる前任の ID */
export const SucceedCtx = createContext<{ local: boolean; busy: Set<string>; ask: (a: Agent) => void }>({ local: false, busy: new Set(), ask: () => {} });

/** カードのボタンから文を送る口（#63）。値は App で一度だけ作り、町の描き直しの合図にしない（#10） */
export const SendCtx = createContext<(a: Agent, text: string) => Promise<boolean>>(async () => false);
