use super::*;

// ---------- 承認 ----------

/// 承認待ちに答える。choice は "allow" か "deny"。ccn の pending と permissions の口で答える（PTY のセッションも同じ口）。
/// 送る前に、今も承認待ちで、承認を求めている requestId が画面で見せたもの（expect_id）と同じかを確かめ、ずれていたら送らない。
/// 質問（AskUserQuestion）は answers（質問の文から答えへの対応）があるときだけ答える。計画の確認（ExitPlanMode）は許可で承認、拒否で見直しを頼む。
/// message は拒否の理由。空なら決まった文を送る。suggestion は「常に許可」で、pending の suggestions の何番目を updatedPermissions で返すか。
/// 中身の組み立ては permission_body（試験あり）。
/// 人が端末で開いたセッション（kind=terminal）は ccn から答えられないので断る。
pub(crate) fn answer_permission(session_id: String, choice: String, expect_id: Option<String>, answers: Option<Value>, message: Option<String>, suggestion: Option<usize>, peer: Option<String>) -> Result<String, String> {
    native_guard(&session_id, &peer)?;
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    if choice != "allow" && choice != "deny" {
        return Err("choice は allow か deny".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    let detail = ccn::session(&peer, &session_id)?;
    if detail["state"].as_str() != Some("waiting_permission") {
        return Err("もう承認待ちではない（ほかで答えたか、終わった）".into());
    }
    if detail["capabilities"]["permissions"].as_bool() != Some(true) {
        return Err("このセッションは ccn から承認に答えられない（人がターミナルで開いたセッション）。そのターミナルで答えて".into());
    }
    let pending = detail["pending"].as_array().cloned().unwrap_or_default();
    let first = pending.first().ok_or("ccn に承認の要求が見当たらない")?;
    let req = first["requestId"].as_str().ok_or("承認の要求に requestId が無い")?.to_string();
    let (body, done) = permission_body(first, &choice, expect_id.as_deref(), answers.as_ref(), message.as_deref(), suggestion)?;
    ccn::post_permission(&peer, &session_id, &req, body)?;
    Ok(done)
}

/// 「常に許可」として返してよい提案か。addRules と setMode だけ（addDirectories は端末の承認の画面が残ったので返さない）
pub(crate) fn allowed_suggestion(s: &Value) -> bool {
    matches!(s["type"].as_str(), Some("addRules") | Some("setMode"))
}

/// 拒否の理由が空のときに送る文
pub(crate) const DENY_DEFAULT: &str = "Claude Town から拒否した";
/// 計画の見直しを頼むときに、理由が空なら送る文
pub(crate) const PLAN_DENY_DEFAULT: &str = "計画を承認しなかった。計画を見直して、もう一度確認して";

/// ccn の permissions の口に送る中身と、終わったときに画面に出す文を作る。first は ccn の pending の先頭。
/// - 許可は、expect_id が requestId と同じときだけ。
/// - AskUserQuestion の許可は、全部の質問に空でない答えがあるときだけ。元の input に answers を足して updatedInput で返す
///   （2026-11-21 に PTY の子で、tool_result が `"<質問>"="<答え>"` になるのを確かめた。複数選択は label を「, 」でつなぐ）。
/// - ExitPlanMode の許可は素の allow（ccn が元の input を updatedInput にして返す）。拒否は「続けて計画する」で、理由を Claude に渡す。
/// - 「常に許可」（suggestion）は道具の許可だけで、pending の suggestions の1つをそのまま updatedPermissions で返す。画面から任意の規則は送らない。
///   addDirectories は返さない（2026-11-21、作業場所の外の計画ファイルの Write に返したら、ccn は答えたのに端末の承認の画面が残って止まった）。
pub(crate) fn permission_body(first: &Value, choice: &str, expect_id: Option<&str>, answers: Option<&Value>, message: Option<&str>, suggestion: Option<usize>) -> Result<(Value, String), String> {
    let req = first["requestId"].as_str().ok_or("承認の要求に requestId が無い")?;
    let tool = first["toolName"].as_str().unwrap_or_default();
    if choice == "deny" {
        if suggestion.is_some() {
            return Err("拒否に「常に許可」は付けない".into());
        }
        let msg = message.map(str::trim).filter(|m| !m.is_empty());
        let (msg, done) = match tool {
            "ExitPlanMode" => (msg.unwrap_or(PLAN_DENY_DEFAULT), "計画の見直しを頼んだ".to_string()),
            "AskUserQuestion" => (msg.unwrap_or(DENY_DEFAULT), "質問に答えずに断った".to_string()),
            _ => (msg.unwrap_or(DENY_DEFAULT), format!("拒否した（{tool}）")),
        };
        return Ok((json!({ "behavior": "deny", "message": msg }), done));
    }
    if choice != "allow" {
        return Err("choice は allow か deny".into());
    }
    if expect_id != Some(req) {
        return Err("承認を求めている中身が変わった。もう一度見てから答えて".into());
    }
    match tool {
        "AskUserQuestion" => {
            let given = answers.and_then(|a| a.as_object()).ok_or("質問への答えが無い")?;
            let qs = first["input"]["questions"].as_array().cloned().unwrap_or_default();
            if qs.is_empty() {
                return Err("質問の中身が読めない。ターミナルで答えて".into());
            }
            let mut out = serde_json::Map::new();
            for q in &qs {
                let text = q["question"].as_str().unwrap_or_default();
                let a = given.get(text).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty());
                let a = a.ok_or_else(|| format!("「{text}」への答えが無い"))?;
                out.insert(text.to_string(), json!(a));
            }
            let mut input = first["input"].clone();
            input["answers"] = Value::Object(out);
            Ok((json!({ "behavior": "allow", "updatedInput": input }), "質問に答えた".into()))
        }
        _ if answers.is_some() => Err(format!("{tool} は質問ではないので、答えを送らない")),
        "ExitPlanMode" if suggestion.is_some() => Err("計画の確認に「常に許可」は付けない".into()),
        "ExitPlanMode" => Ok((json!({ "behavior": "allow" }), "計画を承認した".into())),
        _ => match suggestion {
            None => Ok((json!({ "behavior": "allow" }), format!("許可した（{tool}）"))),
            Some(i) => {
                let s = first["suggestions"].get(i).filter(|s| allowed_suggestion(s)).ok_or("この「常に許可」は今の承認の提案に無い。もう一度見てから答えて")?;
                Ok((json!({ "behavior": "allow", "updatedPermissions": [s] }), format!("許可して、以後は聞かないようにした（{tool}）")))
            }
        },
    }
}

/// 画面から呼ぶ命令の包み。中身の関数は上にある。待つ命令は blocking で別のスレッドへ出す
pub(crate) mod cmd {
    use super::*;

    #[tauri::command]
    pub async fn answer_permission(session_id: String, choice: String, expect_id: Option<String>, answers: Option<Value>, message: Option<String>, suggestion: Option<usize>, peer: Option<String>) -> Result<String, String> {
        blocking(move || super::answer_permission(session_id, choice, expect_id, answers, message, suggestion, peer)).await
    }
}

#[cfg(test)]
mod tests {
    fn ask() -> serde_json::Value {
        serde_json::json!({ "requestId": "r1", "toolName": "AskUserQuestion", "input": { "questions": [
            { "question": "色は？", "header": "色", "options": [{ "label": "赤" }, { "label": "青" }], "multiSelect": false },
            { "question": "数は？", "header": "数", "options": [{ "label": "1" }, { "label": "2" }], "multiSelect": true }
        ] } })
    }

    #[test]
    fn permission_body_answers_questions() {
        let a = serde_json::json!({ "色は？": "青", "数は？": "1, 2" });
        let (b, done) = super::permission_body(&ask(), "allow", Some("r1"), Some(&a), None, None).unwrap();
        assert_eq!(b["behavior"], "allow");
        assert_eq!(b["updatedInput"]["answers"], a);
        // 元の questions はそのまま返す
        assert_eq!(b["updatedInput"]["questions"], ask()["input"]["questions"]);
        assert_eq!(done, "質問に答えた");
    }

    #[test]
    fn permission_body_refuses_partial_or_stale_answers() {
        let some = serde_json::json!({ "色は？": "青" });
        assert!(super::permission_body(&ask(), "allow", Some("r1"), Some(&some), None, None).unwrap_err().contains("数は？"));
        let blank = serde_json::json!({ "色は？": "青", "数は？": "  " });
        assert!(super::permission_body(&ask(), "allow", Some("r1"), Some(&blank), None, None).is_err());
        assert!(super::permission_body(&ask(), "allow", Some("r1"), None, None, None).is_err());
        let full = serde_json::json!({ "色は？": "青", "数は？": "1" });
        assert!(super::permission_body(&ask(), "allow", Some("old"), Some(&full), None, None).unwrap_err().contains("変わった"));
    }

    #[test]
    fn permission_body_always_allow_uses_the_pending_suggestion() {
        // 2026-11-21 に本番のノードで見た pending の形（mcp__ccn__list_peers）
        let mcp = serde_json::json!({ "requestId": "r4", "toolName": "mcp__ccn__list_peers", "input": {}, "suggestions": [
            { "type": "addRules", "rules": [{ "toolName": "mcp__ccn__list_peers" }], "behavior": "allow", "destination": "localSettings" },
            { "type": "addDirectories", "directories": ["/x"], "destination": "session" }
        ] });
        let (b, done) = super::permission_body(&mcp, "allow", Some("r4"), None, None, Some(0)).unwrap();
        assert_eq!(b["updatedPermissions"], serde_json::json!([mcp["suggestions"][0]]));
        assert!(done.contains("以後は聞かない"));
        // addDirectories と、無い番号は返さない
        assert!(super::permission_body(&mcp, "allow", Some("r4"), None, None, Some(1)).is_err());
        assert!(super::permission_body(&mcp, "allow", Some("r4"), None, None, Some(9)).is_err());
        // 中身が変わっていたら送らない。拒否と計画には付けない
        assert!(super::permission_body(&mcp, "allow", Some("old"), None, None, Some(0)).is_err());
        assert!(super::permission_body(&mcp, "deny", None, None, None, Some(0)).is_err());
        let plan = serde_json::json!({ "requestId": "r2", "toolName": "ExitPlanMode", "input": {}, "suggestions": [{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }] });
        assert!(super::permission_body(&plan, "allow", Some("r2"), None, None, Some(0)).is_err());
    }

    #[test]
    fn permission_body_plan_and_tools() {
        let plan = serde_json::json!({ "requestId": "r2", "toolName": "ExitPlanMode", "input": { "plan": "p" } });
        assert_eq!(super::permission_body(&plan, "allow", Some("r2"), None, None, None).unwrap().0, serde_json::json!({ "behavior": "allow" }));
        let (b, done) = super::permission_body(&plan, "deny", None, None, Some("  "), None).unwrap();
        assert_eq!(b, serde_json::json!({ "behavior": "deny", "message": super::PLAN_DENY_DEFAULT }));
        assert_eq!(done, "計画の見直しを頼んだ");
        assert_eq!(super::permission_body(&plan, "deny", None, None, Some("テストも足して"), None).unwrap().0["message"], "テストも足して");
        let bash = serde_json::json!({ "requestId": "r3", "toolName": "Bash", "input": { "command": "ls" } });
        assert_eq!(super::permission_body(&bash, "allow", Some("r3"), None, None, None).unwrap().0, serde_json::json!({ "behavior": "allow" }));
        assert_eq!(super::permission_body(&bash, "deny", None, None, None, None).unwrap().0["message"], super::DENY_DEFAULT);
        // 質問でない待ちに答えを付けたら送らない
        assert!(super::permission_body(&bash, "allow", Some("r3"), Some(&serde_json::json!({ "x": "y" })), None, None).is_err());
    }

    #[derive(serde::Deserialize)]
    struct SharedCase {
        name: String,
        #[serde(rename = "fn")]
        func: String,
        args: serde_json::Value,
        expect: serde_json::Value,
    }

    /// src/perm-cases.json の事例（bun test も src/webPerm.test.ts で同じものを読む）
    #[test]
    fn shared_cases() {
        use serde_json::json;
        let cases: Vec<SharedCase> = serde_json::from_str(include_str!("../../src/perm-cases.json")).unwrap();
        assert!(cases.len() >= 30);
        for c in cases {
            let a = &c.args;
            let got = match c.func.as_str() {
                "const" => match a[0].as_str().unwrap() {
                    "DENY_DEFAULT" => json!(super::DENY_DEFAULT),
                    "PLAN_DENY_DEFAULT" => json!(super::PLAN_DENY_DEFAULT),
                    n => panic!("{}: 知らない文 {n}", c.name),
                },
                "allowed_suggestion" => json!(super::allowed_suggestion(&a[0])),
                "permission_body" => {
                    let answers = Some(&a["answers"]).filter(|v| !v.is_null());
                    match super::permission_body(&a["first"], a["choice"].as_str().unwrap(), a["expectId"].as_str(), answers, a["message"].as_str(), a["suggestion"].as_u64().map(|i| i as usize)) {
                        Ok((body, done)) => json!({ "body": body, "done": done }),
                        Err(e) => json!({ "error": e }),
                    }
                }
                f => panic!("{}: 知らない関数 {f}", c.name),
            };
            assert_eq!(got, c.expect, "{}", c.name);
        }
    }
}
