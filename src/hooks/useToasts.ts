import { useCallback, useState } from "react";

export type Toast = { id: number; text: string; bad?: boolean };

/** 画面の下に出す短い知らせ。最大3件で、通常は2.6秒、失敗は6秒で消える */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 6000 : 2600);
  }, []);
  return { toasts, toast };
}
