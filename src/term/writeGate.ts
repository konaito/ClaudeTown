// 窓が見えていない間、xterm に書く出力をためておき、見えたときにまとめて書く（#8）。
// 隠れている間は WebKit が描画を止めるが、xterm の構文解析は続くので、書くのを止めれば WebContent の CPU が減る。
// 順番は変えない。ためた文字列はつなげて1回の write にし、それぞれの完了の関数は、その write が終わったあとに順に呼ぶ。
// xterm は import せず、書く関数を受け取る形にして、試験では偽の write で確かめる

type Write = (s: string, done: () => void) => void;
type Chunk = { s: string; done?: () => void };

/** ためる量の上限（文字数）。超えたら見えていなくても書く。捨てると途中のエスケープ列が欠けるので、捨てずに書く */
export const GATE_MAX_CHARS = 1_000_000;

export function createWriteGate(write: Write, open = true, maxChars = GATE_MAX_CHARS) {
  let isOpen = open;
  let queue: Chunk[] = [];
  let size = 0;
  const flush = () => {
    if (queue.length === 0) return;
    const q = queue;
    queue = []; size = 0;
    write(q.map((c) => c.s).join(""), () => { for (const c of q) c.done?.(); });
  };
  return {
    /** 見えていれば、そのまま書く。隠れていれば、ためる */
    push(s: string, done?: () => void) {
      if (isOpen) { write(s, () => done?.()); return; }
      queue.push({ s, done }); size += s.length;
      if (size > maxChars) flush();
    },
    /** 見えるかどうかを切り替える。見えるようになったら、ためた分をまとめて書く */
    setOpen(v: boolean) {
      if (v === isOpen) return;
      isOpen = v;
      if (v) flush();
    },
    /** ためた分を書かずに捨てる（画面を消す前など）。完了の関数だけ呼ぶ */
    drop() {
      const q = queue;
      queue = []; size = 0;
      for (const c of q) c.done?.();
    },
    pending: () => size,
  };
}
