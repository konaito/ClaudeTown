import { useEffect, useState } from "react";
import type { Skin } from "../kid/pokemon";

/** 素材の表示と、キャラの見た目（いつもの / ポケモン）の切り替え。見た目で使う素材が変わるので同じ所に置く */
export function Credits({ skin, onSkin, openReq = 0 }: { skin: Skin; onSkin: (s: Skin) => void; openReq?: number }) {
  const [open, setOpen] = useState(false);
  // メニューバーの「素材のクレジット」（#300）。増えたら開く
  useEffect(() => { if (openReq) setOpen(true); }, [openReq]);
  return (
    <span className="credits">
      <button className="credit-btn" onClick={() => setOpen((o) => !o)}>素材</button>
      {open && (
        <span className="credit-pop" onMouseLeave={() => setOpen(false)}>
          <span className="skin-pick" title="ポケモンでは、親を最終進化、子を2段目、孫を1段目で描く">
            キャラの見た目
            {([["default", "いつもの"], ["pokemon", "ポケモン"]] as const).map(([v, label]) => (
              <button key={v} className={skin === v ? "on" : ""} onClick={() => onSkin(v)}>{label}</button>
            ))}
          </span>
          <b>キャラ</b>: Ninja Adventure Asset Pack（Pixel-boy、AAA）、CC0 1.0。
          <br /><b>状態の印、幽霊、お手紙</b>: Animated emoji: Noto Animated Emoji by Google, licensed under CC BY 4.0
          （creativecommons.org/licenses/by/4.0）。Source: googlefonts.github.io/noto-emoji-animation
          <br />キャラは配布元のファイルのまま表示のときに縮めている。Noto は 64px に縮め、コマを半分に間引いた。
          {skin === "pokemon" && (<>
            <br /><b>ポケモン（キャラの見た目で選んだとき）</b>: ブラック・ホワイトの形の2Dのドット絵（アニメ GIF と止め絵）を、PokeAPI/sprites（github.com/PokeAPI/sprites）の配布から
            {"表示中のキャラの分だけ実行時に読む。このアプリには画像を含めない。Pokémon © Nintendo / Creatures Inc. / GAME FREAK inc."}
          </>)}
        </span>
      )}
    </span>
  );
}
