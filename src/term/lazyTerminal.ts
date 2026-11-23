import { lazy } from "react";

// ターミナル（xterm と WebGL の addon）は起動のときに読まず、町を出した後に読む（#16）。
// 起動から町を描くまでに解く JS を減らす。最初に開くときに待たないよう、起動の2秒後に先に読んでおく
export const loadTerminal = () => import("./TerminalView");

export const TerminalView = lazy(() => loadTerminal().then((m) => ({ default: m.TerminalView })));
