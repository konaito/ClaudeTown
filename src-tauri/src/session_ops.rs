use super::*;

// ---------- 作る・止める ----------

/// 新しい世帯を立てる。claude をこのアプリの中の端末で起動する（pty.rs）。cwd を省くと ~/Documents/meta（本人の指定）。
/// cols と rows は、画面のターミナルの今の大きさ。渡せば claude を最初からその大きさで起動し、開いた直後の描き直しを省く（#18）
/// model と permission_mode は設定の既定（src/session/defaults.ts）。claude の --model と --permission-mode で起動する（pty::start_args）
pub(crate) fn create_session(cwd: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>, model: Option<String>, permission_mode: Option<String>) -> Result<Value, String> {
    refuse_if_disabled()?;
    let cwd = cwd.filter(|c| !c.is_empty()).unwrap_or_else(default_place);
    let ok = |v: Option<u16>, d: u16| v.filter(|n| (10..=1000).contains(n)).unwrap_or(d);
    let start = pty::start_args(model.as_deref(), permission_mode.as_deref())?;
    let r = pty::spawn(&cwd, name.as_deref(), &start, ok(cols, 120), ok(rows, 40), town_kick)?;
    town_kick();
    Ok(r)
}

/// 場所を設定していないときに新しい世帯を立てる場所（本人の指定）
pub(crate) fn default_place() -> String {
    home().join("Documents/meta").to_string_lossy().to_string()
}

/// 新しい世帯のペイン（#89）の「最近使った場所」の材料。形は画面の src/newHouse/places.ts の PlacesInput。
/// defaultPlace は、画面が設定の場所を持っていないときに、一覧から除く場所（決定 4、2026-11-21）
pub(crate) fn house_places() -> Result<Value, String> {
    let live: Vec<Value> = town_rows().into_iter().filter(|r| r["kind"] == "terminal").map(|r| json!({ "cwd": r["cwd"], "lastActivityAt": r["lastActivityAt"] })).collect();
    Ok(json!({ "roots": [], "lobby": null, "sessions": live, "places": places::recent(&native::claude_home()), "defaultPlace": default_place() }))
}

/// このアプリが立てたセッションを止める
pub(crate) fn stop_session(session_id: String) -> Result<(), String> {
    app_guard(&session_id)?;
    refuse_if_disabled()?;
    pty::kill(&session_id)?;
    town_kick();
    Ok(())
}

// ---------- 立て直す（#152） ----------

/// 前回の台帳の1件をどうするか
#[derive(Debug, PartialEq)]
pub(crate) enum Plan {
    /// resume で立て直す
    Resume,
    /// 戻さない（理由）
    Skip(&'static str),
}

/// 立て直す前の確かめ。会話の jsonl が無い（1通目の前に止まった）なら resume すると exit 1 で終わるので飛ばす。
/// 同じ id がよそで（本人が手で /resume した、別のアプリが立てたなど）動いていれば、二重に開かないよう飛ばす
pub(crate) fn plan_for(root: &std::path::Path, id: &str, cwd: &str) -> Plan {
    if pty::pid_of_id(id).is_some() {
        Plan::Skip("もう Claude Town で開いている")
    } else if native::sessions::live_pid_of(root, id).is_some() {
        Plan::Skip("よそで同じ id のセッションが動いている")
    } else if native::sessions::find_jsonl(root, id).is_none() {
        Plan::Skip("会話の記録（jsonl）が無い")
    } else if !std::path::Path::new(cwd).is_dir() {
        Plan::Skip("場所が無いか、ディレクトリではない")
    } else {
        Plan::Resume
    }
}

/// 起動のときの立て直しで、前のアプリの claude が終わるのを待つ上限
const RESTORE_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

/// 起動したときに、前回開いていて終わっていなかった端末を立て直す。台帳は terminals.json（アプリの置き場所）。
/// 結果は1件ずつ stderr と restore.log に書く。立てられなかった（起動の失敗）ものは台帳に残し、次の起動でもう一度試す
pub(crate) fn restore_terminals() {
    let path = fc_path(Scope::App, "terminals.json");
    let prev = pty::open_ledger(path.clone());
    let root = native::claude_home();
    let mut log = vec![format!("{} 台帳 {} の {} 件", now_ms(), path.display(), prev.len())];
    for e in prev {
        // 前のアプリの claude がまだ終わりきっていなければ、消えるまで待つ（上限 RESTORE_WAIT）。待っても生きていれば、よそで動いているとして外す
        if native::sessions::live_pid_of(&root, &e.id).is_some() && pty::pid_of_id(&e.id).is_none() {
            let t0 = std::time::Instant::now();
            let gone = native::sessions::wait_gone(&root, &e.id, RESTORE_WAIT);
            log.push(format!("wait {} {:.1}s → {}", e.id, t0.elapsed().as_secs_f32(), if gone { "消えた" } else { "まだ生きている" }));
        }
        let line = match plan_for(&root, &e.id, &e.cwd) {
            Plan::Skip(why) => {
                pty::settle(&e.id);
                format!("skip {} {} → {why}", e.id, e.cwd)
            }
            Plan::Resume => match pty::resume(&e.id, &e.cwd, e.name.as_deref(), e.cols, e.rows, town_kick) {
                Ok(r) => {
                    pty::settle(&e.id);
                    format!("resume {} {} → pid {}", e.id, e.cwd, r["pid"])
                }
                Err(err) => format!("fail {} {} → {err}（台帳に残す）", e.id, e.cwd),
            },
        };
        eprintln!("[restore] {line}");
        log.push(line);
    }
    town_kick();
    let lp = fc_path(Scope::App, "restore.log");
    let old = fs::read_to_string(&lp).unwrap_or_default();
    // 長くしない（直近 200 行）
    let mut lines: Vec<&str> = old.lines().collect();
    let joined = log.join("\n");
    lines.extend(joined.lines());
    let keep = lines.len().saturating_sub(200);
    let _ = fs::write(&lp, lines[keep..].join("\n") + "\n");
}

/// 画面から、id を指定して Claude Town で開き直す。cwd は会話の記録（jsonl）の行から取る
pub(crate) fn resume_session(session_id: String, cols: Option<u16>, rows: Option<u16>) -> Result<Value, String> {
    refuse_if_disabled()?;
    let id = session_id.trim().to_string();
    if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(format!("セッションの id の形ではない: {id}"));
    }
    let root = native::claude_home();
    let jsonl = native::sessions::find_jsonl(&root, &id).ok_or("会話の記録（jsonl）が見つからない")?;
    let cwd = native::sessions::resume_cwd(&jsonl).ok_or("会話の記録から場所（cwd）が読めなかった")?;
    if let Plan::Skip(why) = plan_for(&root, &id, &cwd) {
        return Err(format!("開き直せない: {why}"));
    }
    let ok = |v: Option<u16>, d: u16| v.filter(|n| (10..=1000).contains(n)).unwrap_or(d);
    let r = pty::resume(&id, &cwd, None, ok(cols, 120), ok(rows, 40), town_kick)?;
    town_kick();
    Ok(r)
}

/// 画面から呼ぶ命令の包み。中身の関数は上にある。待つ命令は blocking で別のスレッドへ出す
pub(crate) mod cmd {
    use serde_json::Value;

    #[tauri::command]
    pub async fn create_session(cwd: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>, model: Option<String>, permission_mode: Option<String>) -> Result<Value, String> {
        crate::blocking(move || super::create_session(cwd, name, cols, rows, model, permission_mode)).await
    }
    #[tauri::command]
    pub async fn resume_session(session_id: String, cols: Option<u16>, rows: Option<u16>) -> Result<Value, String> {
        crate::blocking(move || super::resume_session(session_id, cols, rows)).await
    }
    #[tauri::command]
    pub async fn house_places() -> Result<Value, String> { crate::blocking(super::house_places).await }
    #[tauri::command]
    pub async fn stop_session(session_id: String) -> Result<(), String> {
        crate::blocking(move || super::stop_session(session_id)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 立て直す前の確かめ（#152）。jsonl が無いもの、よそで同じ id が動いているもの、場所が無いものは飛ばす
    #[test]
    fn restore_skips_what_cannot_be_resumed() {
        let root = std::env::temp_dir().join(format!("fc-restore-plan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let place = root.join("my place");
        fs::create_dir_all(&place).unwrap();
        let cwd = place.to_string_lossy().to_string();
        let proj = root.join("projects").join(native::sessions::project_dir_name(&cwd));
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(root.join("sessions")).unwrap();
        let (with_log, no_log, elsewhere) = ("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333");
        // 途中で cd した行（場所が合わない）が先にあっても、projects の下の名前と合う cwd を取る
        let line = |c: &str| format!("{{\"type\":\"user\",\"cwd\":{}}}\n", serde_json::to_string(c).unwrap());
        fs::write(proj.join(format!("{with_log}.jsonl")), format!("{{\"type\":\"summary\"}}\n{}{}", line("/somewhere/else"), line(&cwd))).unwrap();
        fs::write(proj.join(format!("{elsewhere}.jsonl")), line(&cwd)).unwrap();
        // この試験のプロセス（生きている）が elsewhere を名乗る
        let me = std::process::id();
        fs::write(root.join(format!("sessions/{me}.json")), format!("{{\"pid\":{me},\"sessionId\":\"{elsewhere}\",\"cwd\":{}}}", serde_json::to_string(&cwd).unwrap())).unwrap();
        // 死んだ pid が with_log を名乗っていても、よそで動いているとは見ない
        fs::write(root.join("sessions/999999.json"), format!("{{\"pid\":999999,\"sessionId\":\"{with_log}\",\"cwd\":\"/x\"}}")).unwrap();

        assert_eq!(plan_for(&root, with_log, &cwd), Plan::Resume);
        assert_eq!(plan_for(&root, no_log, &cwd), Plan::Skip("会話の記録（jsonl）が無い"));
        assert_eq!(plan_for(&root, elsewhere, &cwd), Plan::Skip("よそで同じ id のセッションが動いている"));
        assert_eq!(plan_for(&root, with_log, "/no/such/place"), Plan::Skip("場所が無いか、ディレクトリではない"));
        let jsonl = native::sessions::find_jsonl(&root, with_log).unwrap();
        assert_eq!(native::sessions::resume_cwd(&jsonl).as_deref(), Some(cwd.as_str()));
        let _ = fs::remove_dir_all(&root);
    }

    /// 前のアプリの claude が終わりかけている間は待ってから判定する（#152）。終わったら立て直し、上限まで生きていれば外す
    #[test]
    fn restore_waits_for_the_old_claude_to_end() {
        use std::time::{Duration, Instant};
        let root = std::env::temp_dir().join(format!("fc-restore-wait-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("sessions")).unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        // 1秒で終わるプロセスが id を名乗る
        let mut child = std::process::Command::new("sleep").arg("1").spawn().unwrap();
        let pid = child.id();
        fs::write(root.join(format!("sessions/{pid}.json")), format!("{{\"pid\":{pid},\"sessionId\":\"{id}\",\"cwd\":\"/x\"}}")).unwrap();
        let reaper = std::thread::spawn(move || { let _ = child.wait(); });
        assert!(native::sessions::live_pid_of(&root, id).is_some());
        // 上限が短ければ、まだ生きている
        assert!(!native::sessions::wait_gone(&root, id, Duration::from_millis(100)));
        let t0 = Instant::now();
        assert!(native::sessions::wait_gone(&root, id, Duration::from_secs(5)));
        assert!(t0.elapsed() < Duration::from_secs(3));
        reaper.join().unwrap();
        let _ = fs::remove_dir_all(&root);
    }
}
