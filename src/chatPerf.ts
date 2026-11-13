// チャット欄の描き直しの数（#10）。待機中に増えていなければ、tick やポーリングで吹き出しを描き直していない。
// 開発版では window.__chatPerf から読める（agent-browser の eval で前後を比べる）
export const chatPerf = { md: 0, bubble: 0, time: 0 };
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __chatPerf: typeof chatPerf }).__chatPerf = chatPerf;
