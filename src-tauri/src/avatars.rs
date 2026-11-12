// キャラの絵の割り当て。町の中でなるべく同じ絵が出ないようにする。
// - セッションが初めて出たとき、候補（親は大人、それ以外は子供）のうち、ID の hash で決まる位置から順に見て、町でまだ使っていない絵を取る
// - 一度決めた絵は変えない（~/.family-computing/avatars.json に保存し、再起動しても同じ）
// - セッションが消えたら、その絵を空きに戻す
// - 候補を使い切ったら、色相をずらした版（hue-rotate）で区別する
// 乱数と時刻は使わない。同じ入力からは同じ割り当てになる。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// 親（根のセッション）に当てる大人のキャラ
pub const ADULTS: [&str; 22] = [
    "Woman", "Noble", "Knight", "KnightGold", "Inspector", "Master", "Monk", "Monk2", "OldMan", "OldMan2", "OldMan3",
    "Samurai", "SamuraiBlue", "SamuraiRed", "Shaman", "Sultan", "Sultan2", "SorcererBlack", "SorcererOrange", "Caveman",
    "Caveman2", "ManGreen",
];
/// 子より下に当てる子供のキャラ
pub const KIDS: [&str; 33] = [
    "Boy", "Princess", "EggBoy", "EggGirl", "Cavegirl", "Cavegirl2", "LionBoy", "Villager", "Villager2", "Villager3",
    "Villager4", "Villager5", "Villager6", "Village6", "NinjaBlue", "NinjaBlue2", "NinjaGreen", "NinjaRed", "NinjaRed2",
    "NinjaYellow", "NinjaGray", "NinjaEskimo", "NinjaMasked", "RedNinja3", "Eskimo", "MaskFrog", "MaskRacoon",
    "MaskGoldRacoon", "Hunter", "FighterRed", "FighterWhite", "CamouflageGreen", "CamouflageRed",
];
/// 候補を使い切ったときに使う色相のずらし（度）。0 は元の色
pub const HUES: [u16; 6] = [0, 60, 120, 180, 240, 300];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Assign {
    pub char: String,
    pub hue: u16,
}

fn fnv(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in s.bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

/// live は (セッション ID, 根か) を出てきた順（親の開始時刻などで決まる順）に並べたもの。
/// prev にある割り当ては、生きている限り変えない。生きていないものは外す（絵を空きに戻す）。
pub fn assign(prev: &BTreeMap<String, Assign>, live: &[(String, bool)]) -> BTreeMap<String, Assign> {
    let live_ids: HashSet<&str> = live.iter().map(|(id, _)| id.as_str()).collect();
    let mut out: BTreeMap<String, Assign> = prev.iter().filter(|(id, _)| live_ids.contains(id.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    for (id, is_root) in live {
        if out.contains_key(id) {
            continue;
        }
        let pool: &[&str] = if *is_root { &ADULTS } else { &KIDS };
        let used: HashSet<(String, u16)> = out.values().map(|a| (a.char.clone(), a.hue)).collect();
        let start = fnv(id) as usize % pool.len();
        let mut pick = None;
        'outer: for &hue in HUES.iter() {
            for k in 0..pool.len() {
                let c = pool[(start + k) % pool.len()];
                if !used.contains(&(c.to_string(), hue)) {
                    pick = Some(Assign { char: c.to_string(), hue });
                    break 'outer;
                }
            }
        }
        // 候補×色相をすべて使い切ったら、hash の位置の絵を重ねて使う
        let a = pick.unwrap_or(Assign { char: pool[start].to_string(), hue: 0 });
        out.insert(id.clone(), a);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize, root_every: usize) -> Vec<(String, bool)> {
        (0..n).map(|i| (format!("{:08x}-session-{i}", i * 2654435761usize), i % root_every == 0)).collect()
    }

    #[test]
    fn 同じ入力なら同じ割り当て() {
        let live = ids(20, 5);
        assert_eq!(assign(&BTreeMap::new(), &live), assign(&BTreeMap::new(), &live));
    }

    #[test]
    fn 候補の数までは絵が重ならない() {
        // 根4人（大人22体の範囲）、子16人（子供33体の範囲）
        let live = ids(20, 5);
        let a = assign(&BTreeMap::new(), &live);
        let mut seen = HashSet::new();
        for v in a.values() {
            assert!(seen.insert((v.char.clone(), v.hue)), "重なった: {v:?}");
            assert_eq!(v.hue, 0, "候補が残っているのに色相をずらした");
        }
    }

    #[test]
    fn 新しい人が来ても前からいる人の絵は変わらない() {
        let first = ids(10, 5);
        let a = assign(&BTreeMap::new(), &first);
        let mut more = first.clone();
        more.extend(ids(30, 7).into_iter().skip(10));
        let b = assign(&a, &more);
        for (id, v) in &a {
            assert_eq!(b.get(id), Some(v), "{id} の絵が変わった");
        }
    }

    #[test]
    fn いなくなった人の絵は空きに戻り次の人が使える() {
        let live = vec![("a".to_string(), true)];
        let a = assign(&BTreeMap::new(), &live);
        let freed = a["a"].clone();
        let gone = assign(&a, &[]);
        assert!(gone.is_empty());
        // 同じ hash の位置になる ID を探さなくても、大人を全員埋めれば空きは1つずつ使われる
        let all: Vec<(String, bool)> = (0..ADULTS.len()).map(|i| (format!("r{i}"), true)).collect();
        let full = assign(&gone, &all);
        assert!(full.values().any(|v| *v == freed), "空きに戻った絵が使われていない");
    }

    #[test]
    fn 使い切ったら色相をずらして区別する() {
        let live: Vec<(String, bool)> = (0..(KIDS.len() + 5)).map(|i| (format!("k{i}"), false)).collect();
        let a = assign(&BTreeMap::new(), &live);
        let mut seen = HashSet::new();
        for v in a.values() {
            assert!(seen.insert((v.char.clone(), v.hue)));
        }
        assert_eq!(a.values().filter(|v| v.hue != 0).count(), 5);
    }
}
