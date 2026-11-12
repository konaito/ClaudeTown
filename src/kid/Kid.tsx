// 仮のキャラ。素材が決まったらこのファイルを差し替える（呼び出し側は mood と seed と role だけを渡す）。
import type { Mood } from "../model";

const HAIR = ["#4a3b35", "#7a4b2a", "#2f3a56", "#a4613a", "#3b2f2f", "#5b4636", "#c27a3f", "#454545"];
const SHIRT = ["#ff9aa2", "#ffcf7a", "#9ad7c2", "#9cc5ff", "#c8b6ff", "#ffb48a", "#a8e0a0", "#f7a8d8"];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export type Role = "parent" | "child" | "grandchild";

export function Kid({ seed, mood, role, size }: { seed: string; mood: Mood; role: Role; size: number }) {
  const h = hash(seed);
  const hair = HAIR[h % HAIR.length];
  const shirt = SHIRT[(h >>> 3) % SHIRT.length];
  const tuft = (h >>> 7) % 3;
  const sleeping = mood === "idle";
  return (
    <svg className={`kid kid-${mood}`} width={size} height={size * 1.1} viewBox="0 0 64 70" aria-hidden>
      <ellipse cx="32" cy="66" rx="16" ry="3" fill="#000" opacity="0.07" />
      <g className="kid-body">
        {/* 体 */}
        <path d="M18 64 Q18 44 32 44 Q46 44 46 64 Z" fill={shirt} />
        {/* 腕 */}
        <g className="arm arm-l">
          <path d="M20 50 Q12 54 13 60" stroke={shirt} strokeWidth="5" strokeLinecap="round" fill="none" />
        </g>
        <g className="arm arm-r">
          <path d="M44 50 Q52 54 51 60" stroke={shirt} strokeWidth="5" strokeLinecap="round" fill="none" />
        </g>
        {/* 頭 */}
        <g className="kid-head">
          <circle cx="32" cy="28" r="17" fill="#ffe2c6" />
          <path d={`M15 27 Q16 10 32 10 Q48 10 49 27 Q44 ${18 + tuft} 32 17 Q22 ${18 - tuft} 15 27 Z`} fill={hair} />
          {tuft === 1 && <path d="M30 11 Q33 4 37 8" stroke={hair} strokeWidth="2.5" fill="none" strokeLinecap="round" />}
          {tuft === 2 && <circle cx="46" cy="16" r="4" fill={hair} />}
          {role === "parent" && <path d="M20 12 Q32 2 44 12 L44 14 L20 14 Z" fill="#ffd36e" stroke="#e8b84a" strokeWidth="1" />}
          {/* 目 */}
          {sleeping ? (
            <>
              <path d="M24 30 Q26 32 28 30" stroke="#3b2f2f" strokeWidth="1.6" fill="none" strokeLinecap="round" />
              <path d="M36 30 Q38 32 40 30" stroke="#3b2f2f" strokeWidth="1.6" fill="none" strokeLinecap="round" />
            </>
          ) : mood === "done" ? (
            <>
              <path d="M24 31 Q26 28 28 31" stroke="#3b2f2f" strokeWidth="1.8" fill="none" strokeLinecap="round" />
              <path d="M36 31 Q38 28 40 31" stroke="#3b2f2f" strokeWidth="1.8" fill="none" strokeLinecap="round" />
            </>
          ) : (
            <g className="eyes">
              <ellipse cx={mood === "reply" ? 27.5 : 26} cy="30" rx="2" ry="2.4" fill="#3b2f2f" />
              <ellipse cx={mood === "reply" ? 39.5 : 38} cy="30" rx="2" ry="2.4" fill="#3b2f2f" />
            </g>
          )}
          {/* ほっぺと口 */}
          <ellipse cx="21.5" cy="35" rx="3" ry="2" fill="#ff9b9b" opacity="0.55" />
          <ellipse cx="42.5" cy="35" rx="3" ry="2" fill="#ff9b9b" opacity="0.55" />
          {mood === "approval" ? (
            <ellipse cx="32" cy="37" rx="2.2" ry="2.6" fill="#c0504d" />
          ) : (
            <path d={mood === "done" ? "M28 35 Q32 40 36 35" : "M29.5 36 Q32 38 34.5 36"} stroke="#c0504d" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          )}
        </g>
        {/* 持ち物 */}
        {mood === "working" && (
          <g className="laptop">
            <rect x="20" y="52" width="24" height="12" rx="2" fill="#dfe6ee" stroke="#b5c0cc" />
            <rect x="23" y="54.5" width="18" height="7" rx="1" fill="#9cc5ff" className="screen" />
          </g>
        )}
      </g>
      {/* 記号 */}
      {mood === "approval" && (
        <g className="mark mark-needs">
          <circle cx="54" cy="10" r="8" fill="#f2a516" />
          <rect x="53" y="4.5" width="2.2" height="7" rx="1" fill="#fff" />
          <circle cx="54.1" cy="14.2" r="1.3" fill="#fff" />
        </g>
      )}
      {mood === "done" && (
        <g className="mark mark-done">
          <circle cx="54" cy="10" r="8" fill="#9aa1ad" />
          <path d="M50 10 L53 13 L58 7" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
      {mood === "idle" && (
        <text className="mark mark-z" x="48" y="14" fontSize="11" fill="#8a94a6" fontWeight="700">z</text>
      )}
      {mood === "reply" && (
        <g className="mark mark-dots">
          <path d="M42 3 h20 a5 5 0 0 1 5 5 v6 a5 5 0 0 1 -5 5 h-13 l-5 4 v-4 h-2 a5 5 0 0 1 -5 -5 v-6 a5 5 0 0 1 5 -5 z" fill="#fff" stroke="#4b8bf5" strokeWidth="1.6" />
          <circle cx="47" cy="11" r="1.7" fill="#4b8bf5" />
          <circle cx="52" cy="11" r="1.7" fill="#4b8bf5" />
          <circle cx="57" cy="11" r="1.7" fill="#4b8bf5" />
        </g>
      )}
    </svg>
  );
}
