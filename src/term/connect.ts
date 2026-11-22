// ターミナルを開く処理の結果の受け方。TerminalView（xterm を含む）から出して、bun test で確かめられるようにする（#185）

/**
 * open() が返す切断の関数を受け取る。isClosed() が真なら、画面はもう別のセッションに移ったか閉じたので、
 * 開けた接続はすぐ切り、結果は画面に伝えない
 */
export function connectTerminal(
  open: () => Promise<() => void>,
  isClosed: () => boolean,
  h: { onOpen: (close: () => void) => void; onFail: (message: string) => void },
): Promise<void> {
  return open().then((c) => { if (isClosed()) c(); else h.onOpen(c); });
}
