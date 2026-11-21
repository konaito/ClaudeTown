use super::*;

// ---------- 会話 ----------

#[derive(Default)]
pub(crate) struct Conv {
    /// ccn の messages の次の読み出し位置（after=）
    pub(crate) next: u64,
    /// next の数え方の印（ccn の messages の epoch）。印を返さない古い ccn では None のまま
    pub(crate) epoch: Option<String>,
    /// これまでに縮めた項目の数。項目の通し番号 n は 0 から数える
    pub(crate) total: u64,
    /// 最後の KEEP_MESSAGES 件
    pub(crate) items: Vec<Value>,
    /// 最後に読まれた時刻（ms）
    pub(crate) used: u128,
    /// 今の動き（#59）
    pub(crate) live: Live,
    /// ネイティブの jsonl から読んだか（#96）。同じ id が ccn とネイティブの間で入れ替わったら、読み位置の数え方が違うので頭から読み直す
    pub(crate) native: bool,
}

/// 今の動き（#59）。会話を頭から読みながら、結果がまだ無い道具、最後の出来事、ターンの始まりを持つ。
/// 時刻は node なら ISO の文字列、pty なら jsonl の timestamp（無ければ ccn の at の ms）のまま渡し、画面が Date で読む
#[derive(Default, Clone, Serialize, Debug, PartialEq)]
pub(crate) struct Live {
    /// 結果がまだ無い道具（古い順）
    pub(crate) tools: Vec<LiveTool>,
    /// 最後の出来事の種類（user、thinking、text、tool、result）と時刻
    pub(crate) last: Option<&'static str>,
    pub(crate) last_at: Value,
    /// 最後に人（かほかのセッション）から文が届いた時刻
    pub(crate) turn_at: Value,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
pub(crate) struct LiveTool {
    pub(crate) id: String,
    /// まとめるときの種類（シェル、ccn など）
    pub(crate) kind: String,
    /// 1行の中身（Bash ならコマンドの頭）
    pub(crate) text: String,
    pub(crate) at: Value,
}

#[derive(Debug, Clone)]
pub(crate) enum LiveEv {
    User(Value),
    Thinking(Value),
    Text(Value),
    Tool(LiveTool),
    Result(Vec<String>, Value),
}

impl Live {
    pub(crate) fn apply(&mut self, ev: LiveEv) {
        let (kind, at) = match ev {
            // 新しい文が来たら、前のターンで結果が来なかった道具（中断など）は捨てる
            LiveEv::User(at) => { self.tools.clear(); self.turn_at = at.clone(); ("user", at) }
            LiveEv::Thinking(at) => ("thinking", at),
            LiveEv::Text(at) => ("text", at),
            LiveEv::Tool(t) => { let at = t.at.clone(); self.tools.retain(|x| x.id != t.id); self.tools.push(t); ("tool", at) }
            LiveEv::Result(ids, at) => { self.tools.retain(|x| !ids.contains(&x.id)); ("result", at) }
        };
        self.last = Some(kind);
        self.last_at = at;
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
/// ccn は文を端末に貼るので、送った文が包まれて届くことがある（2026-11-14 の meta、8074d764 の jsonl）。
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

/// ccn の1件から、今の動きに効く出来事を取り出す。simplify と同じく node と pty の両方の形を読む
pub(crate) fn live_events(m: &Value) -> Vec<LiveEv> {
    let (m, at) = match m.get("data").filter(|d| m.get("message").is_none() && d.is_object()) {
        Some(d) => (d, if d["timestamp"].is_string() { d["timestamp"].clone() } else { m["at"].clone() }),
        None => (m, m["timestamp"].clone()),
    };
    let content = &m["message"]["content"];
    let mut out = vec![];
    match m["type"].as_str().unwrap_or("") {
        "user" => {
            let ids: Vec<String> = content.as_array().map(|a| a.iter()
                .filter(|c| c["type"] == "tool_result")
                .filter_map(|c| c["tool_use_id"].as_str().map(String::from))
                .collect()).unwrap_or_default();
            if !ids.is_empty() {
                out.push(LiveEv::Result(ids, at));
            } else {
                let text = user_text(content);
                // hook やシステムの差し込み（<...>、Caveat:）はターンの始まりにしない。お手紙（<cross-session-message>）は始まりにする
                let letter = text.contains("<cross-session-message");
                if !text.is_empty() && !m["isMeta"].as_bool().unwrap_or(false) && (letter || !(text.starts_with('<') || text.starts_with("Caveat:"))) {
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
                        // Bash はコマンドそのもの、ccn などは宛先（session、name）を頭に出す。終わった道具の行（tool_line）は変えない
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
/// 捨てた後に開き直したら、ccn の after=0 から読み直し、画面は reset で受け取る
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
    /// ccn の after=from から next まで読んだ分を足す。同じセッションの取得が重なり、
    /// ほかの呼び出しが先に同じ範囲を足していたら（c.next が読み始めと違う）、足さない
    /// 項目が増えたら true
    pub(crate) fn absorb(&mut self, from: u64, next: u64, fresh: Vec<Value>, evs: Vec<LiveEv>, epoch: Option<String>) -> bool {
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
    pub(crate) fn replace(&mut self, from: u64, seen: &Option<String>, next: u64, fresh: Vec<Value>, evs: Vec<LiveEv>, epoch: Option<String>) -> bool {
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

    pub(crate) fn push(&mut self, fresh: Vec<Value>) {
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
    pub(crate) fn since(&self, since: Option<u64>) -> ConvDelta {
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
/// ccn の messages は、セッションの種類で形が違う。node はトランスクリプトの行そのまま（type、message、timestamp）。
/// pty は {at, type, data: {type, message, …}, seq} で、中身は data に入り、時刻は at（ms）にある。
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
    let mut out: String = t.lines().take(RESULT_LINES).collect::<Vec<_>>().join("\n");
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
            let text = text.strip_prefix("Another Claude session sent a message:").map(str::trim_start).unwrap_or(text);
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
                            // 送ったお手紙（SendMessage、ccn の send_message と create_session）は、宛先と1行目を付ける
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
                            if name == "ExitPlanMode" {
                                if let Some(p) = inp["plan"].as_str().filter(|p| !p.trim().is_empty()) {
                                    item["plan"] = json!(p);
                                }
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

/// ccn の messages を after=start から読む。1回で読むのは最大20ページ（4000件）。続きは次の呼び出しで読む。
/// 返すのは (次の after, 縮めた項目, 今の動きの出来事, 最初のページの epoch)
pub(crate) fn read_messages(peer: &Option<String>, session_id: &str, start: u64) -> Result<(u64, Vec<Value>, Vec<LiveEv>, Option<String>), String> {
    let mut next = start;
    let mut fresh = vec![];
    let mut evs = vec![];
    let mut epoch = None;
    for page in 0..20 {
        let v = ccn::messages(peer, session_id, next)?;
        let e = v["epoch"].as_str().map(String::from);
        if page == 0 {
            epoch = e;
        } else if e != epoch {
            // ページの途中で数え方が変わった（読んでいる間に ccn が起動し直した）。ここまでで止め、次の呼び出しで気づく
            break;
        }
        let msgs = v["messages"].as_array().cloned().unwrap_or_default();
        for m in &msgs {
            fresh.extend(simplify(m));
            evs.extend(live_events(m));
        }
        match v["next"].as_u64() {
            Some(n) if n > next && !msgs.is_empty() => next = n,
            _ => break,
        }
        if msgs.len() < 200 {
            break;
        }
    }
    Ok((next, fresh, evs, epoch))
}

/// 持っている cursor（from）が、今の ccn の番号と続いていないか。ccn の messages は epoch（番号の印）を返し、
/// 再起動、pty の付け直し、終わって jsonl の位置に移ったときに変わる。前に読んだ印と違えば、from から先を読むと欠けるか重なる。
/// 印を返さない古い ccn（got が None）では今までどおり続きを読む。前の印が None で今が Some なのは、
/// 古い ccn から入れ替わった（再起動した）ので、読み直す
pub(crate) fn cursor_is_stale(from: u64, seen: &Option<String>, got: &Option<String>) -> bool {
    from > 0 && got.is_some() && got != seen
}

/// ネイティブの jsonl（#96）を読み位置 from から読む。read_messages と同じ形で返す。読み位置はバイト、印は native:<inode>。
/// ファイルが読み位置より短くなったら、印を変えて返し、conversation が頭から読み直した扱いにする
pub(crate) fn read_native(path: &std::path::Path, from: u64) -> Result<(u64, Vec<Value>, Vec<LiveEv>, Option<String>), String> {
    let c = native::conv::read(path, from)?;
    let fresh = c.lines.iter().flat_map(simplify).collect();
    let evs = c.lines.iter().flat_map(live_events).collect();
    let epoch = if c.restarted { format!("{}:restarted", c.epoch) } else { c.epoch };
    Ok((c.next, fresh, evs, Some(epoch)))
}

pub(crate) fn conversation(session_id: String, peer: Option<String>, since: Option<u64>) -> Result<ConvDelta, String> {
    let peer = peer.filter(|p| !p.is_empty());
    // ネイティブのセッションと sub-agent（一覧に出したもので、ccn に無いもの）は jsonl から読む（#96）
    let native_path = if peer.is_none() { native::path_of(&session_id) } else { None };
    let is_native = native_path.is_some();
    let key = format!("{}|{session_id}", peer.clone().unwrap_or_default());
    let (from, seen, was_native) = {
        let g = CONVS.lock().map_err(|e| e.to_string())?;
        g.as_ref().and_then(|m| m.get(&key)).map(|c| (c.next, c.epoch.clone(), Some(c.native))).unwrap_or((0, None, None))
    };
    // 出どころが ccn とネイティブの間で入れ替わった（ccn が落ちた、戻った、設定を切り替えた）。読み位置は使えないので、
    // 頭から読んで置き換える。置き換えは通し番号を1つ空けるので、画面には必ず reset で届き、2つの出どころの項目が混ざらない
    let switched = was_native.is_some_and(|w| w != is_native);
    let start = if switched { 0 } else { from };
    let read = |from: u64| match &native_path {
        Some(p) => read_native(p, from),
        None => read_messages(&peer, &session_id, from),
    };
    let (mut next, mut fresh, mut evs, mut epoch) = read(start)?;
    let restarted = epoch.as_deref().is_some_and(|e| e.ends_with(":restarted"));
    let stale = switched || restarted || cursor_is_stale(start, &seen, &epoch);
    if restarted {
        // ネイティブで頭から読み直した分は、そのまま置き換えに使う。印は元の形に戻す
        epoch = epoch.map(|e| e.trim_end_matches(":restarted").to_string());
    } else if stale && start > 0 {
        // 読んだページは捨て、after=0 から読み直して置き換える。読み直しに失敗したら何も変えない（次の呼び出しでもう一度気づく）
        (next, fresh, evs, epoch) = read(0)?;
    }
    let mut g = CONVS.lock().map_err(|e| e.to_string())?;
    let map = g.get_or_insert_with(HashMap::new);
    let now = now_ms();
    forget_idle_convs(map, &key, now);
    let c = map.entry(key).or_insert_with(Conv::default);
    c.used = now;
    let changed = if stale {
        // 読み直しが0件で、前に中身があったときは置き換えない。ccn は jsonl を読めなかったときも空で返すので、保存分まで消さない。
        // 置き換えたら、増えたかに関係なく保存し直す（保存分は前の中身のままなので）
        !(fresh.is_empty() && !c.items.is_empty()) && c.replace(from, &seen, next, fresh, evs, epoch)
    } else {
        c.absorb(from, next, fresh, evs, epoch)
    };
    if !stale || changed {
        c.native = is_native;
    }
    // 増えたか置き換えたら、画面に出す分（最後の KEEP_MESSAGES 件）を保存する。ネットが切れたときは画面が conversation_cache で読む。
    // 書くのは錠を持ったまま（同じセッションの取得が重なっても、古い中身があとから上書きしない）。80件の JSON なので短い
    if changed {
        let _ = offline::save_conv(&cache_dir(), &peer, &session_id, c.total, &c.items);
    }
    Ok(c.since(since))
}

/// 保存してある会話（offline.rs）。画面はセッションを開いた直後にこれを出し、ccn から読めたら差し替える
pub(crate) fn conversation_cache(session_id: String, peer: Option<String>) -> Option<offline::ConvCache> {
    let peer = peer.filter(|p| !p.is_empty());
    offline::load_conv(&cache_dir(), &peer, &session_id)
}

pub(crate) fn send_message(session_id: String, text: String, peer: Option<String>) -> Result<String, String> {
    native_guard(&session_id, &peer)?;
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    if text.trim().is_empty() {
        return Err("文が空".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    ccn::post_message(&peer, &session_id, &text)
}
