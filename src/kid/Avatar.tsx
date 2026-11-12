// キャラのアバター。体は Ninja Adventure（CC0）のドット絵、状態の印は Noto Animated Emoji（CC BY 4.0）。
// 配置は docs/research/assets/balance.html の案 A2（本人が選んだ）。印は白い丸の吹き出しで、体の右肩に少し重ねる。
// 作業中は印を出さず、歩きのアニメの足踏みだけで見せる。待機も印を出さない。
import type { Mood } from "../model";
import "./avatar.css";

/** 根のセッション（親）に当てる大人のキャラ */
const ADULTS = ["Woman", "Noble", "Knight", "Inspector", "Princess", "Hunter"];
/** 子より下に当てる子供のキャラ */
const KIDS = [
  "Boy", "Princess", "EggBoy", "EggGirl", "Cavegirl", "Cavegirl2", "LionBoy", "Villager2", "Villager4",
  "NinjaBlue", "NinjaGreen", "NinjaRed", "NinjaYellow", "Eskimo", "MaskFrog", "MaskRacoon", "Hunter", "FighterRed",
];

/** 状態ごとの印（Noto のコードポイント）。無い状態は印を出さない */
const MARK: Partial<Record<Mood, string>> = {
  approval: "270b", // 手を挙げる
  reply: "1f97a", // お願いの顔
  done: "2705", // チェック
};

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  // 似た名前でも下位のビットが散らばるよう混ぜ直す（murmur3 の最後の処理）
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

export type Role = "parent" | "child" | "grandchild";

/**
 * size は体の一辺の px。16px の絵の整数倍（32、48、64）にすると、ドット絵がにじまない。
 * 箱の高さは size に吹き出しの余白を足した分で、印の有無で変わらない。
 */
export function Avatar({ seed, mood, role, size, pick }: { seed: string; mood: Mood; role: Role; size: number; pick?: { char: string; hue: number } | null }) {
  const list = role === "parent" ? ADULTS : KIDS;
  // 絵は Rust が町の中で被らないように割り当てたもの（pick）を使う。無いとき（ブラウザ表示など）は名前の hash で選ぶ
  const char = pick?.char ?? list[hash(`${role}:${seed}`) % list.length];
  const hue = pick?.hue ?? 0;
  const walking = mood === "working";
  const mark = MARK[mood];
  return (
    <span className={`fc-avatar fc-${mood}`} style={{ ["--fc-size" as string]: `${size}px` }} aria-hidden>
      <span className="fc-body">
        <img src={`/sprites/ninja/characters/${char}/SeparateAnim/${walking ? "Walk" : "Idle"}.png`} alt="" draggable={false}
          style={hue ? { filter: `hue-rotate(${hue}deg)` } : undefined} />
      </span>
      {mark && (
        <span className="fc-bubble"><img src={`/sprites/noto/${mark}/512.webp`} alt="" draggable={false} /></span>
      )}
    </span>
  );
}
