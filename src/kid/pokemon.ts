// ポケモンスキン。親・子・孫を、3段進化する1つの系統の1段目・2段目・3段目で描く。
// 絵は Pokémon Showdown のアニメ GIF を PokeAPI/sprites が配布しているもの。リポジトリには入れず、
// 表示中のキャラの分だけ実行時に raw.githubusercontent.com から読む（webview の HTTP キャッシュに残る）。
// 系統の一覧（pokemon-lines.json）は scripts/pokemon-lines.ts で作った図鑑番号と英名だけ。
import { createContext, useContext, useEffect, useState } from "react";
import LINES from "./pokemon-lines.json";
import { hash, type Role } from "./Avatar";

export type Skin = "default" | "pokemon";

/** 一覧を作ったときの PokeAPI/sprites のコミット。確かめた中身と同じものを読むよう、ブランチ名ではなくコミットで指す */
const SPRITES = `https://raw.githubusercontent.com/PokeAPI/sprites/${LINES.sha}/sprites/pokemon/other/showdown`;
/** [図鑑番号3つ, 英名3つ] の並び */
const ALL = LINES.lines as unknown as [number[], string[]][];
const STAGE: Record<Role, number> = { parent: 0, child: 1, grandchild: 2 };

export function spriteUrl(id: number): string {
  return `${SPRITES}/${id}.gif`;
}

/** 世帯の根の ID から系統を決める。同じ世帯は同じ系統になる。世帯どうしで系統が被ることはある */
export function lineOf(rootId: string): { ids: number[]; names: string[] } {
  const [ids, names] = ALL[hash(`pokemon:${rootId}`) % ALL.length];
  return { ids, names };
}

/** その世帯で、その世代のポケモン（図鑑番号と英名） */
export function pokemonOf(rootId: string, role: Role): { id: number; name: string } {
  const l = lineOf(rootId);
  return { id: l.ids[STAGE[role]], name: l.names[STAGE[role]] };
}

// ---------- 切り替え ----------

const KEY = "fc.skin";

export function savedSkin(): Skin {
  try { return localStorage.getItem(KEY) === "pokemon" ? "pokemon" : "default"; } catch { return "default"; }
}
export function saveSkin(s: Skin) {
  try { localStorage.setItem(KEY, s); } catch { /* 保存できなくても今の表示は変える */ }
}

/** スキンと、セッション ID から世帯の根の ID を引く関数。根が分からないときは自分の ID を返す */
export const SkinCtx = createContext<{ skin: Skin; rootOf: (id: string) => string }>({ skin: "default", rootOf: (id) => id });
export const useSkin = () => useContext(SkinCtx);

// ---------- 止め絵 ----------
// 作業中でないときは GIF の1フレームを止めて見せる。会話欄では同じ子が発言の数だけ描かれるので、
// 1種につき1回だけ読んで ImageBitmap にし、各 canvas はそれを描くだけにする。

const stills = new Map<number, Promise<ImageBitmap>>();

export function stillOf(id: number): Promise<ImageBitmap> {
  let p = stills.get(id);
  if (!p) {
    p = new Promise<HTMLImageElement>((ok, ng) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => ng(new Error(`読めない: ${id}`));
      img.src = spriteUrl(id);
    }).then((img) => createImageBitmap(img));
    // 失敗はキャッシュしない（オフラインから戻ったら読み直す）
    p.catch(() => stills.delete(id));
    stills.set(id, p);
  }
  return p;
}

/** 止め絵を読む。読めなければ failed を返す */
export function useStill(id: number, on: boolean): { bmp: ImageBitmap | null; failed: boolean } {
  const [s, setS] = useState<{ id: number; bmp: ImageBitmap | null; failed: boolean }>({ id, bmp: null, failed: false });
  useEffect(() => {
    if (!on) return;
    let live = true;
    stillOf(id).then((bmp) => live && setS({ id, bmp, failed: false }), () => live && setS({ id, bmp: null, failed: true }));
    return () => { live = false; };
  }, [id, on]);
  return s.id === id ? s : { bmp: null, failed: false };
}
