// 承認待ちの画面（質問 AskUserQuestion、道具の承認、計画の確認 ExitPlanMode）に、チャット欄から答える（#83）。アプリが PTY で立てた claude だけ。
// CLI の承認の画面に、人が打つのと同じキーを書く。2026-11-22 に v2.1.330 の本物の claude（tmux）で確かめたこと:
// - 質問: 番号を押すと、単一選択はその答えを選んで次の質問へ進む（質問が1つだけなら、そのまま送られる）。
//   複数選択は番号で印（[✔]）を付け外しし、カーソルは動かない。「Submit」の行で Enter を押すと次へ進む。
//   「Type something.」の行の番号を押すと、単一選択はカーソルがその行に移り、そのまま文を打てる。Enter で決まる。
//   複数選択では番号は印を付けるだけなので、矢印でカーソルをその行へ動かしてから打つ。打った後は Tab で「Submit」の行へ動く。
//   文の欄にいる間に番号や → を押すと、文に入る（「みそ汁1」になった）。全部の質問に答えると「Review your answers」が出て、
//   「1. Submit answers」で送る。Esc は質問に答えずに断る。貼り付け（ESC [200~ … ESC [201~）は文の欄に入る。
// - 道具の承認: 「Do you want to …?」の下に番号の行が出る。行は道具と設定で変わる（Yes、Yes, and …、No）。番号で決まる。
//   No の行で Tab を押すと「No, and tell Claude what to do differently」の欄になり、打った理由と Enter で、作業を止めずに断れる。
//   No の番号を押すと作業が止まる（Interrupted）。
// - 計画の確認: 「Would you like to proceed?」の下に「Yes, and use auto mode」などの行と「Tell Claude what to change」が出る。
//   「Tell Claude what to change」の番号を押すと、その行で文を打てる。打った文と Enter で、計画を続けさせる。
// 押す前に毎回、画面を読み直して、画面の承認がこの会話の待っている道具と合うか、カーソルがどこにあるかを確かめる。合わなければ何も送らない。
// 画面から次のキーを決める処理（parse と next_step）は、画面とキーだけを扱う純粋な関数にして、試験で確かめる。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// 承認の画面の番号の行
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    pub n: u32,
    pub label: String,
    #[serde(skip)]
    pub cursor: bool,
    /// 複数選択の印（[ ] か [✔]）。無い行は None
    #[serde(skip)]
    pub checked: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Dialog {
    /// 質問の1問。submit は複数選択の「Submit」の行があるときに Some（中身はカーソルがそこにあるか）
    Ask { question: String, rows: Vec<Row>, submit: Option<bool> },
    /// 全部の質問に答えた後の確かめ。answers は「→ 」の後ろと、折り返した続きの行をつないだもの
    Review { answers: Vec<String>, rows: Vec<Row> },
    /// 道具の承認と計画の確認。prompt は番号の行のすぐ上の行、body はその上の区切り線から prompt の前まで
    Choice { prompt: String, body: String, rows: Vec<Row> },
}

/// 空白を全部除いた文字列。画面では長い文が折り返され、行の頭に字下げが入るので、比べるときはこれで比べる
pub fn norm(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 番号の行（「❯ 1. Red」「  2. [✔] Two」）。字下げ（番号の前の文字数）と行を返す
fn row_of(line: &str) -> Option<(usize, Row)> {
    let mut rest = line.trim_start();
    let mut cursor = false;
    if let Some(r) = rest.strip_prefix('❯') {
        cursor = true;
        rest = r.trim_start();
    }
    let indent = line.chars().count() - rest.chars().count();
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 2 {
        return None;
    }
    let n: u32 = rest[..digits].parse().ok()?;
    let mut label = rest[digits..].strip_prefix(". ")?.trim_end();
    let mut checked = None;
    for (mark, on) in [("[ ] ", false), ("[✔] ", true)] {
        if let Some(l) = label.strip_prefix(mark) {
            checked = Some(on);
            label = l;
        }
    }
    Some((indent, Row { n, label: label.trim().to_string(), cursor, checked }))
}

fn is_rule(line: &str) -> bool {
    let t = line.trim();
    t.chars().count() >= 20 && t.chars().all(|c| c == '─' || c == '╌')
}

/// 質問のタブの行（「←  ☐ Color  ☒ Nums  ✔ Submit  →」、質問が1つなら「 ☐ Yes」）
fn is_tabs(line: &str) -> bool {
    let t = line.trim_start();
    (t.starts_with('←') || t.starts_with('☐') || t.starts_with('☒')) && (t.contains('☐') || t.contains('☒'))
}

/// 確かめの画面の答え（「→ 」の後ろ）。1行に入らない答えは折り返され、続きの行は「→」と同じ桁に字下げされて出る
/// （2026-11-23、v2.1.330 の tmux 100 桁で見た。#256）。「→」の行のすぐ下で、字下げが「→」の桁以上あり、
/// 質問の行（「●」）でも引用の罫線（「│」）でも次の答えでもない行を、続きとしてつなぐ
fn review_answers(lines: &[&str]) -> Vec<String> {
    let indent = |l: &str| l.chars().take_while(|c| *c == ' ').count();
    let mut answers: Vec<String> = Vec::new();
    let mut arrow: Option<usize> = None;
    for l in lines {
        let t = l.trim();
        if let Some(a) = t.strip_prefix("→ ") {
            answers.push(a.trim().to_string());
            arrow = Some(indent(l));
        } else if let (Some(i), Some(last)) = (arrow, answers.last_mut()) {
            if !t.is_empty() && indent(l) >= i && !t.starts_with(['●', '│', '→']) {
                last.push(' ');
                last.push_str(t);
            } else {
                arrow = None;
            }
        }
    }
    answers
}

/// 今の画面（vt100 で解いた文字）から、承認の画面を読む。無ければ None
pub fn parse(screen: &str) -> Option<Dialog> {
    let lines: Vec<&str> = screen.lines().collect();
    // 確かめの画面
    if let Some(r) = lines.iter().rposition(|l| l.trim() == "Review your answers") {
        let rows: Vec<Row> = lines[r + 1..].iter().filter_map(|l| row_of(l).map(|x| x.1)).collect();
        if rows.iter().any(|x| x.label.starts_with("Submit answers")) {
            return Some(Dialog::Review { answers: review_answers(&lines[r + 1..]), rows });
        }
    }
    // 質問
    if let Some(t) = lines.iter().rposition(|l| is_tabs(l)) {
        let after = &lines[t + 1..];
        if after.iter().any(|l| l.contains("Enter to select")) {
            let mut question = String::new();
            let mut rows = Vec::new();
            let mut submit = None;
            for l in after {
                if l.contains("Enter to select") {
                    break;
                }
                if let Some((_, r)) = row_of(l) {
                    rows.push(r);
                } else if rows.is_empty() {
                    // 質問の文は、各行の頭に引用の罫線「│ 」が付いて出ることがある（v2.1.330、2026-11-22）。行頭の1つだけ外す
                    let t = l.trim();
                    let t = t.strip_prefix('│').map(str::trim_start).unwrap_or(t);
                    if !t.is_empty() {
                        question.push_str(t);
                        question.push(' ');
                    }
                } else {
                    let s = l.trim();
                    if s == "Submit" || s.strip_prefix('❯').map(str::trim) == Some("Submit") {
                        submit = Some(s.starts_with('❯'));
                    }
                }
            }
            if !rows.is_empty() {
                return Some(Dialog::Ask { question: question.trim().to_string(), rows, submit });
            }
        }
    }
    // 道具の承認と計画の確認。下から見て最後のカーソルの行が、番号の並びの中にある
    let c = lines.iter().rposition(|l| row_of(l).is_some_and(|(_, r)| r.cursor))?;
    let (indent, _) = row_of(lines[c])?;
    let deeper = |l: &str| l.trim().is_empty() || l.chars().take_while(|c| *c == ' ').count() > indent;
    // 上へ、番号の行と、行の下の字下げした行と、空行をたどる。最初に当たった字下げの浅い行が prompt。
    // 実際の画面では prompt と番号の行の間に空行がある（2026-11-22、PTY の vt100 の画面で見た。tmux で撮ったときは空行を落としていた）
    let mut top = c;
    while top > 0 {
        let l = lines[top - 1];
        if row_of(l).is_some_and(|(i, _)| i == indent) || deeper(l) {
            top -= 1;
        } else {
            break;
        }
    }
    if top == 0 {
        return None;
    }
    let first = (top..=c).find(|&i| row_of(lines[i]).is_some()).unwrap_or(c);
    if lines[top..first].iter().any(|l| !l.trim().is_empty()) {
        return None;
    }
    let prompt = lines[top - 1].trim().to_string();
    if prompt.is_empty() || is_rule(&prompt) {
        return None;
    }
    let mut rows = Vec::new();
    for l in &lines[first..] {
        match row_of(l) {
            Some((i, r)) if i == indent => rows.push(r),
            _ if deeper(l) && !l.trim().is_empty() => {}
            _ => break,
        }
    }
    if rows.iter().enumerate().any(|(i, r)| r.n != i as u32 + 1) || rows.len() < 2 {
        return None;
    }
    // 本文は、prompt の上の区切り線（─）から prompt の前まで。計画の確認は本文と prompt の間にも区切り線があるので、空なら1本上の線から取る
    let mut end = top - 1;
    let mut body = String::new();
    while body.is_empty() {
        let start = lines[..end].iter().rposition(|l| is_rule(l) && l.contains('─'));
        body = lines[start.map(|i| i + 1).unwrap_or(0)..top - 1].iter().filter(|l| !is_rule(l)).map(|l| l.trim_end()).collect::<Vec<_>>().join("\n").trim().to_string();
        match start {
            Some(i) => end = i,
            None => break,
        }
    }
    Some(Dialog::Choice { prompt, body, rows })
}

/// 選択の行のカーソル（「❯ 1. Yes」「❯ 3.  Sonnet 5.5」）が、入力欄（区切り線のすぐ下の「❯ 」の行）より下にあるか。入力欄が無ければ、カーソルがあるだけで true。
/// 承認の画面とモデルのピッカーは入力欄の代わりに出る。画面の上に残った前の入力（「❯ 1. a」と「  2. b」）は入力欄より上にあるので数えない（#168）
pub fn menu_below_input(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().collect();
    let Some(cursor) = lines.iter().rposition(|l| row_of(l).is_some_and(|(_, r)| r.cursor)) else { return false };
    let input = (1..lines.len()).rev().find(|&i| lines[i].trim_start().starts_with('❯') && is_rule(lines[i - 1]) && lines[i - 1].contains('─'));
    input.is_none_or(|i| cursor > i)
}

/// 画面から押す答え。画面の行の番号と文で指す（番号だけだと、行の並びが変わったときに別の行を押す）
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Act {
    /// 道具の承認か計画の確認で、その行を選ぶ
    Option { n: u32, label: String },
    /// 道具の承認を断る（理由があれば作業を止めずに伝える）。質問なら答えずに断る（Esc）
    Deny { reason: Option<String> },
    /// 計画の確認で、直してほしいことを伝えて計画を続けさせる
    Revise { note: String },
    /// 質問に答える。picks は質問の順で、選んだ選択肢の番号（0 から）と「その他」の文
    Ask { picks: Vec<Pick> },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Pick {
    pub picked: Vec<usize>,
    #[serde(default)]
    pub other: String,
}

/// 質問の形（transcript の AskUserQuestion の input から作る）
#[derive(Debug, Clone, PartialEq)]
pub struct Q {
    pub question: String,
    pub labels: Vec<String>,
    pub multi: bool,
}

pub fn questions_of(input: &Value) -> Vec<Q> {
    input["questions"].as_array().map(|qs| qs.iter().map(|q| Q {
        question: q["question"].as_str().unwrap_or("").to_string(),
        labels: q["options"].as_array().map(|o| o.iter().map(|x| x["label"].as_str().unwrap_or("").to_string()).collect()).unwrap_or_default(),
        multi: q["multiSelect"].as_bool().unwrap_or(false),
    }).collect()).unwrap_or_default()
}

/// 次に書くもの
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// キーを書いて、画面が変わるのを待ち、次を決め直す
    Key(String),
    /// 文の欄に貼る
    Paste(String),
    /// このキーで答えが決まる。書いたら終わる（次の承認の画面に続けて押さない）
    Final(String),
    /// もう承認の画面が無い
    Done,
    Fail(String),
}

pub const DOWN: &str = "\x1b[B";
pub const UP: &str = "\x1b[A";
const ENTER: &str = "\r";
const TAB: &str = "\t";
const ESC: &str = "\x1b";

fn digit(n: u32) -> String {
    n.to_string()
}

/// 1行の欄に入れる文。改行は空白にする（欄は1行で、Enter は決める操作になる）
pub fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 欄に打った文が画面の行に出ているか。長い文は折り返されて行に入りきらないので、頭の30字で比べる
fn shows(label: &str, text: &str) -> bool {
    let want: String = norm(text).chars().take(30).collect();
    !want.is_empty() && norm(label).starts_with(&want)
}

/// 画面の質問の文と、transcript の質問の文が同じか
fn same_question(screen: &str, q: &str) -> bool {
    let (a, b) = (norm(screen), norm(q));
    !a.is_empty() && (a == b || (a.chars().count() >= 10 && b.starts_with(&a)))
}

/// 1つの質問の答えの文。answers.ts の answerText と同じ（確かめの画面と比べる）
pub fn answer_text(q: &Q, p: &Pick) -> String {
    let other = one_line(&p.other);
    let picked: Vec<String> = q.labels.iter().enumerate().filter(|(i, _)| p.picked.contains(i)).map(|(_, l)| l.clone()).collect();
    if !q.multi {
        return if other.is_empty() { picked.first().cloned().unwrap_or_default() } else { other };
    }
    picked.into_iter().chain((!other.is_empty()).then_some(other)).collect::<Vec<_>>().join(", ")
}

/// answer が画面を読み直してキーを書く回数の上限の下限。道具の承認と計画の確認は、これで足りる
const MIN_KEYS: usize = 40;

/// answer が画面を読み直してキーを書く回数の上限。質問は、問いごとに要る回数の和に半分の余裕を足す（#256）。
/// 単一選択は多くて3回（「その他」の番号、貼る、Enter）。複数選択は選択肢 n 個で多くて 2n+4 回
/// （印を n+1 個、「その他」の行まで ↓ を n 回、貼る、Tab、Enter）。確かめの画面で1回
pub fn key_limit(qs: &[Q]) -> usize {
    let need = 1 + qs.iter().map(|q| if q.multi { 2 * q.labels.len() + 4 } else { 3 }).sum::<usize>();
    MIN_KEYS.max(need + need / 2)
}

/// 画面と答えから、次に書くものを決める。画面だけから決めるので、途中で止まっても読み直せば続きから決まる
pub fn next_step(d: Option<&Dialog>, act: &Act, qs: &[Q]) -> Step {
    let Some(d) = d else { return Step::Done };
    match (d, act) {
        (Dialog::Ask { .. } | Dialog::Review { .. }, Act::Deny { .. }) => Step::Final(ESC.into()),
        (Dialog::Ask { question, rows, submit }, Act::Ask { picks }) => {
            let Some(qi) = qs.iter().position(|q| same_question(question, &q.question)) else {
                return Step::Fail(format!("画面の質問「{question}」が、待っている質問と合わない"));
            };
            let (q, Some(p)) = (&qs[qi], picks.get(qi)) else { return Step::Fail("答えの数が質問の数と合わない".into()) };
            let n = q.labels.len() as u32;
            let other_row = n + 1;
            let other = one_line(&p.other);
            let cur = rows.iter().find(|r| r.cursor).map(|r| r.n);
            let Some(orow) = rows.iter().find(|r| r.n == other_row) else { return Step::Fail("「Type something」の行が見つからない".into()) };
            let placeholder = orow.label.starts_with("Type something");
            if !q.multi {
                if !other.is_empty() {
                    return if cur != Some(other_row) {
                        Step::Key(digit(other_row))
                    } else if shows(&orow.label, &other) {
                        if qs.len() == 1 { Step::Final(ENTER.into()) } else { Step::Key(ENTER.into()) }
                    } else if placeholder {
                        Step::Paste(other)
                    } else {
                        Step::Fail("「その他」の欄に違う文が入っている".into())
                    };
                }
                let [i] = p.picked[..] else { return Step::Fail(format!("「{}」は1つだけ選ぶ質問", q.question)) };
                if i as u32 >= n {
                    return Step::Fail("選んだ番号が選択肢に無い".into());
                }
                return if qs.len() == 1 { Step::Final(digit(i as u32 + 1)) } else { Step::Key(digit(i as u32 + 1)) };
            }
            // 複数選択。文の欄にいる間は番号を押さない（文に入る）
            let in_text = cur == Some(other_row);
            for r in rows.iter().filter(|r| r.n >= 1 && r.n <= n) {
                let want = p.picked.contains(&(r.n as usize - 1));
                if r.checked.unwrap_or(false) != want {
                    return if in_text { Step::Fail("「その他」の欄にいる間に印を付け直そうとした".into()) } else { Step::Key(digit(r.n)) };
                }
            }
            let o_on = orow.checked.unwrap_or(false);
            if !other.is_empty() {
                if !shows(&orow.label, &other) {
                    if in_text {
                        return if placeholder { Step::Paste(other) } else { Step::Fail("「その他」の欄に違う文が入っている".into()) };
                    }
                    if !o_on {
                        return Step::Key(digit(other_row));
                    }
                    return match cur {
                        Some(c) if c < other_row => Step::Key(DOWN.into()),
                        _ => Step::Key(UP.into()),
                    };
                }
                if !o_on {
                    return Step::Fail("「その他」に文はあるが印が付いていない".into());
                }
            } else if o_on {
                return if in_text { Step::Fail("「その他」の欄にいる".into()) } else { Step::Key(digit(other_row)) };
            }
            match (submit, cur) {
                (Some(true), _) => Step::Key(ENTER.into()),
                (Some(false), Some(c)) if c == other_row => Step::Key(TAB.into()),
                (Some(false), Some(c)) if c > other_row => Step::Key(UP.into()),
                (Some(false), _) => Step::Key(DOWN.into()),
                (None, _) => Step::Fail("複数選択の「Submit」の行が見つからない".into()),
            }
        }
        (Dialog::Review { answers, rows }, Act::Ask { picks }) => {
            let want: Vec<String> = qs.iter().zip(picks).map(|(q, p)| answer_text(q, p)).collect();
            if answers.len() != want.len() || answers.iter().zip(&want).any(|(a, w)| norm(a) != norm(w)) {
                return Step::Fail(format!("確かめの画面の答え（{}）が、送ろうとした答え（{}）と違う", answers.join(" / "), want.join(" / ")));
            }
            match rows.iter().find(|r| r.label.starts_with("Submit answers")) {
                Some(r) => Step::Final(digit(r.n)),
                None => Step::Fail("「Submit answers」の行が見つからない".into()),
            }
        }
        (Dialog::Choice { rows, .. }, Act::Option { n, label }) => match rows.iter().find(|r| r.n == *n) {
            Some(r) if norm(&r.label).starts_with(&norm(label)) && !label.trim().is_empty() => Step::Final(digit(*n)),
            _ => Step::Fail(format!("画面の {n} 番の行が「{label}」ではない")),
        },
        (Dialog::Choice { rows, .. }, Act::Deny { reason }) => {
            let reason = one_line(reason.as_deref().unwrap_or(""));
            let Some(no) = rows.iter().find(|r| r.label == "No" || r.label.starts_with("No,")) else { return Step::Fail("断る（No）の行が見つからない".into()) };
            if reason.is_empty() {
                return if no.label == "No" { Step::Final(digit(no.n)) } else { Step::Fail("断る行が理由を書く欄になっている".into()) };
            }
            if !no.cursor {
                let c = rows.iter().find(|r| r.cursor).map(|r| r.n).unwrap_or(0);
                return Step::Key(if c < no.n { DOWN } else { UP }.into());
            }
            if no.label == "No" {
                Step::Key(TAB.into())
            } else if no.label.starts_with("No, and tell Claude") {
                Step::Paste(reason)
            } else if shows(no.label.trim_start_matches("No,"), &reason) {
                Step::Final(ENTER.into())
            } else {
                Step::Fail("理由の欄に違う文が入っている".into())
            }
        }
        (Dialog::Choice { rows, .. }, Act::Revise { note }) => {
            let note = one_line(note);
            if note.is_empty() {
                return Step::Fail("直してほしいことが空".into());
            }
            match rows.iter().find(|r| r.label.starts_with("Tell Claude what to change")) {
                Some(r) if r.cursor => Step::Paste(note),
                Some(r) => Step::Key(digit(r.n)),
                None => match rows.iter().find(|r| r.cursor) {
                    Some(r) if shows(&r.label, &note) => Step::Final(ENTER.into()),
                    _ => Step::Fail("「Tell Claude what to change」の行が見つからない".into()),
                },
            }
        }
        _ => Step::Fail("画面の承認の種類が、答えの種類と合わない".into()),
    }
}

/// 待っている道具の (id, 名前, input)
pub type Tool = (String, String, Value);

/// 結果がまだ無い道具（古い順）。transcript の末尾から読む
pub fn open_tools(text: &str) -> Vec<Tool> {
    let mut out: Vec<Tool> = Vec::new();
    for line in text.lines() {
        let Ok(o) = serde_json::from_str::<Value>(line) else { continue };
        let Some(content) = o["message"]["content"].as_array() else { continue };
        for c in content {
            match c["type"].as_str() {
                Some("tool_use") => {
                    let id = c["id"].as_str().unwrap_or("").to_string();
                    if !id.is_empty() && !out.iter().any(|x| x.0 == id) {
                        out.push((id, c["name"].as_str().unwrap_or("").to_string(), c["input"].clone()));
                    }
                }
                Some("tool_result") => {
                    let id = c["tool_use_id"].as_str().unwrap_or("");
                    out.retain(|x| x.0 != id);
                }
                _ => {}
            }
        }
    }
    out
}

/// 道具の承認の画面で、その道具の承認だと確かめるのに使う文。比べるときは空白を除く（norm）
#[derive(Debug, Clone, PartialEq)]
pub struct Hint {
    /// 画面に必ず出る文。Bash は command の1行目の頭30字、ファイルの道具はファイル名の頭30字。これが無い候補は使わない
    pub head: String,
    /// 画面に出うる全体。Bash は command 全体、ファイルの道具はパス全体。どこまで画面に出ているかで候補を比べる
    pub full: String,
    /// full を後ろから比べる（ファイルのパス。画面には cwd からの相対のパスが出ることがある）
    pub tail: bool,
}

/// 分からない道具は None（ここからは答えない）
pub fn hint_of(tool: &str, input: &Value) -> Option<Hint> {
    let s = |k: &str| input[k].as_str().map(str::to_string);
    let (head, full, tail) = match tool {
        "Bash" => {
            let c = s("command")?;
            (c.lines().find(|l| !l.trim().is_empty())?.to_string(), c, false)
        }
        "Write" | "Edit" | "MultiEdit" | "Read" | "NotebookEdit" => {
            let p = s("file_path").or(s("notebook_path"))?;
            (p.rsplit('/').next()?.to_string(), p, true)
        }
        "WebFetch" => s("url").map(|u| {
            let rest = u.split("://").nth(1).unwrap_or(&u).to_string();
            (rest.split('/').next().unwrap_or("").to_string(), rest, false)
        })?,
        "WebSearch" => s("query").map(|q| (q.clone(), q, false))?,
        "Glob" | "Grep" => s("pattern").map(|q| (q.clone(), q, false))?,
        "Skill" => s("skill").map(|q| (q.clone(), q, false))?,
        t if t.starts_with("mcp__") => t.rsplit("__").next().map(|q| (q.to_string(), q.to_string(), false))?,
        _ => return None,
    };
    let head: String = norm(&head).chars().take(30).collect();
    (!head.is_empty()).then(|| Hint { head, full: norm(&full), tail })
}

/// 画面の本文（norm 済み）に、hint がどれだけ出ているか。(full の頭か後ろから続けて本文に出ている字数, full が全部出ているか)。
/// head が出ていなければ None
fn strength(h: &Hint, body: &str) -> Option<(usize, bool)> {
    if !body.contains(&h.head) {
        return None;
    }
    let cs: Vec<char> = h.full.chars().collect();
    let piece = |k: usize| -> String { if h.tail { cs[cs.len() - k..].iter().collect() } else { cs[..k].iter().collect() } };
    // 頭（後ろ）から k 字が出ていれば、それより短いものも出ているので、二分探索で一番長い k を探す
    let (mut lo, mut hi) = (0, cs.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if body.contains(&piece(mid)) { lo = mid } else { hi = mid - 1 }
    }
    Some((lo, lo == cs.len()))
}

/// hook（fc-report.py）が PermissionRequest で残した道具（perm/<session_id>.json の items）。agent_id はチームメイトと sub-agent の印
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HookItem {
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: Value,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub at: u64,
}

pub fn hook_items(text: &str) -> Vec<HookItem> {
    serde_json::from_str::<Value>(text).ok().and_then(|v| serde_json::from_value(v["items"].clone()).ok()).unwrap_or_default()
}

/// 画面の承認と、待っている道具を突き合わせる。合えばその道具の (id, 名前, input) と、承認の種類（ask、plan、tool）を返す。
/// 道具の元は2つで、先に hook が PermissionRequest で残したもの（新しい順）、次に transcript で結果がまだ無い道具を見る。
/// transcript には、承認の画面が出ている間に道具の行がまだ書かれていないことがあった（2026-11-22、v2.1.330 で質問と計画の確認の両方）。
/// hook の分は古いものが残りうるので、画面の質問の文や道具の対象が合うものだけを使う。チームメイトと sub-agent の承認（agent_id 付き）には答えない。
/// 計画の確認だけは画面で決め、id は画面の計画の本文から作る（途中で道具の元が増えても id が変わらないように）
pub fn match_tool(d: &Dialog, hook: &[HookItem], open: &[Tool]) -> Result<(Tool, &'static str), String> {
    // (id, 名前, input, チームメイトか) を、hook の新しい順、transcript の新しい順に並べる
    let mut cands: Vec<(Tool, bool)> = hook.iter().rev().map(|h| ((format!("hook:{}", h.at), h.tool_name.clone(), h.tool_input.clone()), h.agent_id.is_some())).collect();
    cands.extend(open.iter().rev().map(|t| (t.clone(), false)));
    let pick = |found: Option<&(Tool, bool)>, none: &str| -> Result<Tool, String> {
        match found {
            Some((_, true)) => Err("画面の承認は、チームメイトか sub-agent のもの。ここからは答えない".into()),
            Some((t, false)) => Ok(t.clone()),
            None => Err(none.into()),
        }
    };
    match d {
        Dialog::Ask { question, .. } => {
            let f = cands.iter().find(|(t, _)| t.1 == "AskUserQuestion" && questions_of(&t.2).iter().any(|q| same_question(question, &q.question)));
            pick(f, "画面の質問の中身が読めない（hook の記録にも会話の記録にも無い）").map(|t| (t, "ask"))
        }
        Dialog::Review { answers, .. } => {
            let f = cands.iter().find(|(t, _)| t.1 == "AskUserQuestion" && questions_of(&t.2).len() == answers.len());
            pick(f, "確かめの画面の質問の中身が読めない").map(|t| (t, "ask"))
        }
        Dialog::Choice { rows, body, prompt } => {
            let input_of = |name: &str| cands.iter().find(|(t, _)| t.1 == name).map(|(t, _)| t.2.clone()).unwrap_or_else(|| json!({}));
            if rows.iter().any(|r| r.label.starts_with("Tell Claude what to change")) || body.contains("Here is Claude's plan") {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                norm(body).hash(&mut h);
                return Ok(((format!("screen:{:016x}", h.finish()), "ExitPlanMode".into(), input_of("ExitPlanMode")), "plan"));
            }
            // 計画の本文が無い ExitPlanMode は「Exit plan mode?」の画面になる（行は Yes, and switch to … と No）。道具の承認と同じに扱う
            if body.contains("Exit plan mode?") || prompt.contains("exit plan mode") {
                let f = cands.iter().find(|(t, _)| t.1 == "ExitPlanMode");
                return pick(f, "画面の計画の確認が、待っている道具と合わない").map(|t| (t, "tool"));
            }
            // 画面の本文に一番長く出ている候補を取る。頭だけで比べると、頭の同じ別の道具（画面に出ていないほう）を取ることがあった（#169）
            // 折り返した command と複数行の command は、各行の頭に「│ 」が付いて出る（2026-11-23、v2.1.330）。行頭の1つだけ外して比べる
            let lines: Vec<&str> = body.lines().map(|l| { let t = l.trim(); t.strip_prefix('│').map(str::trim_start).unwrap_or(t) }).collect();
            // 本文の1行目は承認の種類の見出し（実物で見たのは「Bash command」「Create file」「Edit file」）。見出しで候補の道具を絞る。
            // 答えた後も残る hook の古い記録が、Write の中身や Edit の diff に出ていると、今の承認より長く合ってしまうため。
            // ファイルの承認は、見出しのすぐ下のパスの行（中身の行「  1 hi」の前まで）だけで比べる。知らない見出しは今まで通り本文の全体で比べる
            const FILE_TOOLS: [&str; 5] = ["Write", "Edit", "MultiEdit", "Read", "NotebookEdit"];
            let head_at = lines.iter().position(|l| !l.is_empty());
            let content_row = |l: &str| { let d = l.chars().take_while(char::is_ascii_digit).count(); d > 0 && l[d..].starts_with(char::is_whitespace) };
            let (only, area): (Option<&[&str]>, &[&str]) = match head_at.map(|i| (i, lines[i])) {
                Some((_, "Bash command")) => (Some(&["Bash"]), &lines[..]),
                Some((i, "Create file" | "Edit file")) => {
                    let end = lines[i + 1..].iter().position(|l| content_row(l)).map_or(lines.len(), |k| i + 1 + k);
                    (Some(&FILE_TOOLS), &lines[i + 1..end])
                }
                _ => (None, &lines[..]),
            };
            let b = norm(&area.join("\n"));
            // cands の hook.len() 番目からが transcript の分
            struct Scored<'a> { c: &'a (Tool, bool), st: (usize, bool), full: String, open: bool }
            let scored: Vec<Scored> = cands.iter().enumerate()
                .filter(|(_, (t, _))| !matches!(t.1.as_str(), "AskUserQuestion" | "ExitPlanMode" | "Agent" | "Task"))
                .filter(|(_, (t, _))| only.is_none_or(|o| o.contains(&t.1.as_str())))
                .filter_map(|(i, c)| hint_of(&c.0 .1, &c.0 .2).and_then(|h| strength(&h, &b).map(|st| Scored { c, st, full: h.full, open: i >= hook.len() })))
                .collect();
            let best = scored.iter().map(|x| x.st).max();
            let top_all: Vec<&Scored> = scored.iter().filter(|x| Some(x.st) == best).collect();
            // 同じ組（道具の名前、画面に出うる全体 full、チームメイトか）の候補は、画面で区別できない
            let same = |x: &Scored, y: &Scored| x.c.0 .1 == y.c.0 .1 && x.full == y.full && x.c.1 == y.c.1;
            // 一番強い候補の組が2つ以上なら、画面からはどれか決められない。同じ組の中は、前と同じく先のもの（hook の新しいもの）を取る。
            // hook の記録は答えた後も残る（fc-report.py は新しい順に8件残し、SessionEnd まで消さない）ので、同じファイルの2回目の Edit などで古い記録と同じ組になる
            let mut top: Vec<&Scored> = Vec::new();
            for x in &top_all {
                if !top.iter().any(|y| same(x, y)) {
                    top.push(x);
                }
            }
            if top.len() > 1 {
                if top.iter().all(|x| x.c.1) {
                    return Err("画面の承認は、チームメイトか sub-agent のもの。ここからは答えない".into());
                }
                return Err(format!("画面の承認に同じだけ合う道具が{}件あり、どれの承認か決められない", top.len()));
            }
            // transcript の分は結果がまだ無い（古い記録ではない）。同じ組に中身の違う道具が2つ以上待っていれば、どれか決められない
            if let Some(first) = top.first() {
                let mut open_inputs: Vec<&Value> = Vec::new();
                for x in top_all.iter().filter(|x| x.open && same(x, first)) {
                    if !open_inputs.contains(&&x.c.0 .2) {
                        open_inputs.push(&x.c.0 .2);
                    }
                }
                if open_inputs.len() > 1 {
                    return Err(format!("画面の承認に同じだけ合う道具が{}件あり、どれの承認か決められない", open_inputs.len()));
                }
            }
            let top: Vec<&(Tool, bool)> = top.into_iter().map(|x| x.c).collect();
            pick(top.first().copied(), "画面の承認が、待っている道具と合わない（ここで読めない道具かもしれない）").map(|t| (t, "tool"))
        }
    }
}

/// 計画の確認の画面に出ている計画の本文（input に plan が無いときの補い）
fn plan_on_screen(body: &str) -> String {
    body.split_once("Here is Claude's plan:").map(|(_, b)| b.trim().to_string()).unwrap_or_default()
}

// ---------- ここから下は、アプリの端末とファイルを読む ----------

fn transcript_tail(id: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = super::native::path_of(id)?;
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let from = len.saturating_sub(2 << 20);
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let s = String::from_utf8_lossy(&buf).into_owned();
    // 途中から読んだときは、最初の半端な行を捨てる
    Some(if from > 0 { s.split_once('\n').map(|x| x.1.to_string()).unwrap_or_default() } else { s })
}

/// hook が道具の input を残す置き場。試験では FC_PERM_DIR で差し替える（hook と同じ変数）
fn perm_dir() -> std::path::PathBuf {
    std::env::var("FC_PERM_DIR").ok().filter(|s| !s.is_empty()).map(Into::into).unwrap_or_else(|| super::fc_path(super::Scope::Shared, "perm"))
}

fn waiting(id: &str) -> bool {
    super::pty::pid_of_id(id)
        .and_then(|pid| super::native::sessions::fresh_row(&super::native::claude_home(), pid))
        .is_some_and(|r| r["state"].as_str() == Some("waiting_permission"))
}

/// 画面の承認と待っている道具。合わなければ、ここから答えられない理由
fn current(id: &str) -> Result<(Dialog, Tool, &'static str), String> {
    let screen = super::pty::screen_text(id).ok_or("このセッションの端末はこのアプリに無い")?;
    let d = parse(&screen).ok_or("端末に承認の画面が見えない")?;
    let open = transcript_tail(id).map(|t| open_tools(&t)).unwrap_or_default();
    let mut hook: Vec<HookItem> = super::pty::ids_of(id).iter().flat_map(|sid| std::fs::read_to_string(perm_dir().join(format!("{sid}.json"))).map(|t| hook_items(&t)).unwrap_or_default()).collect();
    hook.sort_by_key(|h| h.at);
    let (t, kind) = match_tool(&d, &hook, &open)?;
    Ok((d, t, kind))
}

/// 承認の欄に出す中身（Tauri の session_detail）。ccn の pending と同じ名前に、画面の行（options）と種類（kind）を足す
pub fn detail(id: &str) -> Value {
    if !waiting(id) {
        return json!({ "pending": [] });
    }
    match current(id) {
        Ok((d, (tid, name, input), kind)) => {
            let (options, plan) = match &d {
                Dialog::Choice { rows, body, .. } => (json!(rows), plan_on_screen(body)),
                _ => (json!([]), String::new()),
            };
            let mut blocked = Value::Null;
            if kind == "ask" {
                let qs = questions_of(&input);
                if qs.is_empty() {
                    blocked = json!("質問の中身が読めない");
                } else if input["questions"].as_array().is_some_and(|a| a.iter().any(|q| q["options"].as_array().is_some_and(|o| o.iter().any(|x| x.get("preview").is_some())))) {
                    blocked = json!("見本（preview）付きの質問は、ここからは答えられない");
                }
            }
            json!({ "pending": [{ "requestId": tid, "toolName": name, "input": input, "kind": kind, "options": options, "screenPlan": plan, "blocked": blocked }] })
        }
        Err(e) => json!({ "pending": [], "blocked": e }),
    }
}

/// 画面が want を満たすまで待つ
fn wait_screen(id: &str, sec: f32, want: impl Fn(&str) -> bool) -> Option<String> {
    let t0 = Instant::now();
    loop {
        let s = super::pty::screen_text(id)?;
        if want(&s) {
            return Some(s);
        }
        if t0.elapsed() >= Duration::from_secs_f32(sec) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// 画面が quiet_ms の間変わらなくなるまで待つ（長くて max_ms）
fn settle(id: &str, quiet_ms: u64, max_ms: u64) {
    let t0 = Instant::now();
    let mut last = super::pty::screen_text(id);
    let mut since = Instant::now();
    while t0.elapsed() < Duration::from_millis(max_ms) {
        std::thread::sleep(Duration::from_millis(50));
        let now = super::pty::screen_text(id);
        if now != last {
            last = now;
            since = Instant::now();
        } else if since.elapsed() >= Duration::from_millis(quiet_ms) {
            return;
        }
    }
}

/// 答える。expect_id は画面に出した道具の id（押す前に、まだその道具を待っているかを確かめる）。
/// 答え終わるまで端末の錠（pty::serial）を持ち、チャット欄の送信とモデルの切り替えのキーを間に入れない（#168）
pub fn answer(id: &str, expect_id: &str, act: &Act) -> Result<String, String> {
    super::refuse_if_disabled()?;
    super::pty::serial(id, || answer_locked(id, expect_id, act))
}

fn answer_locked(id: &str, expect_id: &str, act: &Act) -> Result<String, String> {
    let fail = |m: String| Err(format!("{m}。何も送らずに止めたので、ターミナルで答えて"));
    let mut qs = Vec::new();
    let mut wrote = false;
    // 承認の画面が出た直後に書いたキーは、受け付けられないことがあった（2026-11-22、直した計画の画面が出てすぐ押した「2」で画面が変わらなかった）。
    // 最初のキーの前に、画面が 400ms 変わらなくなるのを待つ（長くて3秒）
    settle(id, 400, 3000);
    let mut tries = 0;
    while tries < key_limit(&qs) {
        tries += 1;
        let screen = super::pty::screen_text(id).ok_or("このセッションの端末はこのアプリに無い")?;
        let d = parse(&screen);
        if d.is_none() && wrote {
            return Ok(done_text(act));
        }
        // 押す前に毎回、画面の承認が同じ道具のものかを確かめる
        let (_, (tid, _, input), _) = match current(id) {
            Ok(x) => x,
            Err(e) => return if wrote { Err(format!("途中で画面が変わった（{e}）。ターミナルで様子を見る")) } else { fail(e) },
        };
        if tid != expect_id {
            return if wrote { Err("途中で別の承認に変わったので止めた。ターミナルで様子を見る".into()) } else { fail("承認の中身が変わった".into()) };
        }
        if qs.is_empty() {
            qs = questions_of(&input);
        }
        let step = next_step(d.as_ref(), act, &qs);
        eprintln!("[dialog] {id} {step:?}");
        match step {
            Step::Done => return Ok(done_text(act)),
            Step::Fail(m) => return if wrote { Err(format!("{m}。途中まで押したので、ターミナルで続きを答えて")) } else { fail(m) },
            Step::Key(k) => {
                super::pty::write(id, &k)?;
                wrote = true;
                wait_screen(id, 1.5, |s| s != screen);
            }
            Step::Paste(t) => {
                super::pty::write(id, &format!("\x1b[200~{}\x1b[201~", super::composer::paste_body(&t)))?;
                wrote = true;
                wait_screen(id, 1.5, |s| s != screen);
            }
            Step::Final(k) => {
                super::pty::write(id, &k)?;
                // 承認の画面が閉じるか、次の画面に変わるまで待つ
                let before = d.clone();
                wait_screen(id, 4.0, |s| parse(s) != before).ok_or("押したが、4秒たっても承認の画面が変わらなかった。ターミナルで様子を見る")?;
                return Ok(done_text(act));
            }
        }
        // 描き直しの途中で読まないよう、少し待つ
        std::thread::sleep(Duration::from_millis(80));
    }
    Err("押しても承認の画面が閉じなかった。ターミナルで様子を見る".into())
}

fn done_text(act: &Act) -> String {
    match act {
        Act::Ask { .. } => "質問に答えた".into(),
        Act::Option { label, .. } => format!("「{label}」を選んだ"),
        Act::Deny { reason } if reason.as_deref().is_some_and(|r| !r.trim().is_empty()) => "理由を付けて断った".into(),
        Act::Deny { .. } => "断った".into(),
        Act::Revise { .. } => "直してほしいことを伝えた".into(),
    }
}

pub mod cmd {
    use serde_json::Value;

    /// 承認の欄の中身。アプリが立てたセッションは画面と会話の記録から作る
    #[tauri::command]
    pub async fn session_detail(session_id: String) -> Result<Value, String> {
        crate::app_guard(&session_id)?;
        crate::blocking(move || Ok(super::detail(&session_id))).await
    }

    #[tauri::command]
    pub async fn answer_dialog(session_id: String, expect_id: String, act: Value) -> Result<String, String> {
        crate::app_guard(&session_id)?;
        crate::refuse_if_disabled()?;
        let act: super::Act = serde_json::from_value(act).map_err(|e| format!("答えの形が読めない: {e}"))?;
        crate::blocking(move || super::answer(&session_id, &expect_id, &act)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-11-22 に v2.1.330 の claude を tmux で動かし、capture-pane で撮った画面
    const ASK_Q1: &str = "❯ Call the AskUserQuestion tool right now\n────────────────────────────────────────\n←  ☐ Color  ☐ Nums  ✔ Submit  →\nWhich color?\n❯ 1. Red\n     Red\n  2. Blue\n     Blue\n  3. Green\n     Green\n  4. Type something.\n────────────────────────────────────────\n  5. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel";
    const ASK_Q2: &str = "←  ☒ Color  ☐ Nums  ✔ Submit  →\nWhich numbers?\n❯ 1. [ ] One\n         One\n  2. [ ] Two\n         Two\n  3. [ ] Three\n         Three\n  4. [ ] Type something\n     Submit\n────────────────────────────────────────\n  5. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel";
    const REVIEW: &str = "←  ☒ Color  ☒ Nums  ✔ Submit  →\nReview your answers\n ● Which color?\n   → Blue\n ● Which numbers?\n   → One, Three\n❯ 1. Submit answers\n  2. Cancel";
    const BASH: &str = "⏺ Bash(echo probe-ok > probe2.txt)\n  ⎿  Waiting…\n────────────────────────────────────────\n Bash command\n Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below\n Write probe-ok into probe2.txt\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n echo probe-ok > probe2.txt\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and always allow access to /private/tmp/fc-ask-probe from this project\n   3. Yes, and switch to auto mode · auto mode handles these prompts for you\n   4. No\n Esc to cancel · Tab to amend";
    const WRITE: &str = "⏺ Write(hi.txt)\n────────────────────────────────────────\n Create file\n hi.txt\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n  1 hi\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to create hi.txt?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n   3. No\n Esc to cancel · Tab to amend\n───────────────────────────────────── create-hi-txt-file ─";
    // 計画の確認は、PTY（vt100）で解いた実物の画面。空行がある
    const PLAN: &str = "⏺ Updated plan\n  ⎿  /plan to preview\n\n────────────────────────────────────────\n Ready to code?\n\n Here is Claude's plan:\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Create hello.txt in /private/tmp/fc-ask-probe containing \"hi\".\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n────────────────────────────────────────\n Claude has written up a plan and is ready to execute. Would you like to proceed?\n\n ❯ 1. Yes, and use auto mode\n   2. Yes, manually approve edits\n   3. Tell Claude what to change\n      shift+tab to approve with this feedback\n\n ctrl+g to edit in Vim · ~/.claude/plans/plan-create-a-file-binary-pascal.md";
    const IDLE: &str = "⏺ 色は Blue でした。\n範囲はどこまでにする？\n1. 質問だけ\n2. 全部\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ⏸ manual mode on · ? for shortcuts";

    // 2026-11-22 に v2.1.330 の claude を tmux（100x50）で動かして撮った実物の画面。質問の各行の頭に「│ 」が付く（fix-storage-gui の承認で、チャット欄が「質問の中身が読めない」と出た）
    const QUOTE_Q1: &str = include_str!("dialog_fixtures/ask_quote_q1.txt");
    const QUOTE_Q2: &str = include_str!("dialog_fixtures/ask_quote_q2.txt");
    const QUOTE_REVIEW: &str = include_str!("dialog_fixtures/ask_quote_review.txt");
    // 本物の hook（perm/<id>.json）の items の input
    fn quote_hook() -> Vec<HookItem> {
        let input = json!({"questions": [
            {"question": "Fix Storage GUI（今 /Applications にある v0.2.0、Developer ID 署名済み）を消して入れ直す。入れ直すのはどれ？", "header": "入れる版", "multiSelect": false,
             "options": [{"label": "Release の v0.2.0", "description": "GitHub Releases の最新 dmg（~/Downloads に同じ dmg もある）。今入っているのと同じ版"}, {"label": "今のブランチをビルド", "description": "feat/login-redesign（ログイン画面作り直し）を手元で universal ビルドして入れる。ad-hoc 署名・未公証になる"}]},
            {"question": "アプリのデータも消す？（Application Support・Caches・WebKit の io.github.konaito.fixstoragegui / fix-storage-gui と、keyring に入れている鍵やログイン情報）", "header": "データ", "multiSelect": false,
             "options": [{"label": "全部消す（初回起動状態）", "description": "x"}, {"label": "アプリ本体だけ", "description": "x"}, {"label": "キーチェーン以外を消す", "description": "x"}]}
        ]});
        vec![HookItem { tool_name: "AskUserQuestion".into(), tool_input: input, agent_id: None, at: 1 }]
    }

    #[test]
    fn quoted_long_questions_match_hook() {
        let hook = quote_hook();
        let qs = questions_of(&hook[0].tool_input);
        for (screen, want) in [(QUOTE_Q1, 0usize), (QUOTE_Q2, 1)] {
            let d = parse(screen).expect("質問の画面");
            let Dialog::Ask { question, .. } = &d else { panic!("Ask ではない: {d:?}") };
            assert!(!question.contains('│'), "質問の文に罫線が混ざった: {question}");
            let (t, kind) = match_tool(&d, &hook, &[]).expect("hook の質問と合う");
            assert_eq!((kind, t.1.as_str()), ("ask", "AskUserQuestion"));
            let act = Act::Ask { picks: vec![pk(&[0], ""), pk(&[2], "")] };
            assert_eq!(next_step(Some(&d), &act, &qs), Step::Key(digit(if want == 0 { 1 } else { 3 })));
        }
        // 別の質問には合わない
        let other = vec![HookItem { tool_input: json!({"questions": [{"question": "全然違う質問？", "options": []}]}), ..hook[0].clone() }];
        assert!(match_tool(&parse(QUOTE_Q1).unwrap(), &other, &[]).is_err());
    }

    #[test]
    fn quoted_review_matches_two_questions() {
        let d = parse(QUOTE_REVIEW).expect("確かめの画面");
        let Dialog::Review { answers, .. } = &d else { panic!("Review ではない: {d:?}") };
        assert_eq!(answers, &vec!["Release の v0.2.0".to_string(), "キーチェーン以外を消す".to_string()]);
        assert!(match_tool(&d, &quote_hook(), &[]).is_ok());
    }

    fn qs2() -> Vec<Q> {
        vec![
            Q { question: "Which color?".into(), labels: vec!["Red".into(), "Blue".into(), "Green".into()], multi: false },
            Q { question: "Which numbers?".into(), labels: vec!["One".into(), "Two".into(), "Three".into()], multi: true },
        ]
    }
    fn pk(picked: &[usize], other: &str) -> Pick {
        Pick { picked: picked.to_vec(), other: other.into() }
    }
    fn step(screen: &str, act: &Act, qs: &[Q]) -> Step {
        next_step(parse(screen).as_ref(), act, qs)
    }
    /// 画面の文字を置き換えた画面（カーソルや印を動かした形）
    fn with(screen: &str, pairs: &[(&str, &str)]) -> String {
        pairs.iter().fold(screen.to_string(), |s, (a, b)| s.replacen(a, b, 1))
    }

    #[test]
    fn reads_the_question_screen() {
        let Some(Dialog::Ask { question, rows, submit }) = parse(ASK_Q1) else { panic!("{:?}", parse(ASK_Q1)) };
        assert_eq!(question, "Which color?");
        assert_eq!(rows.iter().map(|r| r.n).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
        assert!(rows[0].cursor && rows[0].label == "Red");
        assert_eq!(submit, None);
        let Some(Dialog::Ask { rows, submit, .. }) = parse(ASK_Q2) else { panic!() };
        assert_eq!(rows[0].checked, Some(false));
        assert_eq!(rows[3].label, "Type something");
        assert_eq!(submit, Some(false));
    }

    #[test]
    fn reads_review_tool_and_plan_screens() {
        assert_eq!(parse(REVIEW), Some(Dialog::Review {
            answers: vec!["Blue".into(), "One, Three".into()],
            rows: vec![Row { n: 1, label: "Submit answers".into(), cursor: true, checked: None }, Row { n: 2, label: "Cancel".into(), cursor: false, checked: None }],
        }));
        let Some(Dialog::Choice { prompt, body, rows }) = parse(BASH) else { panic!("{:?}", parse(BASH)) };
        assert_eq!(prompt, "Do you want to proceed?");
        assert!(body.contains("echo probe-ok > probe2.txt"), "{body}");
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[3].label, "No");
        let Some(Dialog::Choice { rows, prompt, .. }) = parse(WRITE) else { panic!() };
        assert_eq!(prompt, "Do you want to create hi.txt?");
        assert_eq!(rows.len(), 3);
        let Some(Dialog::Choice { rows, body, .. }) = parse(PLAN) else { panic!("{:?}", parse(PLAN)) };
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2].label, "Tell Claude what to change");
        assert_eq!(plan_on_screen(&body), "Create hello.txt in /private/tmp/fc-ask-probe containing \"hi\".");
    }

    #[test]
    fn idle_screen_has_no_dialog() {
        // 会話の中の番号の並び（カーソルが無い）と入力欄の「❯ 」は、承認の画面ではない
        assert_eq!(parse(IDLE), None);
    }

    #[test]
    fn single_select_presses_the_number() {
        let act = Act::Ask { picks: vec![pk(&[1], ""), pk(&[0, 2], "")] };
        assert_eq!(step(ASK_Q1, &act, &qs2()), Step::Key("2".into()));
        // 質問が1つなら、番号でそのまま送られる
        let one = vec![qs2()[0].clone()];
        assert_eq!(step(ASK_Q1, &Act::Ask { picks: vec![pk(&[1], "")] }, &one), Step::Final("2".into()));
    }

    #[test]
    fn single_select_free_text() {
        let act = Act::Ask { picks: vec![pk(&[], "ハムスター, 2匹"), pk(&[0], "")] };
        assert_eq!(step(ASK_Q1, &act, &qs2()), Step::Key("4".into()));
        let focused = with(ASK_Q1, &[("❯ 1. Red", "  1. Red"), ("  4. Type something.", "❯ 4. Type something.")]);
        assert_eq!(step(&focused, &act, &qs2()), Step::Paste("ハムスター, 2匹".into()));
        let typed = focused.replace("❯ 4. Type something.", "❯ 4. ハムスター, 2匹");
        assert_eq!(step(&typed, &act, &qs2()), Step::Key("\r".into()));
        let wrong = focused.replace("❯ 4. Type something.", "❯ 4. 別の文");
        assert!(matches!(step(&wrong, &act, &qs2()), Step::Fail(_)));
    }

    #[test]
    fn multi_select_toggles_then_submits() {
        let act = Act::Ask { picks: vec![pk(&[1], ""), pk(&[0, 2], "")] };
        assert_eq!(step(ASK_Q2, &act, &qs2()), Step::Key("1".into()));
        let s1 = with(ASK_Q2, &[("[ ] One", "[✔] One")]);
        assert_eq!(step(&s1, &act, &qs2()), Step::Key("3".into()));
        let s2 = with(&s1, &[("[ ] Three", "[✔] Three")]);
        // 印がそろったら、カーソルを「Submit」の行まで下げて Enter
        assert_eq!(step(&s2, &act, &qs2()), Step::Key(DOWN.into()));
        let s3 = with(&s2, &[("❯ 1. [✔] One", "  1. [✔] One"), ("     Submit", "❯    Submit")]);
        assert_eq!(step(&s3, &act, &qs2()), Step::Key("\r".into()));
    }

    #[test]
    fn multi_select_free_text() {
        let act = Act::Ask { picks: vec![pk(&[1], ""), pk(&[1], "みそ汁")] };
        let s1 = with(ASK_Q2, &[("[ ] Two", "[✔] Two")]);
        assert_eq!(step(&s1, &act, &qs2()), Step::Key("4".into()));
        let s2 = with(&s1, &[("[ ] Type something", "[✔] Type something")]);
        assert_eq!(step(&s2, &act, &qs2()), Step::Key(DOWN.into()));
        let s3 = with(&s2, &[("❯ 1. [ ] One", "  1. [ ] One"), ("  4. [✔] Type something", "❯ 4. [✔] Type something")]);
        assert_eq!(step(&s3, &act, &qs2()), Step::Paste("みそ汁".into()));
        let s4 = s3.replace("❯ 4. [✔] Type something", "❯ 4. [✔] みそ汁");
        assert_eq!(step(&s4, &act, &qs2()), Step::Key("\t".into()));
        // 文の欄にいる間に印を直す必要が出たら、番号を押さずに止める（番号が文に入る）
        let s5 = s4.replace("[✔] Two", "[ ] Two");
        assert!(matches!(step(&s5, &act, &qs2()), Step::Fail(_)));
    }

    #[test]
    fn review_checks_the_answers_before_submitting() {
        let act = Act::Ask { picks: vec![pk(&[1], ""), pk(&[0, 2], "")] };
        assert_eq!(step(REVIEW, &act, &qs2()), Step::Final("1".into()));
        let other = Act::Ask { picks: vec![pk(&[0], ""), pk(&[0, 2], "")] };
        assert!(matches!(step(REVIEW, &other, &qs2()), Step::Fail(_)));
    }

    // 2026-11-23 に v2.1.330 の claude（haiku）を tmux（100x50）で動かして撮った確かめの画面。
    // 長い自由入力と、4つ選んだ複数選択の答えが、どちらも2行に折り返されている。続きの行は「→」と同じ桁に字下げされる（#256）
    const WRAPPED_REVIEW: &str = include_str!("dialog_fixtures/ask_wrapped_review.txt");

    #[test]
    fn review_reads_wrapped_answers() {
        let qs = vec![
            Q { question: "このメモに何と書く？".into(), labels: vec!["短い".into(), "長い".into()], multi: false },
            Q {
                question: "今週の献立に入れるものは？".into(),
                labels: vec!["鶏の照り焼きと季節の野菜の炒め物".into(), "鮭の塩焼きと具だくさんの豚汁".into(), "牛肉とごぼうのしぐれ煮".into(), "麻婆豆腐と卵のスープ".into()],
                multi: true,
            },
        ];
        let memo = "会議の要点と次の打ち合わせまでに各自が調べておくことを、日付と担当者の名前を添えて箇条書きで残しておく";
        let act = Act::Ask { picks: vec![pk(&[], memo), pk(&[0, 1, 2, 3], "")] };
        let d = parse(WRAPPED_REVIEW).expect("確かめの画面");
        let Dialog::Review { answers, .. } = &d else { panic!("Review ではない: {d:?}") };
        assert_eq!(answers.len(), 2, "{answers:?}");
        assert_eq!(next_step(Some(&d), &act, &qs), Step::Final("1".into()));
        // 続きの行まで比べるので、1行目が同じで続きだけが違う答えは送らない
        let tail = Act::Ask { picks: vec![pk(&[], &memo.replace("しておく", "さない")), pk(&[0, 1, 2, 3], "")] };
        assert!(matches!(next_step(Some(&d), &tail, &qs), Step::Fail(_)));
        let other = Act::Ask { picks: vec![pk(&[], memo), pk(&[0, 1, 2], "")] };
        assert!(matches!(next_step(Some(&d), &other, &qs), Step::Fail(_)));
        // 質問の文の続き（引用の罫線「│」付き）は答えに混ぜない
        let Some(Dialog::Review { answers, .. }) = parse(QUOTE_REVIEW) else { panic!() };
        assert_eq!(answers, vec!["Release の v0.2.0".to_string(), "キーチェーン以外を消す".to_string()]);
    }

    /// 複数選択の質問の画面を、書いたキーに合わせて動かす見本。動きは 2026-11-23 に v2.1.330 の tmux で見たもの
    /// （番号で印を付け外しし、カーソルは動かない。↓ で「Type something」の次は「Submit」。Submit で Enter を押すと次の質問）
    struct MultiSim {
        qs: Vec<Q>,
        at: usize,
        checked: Vec<Vec<bool>>,
        /// 1..=n+1 は番号の行、n+2 は Submit
        cur: usize,
        /// 確かめの画面で送った
        sent: bool,
    }

    impl MultiSim {
        fn new(qs: Vec<Q>) -> Self {
            let checked = qs.iter().map(|q| vec![false; q.labels.len() + 1]).collect();
            MultiSim { qs, at: 0, checked, cur: 1, sent: false }
        }
        fn screen(&self) -> String {
            let tabs = format!("←  {}  ✔ Submit  →", (0..self.qs.len()).map(|i| format!("{} Q{i}", if i < self.at { '☒' } else { '☐' })).collect::<Vec<_>>().join("  "));
            let c = |on: bool| if on { "❯ " } else { "  " };
            if self.sent {
                return String::new();
            }
            if self.at == self.qs.len() {
                let mut s = format!("{tabs}\n\nReview your answers\n\n");
                for (i, q) in self.qs.iter().enumerate() {
                    let picked: Vec<usize> = (0..q.labels.len()).filter(|&j| self.checked[i][j]).collect();
                    s += &format!(" ● {}\n   → {}\n", q.question, answer_text(q, &pk(&picked, "")));
                }
                return s + "\n❯ 1. Submit answers\n  2. Cancel\n";
            }
            let q = &self.qs[self.at];
            let n = q.labels.len();
            let mut s = format!("{tabs}\n{}\n", q.question);
            for (j, l) in q.labels.iter().chain(std::iter::once(&"Type something".to_string())).enumerate() {
                let mark = if self.checked[self.at][j] { "✔" } else { " " };
                s += &format!("{}{}. [{mark}] {l}\n", c(self.cur == j + 1), j + 1);
            }
            s += &format!("{}   Submit\n{}\n  {}. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n", c(self.cur == n + 2), "─".repeat(40), n + 2);
            s
        }
        fn key(&mut self, k: &str) {
            if self.at == self.qs.len() {
                assert_eq!(k, "1", "確かめの画面で Submit answers 以外を押した");
                self.sent = true;
                return;
            }
            let n = self.qs[self.at].labels.len();
            match k {
                "\x1b[B" => self.cur = (self.cur + 1).min(n + 2),
                "\x1b[A" => self.cur = self.cur.saturating_sub(1).max(1),
                "\t" if self.cur == n + 1 => self.cur = n + 2,
                "\r" if self.cur == n + 2 => {
                    self.at += 1;
                    self.cur = 1;
                }
                d => {
                    let d: usize = d.parse().unwrap_or_else(|_| panic!("見本が知らないキー {d:?}"));
                    assert!((1..=n + 1).contains(&d), "番号 {d} は行に無い");
                    self.checked[self.at][d - 1] ^= true;
                }
            }
        }
    }

    #[test]
    fn many_multi_select_questions_reach_the_submit() {
        // 選択肢4つの複数選択を4問。全部の印を付けると、1問に10回（印4つ、↓4回、Tab、Enter）押し、確かめの画面で1回押す
        let q = |i: usize| Q { question: format!("Which items {i}?"), labels: ["One", "Two", "Three", "Four"].iter().map(|s| s.to_string()).collect(), multi: true };
        let qs: Vec<Q> = (0..4).map(q).collect();
        let act = Act::Ask { picks: vec![pk(&[0, 1, 2, 3], ""); 4] };
        let mut sim = MultiSim::new(qs.clone());
        // answer と同じく、1回に画面を読み直して1つ書く
        let mut tries = 0;
        let fin = loop {
            assert!(tries < key_limit(&qs), "上限 {} 回で送るところまで届かない。止まった画面:\n{}", key_limit(&qs), sim.screen());
            tries += 1;
            match next_step(parse(&sim.screen()).as_ref(), &act, &qs) {
                Step::Key(k) => sim.key(&k),
                Step::Final(k) => break k,
                s => panic!("{s:?}\n{}", sim.screen()),
            }
        };
        assert_eq!((fin.as_str(), tries), ("1", 41));
        // 送ると承認の画面が閉じる
        sim.key(&fin);
        assert_eq!(next_step(parse(&sim.screen()).as_ref(), &act, &qs), Step::Done);
        // 質問の無い承認（道具の承認、計画の確認）は今までと同じ上限
        assert_eq!(key_limit(&[]), 40);
    }

    #[test]
    fn question_mismatch_sends_nothing() {
        let qs = vec![Q { question: "Which pet?".into(), labels: vec!["Cat".into()], multi: false }];
        assert!(matches!(step(ASK_Q1, &Act::Ask { picks: vec![pk(&[0], "")] }, &qs), Step::Fail(_)));
        assert_eq!(step(ASK_Q1, &Act::Deny { reason: None }, &qs), Step::Final("\x1b".into()));
    }

    #[test]
    fn tool_options_by_number_and_label() {
        assert_eq!(step(BASH, &Act::Option { n: 1, label: "Yes".into() }, &[]), Step::Final("1".into()));
        assert_eq!(step(BASH, &Act::Option { n: 2, label: "Yes, and always allow access to /private/tmp/fc-ask-probe from this project".into() }, &[]), Step::Final("2".into()));
        // 行の並びが違えば押さない
        assert!(matches!(step(BASH, &Act::Option { n: 2, label: "No".into() }, &[]), Step::Fail(_)));
        assert_eq!(step(BASH, &Act::Deny { reason: None }, &[]), Step::Final("4".into()));
    }

    #[test]
    fn deny_with_reason_uses_tab_to_amend() {
        let act = Act::Deny { reason: Some("中身を hello にして".into()) };
        assert_eq!(step(WRITE, &act, &[]), Step::Key(DOWN.into()));
        let on_no = with(WRITE, &[(" ❯ 1. Yes", "   1. Yes"), ("   3. No", " ❯ 3. No")]);
        assert_eq!(step(&on_no, &act, &[]), Step::Key("\t".into()));
        let amend = on_no.replace(" ❯ 3. No", " ❯ 3. No, and tell Claude what to do differently");
        assert_eq!(step(&amend, &act, &[]), Step::Paste("中身を hello にして".into()));
        let typed = on_no.replace(" ❯ 3. No", " ❯ 3. No, 中身を hello にして");
        assert_eq!(step(&typed, &act, &[]), Step::Final("\r".into()));
    }

    #[test]
    fn plan_approve_and_revise() {
        assert_eq!(step(PLAN, &Act::Option { n: 2, label: "Yes, manually approve edits".into() }, &[]), Step::Final("2".into()));
        let act = Act::Revise { note: "ファイル名を hi.txt にして".into() };
        assert_eq!(step(PLAN, &act, &[]), Step::Key("3".into()));
        let on = with(PLAN, &[(" ❯ 1. Yes, and use auto mode", "   1. Yes, and use auto mode"), ("   3. Tell Claude", " ❯ 3. Tell Claude")]);
        assert_eq!(step(&on, &act, &[]), Step::Paste("ファイル名を hi.txt にして".into()));
        let typed = on.replace(" ❯ 3. Tell Claude what to change", " ❯ 3. ファイル名を hi.txt にして");
        assert_eq!(step(&typed, &act, &[]), Step::Final("\r".into()));
    }

    #[test]
    fn matches_the_dialog_to_the_waiting_tool() {
        let open = vec![
            ("t1".to_string(), "Agent".to_string(), json!({"prompt": "x"})),
            ("t2".to_string(), "Bash".to_string(), json!({"command": "echo probe-ok > probe2.txt"})),
        ];
        let (t, kind) = match_tool(&parse(BASH).unwrap(), &[], &open).unwrap();
        assert_eq!((t.0.as_str(), kind), ("t2", "tool"));
        // 画面の道具がどこにも無いなら答えない。Agent の道具は数えない
        assert!(match_tool(&parse(WRITE).unwrap(), &[], &open).is_err());
        // 計画の確認は道具の元が無くても画面で決める。id は画面の本文から作り、同じ画面なら同じ id
        let (t, kind) = match_tool(&parse(PLAN).unwrap(), &[], &open).unwrap();
        assert_eq!((t.1.as_str(), kind), ("ExitPlanMode", "plan"));
        assert!(t.0.starts_with("screen:"));
        let typed = PLAN.replace("   3. Tell Claude what to change", " ❯ 3. 直して").replace(" ❯ 1. Yes", "   1. Yes");
        assert_eq!(match_tool(&parse(&typed).unwrap(), &[], &open).unwrap().0.0, t.0);
    }

    /// BASH の画面の command を置き換えた画面
    fn bash_screen(cmd: &str) -> String {
        BASH.replace("Bash(echo probe-ok > probe2.txt)", &format!("Bash({cmd})")).replace(" echo probe-ok > probe2.txt\n", &format!(" {cmd}\n"))
    }
    /// WRITE の画面を、path の Edit の承認にした画面
    fn edit_screen(path: &str) -> String {
        let name = path.rsplit('/').next().unwrap();
        WRITE.replace("Write(hi.txt)", &format!("Update({path})")).replace(" Create file\n hi.txt", &format!(" Edit file\n {path}"))
            .replace("Do you want to create hi.txt?", &format!("Do you want to make this edit to {name}?"))
    }
    fn bash(id: &str, cmd: &str) -> Tool {
        (id.into(), "Bash".into(), json!({ "command": cmd }))
    }
    fn edit(id: &str, path: &str) -> Tool {
        (id.into(), "Edit".into(), json!({ "file_path": path, "old_string": "a", "new_string": "b" }))
    }

    #[test]
    fn same_head_bash_picks_the_one_on_screen() {
        // #169。頭の30字が同じ Bash が2件待っている。新しいほう（t2）は画面に出ていない
        let rm = "cd /Users/a/Documents/family-computing && rm -rf dist";
        let st = "cd /Users/a/Documents/family-computing && git status";
        let open = vec![bash("t1", rm), bash("t2", st)];
        let d = parse(&bash_screen(rm)).unwrap();
        assert_eq!(match_tool(&d, &[], &open).unwrap().0.0, "t1");
        let d = parse(&bash_screen(st)).unwrap();
        assert_eq!(match_tool(&d, &[], &open).unwrap().0.0, "t2");
        // 画面の command が、待っている片方の command の頭になっている場合も、全体が合うほうを取る
        let open = vec![bash("t1", rm), bash("t2", &format!("{rm} && ls"))];
        assert_eq!(match_tool(&parse(&bash_screen(rm)).unwrap(), &[], &open).unwrap().0.0, "t1");
        assert_eq!(match_tool(&parse(&bash_screen(&format!("{rm} && ls"))).unwrap(), &[], &open).unwrap().0.0, "t2");
        // 古いチームメイトの承認が画面に出ている間に、リードが頭の同じ承認を出した。チームメイトのものとして断る
        let hook = vec![hk("Bash", json!({ "command": rm }), Some("abeta-1"), 5), hk("Bash", json!({ "command": st }), None, 6)];
        assert!(match_tool(&parse(&bash_screen(rm)).unwrap(), &hook, &[]).unwrap_err().contains("チームメイト"));
    }

    #[test]
    fn same_strength_candidates_are_not_answered() {
        // 画面の command が両方に同じだけ合う（画面で区別できない）ときは答えない
        let rm = "cd /Users/a/Documents/family-computing && rm -rf dist";
        let open = vec![bash("t1", &format!("{rm}\necho one")), bash("t2", &format!("{rm}\necho two"))];
        let d = parse(&bash_screen(rm)).unwrap();
        assert!(match_tool(&d, &[], &open).unwrap_err().contains("決められない"));
        // 同じ道具が hook と transcript の両方にあるのは1件と数える（hook の分を返す）
        let hook = vec![hk("Bash", json!({ "command": rm }), None, 5)];
        assert_eq!(match_tool(&d, &hook, &[bash("t1", rm)]).unwrap().0.0, "hook:5");
    }

    #[test]
    fn same_file_name_edit_picks_the_directory_on_screen() {
        let a = "/Users/a/proj/src/a/mod.rs";
        let b = "/Users/a/proj/src/b/mod.rs";
        let open = vec![edit("t1", a), edit("t2", b)];
        // 画面には cwd からの相対のパスが出る
        assert_eq!(match_tool(&parse(&edit_screen("src/a/mod.rs")).unwrap(), &[], &open).unwrap().0.0, "t1");
        assert_eq!(match_tool(&parse(&edit_screen("src/b/mod.rs")).unwrap(), &[], &open).unwrap().0.0, "t2");
        assert_eq!(match_tool(&parse(&edit_screen(a)).unwrap(), &[], &open).unwrap().0.0, "t1");
        // ファイル名しか出ていなければ、どちらか決められないので答えない
        assert!(match_tool(&parse(&edit_screen("mod.rs")).unwrap(), &[], &open).is_err());
    }

    // 2026-11-23 に v2.1.330 の claude を tmux（100x50）で動かして撮った実物の道具の承認の画面（#169）。
    // 折り返した command と複数行の command は、各行の頭に「│ 」が付く。Edit はパスが cwd からの相対で出る
    const BASH_LONG: &str = include_str!("dialog_fixtures/bash_long_wrapped.txt");
    const BASH_MULTI: &str = include_str!("dialog_fixtures/bash_multiline.txt");
    const EDIT_NESTED: &str = include_str!("dialog_fixtures/edit_nested.txt");

    #[test]
    fn real_tool_screens_pick_the_tool_on_screen() {
        let long = "echo first-segment-0123456789-abcdefghijklmnopqrstuvwxyz second-segment-0123456789-abcdefghijklmnopqrstuvwxyz third-segment-0123456789-abcdefghijklmnopqrstuvwxyz fourth-segment-0123456789 > long-output-file.txt && wc -c long-output-file.txt";
        let long2 = long.replace("third-segment", "other-segment");
        let multi = "touch multiline-probe-first-file-aaaaaaaaaaaaaaaa.txt\ntouch multiline-probe-second-file-bbbbbbbbbbbbbbbb.txt";
        let multi2 = multi.replace("second-file", "other-file");
        let path = "/private/tmp/fc169-probe/src/deep/nested/mod.rs";
        let path2 = "/private/tmp/fc169-probe/src/other/mod.rs";
        for (screen, right, wrong) in [(BASH_LONG, bash("t1", long), bash("t2", &long2)), (BASH_MULTI, bash("t1", multi), bash("t2", &multi2)), (EDIT_NESTED, edit("t1", path), edit("t2", path2))] {
            let d = parse(screen).expect("道具の承認の画面");
            // 1件だけなら今まで通り当たる
            assert_eq!(match_tool(&d, &[], std::slice::from_ref(&right)).unwrap().0.0, "t1");
            // 頭の同じ別の道具（新しいほう）があっても、画面に出ているほうを取る
            assert_eq!(match_tool(&d, &[], &[right.clone(), wrong.clone()]).unwrap().0.0, "t1", "{screen}");
            assert_eq!(match_tool(&d, &[], &[wrong.clone(), right.clone()]).unwrap().0.0, "t1");
        }
    }

    #[test]
    fn old_records_in_the_file_content_do_not_win() {
        // 答えた後も残る古い Bash の記録の command が、Write の中身に出ている。前と同じく Write を取る
        let screen = WRITE.replace("  1 hi", "  1 echo probe-ok > probe2.txt");
        let hook = vec![
            hk("Bash", json!({ "command": "echo probe-ok > probe2.txt" }), None, 5),
            hk("Write", json!({ "file_path": "/private/tmp/fc-ask-probe/hi.txt", "content": "echo probe-ok > probe2.txt" }), None, 6),
        ];
        assert_eq!(match_tool(&parse(&screen).unwrap(), &hook, &[]).unwrap().0.0, "hook:6");
        // 古い Edit の記録のパスが、今の Edit の diff に出ている。画面のパスの行で比べる
        let screen = edit_screen("src/x.ts").replace("  1 hi", "  1 import { c } from \"/Users/a/proj/src/b/config.ts\"");
        let hook = vec![
            hk("Edit", json!({ "file_path": "/Users/a/proj/src/b/config.ts", "old_string": "a", "new_string": "b" }), None, 5),
            hk("Edit", json!({ "file_path": "/Users/a/proj/src/x.ts", "old_string": "a", "new_string": "b" }), None, 6),
        ];
        assert_eq!(match_tool(&parse(&screen).unwrap(), &hook, &[]).unwrap().0.0, "hook:6");
    }

    #[test]
    fn same_file_edit_again_uses_the_newest_hook_record() {
        // hook の記録は答えた後も残る。同じファイルの2回目の Edit は、古い記録と画面で区別できないので、前と同じく新しい記録を取る
        let a = "/Users/a/proj/src/a/mod.rs";
        let old = hk("Edit", json!({ "file_path": a, "old_string": "x", "new_string": "y" }), None, 5);
        let new = hk("Edit", json!({ "file_path": a, "old_string": "y", "new_string": "z" }), None, 6);
        let d = parse(&edit_screen("src/a/mod.rs")).unwrap();
        assert_eq!(match_tool(&d, &[old.clone(), new.clone()], &[]).unwrap().0.0, "hook:6");
        // 同じ Bash の2回目も同じ
        let rm = "cd /Users/a/Documents/family-computing && rm -rf dist";
        let hook = vec![hk("Bash", json!({ "command": rm }), None, 5), hk("Bash", json!({ "command": rm }), None, 7)];
        assert_eq!(match_tool(&parse(&bash_screen(rm)).unwrap(), &hook, &[]).unwrap().0.0, "hook:7");
        // transcript で結果の無い（両方とも待っている）同じファイルの Edit が2件あれば、どれの承認か決められない
        let open = vec![
            ("t1".to_string(), "Edit".to_string(), old.tool_input.clone()),
            ("t2".to_string(), "Edit".to_string(), new.tool_input.clone()),
        ];
        assert!(match_tool(&d, &[], &open).unwrap_err().contains("決められない"));
        // 古いチームメイトの記録と、リードの同じ command が同じだけ合うときは、どちらのものか決められないので答えない
        let hook = vec![hk("Bash", json!({ "command": rm }), Some("abeta-1"), 5), hk("Bash", json!({ "command": rm }), None, 7)];
        assert!(match_tool(&parse(&bash_screen(rm)).unwrap(), &hook, &[]).is_err());
    }

    fn hk(tool: &str, input: Value, agent: Option<&str>, at: u64) -> HookItem {
        HookItem { tool_name: tool.into(), tool_input: input, agent_id: agent.map(Into::into), at }
    }

    #[test]
    fn hook_items_come_first_and_must_match_the_screen() {
        let q = json!({"questions": [{"question": "Which color?", "options": [{"label": "Red"}, {"label": "Blue"}, {"label": "Green"}]}, {"question": "Which numbers?", "multiSelect": true, "options": [{"label": "One"}]}]});
        let old = json!({"questions": [{"question": "Which pet?", "options": [{"label": "Cat"}]}]});
        // transcript に質問の行が無くても、hook の分で読める。古い質問（文が違う）は使わない
        let hook = vec![hk("AskUserQuestion", q.clone(), None, 2), hk("AskUserQuestion", old, None, 3)];
        let (t, kind) = match_tool(&parse(ASK_Q1).unwrap(), &hook, &[]).unwrap();
        assert_eq!((t.0.as_str(), kind, t.2.clone()), ("hook:2", "ask", q.clone()));
        assert!(match_tool(&parse(ASK_Q1).unwrap(), &[], &[]).is_err());
        // チームメイトの承認には答えない
        let mate = vec![hk("Bash", json!({"command": "echo probe-ok > probe2.txt"}), Some("abeta-1"), 5)];
        assert!(match_tool(&parse(BASH).unwrap(), &mate, &[]).unwrap_err().contains("チームメイト"));
        let own = vec![hk("Bash", json!({"command": "echo probe-ok > probe2.txt"}), None, 5)];
        assert_eq!(match_tool(&parse(BASH).unwrap(), &own, &[]).unwrap().0.0, "hook:5");
        assert_eq!(hook_items(r#"{"items":[{"tool_name":"Bash","tool_input":{"command":"ls"},"agent_id":null,"at":7}]}"#), vec![hk("Bash", json!({"command": "ls"}), None, 7)]);
        assert!(hook_items("{").is_empty());
    }

    #[test]
    fn exit_plan_mode_without_a_plan_is_a_tool_approval() {
        // 2026-11-22 に v2.1.330 で、計画の本文の無い ExitPlanMode で出た画面
        let screen = "────────────────────────────────────────\n Exit plan mode?\n  Claude wants to exit plan mode\n  ❯ 1. Yes, and switch to default (ask each time) for this session\n    2. No";
        let d = parse(screen).unwrap();
        let hook = vec![hk("ExitPlanMode", json!({}), None, 9)];
        let (t, kind) = match_tool(&d, &hook, &[]).unwrap();
        assert_eq!((t.1.as_str(), kind), ("ExitPlanMode", "tool"));
        assert_eq!(next_step(Some(&d), &Act::Deny { reason: None }, &[]), Step::Final("2".into()));
    }

    #[test]
    fn open_tools_drop_answered_ones() {
        let t = [
            json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "ls"}}]}}),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "a"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "b", "name": "AskUserQuestion", "input": {}}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "b", "name": "AskUserQuestion", "input": {}}]}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n");
        let open = open_tools(&t);
        assert_eq!(open.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }

    #[test]
    fn answer_text_matches_answers_ts() {
        let q = &qs2()[1];
        assert_eq!(answer_text(q, &pk(&[2, 0], "みそ汁")), "One, Three, みそ汁");
        assert_eq!(answer_text(&qs2()[0], &pk(&[1], " 自由\n入力 ")), "自由 入力");
    }
    /// Enter を書いてはいけない画面か（#168）。承認の画面、質問、ピッカーでは断り、画面に残った前の入力や本人の文では断らない
    #[test]
    fn enter_is_blocked_only_by_a_live_menu() {
        use crate::composer::enter_blocked;
        let rule = "─".repeat(40);
        for s in [BASH, WRITE, PLAN, ASK_Q1, ASK_Q2, REVIEW, QUOTE_Q1, QUOTE_Q2, QUOTE_REVIEW] {
            assert!(enter_blocked(None, s).is_some(), "{s}");
        }
        let picker = "❯ /model\n  Select model\n    1.  Default (recommended)\n  ❯ 2.  Sonnet 5.5\n    3.  Haiku 5.5";
        assert!(enter_blocked(None, picker).unwrap().contains("ピッカー"));
        assert!(enter_blocked(None, IDLE).is_none());
        assert!(enter_blocked(Some(&json!({"state": "waiting_permission"})), IDLE).is_some());
        assert!(enter_blocked(Some(&json!({"state": "running"})), IDLE).is_none());
        // 前に送った「1. a」「2. b」が画面に残っている。parse は承認の画面と読むが、カーソルの行が入力欄より上なので断らない
        let history = format!("⏺ 前の答え\n  ⎿  結果\n\n❯ 1. a\n  2. b\n\n⏺ 了解\n{rule}\n❯ hello\n{rule}\n  ⏸ manual mode on");
        assert!(parse(&history).is_some(), "この画面は parse だけでは承認の画面に見える");
        assert!(enter_blocked(None, &history).is_none());
        // 貼った文が入力欄に「1. a」「2. b」で出ている
        let typed = format!("⏺ 了解\n{rule}\n❯ 1. a\n  2. b\n{rule}\n  ⏸ manual mode on");
        assert!(enter_blocked(None, &typed).is_none());
        // 本人の文に「Select model」があり、前の入力に「❯ 1.」がある
        let words = format!("❯ 1. Select model の画面を直す\n  2. 試験\n\n⏺ 直した\n{rule}\n❯ \n{rule}");
        assert!(enter_blocked(None, &words).is_none());
    }

    /// 本物の claude を、アプリと同じ PTY の道（pty::spawn）で動かし、質問、道具の承認、計画の確認に answer で答える。
    /// 人の設定（全部許可、bypassPermissions）だと承認の画面が出ないので、FC_CLAUDE_BIN に包みのスクリプトを渡す:
    ///   printf '#!/bin/sh\nexec claude --setting-sources project --permission-mode default --model haiku "$@"\n' > /tmp/fc-claude-wrap.sh && chmod +x /tmp/fc-claude-wrap.sh
    ///   FC_CLAUDE_BIN=/tmp/fc-claude-wrap.sh FC_E2E_DIR=/private/tmp/fc-ask-probe FC_PERM_DIR=/tmp/fc-e2e-perm FC_STATE_DIR=/tmp/fc-e2e-state FC_IDS_DIR=/tmp/fc-e2e-ids \
    ///     cargo test --lib real_claude_answers -- --ignored --nocapture
    /// FC_E2E_DIR は信頼済みの空のディレクトリ（実体のパス）。`--setting-sources project` では人の hook が動かないので、
    /// FC_E2E_DIR/.claude/settings.json の PermissionRequest と SessionEnd に、このリポジトリの hooks/fc-report.py を登録しておく。
    /// FC_PERM_DIR、FC_STATE_DIR、FC_IDS_DIR は hook と Rust の両方が読み、本物の ~/.family-computing に書かないようにする。claude の利用枠を少し使う
    #[test]
    #[ignore]
    fn real_claude_answers_through_the_pty() {
        let dir = std::env::var("FC_E2E_DIR").expect("FC_E2E_DIR");
        let r = crate::pty::spawn(&dir, None, &[], 140, 45, || {}).unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        let pid = r["pid"].as_u64().unwrap();
        let home = crate::native::claude_home();
        let proj = home.join("projects").join(dir.replace(['/', '.'], "-"));
        let jsonl = proj.join(format!("{id}.jsonl"));
        // 画面と同じく、町の一覧（town_rows）を作り直して、この端末の今の id を引く。計画を承認すると、claude が新しい session id に
        // 移ることがあった（2026-11-22）。一覧は pid で同じ端末として扱い、会話の読み先も登録し直す
        let now_id = || -> String {
            crate::town_rows().iter().find(|r| r["pid"].as_u64() == Some(pid)).and_then(|r| r["id"].as_str()).map(String::from).unwrap_or_else(|| id.clone())
        };
        let until = |sec: u64, what: &str, f: &dyn Fn() -> bool| {
            let t0 = Instant::now();
            while !f() {
                assert!(t0.elapsed() < Duration::from_secs(sec), "{what} が {sec} 秒で来なかった。画面:\n{}", crate::pty::screen_text(&id).unwrap_or_default());
                std::thread::sleep(Duration::from_millis(200));
            }
        };
        let say = |t: &str| {
            crate::pty::write(&id, &format!("\x1b[200~{t}\x1b[201~")).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            crate::pty::write(&id, "\r").unwrap();
        };
        let pending = |kind: &str| -> Value {
            let d = detail(&now_id());
            let p = &d["pending"][0];
            if p["kind"] == kind { p.clone() } else { Value::Null }
        };
        let wait_pending = |kind: &str| -> Value {
            let t0 = Instant::now();
            until(90, kind, &|| {
                let ok = !pending(kind).is_null();
                if !ok && t0.elapsed().as_millis() % 10_000 < 200 {
                    eprintln!("待ち {kind}: waiting={} detail={}", waiting(&id), detail(&now_id()));
                }
                ok
            });
            pending(kind)
        };
        // 道具の結果の行のうち、want を満たす最初のもの。id は hook から読むと「hook:<時刻>」になり transcript の id と違うので、中身で探す
        let result_where = |want: &dyn Fn(&Value) -> bool| -> Option<Value> {
            std::fs::read_to_string(&jsonl).ok()?.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .find(|o| o["message"]["content"].as_array().is_some_and(|c| c.iter().any(|x| x["type"] == "tool_result")) && want(o))
        };
        until(30, "入力欄", &|| crate::pty::screen_text(&id).is_some_and(|s| s.contains("manual mode on")));
        std::thread::sleep(Duration::from_secs(2));

        // 1. 質問（単一選択の自由入力、複数選択の自由入力）
        say("Call the AskUserQuestion tool right now with exactly 2 questions: Q1 header \"Pet\" question \"Which pet?\" options Cat, Dog (single select). Q2 header \"Food\" question \"Which foods?\" options Rice, Bread, Soup (multiSelect true). Do nothing else.");
        let p = wait_pending("ask");
        let tid = p["requestId"].as_str().unwrap().to_string();
        let act = Act::Ask { picks: vec![Pick { picked: vec![], other: "ハムスター 2匹".into() }, Pick { picked: vec![0, 2], other: "みそ汁".into() }] };
        eprintln!("ask: {:?}", answer(&now_id(), &tid, &act));
        let has_answers = |o: &Value| o["toolUseResult"]["answers"].is_object();
        until(20, "質問の結果", &|| result_where(&has_answers).is_some());
        let res = result_where(&has_answers).unwrap();
        eprintln!("answers: {}", res["toolUseResult"]["answers"]);
        assert_eq!(res["toolUseResult"]["answers"], json!({ "Which pet?": "ハムスター 2匹", "Which foods?": "Rice, Soup, みそ汁" }));

        // 2. 道具の承認（理由を付けて断る → やり直しを許可する）
        until(60, "待機", &|| !waiting(&id) && crate::pty::screen_text(&id).is_some_and(|s| s.contains("manual mode on")));
        say("Run this exact bash command: echo e2e-one > e2e.txt . If it is rejected, follow the feedback.");
        let p = wait_pending("tool");
        let tid = p["requestId"].as_str().unwrap().to_string();
        eprintln!("tool rows: {}", p["options"]);
        eprintln!("deny: {:?}", answer(&now_id(), &tid, &Act::Deny { reason: Some("代わりに echo e2e-two > e2e.txt を実行して".into()) }));
        let has_reason = |o: &Value| o.to_string().contains("e2e-two");
        until(20, "拒否の結果", &|| result_where(&has_reason).is_some());
        let p = wait_pending("tool");
        let tid2 = p["requestId"].as_str().unwrap().to_string();
        assert_ne!(tid, tid2);
        let yes = p["options"].as_array().unwrap().iter().find(|r| r["label"] == "Yes").unwrap().clone();
        eprintln!("allow: {:?}", answer(&now_id(), &tid2, &Act::Option { n: yes["n"].as_u64().unwrap() as u32, label: "Yes".into() }));
        until(20, "許可の結果", &|| std::fs::read_to_string(format!("{dir}/e2e.txt")).is_ok_and(|s| s.contains("e2e-two")));

        // 3. 計画の確認（直してほしいことを伝える → 承認する）
        until(60, "待機", &|| !waiting(&id) && crate::pty::screen_text(&id).is_some_and(|s| s.contains("manual mode on")));
        crate::pty::write(&id, "\x1b[Z").unwrap();
        std::thread::sleep(Duration::from_millis(600));
        crate::pty::write(&id, "\x1b[Z").unwrap();
        until(5, "plan モード", &|| crate::pty::screen_text(&id).is_some_and(|s| s.contains("plan mode on")));
        say("Plan: create plan-e2e.txt containing hi. One line plan. Call ExitPlanMode immediately.");
        let p = wait_pending("plan");
        let tid = p["requestId"].as_str().unwrap().to_string();
        eprintln!("plan rows: {} screenPlan: {}", p["options"], p["screenPlan"]);
        eprintln!("revise: {:?}", answer(&now_id(), &tid, &Act::Revise { note: "ファイル名を plan-e2e2.txt にして".into() }));
        // 計画の id は画面の本文から作るので、直した計画が出ると id が変わる
        until(90, "直した計画", &|| { let p = pending("plan"); !p.is_null() && p["requestId"].as_str() != Some(tid.as_str()) });
        let p = wait_pending("plan");
        let tid = p["requestId"].as_str().unwrap().to_string();
        assert!(p["screenPlan"].as_str().unwrap_or("").contains("plan-e2e2") || p["input"]["plan"].as_str().unwrap_or("").contains("plan-e2e2"), "{p}");
        let manual = p["options"].as_array().unwrap().iter().find(|r| r["label"].as_str().unwrap().starts_with("Yes, manually")).unwrap().clone();
        eprintln!("approve: {:?}", answer(&now_id(), &tid, &Act::Option { n: manual["n"].as_u64().unwrap() as u32, label: manual["label"].as_str().unwrap().into() }));
        // 承認の結果の行は、次の道具の承認に答えるまで transcript に書かれないことがあった（2026-11-22）。画面の印で見る
        until(20, "承認の印", &|| crate::pty::screen_text(&id).is_some_and(|s| s.contains("Approved Claude's plan")));
        // 計画のあとの Write の承認は、理由なしで断って終える
        let p = wait_pending("tool");
        eprintln!("deny: {:?}", answer(&now_id(), p["requestId"].as_str().unwrap(), &Act::Deny { reason: None }));
        until(20, "承認の結果", &|| std::fs::read_dir(&proj).unwrap().filter_map(|e| e.ok())
            .any(|e| std::fs::read_to_string(e.path()).is_ok_and(|t| t.contains(&id) && t.contains("User has approved your plan"))));
        crate::pty::kill(&id).unwrap();
    }

}
