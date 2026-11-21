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

/// 画面から呼ぶ命令の包み。中身の関数は上にある。待つ命令は blocking で別のスレッドへ出す
pub(crate) mod cmd {
    use super::*;

    #[tauri::command]
    pub async fn conversation(session_id: String, peer: Option<String>, since: Option<u64>) -> Result<super::ConvDelta, String> {
        blocking(move || super::conversation(session_id, peer, since)).await
    }
    #[tauri::command]
    pub async fn conversation_cache(session_id: String, peer: Option<String>) -> Result<Option<super::offline::ConvCache>, String> {
        blocking(move || Ok(super::conversation_cache(session_id, peer))).await
    }
    #[tauri::command]
    pub async fn send_message(session_id: String, text: String, peer: Option<String>) -> Result<String, String> {
        blocking(move || super::send_message(session_id, text, peer)).await
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
        // 印が変わった（ccn の再起動、付け直し、終わって jsonl の位置へ）
        assert!(cursor_is_stale(3, &s("a"), &s("b")));
        assert!(cursor_is_stale(3, &s("a"), &s("history")));
        // 印を返さない古い ccn から入れ替わった
        assert!(cursor_is_stale(3, &None, &s("b")));
        // 印を返さない古い ccn では今までどおり
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

    /// 試験用の ccn（FC_CCN_URL）のセッション（FC_CONV_ID）の会話を、画面と同じ形で FC_CONV_SECS 秒読み続ける。
    /// 同じプロセスで cursor を持ったまま、外で ccn を起動し直して会話を足す。終わりに、画面が持つ分と、
    /// after=0 から読んだ分を比べる（再起動の前後で欠けも二重も無いか）。HOME は空のディレクトリにする（保存分を分ける）。
    /// HOME=<空> FC_CCN_URL=http://127.0.0.1:<ポート> FC_CONV_ID=<id> FC_CONV_SECS=120 <試験のバイナリ> conversation_across_restart --ignored --nocapture
    #[test]
    #[ignore]
    fn conversation_across_restart() {
        use super::{conversation, read_messages, offline, cache_dir};
        let id = std::env::var("FC_CONV_ID").expect("FC_CONV_ID");
        let secs: u64 = std::env::var("FC_CONV_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(120);
        // 画面（App.tsx の load と conv.ts の mergeConv）と同じ持ち方
        let mut since: Option<u64> = None;
        let mut screen: Vec<Value> = vec![];
        let texts = |v: &[Value]| v.iter().map(|x| format!("{}:{}", x["role"].as_str().unwrap_or(""), x["text"].as_str().unwrap_or(""))).collect::<Vec<_>>();
        let t0 = std::time::Instant::now();
        // FC_CONV_PAUSE のファイルがある間は読まない（再起動して1往復進めてから読む順序を作る）
        let pause = std::env::var("FC_CONV_PAUSE").ok().map(std::path::PathBuf::from);
        while t0.elapsed() < Duration::from_secs(secs) {
            if pause.as_ref().is_some_and(|p| p.exists()) {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            match conversation(id.clone(), None, since) {
                Ok(d) => {
                    if d.reset {
                        screen = d.items.clone();
                    } else {
                        let last = screen.last().and_then(|x| x["n"].as_u64());
                        screen.extend(d.items.iter().filter(|x| last.map_or(true, |l| x["n"].as_u64().unwrap_or(u64::MAX) > l)).cloned());
                    }
                    let prev = since;
                    since = Some(if d.reset { d.total } else { since.unwrap_or(0).max(d.total) });
                    if d.reset || !d.items.is_empty() {
                        let g = super::CONVS.lock().unwrap();
                        let c = g.as_ref().and_then(|m| m.get(&format!("|{id}"))).unwrap();
                        println!("[{:>5.1}s] since {prev:?}→{since:?} reset={} +{} 画面{}件 cursor={} epoch={:?} {:?}",
                            t0.elapsed().as_secs_f32(), d.reset, d.items.len(), screen.len(), c.next, c.epoch, texts(&d.items));
                    }
                }
                Err(e) => println!("[{:>5.1}s] 読めない: {e}", t0.elapsed().as_secs_f32()),
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let (_, fresh, _, epoch) = read_messages(&None, &id, 0).expect("after=0");
        let cached = offline::load_conv(&cache_dir(), &None, &id).map(|c| texts(&c.items)).unwrap_or_default();
        println!("画面 {}件: {:?}", screen.len(), texts(&screen));
        println!("after=0 {}件（epoch {epoch:?}）: {:?}", fresh.len(), texts(&fresh));
        println!("保存分 {}件", cached.len());
        assert_eq!(texts(&screen), texts(&fresh));
        assert_eq!(cached, texts(&fresh));
    }

    #[test]
    fn switching_between_ccn_and_native_always_resets_the_screen() {
        // 会話を読む先の登録（native::register）はプロセスで1つなので、使う試験を1本ずつ動かす
        let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        use native::testtree::*;
        let root = tmp("switch");
        TEST_CACHE.with(|c| *c.borrow_mut() = Some(root.join("cache")));
        let id = "cccccccc-0000-4000-8000-00000000000c";
        let path = root.join("c.jsonl");
        write(&path, "{\"type\":\"user\",\"message\":{\"content\":\"ネイティブ\"}}\n");
        // ccn から読んだ会話が 10 件ある（読み位置 7、印 e1）
        {
            let mut g = CONVS.lock().unwrap();
            let map = g.get_or_insert_with(HashMap::new);
            let mut c = Conv { next: 7, epoch: Some("e1".into()), used: now_ms(), ..Default::default() };
            c.push((0..10).map(|i| json!({ "role": "user", "text": format!("ccn {i}") })).collect());
            map.insert(format!("|{id}"), c);
        }
        // 同じ id がネイティブの行になった（ccn が落ちた）。画面は 8 件目まで持っている
        let mut reg = HashMap::new();
        reg.insert(id.to_string(), path.clone());
        native::register(reg);
        let d = conversation(id.into(), None, Some(8)).unwrap();
        assert!(d.reset, "出どころが変わったら必ず reset");
        assert_eq!(d.items.len(), 1);
        assert_eq!(d.items[0]["text"], "ネイティブ");
        // 続きはネイティブの読み位置で読む（もう reset しない）
        let d2 = conversation(id.into(), None, Some(d.total)).unwrap();
        assert!(!d2.reset);
        assert!(d2.items.is_empty());
        native::register(HashMap::new());
        CONVS.lock().unwrap().as_mut().unwrap().remove(&format!("|{id}"));
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

    // 2026-11-14 14:21 に本人が meta（8074d764）へ続けて送った3通。ccn の GET messages が返した形のまま（#69）。
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
            assert!(matches!(live_events(m).as_slice(), [LiveEv::User(_)]));
        }
        // hook の差し込みは今までどおり落とす
        let hook = json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": "<command-name>/clear</command-name>"}});
        assert!(simplify(&hook).is_empty());
    }

    // 2026-11-14、写した画像のパスを入れて送った文を、CLI が画像の添付にした形（ccn の GET messages のまま、#69）
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
}
