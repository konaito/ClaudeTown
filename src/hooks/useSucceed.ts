import { useMemo, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent, buildTree } from "../model";
import { lastTermSize } from "../term/size";
import { kickTown } from "../town";
import { SucceedError, kidsOf, startSuccessor, succeedBlock } from "../succeed";
import { NEW_HOUSE_CAPS } from "../abilities";

type Tree = ReturnType<typeof buildTree>;

/**
 * 引き継ぎ（src/succeed.ts）。確認を挟んでから、ccn に後継を立てさせる。新しい ccn は前任の停止と子の付け替えまで行う。
 * 古い ccn では、後継が1通目を受け取ったら、ここで前任だけを止める
 */
export function useSucceed(h: {
  tree: Tree; peer: string; toast: (text: string, bad?: boolean) => void;
  selectedNow: React.MutableRefObject<string | null>;
  setSelected: (id: string | null) => void; setFresh: (a: Agent | null) => void; setTermReq: React.Dispatch<React.SetStateAction<number>>;
  setHidden: React.Dispatch<React.SetStateAction<Map<string, number>>>;
  kill: (a: Agent, alone?: boolean) => Promise<boolean>;
}) {
  const { tree, peer, toast, selectedNow, setSelected, setFresh, setTermReq, setHidden, kill } = h;
  const [succeedAsk, setSucceedAsk] = useState<Agent | null>(null);
  // 引き継げなかったときの、閉じるまで残る知らせ（枠の残るアカウントが無いとき。次に空く時刻を読めるように、消えるトーストにしない）
  const [succeedNote, setSucceedNote] = useState<{ title: string; text: string } | null>(null);
  const [succeeding, setSucceeding] = useState<Set<string>>(new Set());
  // 同じ前任で二重に走らせない（確認の Enter の連打、カードと見出しの両方からの操作）。後継が2人立つと、同じ作業が二重に進む
  const succeedRun = useRef<Set<string>>(new Set());
  const succeed = async (a0: Agent) => {
    if (succeedRun.current.has(a0.id)) return;
    // 確認を出している間に一覧が変わることがあるので、今の木の姿で見直す
    const a = tree.byId.get(a0.id) ?? a0;
    const why = succeedBlock(a, !peer);
    if (why) { toast(`${a.name} を引き継げない: ${why}`, true); return; }
    const mark = (on: boolean) => {
      if (on) succeedRun.current.add(a.id); else succeedRun.current.delete(a.id);
      setSucceeding(new Set(succeedRun.current));
    };
    mark(true);
    toast(`${a.name} の後継を立てている…`);
    try {
      const { cols, rows } = lastTermSize() ?? { cols: null, rows: null };
      const r = await startSuccessor({ agent: a, kids: kidsOf(tree.childrenOf.get(a.id) ?? []), cols, rows }, {
        call: invoke, sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), now: Date.now,
      });
      // 一覧に載るまでは、作成の応答から作った仮の姿で右パネルを出す（新しい世帯と同じ）
      const show = (term: boolean) => {
        setFresh({
          id: r.id, name: a.name, kind: "terminal", state: "running", cwd: r.cwd, canSend: true, parent: a.parent,
          startedAt: Date.now(), capabilities: NEW_HOUSE_CAPS,
        });
        setSelected(r.id);
        if (term) setTermReq((n) => n + 1);
      };
      kickTown();
      if (r.kind === "waiting") {
        // 後継は生きているが、1通目をまだ受け取っていない。端末で確認の画面に止まっていることがあるので、端末を開いて見せる。前任は止めない
        show(true);
        toast(`${a.name} の後継（${r.id.slice(0, 8)}）は起動したが、引き継ぎの文をまだ受け取っていない。ターミナルを見る。${a.name} は止めていないので、後継が動いたら閉じる`, true);
        return;
      }
      // 前任を選んでいたら、選択を後継へ移す（右パネルを空にしない）
      if (selectedNow.current === a.id) show(false);
      const id8 = r.id.slice(0, 8);
      if (r.kind === "ccn") {
        // 新しい ccn。後継の起動、子の付け替え、前任の停止まで ccn が済ませている
        let stopped = r.stopped;
        // 止まった前任は、一覧から消えるまで隠す。10秒たっても残っていれば、隠す側の見張りが「止まらなかった」と出す。
        // ccn が止められなかったときだけ、ここから1回止める
        if (stopped) setHidden((hh) => new Map(hh).set(a.id, Date.now()));
        else stopped = await kill(a, true);
        kickTown();
        // 付け替わった子の数は、町に出ていた子で数える（ccn の adopted には、止まって30分以内の子も入る）。
        // 済んでいた引き継ぎ（already が付く）は、どの子が付け替わったかが分からないので書かない
        const before = (tree.childrenOf.get(a.id) ?? []).filter((k) => !k.ghost);
        const moved = before.filter((k) => r.adopted.includes(k.id)).length;
        const left = r.already === undefined ? before.length - moved : 0;
        const kids = `${moved ? `。子 ${moved} 人も後継の下に付けた` : ""}${left ? `。子 ${left} 人は付け替わらず、別の世帯に分かれる` : ""}`;
        if (r.already) toast(`${a.name} は、すでに後継（${id8}）に引き継がれている`);
        else if (stopped) toast(`${a.name} を後継（${id8}）へ引き継いだ${kids}${r.account ? `（アカウント: ${r.account}）` : ""}`, left > 0);
        else toast(`${a.name} の後継（${id8}）は立ったが、${a.name} を止められなかった。手で閉じる`, true);
        return;
      }
      // 古い ccn。後継が1通目を受け取ったので、前任だけを止める（子孫は止めない）
      const stopped = await kill(a, true);
      const note = r.depthChecked ? "" : "（前任の深さが ccn に無く、深さは比べていない）";
      if (stopped) toast(`${a.name} を後継（${id8}）へ引き継いだ${note}`);
      else toast(`${a.name} の後継（${id8}）は立ったが、${a.name} を止められなかった。手で閉じる${note}`, true);
    } catch (e) {
      if (e instanceof SucceedError && e.kind === "no_account") setSucceedNote({ title: `${a.name} を引き継げなかった`, text: e.message });
      else toast(`${a.name} を引き継げなかった: ${e instanceof Error ? e.message : e}`, true);
    } finally {
      mark(false);
    }
  };
  const local = !peer;
  const succeedCtx = useMemo(() => ({ local, busy: succeeding, ask: setSucceedAsk }), [local, succeeding]);
  return { succeed, succeedAsk, setSucceedAsk, succeedNote, setSucceedNote, succeedCtx };
}
