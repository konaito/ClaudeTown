import { useState } from "react";
import type { CreatedSession } from "../types";
import { createHousehold } from "./NewHousePane";
import { placeFailure } from "./placeSetting";

/** 町が空のときの「最初の世帯を作る」。最初の依頼の欄は出さず、すぐ ~/Documents/meta で親（端末のセッション）を立て、右のチャットを開く。
 *  ふだんの作る口は左の新しい世帯のペイン（#89、src/newHouse） */
export function NewHousehold({ place, onCreated, onError }: { place: string | null; onCreated: (r: CreatedSession | null) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      // 前に開いたターミナルの大きさで起動する。開いた直後に大きさを変えて、claude が全部描き直すのを省く（createHousehold の中）
      onCreated(await createHousehold(place));
    } catch (e) { onCreated(null); onError(placeFailure(place, e)); } finally { setBusy(false); }
  };
  return (
    <button className="primary new-house big" disabled={busy} onClick={go}>
      {busy ? "立てている…" : "最初の世帯を作る"}
    </button>
  );
}
