use super::*;

// ---------- 会話 ----------

#[derive(Default)]
pub(crate) struct Conv {
    /// jsonl の次の読み位置（バイト）
    next: u64,
    /// next の数え方の印（native:<inode>）。ファイルが入れ替わったら変わる
    epoch: Option<String>,
    /// これまでに縮めた項目の数。項目の通し番号 n は 0 から数える
    total: u64,
    /// 最後の KEEP_MESSAGES 件
    items: Vec<Value>,
    /// 最後に読まれた時刻（ms）
    used: u128,
    /// 今の動き（#59）
    live: Live,
}

/// 今の動き（#59）。会話を頭から読みながら、結果がまだ無い道具、最後の出来事、ターンの始まりを持つ。
/// 時刻は jsonl の timestamp（ISO の文字列。data で包んだ形では at の ms）のまま渡し、画面が Date で読む
#[derive(Default, Clone, Serialize, Debug, PartialEq)]
pub(crate) struct Live {
    /// 結果がまだ無い道具（古い順）
    tools: Vec<LiveTool>,
    /// 最後の出来事の種類（user、thinking、text、tool、result）と時刻
    last: Option<&'static str>,
    last_at: Value,
    /// 最後に人（かほかのセッション）から文が届いた時刻
    turn_at: Value,
    /// 作業中に打たれて、まだ読まれていない文（順番待ち、古い順）。画面に出す形（role: user の項目）。空なら送らない
    #[serde(skip_serializing_if = "Vec::is_empty")]
    queued: Vec<Value>,
    /// 待ちの中身。jsonl の queue-operation の行をたどって持つ。人の文でないもの（道具の終わりの知らせ、中身の無いもの）も入る
    #[serde(skip)]
    queue: Vec<QItem>,
}

#[derive(Default, Clone, Debug, PartialEq)]
pub(crate) struct QItem {
    /// 打たれた文。queue-operation の content に無いときは None
    text: Option<String>,
    at: Value,
}

impl QItem {
    /// 人の打った文か（道具の終わりの知らせなどの <...> で始まる差し込みでない）
    fn human(&self) -> bool {
        self.text.as_deref().is_some_and(|t| !t.trim().is_empty() && !t.trim_start().starts_with('<'))
    }
}

/// 順番待ちの出来事。CLI（2.1.330）は打った文を enqueue し、ターンの終わりに dequeue（中身なし、人の文が先）、
/// ターンの途中で取り込んだら remove（中身あり）を書く
#[derive(Debug, Clone)]
pub(crate) enum QEv {
    Enqueue(Option<String>, Value),
    Dequeue,
    Remove(Option<String>),
    /// 知らない操作と起動し直した印。待ちを空にする
    Clear,
    /// 文が会話に出た（user の行か、途中で取り込まれた印）。同じ文が待ちに残っていたら消す
    Delivered(String),
}

#[derive(Clone, Serialize, Debug, PartialEq)]
pub(crate) struct LiveTool {
    id: String,
    /// まとめるときの種類（シェル、MCP のサーバー名など）
    kind: String,
    /// 1行の中身（Bash ならコマンドの頭）
    text: String,
    at: Value,
}

#[derive(Debug, Clone)]
pub(crate) enum LiveEv {
    User(Value),
    Thinking(Value),
    Text(Value),
    Tool(LiveTool),
    Result(Vec<String>, Value),
    Queue(QEv),
}

impl Live {
    fn apply(&mut self, ev: LiveEv) {
        if let LiveEv::Queue(q) = ev {
            self.apply_queue(q);
            return;
        }
        let (kind, at) = match ev {
            // 新しい文が来たら、前のターンで結果が来なかった道具（中断など）は捨てる
            LiveEv::User(at) => { self.tools.clear(); self.turn_at = at.clone(); ("user", at) }
            LiveEv::Thinking(at) => ("thinking", at),
            LiveEv::Text(at) => ("text", at),
            LiveEv::Tool(t) => { let at = t.at.clone(); self.tools.retain(|x| x.id != t.id); self.tools.push(t); ("tool", at) }
            LiveEv::Result(ids, at) => { self.tools.retain(|x| !ids.contains(&x.id)); ("result", at) }
            LiveEv::Queue(_) => return,
        };
        self.last = Some(kind);
        self.last_at = at;
    }

    fn apply_queue(&mut self, ev: QEv) {
        let same = |a: &Option<String>, b: &str| a.as_deref().map(|t| unwrap_pasted(t) == b).unwrap_or(false);
        match ev {
            QEv::Enqueue(text, at) => self.queue.push(QItem { text, at }),
            QEv::Dequeue => {
                // 人の文が先に読まれる（道具の終わりの知らせは後回し）
                let i = self.queue.iter().position(QItem::human).or(if self.queue.is_empty() { None } else { Some(0) });
                if let Some(i) = i { self.queue.remove(i); }
            }
            QEv::Remove(text) => {
                if let Some(i) = self.queue.iter().position(|q| q.text == text) { self.queue.remove(i); }
            }
            QEv::Clear => self.queue.clear(),
            QEv::Delivered(text) => {
                if let Some(i) = self.queue.iter().position(|q| same(&q.text, &text)) { self.queue.remove(i); }
            }
        }
        // 画面に出す形は simplify に任せる（from 行を外す、貼り付けの包みを外す、差し込みを落とす）
        self.queued = self.queue.iter().filter(|q| q.human()).flat_map(|q| {
            simplify(&json!({ "type": "user", "timestamp": q.at, "message": { "role": "user", "content": q.text } }))
        }).filter(|x| x["role"] == "user").collect();
    }
}

/// 道具をまとめるときの種類
pub(crate) fn tool_kind(name: &str) -> String {
    match name {
        "Bash" | "BashOutput" | "KillShell" => "シェル".into(),
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "書く".into(),
        "Read" => "読む".into(),
        "Grep" | "Glob" => "探す".into(),
        "WebSearch" | "WebFetch" => "調べる".into(),
        "Agent" | "Task" => "手伝い".into(),
        n if n.starts_with("mcp__") => n.split("__").nth(1).unwrap_or(n).into(),
        n => n.into(),
    }
}

/// CLI が貼り付けた文に付ける包み（`<pasted_content id="…">` と `</pasted_content id="…">`）を外す。
/// 文を端末に貼って送ると、送った文が包まれて記録されることがある（2026-11-14 の meta、8074d764 の jsonl）。
/// 包みのまま `<` で始まると、hook の差し込みと見分けられず会話から落ちていた（#69）。外した後の前後の空白は落とす
pub(crate) fn unwrap_pasted(text: &str) -> String {
    const TAGS: [&str; 2] = ["<pasted_content", "</pasted_content"];
    if !text.contains("pasted_content") {
        return text.trim().to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((i, tag)) = TAGS.iter().filter_map(|t| rest.find(t).map(|i| (i, *t))).min_by_key(|(i, _)| *i) {
        let tail = &rest[i..];
        // 包みの印は、名前の直後が空白か > で、1行に収まり > で閉じるもの
        let end = tail.find('>').filter(|&j| !tail[..j].contains('\n'));
        let named = matches!(tail[tag.len()..].chars().next(), Some(' ') | Some('>'));
        match end {
            Some(j) if named => {
                out.push_str(&rest[..i]);
                rest = &tail[j + 1..];
            }
            _ => {
                out.push_str(&rest[..i + 1]);
                rest = &rest[i + 1..];
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// 先頭に並んだ画像の印（[Image #3]）と、その後ろの文に分ける。印が無ければ ("", text)
pub(crate) fn split_image_marks(text: &str) -> (&str, &str) {
    let mut i = 0;
    while let Some(r) = text[i..].strip_prefix("[Image #") {
        let digits = r.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || !r[digits..].starts_with(']') {
            break;
        }
        i += "[Image #".len() + digits + 1;
        i += text[i..].len() - text[i..].trim_start_matches([' ', '\t']).len();
    }
    (text[..i].trim_end(), &text[i..])
}

/// user の行の文。文の部分をつなぎ、貼り付けの包みを外す
pub(crate) fn user_text(content: &Value) -> String {
    match content {
        Value::String(s) => unwrap_pasted(s),
        Value::Array(a) => unwrap_pasted(&a.iter().filter(|c| c["type"] == "text").filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n")),
        _ => String::new(),
    }
}

/// スラッシュコマンドの入力を、端末と同じ「/名前 引数」の文に直す（#157）。コマンドの行でなければ None。
/// jsonl には <command-message>、<command-name>、<command-args> の組で残る。並び順は2通りあり、引数は無いこともある。
/// 引数には `<` を含む本文も入るので、引数の終わりは最後の </command-args> で決める
pub(crate) fn slash_command(text: &str) -> Option<String> {
    let t = text.trim_start();
    if !(t.starts_with("<command-name>") || t.starts_with("<command-message>")) {
        return None;
    }
    let name = t.split_once("<command-name>")?.1.split("</command-name>").next()?.trim();
    if name.is_empty() {
        return None;
    }
    let name = if name.starts_with('/') { name.to_string() } else { format!("/{name}") };
    let args = t.split_once("<command-args>").and_then(|(_, r)| r.rfind("</command-args>").map(|i| r[..i].trim())).unwrap_or("");
    Some(if args.is_empty() { name } else { format!("{name} {args}") })
}

/// 会話の1行から、今の動きに効く出来事を取り出す。simplify と同じく、jsonl の行と data で包んだ形の両方を読む
pub(crate) fn live_events(m: &Value) -> Vec<LiveEv> {
    let (m, at) = match m.get("data").filter(|d| m.get("message").is_none() && d.is_object()) {
        Some(d) => (d, if d["timestamp"].is_string() { d["timestamp"].clone() } else { m["at"].clone() }),
        None => (m, m["timestamp"].clone()),
    };
    let content = &m["message"]["content"];
    let mut out = vec![];
    match m["type"].as_str().unwrap_or("") {
        "queue-operation" => {
            let text = m["content"].as_str().map(String::from);
            out.push(LiveEv::Queue(match m["operation"].as_str() {
                Some("enqueue") => QEv::Enqueue(text, at),
                Some("dequeue") => QEv::Dequeue,
                Some("remove") => QEv::Remove(text),
                _ => QEv::Clear,
            }));
        }
        "session-start" => out.push(LiveEv::Queue(QEv::Clear)),
        "user" => {
            let ids: Vec<String> = content.as_array().map(|a| a.iter()
                .filter(|c| c["type"] == "tool_result")
                .filter_map(|c| c["tool_use_id"].as_str().map(String::from))
                .collect()).unwrap_or_default();
            if !ids.is_empty() {
                out.push(LiveEv::Result(ids, at));
            } else {
                let text = user_text(content);
                if !text.is_empty() {
                    out.push(LiveEv::Queue(QEv::Delivered(text.clone())));
                }
                // ターンの途中で取り込まれた文は、ターンの始まりにしない（道具は動いたまま）
                if m["queued"].as_bool() == Some(true) {
                    return out;
                }
                // hook やシステムの差し込み（<...>、Caveat:）はターンの始まりにしない。お手紙（<cross-session-message>）は始まりにする
                let letter = text.contains("<cross-session-message");
                let command = slash_command(&text).is_some();
                if !text.is_empty() && !m["isMeta"].as_bool().unwrap_or(false) && (letter || command || !(text.starts_with('<') || text.starts_with("Caveat:"))) {
                    out.push(LiveEv::User(at));
                }
            }
        }
        "assistant" => {
            for c in content.as_array().into_iter().flatten() {
                match c["type"].as_str() {
                    Some("thinking") | Some("redacted_thinking") => out.push(LiveEv::Thinking(at.clone())),
                    Some("text") => out.push(LiveEv::Text(at.clone())),
                    Some("tool_use") => {
                        let name = c["name"].as_str().unwrap_or("");
                        let inp = &c["input"];
                        // Bash はコマンドそのもの、MCP の道具は宛先（session、name）を頭に出す。終わった道具の行（tool_line）は変えない
                        let text = match (name, inp["command"].as_str()) {
                            ("Bash", Some(cmd)) => format!("コマンド: {}", clip(cmd, 70)),
                            _ => {
                                let line = tool_line(name, inp);
                                match ["session", "name"].iter().find_map(|k| inp[*k].as_str()).filter(|_| !line.contains(": ")) {
                                    Some(to) => format!("{line}: {}", clip(to, 70)),
                                    None => line,
                                }
                            }
                        };
                        out.push(LiveEv::Tool(LiveTool { id: c["id"].as_str().unwrap_or("").into(), kind: tool_kind(name), text, at: at.clone() }));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

/// 会話のキャッシュを残す時間（#15）。画面は開いている会話だけを 2.5 秒ごとに読むので、
/// これより長く読まれていない会話（閉じたセッション、ほかのセッションに切り替えた後）は捨てる。
/// 捨てた後に開き直したら、jsonl を頭から読み直し、画面は reset で受け取る
pub(crate) const CONV_IDLE_MS: u128 = 10 * 60 * 1000;

pub(crate) fn forget_idle_convs(map: &mut HashMap<String, Conv>, keep: &str, now: u128) {
    map.retain(|k, c| k == keep || now.saturating_sub(c.used) < CONV_IDLE_MS);
}

/// 画面へ渡す差分（#10）。items の各項目には通し番号 n を付ける。
/// reset=true のとき、画面は持っている分を捨てて items に置き換える。total は次の呼び出しの since に渡す
#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct ConvDelta {
    pub(crate) items: Vec<Value>,
    pub(crate) total: u64,
    pub(crate) reset: bool,
    /// 今の動き（#59）。毎回、全部を返す
    pub(crate) live: Live,
}

impl Conv {
    /// 読み位置 from から next まで読んだ分を足す。同じセッションの取得が重なり、
    /// ほかの呼び出しが先に同じ範囲を足していたら（c.next が読み始めと違う）、足さない
    /// 項目が増えたら true
    fn absorb(&mut self, from: u64, next: u64, fresh: Vec<Value>, evs: Vec<LiveEv>, epoch: Option<String>) -> bool {
        if self.next != from {
            return false;
        }
        self.next = next;
        if epoch.is_some() {
            self.epoch = epoch;
        }
        let grew = !fresh.is_empty();
        for e in evs {
            self.live.apply(e);
        }
        self.push(fresh);
        grew
    }

    /// after=0 から読み直した中身で置き換える。読み始めたとき（from、seen）から誰も進めていなければ置き換えて true。
    /// 通し番号 n は前の続きから1つ空けて振る。画面が持っている数（since）は必ず新しい範囲の手前に落ちるので、
    /// since() が reset を返し、画面は持っている分を捨てて置き換える（App.tsx と conv.ts は変えない）。
    /// n は減らないので、送ったばかりの仮の項目（pending の after）とも比べられる
    /// 今の動き（#59）も、頭から読んだ出来事（evs）で作り直す
    fn replace(&mut self, from: u64, seen: &Option<String>, next: u64, fresh: Vec<Value>, evs: Vec<LiveEv>, epoch: Option<String>) -> bool {
        if self.next != from || &self.epoch != seen {
            return false;
        }
        self.total += 1;
        self.items.clear();
        self.next = next;
        self.epoch = epoch;
        self.live = Live::default();
        for e in evs {
            self.live.apply(e);
        }
        self.push(fresh);
        true
    }

    fn push(&mut self, fresh: Vec<Value>) {
        let start = self.total;
        for mut v in fresh {
            // 止めた印の直後の印は重ねない。-p の子は、止めると止めた印の文に続いて error_during_execution の result を書く（#83）
            if v["role"] == "event" && self.items.last().map(|l| l["role"] == "event" && l["kind"] == "interrupted").unwrap_or(false) {
                continue;
            }
            // 道具の結果は、持っている道具の行に付ける。道具の行が今回の分にあれば、それで画面に届くので項目にしない。
            // 前に渡した道具の行の結果だけ、小さい result の項目で送り、画面が道具の行に付け直す。道具の行が無ければ捨てる（#83）
            if v["role"] == "result" {
                let id = v["id"].clone();
                let hit = self.items.iter_mut().rev().find(|t| t["role"] == "tool" && t["id"] == id && t.get("result").is_none());
                let Some(t) = hit else { continue };
                t["result"] = json!({ "text": v["text"], "error": v["error"] });
                if t["n"].as_u64().map(|n| n >= start).unwrap_or(false) {
                    continue;
                }
            }
            if let Value::Object(o) = &mut v {
                o.insert("n".into(), json!(self.total));
            }
            self.total += 1;
            self.items.push(v);
        }
        if self.items.len() > KEEP_MESSAGES {
            let cut = self.items.len() - KEEP_MESSAGES;
            self.items.drain(..cut);
        }
    }

    /// 画面が total=since まで持っているときの差分。持っている分が古すぎる（捨てた分より前）、
    /// 先に進みすぎている（キャッシュを作り直した）、since が無いときは、全部を reset で返す
    fn since(&self, since: Option<u64>) -> ConvDelta {
        let base = self.total - self.items.len() as u64;
        match since {
            Some(s) if s >= base && s <= self.total => {
                ConvDelta { items: self.items[(s - base) as usize..].to_vec(), total: self.total, reset: false, live: self.live.clone() }
            }
            _ => ConvDelta { items: self.items.clone(), total: self.total, reset: true, live: self.live.clone() },
        }
    }
}

pub(crate) static CONVS: Mutex<Option<HashMap<String, Conv>>> = Mutex::new(None);

pub(crate) fn clip(s: &str, n: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= n { t } else { t.chars().take(n - 1).collect::<String>() + "…" }
}

pub(crate) fn tool_line(name: &str, input: &Value) -> String {
    let verb = match name {
        "Bash" => "コマンド",
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "書く",
        "Read" => "読む",
        "Grep" | "Glob" => "探す",
        "WebSearch" | "WebFetch" => "調べる",
        "SendMessage" => "話す",
        "Agent" | "Task" => "手伝いを呼ぶ",
        n if n.contains("spawn_child") => "子を呼ぶ",
        n if n.starts_with("mcp__") => n.split("__").last().unwrap_or(n),
        n => n,
    };
    let target = ["description", "title", "command", "file_path", "pattern", "query", "url", "to"]
        .iter()
        .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
        .unwrap_or("");
    let target = if target.contains('/') && matches!(name, "Edit" | "MultiEdit" | "Write" | "Read") {
        target.rsplit('/').take(2).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("/")
    } else {
        target.to_string()
    };
    if target.is_empty() { verb.to_string() } else { format!("{verb}: {}", clip(&target, 70)) }
}

/// SDK の1件を、画面に出す0件以上の項目に縮める。考えた中身と道具の結果は捨てる
/// 読むのは jsonl の行そのまま（type、message、timestamp）。{at, type, data: {type, message, …}, seq} の形
/// （中身が data に入り、時刻が at の ms にある。前に ccn の PTY の会話が返した形で、試験の材料がこの形で残っている）も読む。
/// 道具の結果を画面に出す長さ（字）と行数。長い出力は頭だけを持つ
pub(crate) const RESULT_CHARS: usize = 1500;
pub(crate) const RESULT_LINES: usize = 40;

/// 道具の結果（tool_result の content）を文にする。content は文字列か、text と image の並び。改行は残し、頭だけを持つ
pub(crate) fn result_text(content: &Value) -> String {
    let t = match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|c| match c["type"].as_str() {
            Some("text") => c["text"].as_str().unwrap_or("").to_string(),
            Some("image") => "[画像]".to_string(),
            _ => String::new(),
        }).filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    };
    let t = t.trim();
    // lines() は行末の \r も落とすので、省いていないのに長さが縮んで「続きは省いた」が付く。\n だけで割り、TypeScript の split("\n") と合わせる
    // lines() は行末の \r も落とすので、省いていないのに長さが縮んで「続きは省いた」が付く。\n だけで割り、TypeScript の split("\n") と合わせる
    let mut out: String = t.split('\n').take(RESULT_LINES).collect::<Vec<_>>().join("\n");
    if out.chars().count() > RESULT_CHARS {
        out = out.chars().take(RESULT_CHARS).collect();
    }
    if out.len() < t.len() {
        out.push_str("\n…（続きは省いた）");
    }
    out
}

pub(crate) fn simplify(m: &Value) -> Vec<Value> {
    let (m, at) = match m.get("data").filter(|d| m.get("message").is_none() && d.is_object()) {
        Some(d) => (d, m["at"].clone()),
        None => (m, m["timestamp"].clone()),
    };
    let ty = m["type"].as_str().unwrap_or("");
    let content = &m["message"]["content"];
    let mut out = vec![];
    match ty {
        // ターンの終わり。止めた（interrupted）と失敗（is_error）だけを会話に出す（#83）。成功は返事の文が出ているので出さない
        "result" => {
            if m["subtype"].as_str() == Some("interrupted") {
                out.push(json!({ "role": "event", "kind": "interrupted", "text": "ここで止めた", "at": at }));
            } else if m["is_error"].as_bool() == Some(true) {
                let t = clip(m["result"].as_str().unwrap_or(""), 300);
                out.push(json!({ "role": "event", "kind": "error", "text": if t.is_empty() { "ターンが失敗で終わった".to_string() } else { format!("ターンが失敗で終わった: {t}") }, "at": at }));
            }
        }
        "user" if content.as_array().map(|a| a.iter().any(|c| c["type"] == "tool_result")).unwrap_or(false) => {
            // 道具の結果。画面は道具の行を開いたときに出す。Conv::push が道具の行に付ける（#83）
            for c in content.as_array().into_iter().flatten().filter(|c| c["type"] == "tool_result") {
                if let Some(id) = c["tool_use_id"].as_str() {
                    out.push(json!({ "role": "result", "id": id, "text": result_text(&c["content"]), "error": c["is_error"].as_bool() == Some(true), "at": at }));
                }
            }
        }
        "user" => {
            // 貼り付けの包み（<pasted_content>）は外してから見る。外さないと `<` で始まり、下の除外で落ちる（#69）
            let text = user_text(content);
            let text = text.as_str();
            // ターミナルのセッションには、お手紙の前に「Another Claude session sent a message:」の1行が付く
            let text = match text.strip_prefix("Another Claude session sent a message:") {
                // 2.1.330 からは、本文の後ろに英語の注記（This came from another Claude session — …）が付く（#156）
                Some(r) => r.trim_start().split("\n\nThis came from another Claude session").next().unwrap_or("").trim_end(),
                None => text,
            };
            // 別のセッションからのお手紙（<cross-session-message from=… from-name=…>本文</cross-session-message>、後ろに注記が付くことがある）は、包みの内側の本文だけ出す
            if let Some(rest) = text.strip_prefix("<cross-session-message") {
                let (attrs, body) = rest.split_once('>').unwrap_or(("", ""));
                let body = body.split("</cross-session-message>").next().unwrap_or("");
                let attr = |k: &str| {
                    let key = format!("{k}=\"");
                    attrs.find(&key).and_then(|i| attrs[i + key.len()..].split('"').next()).map(String::from)
                };
                let body = body.trim();
                if !body.is_empty() {
                    out.push(json!({ "role": "user", "text": body, "from": null, "at": at,
                        "letter": { "fromName": attr("from-name"), "fromRaw": attr("from") } }));
                }
                return out;
            }
            // 止めたときに claude が書く印（-p の子で見た。2026-11-21）。吹き出しにせず、止めた印にする（#83）
            if text.starts_with("[Request interrupted by user") {
                out.push(json!({ "role": "event", "kind": "interrupted", "text": "ここで止めた", "at": at }));
                return out;
            }
            // スラッシュコマンドの入力は「/名前 引数」の文にしてから見る。そのままだと `<` で始まり、下の除外で落ちる（#157）
            let command = slash_command(text);
            let text = command.as_deref().unwrap_or(text);
            // 道具の結果だけの user、hook やシステムの差し込み（<...> で始まる）は出さない
            if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") {
                return out;
            }
            // 別のセッションからの文は1行目が from 行。画像のパスを含む文を端末に貼ると、CLI はパスを画像の添付にし、
            // 先頭に [Image #3] を置く（from 行はその後ろに回る、#69）。印を外して from 行を探し、印は本文の頭に戻す
            // 画像だけを送ると、印の後ろが from 行だけになり改行が無いことがある（観測はしていない。来ても from 行を本文に出さない）
            let (imgs, rest) = split_image_marks(text);
            let (first, after) = rest.split_once('\n').unwrap_or((rest, ""));
            let (from, body) = if first.starts_with("from ") && first.contains(" via ") && (rest.contains('\n') || !imgs.is_empty()) {
                let after = after.trim();
                (Some(first.trim_end().to_string()), if imgs.is_empty() { after.to_string() } else if after.is_empty() { imgs.to_string() } else { format!("{imgs}\n{after}") })
            } else {
                (None, text.to_string())
            };
            // from agent:<ノード>/<sid8>/<役割> の文は、セッションからのお手紙
            let letter = from.as_deref().and_then(|f| f.strip_prefix("from agent:")).map(|r| {
                let who = r.split_whitespace().next().unwrap_or("");
                json!({ "fromName": null, "fromRaw": who })
            });
            out.push(json!({ "role": "user", "text": body, "from": from, "at": at, "letter": letter }));
        }
        "assistant" => {
            if let Value::Array(a) = content {
                for c in a {
                    match c["type"].as_str() {
                        Some("text") => {
                            let t = c["text"].as_str().unwrap_or("").trim();
                            if !t.is_empty() {
                                out.push(json!({ "role": "assistant", "text": t, "at": at }));
                            }
                        }
                        Some("tool_use") => {
                            let name = c["name"].as_str().unwrap_or("");
                            let inp = &c["input"];
                            // 送ったお手紙（SendMessage と、MCP の mcp__ccn__send_message、mcp__ccn__create_session）は、宛先と1行目を付ける。
                            // ccn の MCP は別のプロダクトの道具で、ここでは記録の道具名を読むだけ
                            let first = |v: &Value| v.as_str().unwrap_or("").lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
                            let sent = match name {
                                "SendMessage" if inp["message"].is_string() => Some(json!({ "to": inp["to"], "summary": inp["summary"].as_str().map(String::from).unwrap_or_else(|| first(&inp["message"])), "text": inp["message"] })),
                                "mcp__ccn__send_message" => Some(json!({ "to": inp["session"], "peer": inp["peer"], "summary": first(&inp["text"]), "text": inp["text"] })),
                                "mcp__ccn__create_session" if inp["prompt"].is_string() => Some(json!({ "to": null, "peer": inp["peer"], "summary": first(&inp["prompt"]), "text": inp["prompt"], "create": true })),
                                _ => None,
                            };
                            let mut item = json!({ "role": "tool", "text": tool_line(name, inp), "at": at, "sent": sent, "id": c["id"] });
                            // 計画の確認（ExitPlanMode）の本文。承認の hook の tool_input は、計画ファイルが無いと空で来るので、
                            // 承認の欄は会話の最後の計画で補う（#83、2026-11-21 に PTY の子で見た）
                            if name == "ExitPlanMode"
                                && let Some(p) = inp["plan"].as_str().filter(|p| !p.trim().is_empty()) {
                                    item["plan"] = json!(p);
                                }
                            out.push(item);
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
    out
}

/// 読んだ結果。(次の読み位置, 縮めた項目, 今の動きの出来事, 印)
pub(crate) type MessagesRead = (u64, Vec<Value>, Vec<LiveEv>, Option<String>);

/// 持っている cursor（from）が、今の jsonl の読み位置と続いていないか。前に読んだ印（inode）と違えば、from から先を読むと欠けるか重なる
pub(crate) fn cursor_is_stale(from: u64, seen: &Option<String>, got: &Option<String>) -> bool {
    from > 0 && got.is_some() && got != seen
}

/// セッションの jsonl を読み位置 from から読む。返すのは (次の読み位置, 縮めた項目, 今の動きの出来事, 印)。読み位置はバイト、印は native:<inode>。
/// ファイルが読み位置より短くなったら、印に :restarted を付けて返し、conversation が頭から読み直した扱いにする
pub(crate) fn read_native(path: &std::path::Path, from: u64) -> Result<MessagesRead, String> {
    let c = native::conv::read(path, from)?;
    let fresh = c.lines.iter().flat_map(simplify).collect();
    let evs = c.lines.iter().flat_map(live_events).collect();
    let epoch = if c.restarted { format!("{}:restarted", c.epoch) } else { c.epoch };
    Ok((c.next, fresh, evs, Some(epoch)))
}

pub(crate) fn conversation(session_id: String, since: Option<u64>) -> Result<ConvDelta, String> {
    // jsonl の場所は一覧を作るときに登録する。起動したばかりで、まだ jsonl が無いセッションは空で返す
    let Some(path) = native::path_of(&session_id) else {
        return Ok(ConvDelta { items: vec![], total: 0, reset: true, live: Live::default() });
    };
    // 登録はあっても、jsonl は最初の文が処理されるまで作られない。NotFound は空で返す（権限などの失敗は下で今までどおり出す）。
    // 前に読んだ分があれば、それを返す（消えたのを見て画面を空にしない）
    if matches!(std::fs::metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
        let g = CONVS.lock().map_err(|e| e.to_string())?;
        return Ok(match g.as_ref().and_then(|m| m.get(&session_id)) {
            Some(c) => c.since(since),
            None => ConvDelta { items: vec![], total: 0, reset: true, live: Live::default() },
        });
    }
    let key = session_id.clone();
    let (from, seen) = {
        let g = CONVS.lock().map_err(|e| e.to_string())?;
        g.as_ref().and_then(|m| m.get(&key)).map(|c| (c.next, c.epoch.clone())).unwrap_or((0, None))
    };
    let (mut next, mut fresh, mut evs, mut epoch) = read_native(&path, from)?;
    let restarted = epoch.as_deref().is_some_and(|e| e.ends_with(":restarted"));
    let stale = restarted || cursor_is_stale(from, &seen, &epoch);
    if restarted {
        // 頭から読み直した分は、そのまま置き換えに使う。印は元の形に戻す
        epoch = epoch.map(|e| e.trim_end_matches(":restarted").to_string());
    } else if stale && from > 0 {
        // 読んだ分は捨て、頭から読み直して置き換える。読み直しに失敗したら何も変えない（次の呼び出しでもう一度気づく）
        (next, fresh, evs, epoch) = read_native(&path, 0)?;
    }
    let mut g = CONVS.lock().map_err(|e| e.to_string())?;
    let map = g.get_or_insert_with(HashMap::new);
    let now = now_ms();
    forget_idle_convs(map, &key, now);
    let c = map.entry(key).or_insert_with(Conv::default);
    c.used = now;
    if stale {
        // 読み直しが0件で、前に中身があったときは置き換えない（読めなかっただけかもしれないので、持っている分まで消さない）
        if !fresh.is_empty() || c.items.is_empty() {
            c.replace(from, &seen, next, fresh, evs, epoch);
        }
    } else {
        c.absorb(from, next, fresh, evs, epoch);
    }
    Ok(c.since(since))
}

/// 画面から呼ぶ命令の包み。中身の関数は上にある。待つ命令は blocking で別のスレッドへ出す
pub(crate) mod cmd {
    #[tauri::command]
    pub async fn conversation(session_id: String, since: Option<u64>) -> Result<super::ConvDelta, String> {
        crate::blocking(move || super::conversation(session_id, since)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_tracks_open_tools_and_thinking() {
        use super::{live_events, Live};
        use serde_json::json;
        let pty = |ts: &str, data: serde_json::Value| json!({ "at": 1, "type": "x", "seq": 0, "data": { "timestamp": ts, "type": data["type"], "message": data["message"] } });
        let mut l = Live::default();
        let feed = |l: &mut Live, m: serde_json::Value| for e in live_events(&m) { l.apply(e) };
        feed(&mut l, pty("t0", json!({ "type": "user", "message": { "content": "やって" } })));
        assert_eq!(l.turn_at, json!("t0"));
        feed(&mut l, pty("t1", json!({ "type": "assistant", "message": { "content": [{ "type": "thinking", "thinking": "" }] } })));
        assert_eq!(l.last, Some("thinking"));
        feed(&mut l, pty("t2", json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "a", "name": "Bash", "input": { "command": "git status", "description": "見る" } },
            { "type": "tool_use", "id": "b", "name": "mcp__ccn__send_message", "input": { "session": "abc", "text": "x" } } ] } })));
        assert_eq!(l.tools.len(), 2);
        assert_eq!(l.tools[0].text, "コマンド: git status");
        assert_eq!(l.tools[1].kind, "ccn");
        assert_eq!(l.tools[1].text, "send_message: abc");
        // node の形（timestamp が外）でも読む
        feed(&mut l, json!({ "type": "user", "timestamp": "t3", "message": { "content": [{ "type": "tool_result", "tool_use_id": "a" }] } }));
        assert_eq!(l.tools.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!((l.last, l.last_at.clone()), (Some("result"), json!("t3")));
        // hook の差し込みはターンの始まりにしない。人の文が来たら、結果の来なかった道具は捨てる
        feed(&mut l, pty("t4", json!({ "type": "user", "message": { "content": "<system-reminder>x</system-reminder>" } })));
        assert_eq!(l.tools.len(), 1);
        feed(&mut l, pty("t5", json!({ "type": "user", "message": { "content": [{ "type": "text", "text": "[Request interrupted by user]" }] } })));
        assert!(l.tools.is_empty());
        assert_eq!(l.turn_at, json!("t5"));
    }

    #[test]
    fn conversation_returns_only_what_the_screen_lacks() {
        use super::{Conv, KEEP_MESSAGES};
        use serde_json::json;
        let mut c = Conv::default();
        let item = |i: usize| json!({ "role": "assistant", "text": format!("t{i}") });
        c.push((0..3).map(item).collect());
        // 初めて開いたときは全部
        let d = c.since(None);
        assert!(d.reset);
        assert_eq!(d.total, 3);
        assert_eq!(d.items.iter().map(|v| v["n"].as_u64().unwrap()).collect::<Vec<_>>(), vec![0, 1, 2]);
        // 増えていなければ空
        let d = c.since(Some(3));
        assert!(!d.reset && d.items.is_empty() && d.total == 3);
        // 増えた分だけ
        c.push(vec![item(3)]);
        let d = c.since(Some(3));
        assert!(!d.reset);
        assert_eq!(d.items, vec![json!({ "role": "assistant", "text": "t3", "n": 3 })]);
        // 一度に KEEP_MESSAGES を超えて増え、画面の持つ分が捨てた分より前になったら、全部を reset で
        c.push((4..4 + KEEP_MESSAGES + 5).map(item).collect());
        let d = c.since(Some(4));
        assert!(d.reset);
        assert_eq!(d.items.len(), KEEP_MESSAGES);
        assert_eq!(d.items[0]["n"], json!(9));
        assert_eq!(d.total, 4 + KEEP_MESSAGES as u64 + 5);
        // 画面のほうが先に進んでいる（キャッシュを作り直した）ときも reset
        assert!(c.since(Some(d.total + 1)).reset);
    }

    #[test]
    fn overlapping_reads_do_not_add_twice() {
        use super::Conv;
        use serde_json::json;
        let mut c = Conv::default();
        let fresh = || vec![json!({ "role": "user", "text": "a" })];
        // 同じ after=0 から読んだ2回。先に終わった方だけ足す
        c.absorb(0, 5, fresh(), vec![], None);
        c.absorb(0, 5, fresh(), vec![], None);
        assert_eq!(c.total, 1);
        assert_eq!(c.next, 5);
        c.absorb(5, 6, fresh(), vec![], None);
        assert_eq!(c.total, 2);
    }

    #[test]
    fn idle_conversations_are_forgotten() {
        use super::{forget_idle_convs, Conv, CONV_IDLE_MS};
        use std::collections::HashMap;
        let mut m: HashMap<String, Conv> = HashMap::new();
        let now = 100 * CONV_IDLE_MS;
        m.insert("|open".into(), Conv { used: now - 2500, ..Default::default() });
        m.insert("|closed".into(), Conv { used: now - CONV_IDLE_MS - 1, ..Default::default() });
        m.insert("|asked".into(), Conv { used: 0, ..Default::default() });
        forget_idle_convs(&mut m, "|asked", now);
        let mut keys: Vec<_> = m.keys().cloned().collect();
        keys.sort();
        // 読んでいる会話と、いま読もうとしている会話は残し、長く読まれていない会話は捨てる
        assert_eq!(keys, vec!["|asked", "|open"]);
    }

    #[test]
    fn a_changed_epoch_means_the_cursor_does_not_continue() {
        use super::cursor_is_stale;
        let s = |x: &str| Some(x.to_string());
        // 初めて読む（from=0）ときは、印が何でも続きとして読む
        assert!(!cursor_is_stale(0, &None, &s("a")));
        // 同じ印なら続き
        assert!(!cursor_is_stale(3, &s("a"), &s("a")));
        // 印が変わった（jsonl が入れ替わった）
        assert!(cursor_is_stale(3, &s("a"), &s("b")));
        assert!(cursor_is_stale(3, &s("a"), &s("history")));
        // 前の印が無い（読んだことが無い）のに読み位置がある
        assert!(cursor_is_stale(3, &None, &s("b")));
        // 印が無ければ今までどおり
        assert!(!cursor_is_stale(3, &None, &None));
        assert!(!cursor_is_stale(3, &s("a"), &None));
    }

    /// 読み直して置き換えた後は、画面が前に持っていた数（since）で呼んでも必ず reset になる。
    /// 読み直しが前より短い、同じ、長い（KEEP_MESSAGES を超える）の3通り
    #[test]
    fn replacing_after_a_reread_always_resets_the_screen() {
        use super::{Conv, KEEP_MESSAGES};
        use serde_json::json;
        let item = |i: usize| json!({ "role": "assistant", "text": format!("t{i}") });
        let a = Some("a".to_string());
        for len in [1usize, 3, KEEP_MESSAGES + 7] {
            let mut c = Conv::default();
            c.absorb(0, 3, (0..3).map(item).collect(), vec![], a.clone());
            let old = c.since(None).total;
            assert!(c.replace(3, &a, 5, (0..len).map(item).collect(), vec![], Some("b".into())));
            let d = c.since(Some(old));
            assert!(d.reset, "len={len}");
            assert_eq!(d.items.len(), len.min(KEEP_MESSAGES));
            assert_eq!(d.items.last().unwrap()["text"], json!(format!("t{}", len - 1)));
            // n は前より大きいところから続く
            assert!(d.items[0]["n"].as_u64().unwrap() > old);
            assert_eq!((c.next, c.epoch.as_deref()), (5, Some("b")));
            // 画面が追いついた後は、続きの差分だけ
            assert!(c.absorb(5, 6, vec![item(99)], vec![], Some("b".into())));
            let e = c.since(Some(d.total));
            assert!(!e.reset);
            assert_eq!(e.items.len(), 1);
        }
        // 0件に読み直しても、画面は reset で空になり、その後は reset を繰り返さない
        let mut c = Conv::default();
        c.absorb(0, 3, (0..3).map(item).collect(), vec![], a.clone());
        assert!(c.replace(3, &a, 0, vec![], vec![], Some("b".into())));
        let d = c.since(Some(3));
        assert!(d.reset && d.items.is_empty());
        assert!(!c.since(Some(d.total)).reset);
    }

    #[test]
    fn a_second_overlapping_reread_does_not_replace_twice() {
        use super::Conv;
        use serde_json::json;
        let a = Some("a".to_string());
        let mut c = Conv::default();
        c.absorb(0, 3, vec![json!({ "role": "user", "text": "x" })], vec![], a.clone());
        assert!(c.replace(3, &a, 5, vec![json!({ "role": "user", "text": "y" })], vec![], Some("b".into())));
        let total = c.total;
        // 同じ時に読み始めたもう1回は、もう進んでいるので置き換えない
        assert!(!c.replace(3, &a, 5, vec![json!({ "role": "user", "text": "y" })], vec![], Some("b".into())));
        assert_eq!(c.total, total);
        // 古い印のまま続きを足そうとした取得も足さない
        assert!(!c.absorb(3, 4, vec![json!({ "role": "user", "text": "z" })], vec![], a.clone()));
        assert_eq!(c.total, total);
    }

    #[test]
    fn conv_delta_is_sent_as_an_object() {
        use super::ConvDelta;
        use serde_json::json;
        let d = ConvDelta { items: vec![json!({ "role": "user", "text": "a", "n": 0 })], total: 1, reset: true, live: Default::default() };
        assert_eq!(serde_json::to_value(&d).unwrap(), json!({ "items": [{ "role": "user", "text": "a", "n": 0 }], "total": 1, "reset": true,
            "live": { "tools": [], "last": null, "last_at": null, "turn_at": null } }));
    }

    // 2026-11-12 に本番のノードの pty のセッションから読んだ messages の形
    #[test]
    fn pty_messages_are_read_from_data() {
        let user = json!({"at": 1794490104245u64, "type": "user", "seq": 1,
            "data": {"type": "user", "message": {"role": "user", "content": "from local via konaito-pro\n\nちゃんと動くのかテスト"}}});
        let out = simplify(&user);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[0]["text"], "ちゃんと動くのかテスト");
        assert_eq!(out[0]["from"], "from local via konaito-pro");
        assert_eq!(out[0]["at"], 1794490104245u64);

        let asst = json!({"at": 1794490107988u64, "type": "assistant", "seq": 2,
            "data": {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "届いてる"}]}}});
        let out = simplify(&asst);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "assistant");
        assert_eq!(out[0]["text"], "届いてる");

        let result = json!({"at": 1794490107988u64, "type": "result", "seq": 3, "data": {"type": "result", "result": "届いてる"}});
        assert!(simplify(&result).is_empty());
    }

    #[test]
    fn tool_results_attach_to_tool_lines() {
        let asst = |id: &str| json!({"type": "assistant", "timestamp": "t", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": "Bash", "input": {"command": "ls"}}]}});
        let res = |id: &str, err: bool| json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": [{"type": "text", "text": "a\nb"}], "is_error": err}]}});
        let mut c = Conv::default();
        // 同じ読み出しの結果は、道具の行に付くだけで項目は増えない
        c.push([asst("t1"), res("t1", false)].iter().flat_map(simplify).collect());
        assert_eq!(c.items.len(), 1);
        assert_eq!(c.items[0]["result"], json!({"text": "a\nb", "error": false}));
        // 後の読み出しの結果は、道具の行に付け、画面に送る result の項目も足す
        c.push(simplify(&asst("t2")));
        c.push(simplify(&res("t2", true)));
        assert_eq!(c.items.len(), 3);
        assert_eq!(c.items[1]["result"]["error"], true);
        assert_eq!(c.items[2]["role"], "result");
        assert_eq!(c.items[2]["id"], "t2");
        // 道具の行が無い結果は捨てる
        c.push(simplify(&res("nope", false)));
        assert_eq!(c.items.len(), 3);
    }

    #[test]
    fn turn_end_events() {
        let r = |o: Value| simplify(&json!({"at": 5, "type": "result", "data": o}));
        assert_eq!(r(json!({"type": "result", "subtype": "interrupted", "is_error": true, "result": ""}))[0]["kind"], "interrupted");
        let e = r(json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "result": "API Error: limit"}));
        assert_eq!(e[0]["kind"], "error");
        assert!(e[0]["text"].as_str().unwrap().contains("API Error: limit"));
        assert!(r(json!({"type": "result", "subtype": "success", "is_error": false, "result": "ok"})).is_empty());
    }

    #[test]
    fn node_interrupt_is_one_mark() {
        // 2026-11-21 に -p の子を止めたときの行（中身は縮めた）
        let user = json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}, "timestamp": "t"});
        let end = json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "result": ""});
        let mut c = Conv::default();
        c.push(simplify(&user));
        c.push(simplify(&end));
        assert_eq!(c.items.len(), 1);
        assert_eq!(c.items[0]["kind"], "interrupted");
    }

    #[test]
    fn result_text_keeps_the_head() {
        assert_eq!(result_text(&json!("x")), "x");
        assert_eq!(result_text(&json!([{"type": "text", "text": "a"}, {"type": "image"}])), "a\n[画像]");
        let long = (0..100).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let t = result_text(&json!(long));
        assert!(t.ends_with("…（続きは省いた）"));
        assert_eq!(t.lines().count(), RESULT_LINES + 1);
    }

    #[test]
    fn exit_plan_mode_keeps_the_plan() {
        let asst = json!({"type": "assistant", "timestamp": "t", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "name": "ExitPlanMode", "input": {"plan": "# 計画\n- a"}},
            {"type": "tool_use", "name": "Read", "input": {"file_path": "/a/b"}}]}});
        let out = simplify(&asst);
        assert_eq!(out[0]["plan"], "# 計画\n- a");
        assert!(out[1].get("plan").is_none());
    }

    #[test]
    fn node_messages_keep_the_transcript_shape() {
        let asst = json!({"type": "assistant", "timestamp": "2026-11-12T13:00:00Z",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "はい"}]}});
        let out = simplify(&asst);
        assert_eq!(out[0]["text"], "はい");
        assert_eq!(out[0]["at"], "2026-11-12T13:00:00Z");
        // トランスクリプトの行に data が付いていても、message があればそちらを読む
        let with_data = json!({"type": "user", "timestamp": "t", "data": {"type": "hook_progress"}, "message": {"role": "user", "content": "やあ"}});
        assert_eq!(simplify(&with_data)[0]["text"], "やあ");
    }

    // 2026-11-14 14:21 に本人が meta（8074d764）へ続けて送った3通。当時の会話の形（data で包んだ形）のまま（#69）。
    // 1通目と3通目は CLI が <pasted_content> で包んでいた。包みのまま `<` で始まるので会話から落ち、仮の吹き出しが消えずに末尾に残った
    #[test]
    fn pasted_content_is_unwrapped_not_dropped() {
        let first = json!({"at": 1794633665654u64, "type": "user", "seq": 442, "data": {"type": "user", "message": {"role": "user",
            "content": "\n\n<pasted_content id=\"9779\">\nfrom local via konaito-pro\n\n/var/folders/lp/twxk19yd58v9rb7ytpcxt6pm0000gn/T/TemporaryItems/NSIRD_screencaptureui_GJ7Y9w/スクリーンショット\\ 2026-11-14\\ 14.20.54.png \n\nこれ挙動がおかしいぞ、掘ってくれ\n</pasted_content id=\"9779\">\n"}}});
        let second = json!({"at": 1794633683710u64, "type": "user", "seq": 453, "data": {"type": "user", "message": {"role": "user",
            "content": "from local via konaito-pro\n\n先に送ったやつが先に反映されてない"}}});
        let third = json!({"at": 1794633703956u64, "type": "user", "seq": 460, "data": {"type": "user", "message": {"role": "user",
            "content": "<pasted_content id=\"9779\">\nfrom local via konaito-pro\n\n/var/folders/lp/twxk19yd58v9rb7ytpcxt6pm0000gn/T/TemporaryItems/NSIRD_screencaptureui_s8ZkFz/スクリーンショット\\ 2026-11-14\\ 14.21.28.png \n今回も、多分送られてるし、読まれてるんだけど、判定がおかしいんだと思う\n</pasted_content id=\"9779\">"}}});
        let a = simplify(&first);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["from"], "from local via konaito-pro");
        assert_eq!(a[0]["text"], "/var/folders/lp/twxk19yd58v9rb7ytpcxt6pm0000gn/T/TemporaryItems/NSIRD_screencaptureui_GJ7Y9w/スクリーンショット\\ 2026-11-14\\ 14.20.54.png \n\nこれ挙動がおかしいぞ、掘ってくれ");
        assert_eq!(simplify(&second)[0]["text"], "先に送ったやつが先に反映されてない");
        let c = simplify(&third);
        assert_eq!(c.len(), 1);
        assert!(c[0]["text"].as_str().unwrap().ends_with("判定がおかしいんだと思う"));
        // 包まれた文も、ターンの始まりとして数える
        for m in [&first, &second, &third] {
            // 文が会話に出た印（順番待ちを消す Delivered）も一緒に出る
            assert!(live_events(m).iter().any(|e| matches!(e, LiveEv::User(_))));
        }
        // hook の差し込みは今までどおり落とす
        let hook = json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": "<system-reminder>x</system-reminder>"}});
        assert!(simplify(&hook).is_empty());
    }

    // 2026-11-22 に fix-storage-gui（e545f8a7）で本人が打った /merge の行。当時の形のまま。`<` で始まるので会話から落ちていた（#157）
    #[test]
    fn slash_commands_show_as_user_text() {
        let line = |c: &str| json!({"type": "user", "timestamp": "2026-11-22T12:53:39.294Z", "message": {"role": "user", "content": c}});
        let merge = line("<command-message>merge</command-message>\n<command-name>/merge</command-name>");
        let out = simplify(&merge);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[0]["text"], "/merge");
        // ターンの始まりとして数える（順番待ちを消す Delivered も一緒に出る、#153）
        assert!(live_events(&merge).iter().any(|e| matches!(e, LiveEv::User(_))));
        // 名前が先で、引数が付く形（字下げも当時のまま）
        let login = line("<command-name>/login</command-name>\n            <command-message>login</command-message>\n            <command-args></command-args>");
        assert_eq!(simplify(&login)[0]["text"], "/login");
        // 引数に < を含む本文が入る形
        let surf = line("<command-message>surf</command-message>\n<command-name>/surf</command-name>\n<command-args>https://a.example/x <b>強</b></command-args>");
        assert_eq!(simplify(&surf)[0]["text"], "/surf https://a.example/x <b>強</b>");
        // 本文の配列で来ても同じ
        let arr = json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": [{"type": "text", "text": "<command-name>/clear</command-name>"}]}});
        assert_eq!(simplify(&arr)[0]["text"], "/clear");
    }

    // 2026-11-14、写した画像のパスを入れて送った文を、CLI が画像の添付にした形（当時の会話の形のまま、#69）
    #[test]
    fn image_marks_before_the_from_line() {
        let m = json!({"at": 1794634823274u64, "type": "user", "seq": 51, "data": {"type": "user", "message": {"role": "user",
            "content": "[Image #3]from local via konaito-pro\n（ドロップの確認）上のパスの画像を Read で開いて"}}});
        let out = simplify(&m);
        assert_eq!(out[0]["from"], "from local via konaito-pro");
        assert_eq!(out[0]["text"], "[Image #3]\n（ドロップの確認）上のパスの画像を Read で開いて");
        // 画像だけを送り、from 行の後ろに何も無い形
        let only = json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": "[Image #4]from local via konaito-pro"}});
        assert_eq!(simplify(&only)[0]["from"], "from local via konaito-pro");
        assert_eq!(simplify(&only)[0]["text"], "[Image #4]");
        // 印が無く改行も無い from 始まりの文は、今までどおり本文として出す
        let plain = json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": "from A via B"}});
        assert_eq!(simplify(&plain)[0]["text"], "from A via B");
        assert_eq!(split_image_marks("[Image #1] [Image #12]from x"), ("[Image #1] [Image #12]", "from x"));
        assert_eq!(split_image_marks("[Image #]x"), ("", "[Image #]x"));
        assert_eq!(split_image_marks("ふつう"), ("", "ふつう"));
    }

    #[test]
    fn unwrap_pasted_keeps_text_around_and_odd_tags() {
        assert_eq!(unwrap_pasted("  ふつう  "), "ふつう");
        // 打った文と貼った文が混ざっている
        assert_eq!(unwrap_pasted("見て <pasted_content id=\"1\">\n長い文\n</pasted_content id=\"1\"> どう？"), "見て \n長い文\n どう？");
        // 閉じの印に id が無い形も外す
        assert_eq!(unwrap_pasted("<pasted_content id=\"2\">a</pasted_content>"), "a");
        // 名前が続いているもの、> で閉じないものは文のまま残す
        assert_eq!(unwrap_pasted("<pasted_contents>x"), "<pasted_contents>x");
        assert_eq!(unwrap_pasted("<pasted_content\nx"), "<pasted_content\nx");
    }

    #[derive(serde::Deserialize)]
    struct SharedCase {
        name: String,
        #[serde(rename = "fn")]
        func: String,
        args: Vec<Value>,
        expect: Value,
    }

    /// src/conv-cases.json の事例（bun test も src/webConv.test.ts で同じものを読む）
    #[test]
    fn shared_cases() {
        let cases: Vec<SharedCase> = serde_json::from_str(include_str!("../../src/conv-cases.json")).unwrap();
        assert!(cases.len() >= 60);
        for c in cases {
            let a = &c.args;
            let got = match c.func.as_str() {
                "clip" => json!(clip(a[0].as_str().unwrap(), a[1].as_u64().unwrap() as usize)),
                "tool_line" => json!(tool_line(a[0].as_str().unwrap(), &a[1])),
                "result_text" => json!(result_text(&a[0])),
                "unwrap_pasted" => json!(unwrap_pasted(a[0].as_str().unwrap())),
                "split_image_marks" => {
                    let (imgs, rest) = split_image_marks(a[0].as_str().unwrap());
                    json!([imgs, rest])
                }
                "simplify" => json!(simplify(&a[0])),
                f => panic!("{}: 知らない関数 {f}", c.name),
            };
            assert_eq!(got, c.expect, "{}", c.name);
        }
    }

    /// 作業中に打った文（順番待ち）。jsonl の queue-operation の行と、途中で取り込まれた文の attachment（queued_command）の形は、
    /// 2026-11-22 の 16270b20 の jsonl（2.1.330）の 348、390、394、396 行目から写した。中身のない enqueue と dequeue の組は a9c909ad から
    #[test]
    fn conversation_is_empty_while_jsonl_is_not_created_yet() {
        use crate::native::testtree::tmp;
        // 登録はあるが jsonl がまだ無い（起動した直後）。エラーにせず空で返す
        let d = tmp("nojsonl");
        let id = "missing-jsonl-test-session".to_string();
        let p = d.join("not-yet.jsonl");
        native::register(HashMap::from([(id.clone(), p.clone())]));
        let r = conversation(id.clone(), None);
        let delta = r.expect("jsonl が無い間は空の会話を返す");
        assert!(delta.items.is_empty());
        assert_eq!(delta.total, 0);
        // NotFound 以外（ここでは親がファイルで、ディレクトリとして辿れない）は今までどおりエラー
        let blocker = d.join("file");
        std::fs::write(&blocker, "x").unwrap();
        let id2 = "unreadable-jsonl-test-session".to_string();
        native::register(HashMap::from([(id.clone(), p), (id2.clone(), blocker.join("child.jsonl"))]));
        assert!(conversation(id2, None).is_err());
        // 作られたら読める
        std::fs::write(d.join("not-yet.jsonl"), "").unwrap();
        assert!(conversation(id, None).is_ok());
    }

    #[test]
    fn queued_prompts_wait_then_land() {
        use crate::native::testtree::{tmp, write};
        let a = "/Users/x/.family-computing/attachments/drop-1.png 一回オンにしたけど、開き直す？";
        let b = "claudetownがccnに依存していないなら開き直しても動く？";
        let op = |ts: &str, o: &str, c: Option<&str>| {
            let mut v = json!({ "type": "queue-operation", "operation": o, "timestamp": ts, "sessionId": "s" });
            if let Some(c) = c { v["content"] = json!(c); }
            v.to_string()
        };
        let mut lines = vec![
            json!({ "type": "user", "timestamp": "2026-11-22T11:47:00Z", "message": { "role": "user", "content": "監査して" } }).to_string(),
            // 道具の終わりの知らせ（人の文ではない）と、中身のない enqueue は、人の文が無いときに dequeue される
            op("2026-11-22T11:48:00Z", "enqueue", Some("<task-notification>\n<task-id>b1</task-id>\n</task-notification>")),
            op("2026-11-22T11:48:01Z", "dequeue", None),
            op("2026-11-22T11:48:02Z", "enqueue", None),
            op("2026-11-22T11:48:03Z", "dequeue", None),
            json!({ "type": "assistant", "timestamp": "2026-11-22T11:49:00Z", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } }).to_string(),
            op("2026-11-22T11:49:56.503Z", "enqueue", Some(a)),
            op("2026-11-22T11:49:57Z", "enqueue", Some("from local via konaito-pro\n\nこんにちは")),
            op("2026-11-22T11:50:18.098Z", "enqueue", Some(b)),
            op("2026-11-22T11:50:18.353Z", "remove", Some(b)),
            json!({ "type": "attachment", "timestamp": "2026-11-22T11:50:18.000Z", "attachment": { "type": "queued_command", "prompt": b,
                "source_uuid": "u1", "commandMode": "prompt", "origin": { "kind": "human" }, "timestamp": "2026-11-22T11:50:18.000Z", "humanTurn": true } }).to_string(),
            // 人の文でない取り込み（道具の知らせ）は会話に出さない
            json!({ "type": "attachment", "timestamp": "2026-11-22T11:50:19Z", "attachment": { "type": "queued_command", "prompt": "<task-notification>x</task-notification>",
                "commandMode": "task-notification", "origin": { "kind": "task-notification" } } }).to_string(),
        ];
        let d = tmp("queue");
        let p = d.join("s.jsonl");
        write(&p, &(lines.join("\n") + "\n"));
        let mut c = Conv::default();
        let (next, fresh, evs, _) = read_native(&p, 0).unwrap();
        c.absorb(0, next, fresh, evs, None);
        let users = |c: &Conv| c.since(None).items.iter().filter(|x| x["role"] == "user").map(|x| x["text"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>();
        let queued = |c: &Conv| serde_json::to_value(c.since(None).live).unwrap()["queued"].as_array().cloned().unwrap_or_default();
        // 途中で取り込まれた文は、取り込まれた所に人の文として出る
        assert_eq!(users(&c), vec!["監査して", b]);
        // まだ読まれていない文は順番待ちに出る。別のセッションからの文は from 行を外す
        let q = queued(&c);
        assert_eq!(q.iter().map(|x| x["text"].as_str().unwrap()).collect::<Vec<_>>(), vec![a, "こんにちは"]);
        assert_eq!(q[0]["at"], "2026-11-22T11:49:56.503Z");
        assert_eq!(q[1]["from"], "from local via konaito-pro");
        // ターンが終わって順に読まれると、順番待ちから消えて会話に出る
        lines.push(op("2026-11-22T11:55:00Z", "dequeue", None));
        lines.push(json!({ "type": "user", "timestamp": "2026-11-22T11:55:00Z", "message": { "role": "user", "content": a } }).to_string());
        lines.push(op("2026-11-22T11:55:00Z", "dequeue", None));
        lines.push(json!({ "type": "user", "timestamp": "2026-11-22T11:55:00Z", "message": { "role": "user", "content": "from local via konaito-pro\n\nこんにちは" } }).to_string());
        write(&p, &(lines.join("\n") + "\n"));
        let (next2, fresh, evs, _) = read_native(&p, next).unwrap();
        c.absorb(next, next2, fresh, evs, None);
        assert!(queued(&c).is_empty());
        assert_eq!(users(&c), vec!["監査して", b, a, "こんにちは"]);
        // 起動し直すと待ちは空になる（残った enqueue を待ちのまま出さない）
        lines.push(op("2026-11-22T12:00:00Z", "enqueue", Some("消えるはず")));
        lines.push(json!({ "type": "attachment", "timestamp": "2026-11-22T12:01:00Z", "attachment": { "type": "hook_success", "hookName": "SessionStart:resume", "hookEvent": "SessionStart" } }).to_string());
        write(&p, &(lines.join("\n") + "\n"));
        let (next3, fresh, evs, _) = read_native(&p, next2).unwrap();
        c.absorb(next2, next3, fresh, evs, None);
        assert!(queued(&c).is_empty());
    }
}
