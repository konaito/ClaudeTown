// キャラの絵の割り当て。世代（根、子、孫より下）に合った見た目のキャラほど出やすい、重み付きの乱数で選ぶ。
// - 年齢の印象の点数（AGES）と、世代の目標の点数（Gen::target）が近いほど重みが大きい。遠いキャラも重みは0にしない
// - 同じ世代で直近に出たキャラ（RECENT_N 回分）は、重みを RECENT_PENALTY 倍に下げる
// - 町の中でなるべく同じ絵が出ないようにする。世代の候補（重みが POOL_FLOOR 以上）が尽きたら、色相をずらした版で区別する
// - 一度決めた絵は、セッションが生きている限り変えない（保存して、再起動しても同じ）
// - セッションが消えたら、その絵を空きに戻す
// 点数の基準と理由は docs/design/character-age.md。画面側の表（src/kid/ages.json）はこの表から生成する。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 年齢の印象の点数（0＝子供、50＝お兄さん、100＝おじさん）。点数の正本はここだけ。
/// 変えたら `FC_WRITE_AGES=1 cargo test ages` で src/kid/ages.json を作り直す
pub const AGES: [(&str, u8); 55] = [
    ("Boy", 10), ("CamouflageGreen", 45), ("CamouflageRed", 45), ("Cavegirl", 20), ("Cavegirl2", 25),
    ("Caveman", 55), ("Caveman2", 60), ("EggBoy", 5), ("EggGirl", 5), ("Eskimo", 20),
    ("FighterRed", 40), ("FighterWhite", 40), ("Hunter", 40), ("Inspector", 70), ("Knight", 60),
    ("KnightGold", 50), ("LionBoy", 15), ("ManGreen", 65), ("MaskFrog", 10), ("MaskGoldRacoon", 20),
    ("MaskRacoon", 25), ("Master", 95), ("Monk", 85), ("Monk2", 75), ("NinjaBlue", 35),
    ("NinjaBlue2", 40), ("NinjaEskimo", 25), ("NinjaGray", 50), ("NinjaGreen", 35), ("NinjaMasked", 45),
    ("NinjaRed", 40), ("NinjaRed2", 40), ("NinjaYellow", 30), ("Noble", 65), ("OldMan", 70),
    ("OldMan2", 90), ("OldMan3", 100), ("Princess", 30), ("RedNinja3", 45), ("Samurai", 45),
    ("SamuraiBlue", 45), ("SamuraiRed", 70), ("Shaman", 60), ("SorcererBlack", 35), ("SorcererOrange", 30),
    ("Sultan", 80), ("Sultan2", 75), ("Village6", 30), ("Villager", 15), ("Villager2", 40),
    ("Villager3", 25), ("Villager4", 15), ("Villager5", 35), ("Villager6", 35), ("Woman", 40),
];
/// 重みの広がり。w = exp(-((点数 - 目標) / SIGMA)^2 / 2)
pub const SIGMA: f64 = 12.0;
/// 世代の候補とみなす重みの下限（目標から約 2.45σ、σ=12 で約29点以内）。この候補が町で使い切られたら、次の色相へ進む
pub const POOL_FLOOR: f64 = 0.05;
/// 同じ世代で直近に出たキャラを何回分覚えるか。根1・子3・孫6 の町を作り直したとき、1つ前の町の孫を全員覚えていられる長さにした
pub const RECENT_N: usize = 6;
/// 直近に出たキャラの重みに掛ける値
pub const RECENT_PENALTY: f64 = 0.2;
/// 候補を使い切ったときに使う色相のずらし（度）。0 は元の色
pub const HUES: [u16; 6] = [0, 60, 120, 180, 240, 300];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Gen {
    /// 根のセッション（おじさん）
    Root,
    /// 子（お兄さん）
    Child,
    /// 孫より下（子供）
    Grand,
}

impl Gen {
    #[cfg(test)]
    pub const ALL: [Gen; 3] = [Gen::Root, Gen::Child, Gen::Grand];
    pub fn of(depth: u32) -> Gen {
        match depth {
            0 => Gen::Root,
            1 => Gen::Child,
            _ => Gen::Grand,
        }
    }
    /// 世代の目標の点数
    pub fn target(self) -> f64 {
        match self {
            Gen::Root => 85.0,
            Gen::Child => 45.0,
            Gen::Grand => 15.0,
        }
    }
    /// 保存と画面で使う名前（src/kid/Avatar.tsx の Role と同じ）
    pub fn key(self) -> &'static str {
        match self {
            Gen::Root => "parent",
            Gen::Child => "child",
            Gen::Grand => "grandchild",
        }
    }
}

pub fn weight(score: u8, g: Gen) -> f64 {
    let z = (score as f64 - g.target()) / SIGMA;
    (-z * z / 2.0).exp()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Assign {
    pub char: String,
    pub hue: u16,
}

pub type Assigns = BTreeMap<String, Assign>;
/// 世代の名前（Gen::key）→ 直近に出たキャラ（古い順、最大 RECENT_N 件）
pub type Recent = BTreeMap<String, Vec<String>>;

/// 重みに比例して1つ選ぶ。重みの合計が0なら None
fn pick_weighted<'a>(rng: &mut fastrand::Rng, items: &[(&'a str, f64)]) -> Option<&'a str> {
    let total: f64 = items.iter().map(|(_, w)| w).sum();
    if total <= 0.0 {
        return None;
    }
    let mut r = rng.f64() * total;
    for (c, w) in items {
        if r < *w {
            return Some(c);
        }
        r -= w;
    }
    items.last().map(|(c, _)| *c)
}

/// 新しく1人に絵を決める。used は町で使っている (キャラ, 色相)
fn pick_one(g: Gen, used: &HashSet<(String, u16)>, recent: &[String], rng: &mut fastrand::Rng) -> Assign {
    let w = |c: &str, s: u8| weight(s, g) * if recent.iter().any(|r| r == c) { RECENT_PENALTY } else { 1.0 };
    for &hue in HUES.iter() {
        let free = |c: &str| !used.contains(&(c.to_string(), hue));
        // 世代の候補がこの色相で尽きていたら、次の色相へ進む
        if !AGES.iter().any(|&(c, s)| weight(s, g) >= POOL_FLOOR && free(c)) {
            continue;
        }
        // 尽きていなければ、空いているキャラ全部から重みで選ぶ（遠いキャラも重みは小さいが残る）
        let items: Vec<(&str, f64)> = AGES.iter().filter(|(c, _)| free(c)).map(|&(c, s)| (c, w(c, s))).collect();
        if let Some(c) = pick_weighted(rng, &items) {
            return Assign { char: c.to_string(), hue };
        }
    }
    // 候補×色相をすべて使い切ったら、重なるのを許して色相0で選ぶ
    let items: Vec<(&str, f64)> = AGES.iter().map(|&(c, s)| (c, w(c, s))).collect();
    Assign { char: pick_weighted(rng, &items).unwrap_or(AGES[0].0).to_string(), hue: 0 }
}

/// live は (セッション ID, 深さ) を出てきた順（開始時刻などで決まる順）に並べたもの。深さは根が0。
/// prev にある割り当ては、生きている限り変えない。生きていないものは外す（絵を空きに戻す）。
/// 新しく決めたキャラは recent の世代の列に足す。
pub fn assign(prev: &Assigns, recent: &mut Recent, live: &[(String, u32)], rng: &mut fastrand::Rng) -> Assigns {
    let live_ids: HashSet<&str> = live.iter().map(|(id, _)| id.as_str()).collect();
    let mut out: Assigns = prev.iter().filter(|(id, _)| live_ids.contains(id.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    for (id, depth) in live {
        if out.contains_key(id) {
            continue;
        }
        let g = Gen::of(*depth);
        let used: HashSet<(String, u16)> = out.values().map(|a| (a.char.clone(), a.hue)).collect();
        let hist = recent.entry(g.key().to_string()).or_default();
        let a = pick_one(g, &used, hist, rng);
        hist.push(a.char.clone());
        if hist.len() > RECENT_N {
            let cut = hist.len() - RECENT_N;
            hist.drain(..cut);
        }
        out.insert(id.clone(), a);
    }
    out
}

/// parent（生きている親の ID、無ければ根）をたどって深さを出す。循環していたら、そこで打ち切る
pub fn depths(parent_of: &HashMap<String, Option<String>>) -> HashMap<String, u32> {
    let mut out = HashMap::new();
    for id in parent_of.keys() {
        let mut d = 0u32;
        let mut seen: HashSet<&str> = HashSet::from([id.as_str()]);
        let mut cur = id.as_str();
        while let Some(Some(p)) = parent_of.get(cur) {
            if !seen.insert(p.as_str()) || d >= 64 {
                break;
            }
            d += 1;
            cur = p.as_str();
        }
        out.insert(id.clone(), d);
    }
    out
}

// ---------- 保存 ----------
// 割り当ては avatars.json に {ID: {char, hue}} の形で置く。この形は安定版の古いコードも読むので、変えない・足さない
// （読めないと古いコードは空とみなし、全員を振り直して上書きする）。直近の履歴は別のファイル（avatars-recent.json）に置く。

pub fn recent_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("avatars");
    path.with_file_name(format!("{stem}-recent.json"))
}

/// 読むのは、前に読んだときからファイルが変わったときだけ（#11、super::read_json_cached）
pub fn load(path: &Path) -> (Assigns, Recent) {
    let a = super::read_json_cached(path).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let r = super::read_json_cached(&recent_path(path)).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    (a, r)
}

fn write_atomic(path: &Path, text: &str) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("tmp");
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

pub fn save(path: &Path, a: &Assigns, r: &Recent) {
    write_atomic(path, &serde_json::to_string_pretty(a).unwrap_or_default());
    write_atomic(&recent_path(path), &serde_json::to_string_pretty(r).unwrap_or_default());
}

/// 画面側（src/kid/ages.json）に渡す表。点数、σ、世代の目標。試験の中で生成と照合をする
#[cfg(test)]
pub fn ages_json() -> String {
    let ages: BTreeMap<&str, u8> = AGES.iter().copied().collect();
    let targets: BTreeMap<&str, f64> = Gen::ALL.iter().map(|g| (g.key(), g.target())).collect();
    let v = serde_json::json!({
        "_comment": "src-tauri/src/avatars.rs の AGES から生成した。手で直さない（FC_WRITE_AGES=1 cargo test ages）",
        "sigma": SIGMA,
        "targets": targets,
        "ages": ages,
    });
    serde_json::to_string_pretty(&v).unwrap() + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng() -> fastrand::Rng {
        fastrand::Rng::with_seed(20261112)
    }
    fn score(c: &str) -> u8 {
        AGES.iter().find(|(n, _)| *n == c).unwrap().1
    }
    fn ids(n: usize, depth_of: impl Fn(usize) -> u32) -> Vec<(String, u32)> {
        (0..n).map(|i| (format!("{:08x}-session-{i}", i * 2654435761usize), depth_of(i))).collect()
    }

    #[test]
    fn 表にキャラの絵が全部そろっていて重複が無い() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/sprites/ninja/characters");
        let mut on_disk: Vec<String> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        on_disk.sort();
        let mut table: Vec<String> = AGES.iter().map(|(c, _)| c.to_string()).collect();
        table.sort();
        table.dedup();
        assert_eq!(table.len(), AGES.len(), "表に同じキャラが2回ある");
        assert_eq!(table, on_disk);
    }

    #[test]
    fn ages_の生成物が表とそろっている() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/kid/ages.json");
        if std::env::var("FC_WRITE_AGES").is_ok() {
            fs::write(&p, ages_json()).unwrap();
        }
        assert_eq!(fs::read_to_string(&p).unwrap_or_default(), ages_json(), "src/kid/ages.json が古い。FC_WRITE_AGES=1 cargo test ages で作り直す");
    }

    #[test]
    fn 各世代の候補が8体以上ある() {
        // 重みの大きい順に足して、合計の8割に届くまでの数
        for g in Gen::ALL {
            let mut w: Vec<f64> = AGES.iter().map(|&(_, s)| weight(s, g)).collect();
            w.sort_by(|a, b| b.partial_cmp(a).unwrap());
            let total: f64 = w.iter().sum();
            let mut acc = 0.0;
            let n = w.iter().take_while(|x| { let before = acc; acc += *x; before < 0.8 * total }).count();
            println!("{:?}: 合計8割の候補 {n} 体", g);
            assert!(n >= 8, "{g:?} の候補が {n} 体しかない");
        }
    }

    /// 1万回、空の町に1人ずつ来ては去る。直近の減点を効かせる版と、効かせない素の抽選の両方で数える
    fn draw(g: Gen, n: usize, with_recent: bool) -> HashMap<String, usize> {
        let mut r = rng();
        let mut recent = Recent::new();
        let mut count = HashMap::new();
        for i in 0..n {
            let live = vec![(format!("s{i}"), match g { Gen::Root => 0, Gen::Child => 1, Gen::Grand => 2 })];
            if !with_recent {
                recent.clear();
            }
            let a = assign(&Assigns::new(), &mut recent, &live, &mut r);
            *count.entry(a[&live[0].0].char.clone()).or_insert(0) += 1;
        }
        count
    }

    #[test]
    fn 重み付けで世代らしいキャラが出る() {
        const N: usize = 10_000;
        for g in Gen::ALL {
            let count = draw(g, N, false);
            let mean = count.iter().map(|(c, k)| score(c) as f64 * *k as f64).sum::<f64>() / N as f64;
            // 理論値（重みで割り振った平均）
            let wsum: f64 = AGES.iter().map(|&(_, s)| weight(s, g)).sum();
            let expect = AGES.iter().map(|&(_, s)| s as f64 * weight(s, g)).sum::<f64>() / wsum;
            let top = *count.values().max().unwrap() as f64 / N as f64;
            let over60 = count.iter().filter(|(c, _)| score(c) >= 60).map(|(_, k)| *k).sum::<usize>() as f64 / N as f64;
            println!("{g:?}: 平均 {mean:.1}（理論 {expect:.1}、目標 {}）上位1体 {:.1}% 60点以上 {:.1}% 出た種類 {}", g.target(), top * 100.0, over60 * 100.0, count.len());
            assert!((mean - expect).abs() < 1.0, "{g:?} の平均 {mean} が理論値 {expect} から外れた");
            // 表の端（85点以上は4体、15点以下は7体）に寄るぶん、平均は目標より内側にずれる。σ=12 で約6点
            assert!((mean - g.target()).abs() < 10.0, "{g:?} の平均 {mean} が目標 {} から遠い", g.target());
            assert!(top < 0.25, "{g:?} の上位1体が {top}");
            if g == Gen::Grand {
                assert!(over60 < 0.05, "孫の世代で60点以上が {over60}");
            }
        }
    }

    #[test]
    fn 直近に出たキャラは続けて出にくい() {
        // 直近の減点がないと、同じ世代で前の3回と同じ顔が出る割合はおよそ重みの二乗和ぶんある。減点するとそれより下がる
        for g in Gen::ALL {
            let mut r = rng();
            let mut recent = Recent::new();
            let mut last: Vec<String> = vec![];
            let (mut hit, n) = (0usize, 5_000usize);
            for i in 0..n {
                let live = vec![(format!("s{i}"), match g { Gen::Root => 0, Gen::Child => 1, Gen::Grand => 2 })];
                let a = assign(&Assigns::new(), &mut recent, &live, &mut r);
                let c = a[&live[0].0].char.clone();
                if last.contains(&c) {
                    hit += 1;
                }
                last.push(c);
                if last.len() > 3 {
                    last.remove(0);
                }
            }
            let wsum: f64 = AGES.iter().map(|&(_, s)| weight(s, g)).sum();
            let p_same: f64 = AGES.iter().map(|&(_, s)| (weight(s, g) / wsum).powi(2)).sum();
            let rate = hit as f64 / n as f64;
            println!("{g:?}: 直近3回と同じ顔 {:.1}%（減点なしの目安 {:.1}%）", rate * 100.0, 3.0 * p_same * 100.0);
            assert!(rate < 3.0 * p_same * 0.5, "{g:?} で直近と同じ顔が {rate}");
            assert_eq!(recent[g.key()].len(), RECENT_N);
        }
        // 直後の1回は、減点された3体の重みが 0.2 倍になっている
        let mut recent = Recent::from([("parent".to_string(), vec!["Monk".into(), "OldMan2".into(), "Master".into()])]);
        let count = (0..2000).fold(0, |k, i| {
            let mut r = fastrand::Rng::with_seed(i);
            let mut rc = recent.clone();
            let a = assign(&Assigns::new(), &mut rc, &[("x".into(), 0)], &mut r);
            k + ["Monk", "OldMan2", "Master"].contains(&a["x"].char.as_str()) as usize
        });
        assert!(count < 2000 / 4, "減点した3体が {count}/2000 回出た");
        recent.clear();
    }

    /// 根1・子3・孫6 の町を作っては全員消す。深さごとに、1つ前の町と同じ顔が出た割合を返す。
    /// remember が false なら、町ごとに直近の記録を消す（減点が効かない）
    fn rebuild_towns(remember: bool) -> HashMap<u32, f64> {
        let mut r = rng();
        let mut recent = Recent::new();
        let mut prev_round: HashMap<u32, Vec<String>> = HashMap::new();
        let (mut hit, mut total) = (HashMap::<u32, usize>::new(), HashMap::<u32, usize>::new());
        for t in 0..2000 {
            if !remember {
                recent.clear();
            }
            let live: Vec<(String, u32)> = (0..10).map(|i| (format!("t{t}-{i}"), if i == 0 { 0 } else if i < 4 { 1 } else { 2 })).collect();
            let a = assign(&Assigns::new(), &mut recent, &live, &mut r);
            let mut this_round: HashMap<u32, Vec<String>> = HashMap::new();
            for (id, d) in &live {
                let c = a[id].char.clone();
                *total.entry(*d).or_default() += 1;
                if prev_round.get(d).is_some_and(|p| p.contains(&c)) {
                    *hit.entry(*d).or_default() += 1;
                }
                this_round.entry(*d).or_default().push(c);
            }
            prev_round = this_round;
        }
        total.iter().map(|(d, n)| (*d, *hit.get(d).unwrap_or(&0) as f64 / *n as f64)).collect()
    }

    #[test]
    fn 町を作り直すと前の町の顔ぶれが続けて出にくい() {
        // 子と孫は一度に何人も立つので、1つ前の町の顔ぶれを全部覚えていないと減点が効かない
        let with = rebuild_towns(true);
        let without = rebuild_towns(false);
        for d in [0u32, 1, 2] {
            println!("深さ{d}: 1つ前の町と同じ顔 {:.1}%（減点なし {:.1}%）", with[&d] * 100.0, without[&d] * 100.0);
            assert!(with[&d] < without[&d] * 0.7, "深さ{d} で減点が効いていない");
        }
    }

    #[test]
    fn 種が同じなら同じ割り当て() {
        let live = ids(20, |i| (i % 3) as u32);
        let a = assign(&Assigns::new(), &mut Recent::new(), &live, &mut rng());
        let b = assign(&Assigns::new(), &mut Recent::new(), &live, &mut rng());
        assert_eq!(a, b);
    }

    #[test]
    fn 種が違えば顔ぶれが変わる() {
        let live = ids(10, |i| if i == 0 { 0 } else if i < 4 { 1 } else { 2 });
        let a = assign(&Assigns::new(), &mut Recent::new(), &live, &mut fastrand::Rng::with_seed(1));
        let b = assign(&Assigns::new(), &mut Recent::new(), &live, &mut fastrand::Rng::with_seed(2));
        assert_ne!(a, b);
    }

    #[test]
    fn 候補の数までは絵が重ならない() {
        // 根4人、子8人、孫16人
        let live = ids(28, |i| if i < 4 { 0 } else if i < 12 { 1 } else { 2 });
        let a = assign(&Assigns::new(), &mut Recent::new(), &live, &mut rng());
        let mut seen = HashSet::new();
        for v in a.values() {
            assert!(seen.insert((v.char.clone(), v.hue)), "重なった: {v:?}");
            assert_eq!(v.hue, 0, "候補が残っているのに色相をずらした");
        }
    }

    #[test]
    fn 新しい人が来ても前からいる人の絵は変わらない() {
        let first = ids(10, |i| (i % 3) as u32);
        let mut recent = Recent::new();
        let a = assign(&Assigns::new(), &mut recent, &first, &mut rng());
        let mut more = first.clone();
        more.extend(ids(30, |i| (i % 4) as u32).into_iter().skip(10));
        // 種を変え、深さが変わっても、生きている人の絵は保存したまま
        let mut moved: Vec<(String, u32)> = more.iter().map(|(id, d)| (id.clone(), d + 1)).collect();
        moved.reverse();
        let b = assign(&a, &mut recent, &moved, &mut fastrand::Rng::with_seed(99));
        for (id, v) in &a {
            assert_eq!(b.get(id), Some(v), "{id} の絵が変わった");
        }
    }

    #[test]
    fn 保存して読み直しても同じで形は変わらない() {
        let dir = std::env::temp_dir().join(format!("fc-avatars-test-{}", std::process::id()));
        let path = dir.join("avatars.json");
        let mut recent = Recent::new();
        let a = assign(&Assigns::new(), &mut recent, &ids(6, |i| (i % 3) as u32), &mut rng());
        save(&path, &a, &recent);
        let (a2, r2) = load(&path);
        assert_eq!((a2.clone(), r2), (a.clone(), recent));
        // 安定版の古いコードと同じ形（{ID: {char, hue}} だけ）で書いている
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for (_, x) in v.as_object().unwrap() {
            let keys: Vec<&String> = x.as_object().unwrap().keys().collect();
            assert_eq!(keys, vec!["char", "hue"]);
        }
        // 再起動を真似て、読み直した割り当てと別の種で回しても変わらない
        let b = assign(&a2, &mut Recent::new(), &ids(6, |i| (i % 3) as u32), &mut fastrand::Rng::with_seed(7));
        assert_eq!(b, a);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn いなくなった人の絵は空きに戻る() {
        let mut recent = Recent::new();
        let a = assign(&Assigns::new(), &mut recent, &[("a".to_string(), 0)], &mut rng());
        let freed = a["a"].clone();
        let gone = assign(&a, &mut recent, &[], &mut rng());
        assert!(gone.is_empty());
        // 根の候補を全部埋めれば、空きに戻った絵も色相0のまま使われる
        let all: Vec<(String, u32)> = (0..AGES.len()).map(|i| (format!("r{i}"), 0)).collect();
        let full = assign(&gone, &mut recent, &all, &mut rng());
        assert!(full.values().any(|v| *v == freed), "空きに戻った絵が使われていない");
    }

    #[test]
    fn 世代の候補を使い切ったら色相をずらす() {
        // 孫を、孫の候補の数より5人多く入れる。色相0のうちは重ならず、あふれた分は色相をずらす
        let pool = AGES.iter().filter(|&&(_, s)| weight(s, Gen::Grand) >= POOL_FLOOR).count();
        let live: Vec<(String, u32)> = (0..(pool + 5)).map(|i| (format!("k{i}"), 2)).collect();
        let a = assign(&Assigns::new(), &mut Recent::new(), &live, &mut rng());
        let mut seen = HashSet::new();
        for v in a.values() {
            assert!(seen.insert((v.char.clone(), v.hue)));
        }
        assert!(a.values().any(|v| v.hue != 0), "孫の候補 {pool} 体を超えたのに色相をずらしていない");
    }

    #[test]
    fn 大きい町でも孫に年上の顔が出にくい() {
        // 根4、子12、孫24 の町を 300 回作る。子供らしい顔が埋まった後も、孫は色相をずらした子供らしい顔を取る
        let (mut over60, mut total, mut shifted) = (0, 0, 0);
        let mut r = rng();
        for t in 0..300 {
            let live: Vec<(String, u32)> = (0..40).map(|i| (format!("t{t}-{i}"), if i < 4 { 0 } else if i < 16 { 1 } else { 2 })).collect();
            let a = assign(&Assigns::new(), &mut Recent::new(), &live, &mut r);
            for (id, d) in &live {
                if *d == 2 {
                    total += 1;
                    over60 += (score(&a[id].char) >= 60) as usize;
                    shifted += (a[id].hue != 0) as usize;
                }
            }
        }
        let rate = over60 as f64 / total as f64;
        println!("根4・子12・孫24: 孫の60点以上 {:.2}%、色相をずらした孫 {:.1}%", rate * 100.0, shifted as f64 / total as f64 * 100.0);
        assert!(rate < 0.05);
    }

    #[test]
    fn 深さは親をたどって数え循環でも止まる() {
        let m: HashMap<String, Option<String>> = [
            ("r", None), ("c", Some("r")), ("g", Some("c")), ("gg", Some("g")), ("x", Some("y")), ("y", Some("x")),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.map(String::from)))
        .collect();
        let d = depths(&m);
        assert_eq!((d["r"], d["c"], d["g"], d["gg"]), (0, 1, 2, 3));
        assert!(d["x"] <= 2 && d["y"] <= 2);
        assert_eq!(Gen::of(d["gg"]), Gen::Grand);
    }
}
