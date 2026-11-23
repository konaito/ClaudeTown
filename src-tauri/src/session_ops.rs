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

// ---------- 再起動（カードの「再起動」） ----------

/// 再起動で、前任の claude が消えるのを待つ上限（SIGHUP で2秒、効かなければ SIGKILL）
const RESTART_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// このアプリが立てたセッションを止め、同じ id を `claude --resume` で立て直す。
/// アカウントは resume のときも cam usage の best で選び直す（account.rs）ので、利用上限で止まったアカウントから枠の残るアカウントへ替わる。
/// id と会話の jsonl は変わらないので、親（最初の文の from 行）と名前は継がれる。モデルと権限モードは resume では渡さず、会話の記録のまま。
/// ccn の引き継ぎ（succeed）は使わない。ccn は 2026-11-21 にアプリから外した
pub(crate) fn restart_session(session_id: String) -> Result<Value, String> {
    app_guard(&session_id)?;
    refuse_if_disabled()?;
    let root = native::claude_home();
    // 止める前に、立て直せるかを確かめる（止めてから立て直せないと、会話が閉じたままになる）
    let jsonl = native::sessions::find_jsonl(&root, &session_id).ok_or("会話の記録（jsonl）が無いので再起動できない（1通目の前に止まったセッション）")?;
    let cwd = native::sessions::resume_cwd(&jsonl).ok_or("会話の記録から場所（cwd）が読めなかった")?;
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("場所が無いか、ディレクトリではない: {cwd}"));
    }
    let (cols, rows) = pty::size_of(&session_id).unwrap_or((120, 40));
    pty::kill(&session_id)?;
    let t0 = std::time::Instant::now();
    // このアプリの台帳から消え、claude の sessions/<pid>.json の pid も終わるまで待つ
    while pty::pid_of_id(&session_id).is_some() || native::sessions::live_pid_of(&root, &session_id).is_some() {
        if t0.elapsed() >= RESTART_WAIT {
            town_kick();
            return Err("前任が終わらなかったので、立て直さなかった".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let r = pty::resume(&session_id, &cwd, None, cols, rows, town_kick)?;
    town_kick();
    Ok(r)
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

/// 飛ばす理由のうち、このアプリの中で開いているもの。戻らなかった端末には数えない（#262）
const ALREADY_HERE: &str = "もう Claude Town で開いている";

/// 立て直す前の確かめ。会話の jsonl が無い（1通目の前に止まった）なら resume すると exit 1 で終わるので飛ばす。
/// 同じ id がよそで（本人が手で /resume した、別のアプリが立てたなど）動いていれば、二重に開かないよう飛ばす
pub(crate) fn plan_for(root: &std::path::Path, id: &str, cwd: &str) -> Plan {
    if pty::pid_of_id(id).is_some() {
        Plan::Skip(ALREADY_HERE)
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

/// 立て直しで戻らなかった端末（#262）。画面が知らせに使う。形は画面の src/restore.ts の Lost
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Lost {
    pub id: String,
    pub cwd: String,
    pub name: Option<String>,
    /// 戻らなかった理由（plan_for の Skip の理由か、起動の失敗の文）
    pub reason: String,
    /// 台帳に残し、次の起動でもう一度試すか（起動の失敗のとき true）
    pub retry: bool,
}

/// 立て直しの結果。済むまで None。画面は restore_report で取りに来る（#262）。
/// 起動の直後に送ると、画面が受け始める前に済んで取りこぼすので、送らずに置いておく
static RESTORE_REPORT: Mutex<Option<Vec<Lost>>> = Mutex::new(None);
static RESTORE_DONE: std::sync::Condvar = std::sync::Condvar::new();

/// 立て直しが済んだことにする（結果を置いて、待っている restore_report を起こす）。立て直さないとき（FC_NO_RESTORE）も空で呼ぶ
pub(crate) fn finish_restore(lost: Vec<Lost>) {
    *RESTORE_REPORT.lock().unwrap_or_else(|e| e.into_inner()) = Some(lost);
    RESTORE_DONE.notify_all();
}

/// 立て直しの結果を、済むまで（上限 limit）待って返す。済んでいなければ done が false
pub(crate) fn restore_report(limit: std::time::Duration) -> Value {
    let g = RESTORE_REPORT.lock().unwrap_or_else(|e| e.into_inner());
    let (g, _) = RESTORE_DONE.wait_timeout_while(g, limit, |r| r.is_none()).unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some(lost) => json!({ "done": true, "lost": lost }),
        None => json!({ "done": false, "lost": [] }),
    }
}

/// 起動したときに、前回開いていて終わっていなかった端末を立て直す。台帳は terminals.json（アプリの置き場所）。
/// 結果は1件ずつ stderr と restore.log に書き、戻らなかった端末の一覧を画面が取りに来る場所に置く（#262）。
/// 立てられなかった（起動の失敗）ものは台帳に残し、次の起動でもう一度試す
pub(crate) fn restore_terminals() {
    let path = fc_path(Scope::App, "terminals.json");
    let prev = pty::open_ledger(path.clone());
    let root = native::claude_home();
    let mut log = vec![format!("{} 台帳 {} の {} 件", now_ms(), path.display(), prev.len())];
    // 立てる前にログインシェルの PATH を取っておく（#175。取れなければ、立て直した端末はアプリの PATH で動く）
    if !prev.is_empty() {
        let t0 = std::time::Instant::now();
        let ok = pty::wait_login_path();
        log.push(format!("ログインシェルの PATH {:.1}s → {}", t0.elapsed().as_secs_f32(), if ok { "取れた" } else { "取れなかった" }));
    }
    let (lines, lost) = restore_entries(prev, &root, RESTORE_WAIT, |e| pty::resume(&e.id, &e.cwd, e.name.as_deref(), e.cols, e.rows, town_kick), pty::settle);
    log.extend(lines);
    town_kick();
    finish_restore(lost);
    let lp = fc_path(Scope::App, "restore.log");
    let old = fs::read_to_string(&lp).unwrap_or_default();
    // 長くしない（直近 200 行）
    let mut lines: Vec<&str> = old.lines().collect();
    let joined = log.join("\n");
    lines.extend(joined.lines());
    let keep = lines.len().saturating_sub(200);
    let _ = fs::write(&lp, lines[keep..].join("\n") + "\n");
}

/// 台帳の分を1件ずつ立て直し、restore.log の行と、戻らなかった端末の一覧を返す。
/// 立てる（resume）と台帳から外す（settle）は引数で受ける（試験で本物の claude を起動しないため）
pub(crate) fn restore_entries(
    prev: Vec<pty::Entry>,
    root: &std::path::Path,
    wait: std::time::Duration,
    mut resume: impl FnMut(&pty::Entry) -> Result<Value, String>,
    mut settle: impl FnMut(&str),
) -> (Vec<String>, Vec<Lost>) {
    let mut log = vec![];
    let mut lost = vec![];
    let lose = |e: &pty::Entry, reason: String, retry: bool| Lost { id: e.id.clone(), cwd: e.cwd.clone(), name: e.name.clone(), reason, retry };
    for e in prev {
        // 前のアプリの claude がまだ終わりきっていなければ、消えるまで待つ（上限 wait）。待っても生きていれば、よそで動いているとして外す
        if native::sessions::live_pid_of(root, &e.id).is_some() && pty::pid_of_id(&e.id).is_none() {
            let t0 = std::time::Instant::now();
            let gone = native::sessions::wait_gone(root, &e.id, wait);
            log.push(format!("wait {} {:.1}s → {}", e.id, t0.elapsed().as_secs_f32(), if gone { "消えた" } else { "まだ生きている" }));
        }
        let line = match plan_for(root, &e.id, &e.cwd) {
            Plan::Skip(why) => {
                settle(&e.id);
                if why != ALREADY_HERE {
                    lost.push(lose(&e, why.to_string(), false));
                }
                format!("skip {} {} → {why}", e.id, e.cwd)
            }
            Plan::Resume => match resume(&e) {
                Ok(r) => {
                    settle(&e.id);
                    // ログインシェルの PATH を取れずに立てたら、そう書く（#175。画面には出していない）
                    let fallback = if r["pathFallback"] == true { "（ログインシェルの PATH を取れず、アプリの PATH で起動）" } else { "" };
                    format!("resume {} {} → pid {}{fallback}", e.id, e.cwd, r["pid"])
                }
                Err(err) => {
                    let line = format!("fail {} {} → {err}（台帳に残す）", e.id, e.cwd);
                    lost.push(lose(&e, err, true));
                    line
                }
            },
        };
        eprintln!("[restore] {line}");
        log.push(line);
    }
    (log, lost)
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
    /// 起動のときの立て直しの結果（#262）。済むまで最大60秒待つ。済んでいなければ done が false で、画面はもう一度呼ぶ
    #[tauri::command]
    pub async fn restore_report() -> Result<Value, String> {
        crate::blocking(|| Ok(super::restore_report(std::time::Duration::from_secs(60)))).await
    }
    #[tauri::command]
    pub async fn restart_session(session_id: String) -> Result<Value, String> {
        crate::blocking(move || super::restart_session(session_id)).await
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

    /// このアプリが立てていないセッションは、止める前に断る（外で動いている claude を止めない）
    #[test]
    fn restart_refuses_sessions_the_app_did_not_start() {
        let e = restart_session("55555555-5555-4555-8555-555555555555".into()).unwrap_err();
        assert_eq!(e, native::READ_ONLY);
    }

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

    /// 戻らなかった端末が一覧に入る（#262）。飛ばしたもの（jsonl が無い、よそで動いている）と起動に失敗したものは入り、
    /// 立て直せたものは入らない。起動に失敗したものだけ台帳から外さない（次の起動でもう一度試す）
    #[test]
    fn restore_lists_the_terminals_that_did_not_come_back() {
        let root = std::env::temp_dir().join(format!("fc-restore-lost-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let place = root.join("place");
        fs::create_dir_all(&place).unwrap();
        let cwd = place.to_string_lossy().to_string();
        let proj = root.join("projects").join(native::sessions::project_dir_name(&cwd));
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(root.join("sessions")).unwrap();
        let (ok, no_log, broken, elsewhere) = (
            "55555555-5555-4555-8555-555555555555",
            "66666666-6666-4666-8666-666666666666",
            "77777777-7777-4777-8777-777777777777",
            "88888888-8888-4888-8888-888888888888",
        );
        let line = format!("{{\"type\":\"user\",\"cwd\":{}}}\n", serde_json::to_string(&cwd).unwrap());
        for id in [ok, broken, elsewhere] {
            fs::write(proj.join(format!("{id}.jsonl")), &line).unwrap();
        }
        // この試験のプロセス（生きている）が elsewhere を名乗る
        let me = std::process::id();
        fs::write(root.join(format!("sessions/{me}.json")), format!("{{\"pid\":{me},\"sessionId\":\"{elsewhere}\",\"cwd\":{}}}", serde_json::to_string(&cwd).unwrap())).unwrap();
        let entry = |id: &str, name: Option<&str>| pty::Entry { id: id.into(), cwd: cwd.clone(), name: name.map(String::from), cols: 120, rows: 40, started_at: 0 };
        let prev = vec![entry(ok, Some("戻る")), entry(no_log, None), entry(broken, Some("壊れた")), entry(elsewhere, None)];
        let mut settled = vec![];
        let (log, lost) = restore_entries(
            prev,
            &root,
            std::time::Duration::from_millis(50),
            |e| if e.id == broken { Err("claude を起動できなかった".into()) } else { Ok(json!({ "pid": 1 })) },
            |id| settled.push(id.to_string()),
        );
        assert_eq!(lost, vec![
            Lost { id: no_log.into(), cwd: cwd.clone(), name: None, reason: "会話の記録（jsonl）が無い".into(), retry: false },
            Lost { id: broken.into(), cwd: cwd.clone(), name: Some("壊れた".into()), reason: "claude を起動できなかった".into(), retry: true },
            Lost { id: elsewhere.into(), cwd: cwd.clone(), name: None, reason: "よそで同じ id のセッションが動いている".into(), retry: false },
        ]);
        assert_eq!(settled, vec![ok, no_log, elsewhere]);
        // restore.log の行の形は前と同じ（skip / resume / fail / wait）
        assert!(log.iter().any(|l| l.starts_with(&format!("resume {ok} "))), "{log:?}");
        assert!(log.iter().any(|l| l.starts_with(&format!("fail {broken} ")) && l.ends_with("（台帳に残す）")), "{log:?}");
        assert!(log.iter().any(|l| l.starts_with(&format!("wait {elsewhere} "))), "{log:?}");
        let _ = fs::remove_dir_all(&root);
    }

    /// 画面が取りに来たとき、済むまで待ち、済んだら一覧を返す（#262）
    #[test]
    fn restore_report_waits_until_the_restore_is_done() {
        // 済む前に上限が来たら done が false
        if RESTORE_REPORT.lock().unwrap().is_none() {
            assert_eq!(restore_report(std::time::Duration::from_millis(10))["done"], false);
        }
        let lost = vec![Lost { id: "x".into(), cwd: "/x".into(), name: None, reason: "r".into(), retry: false }];
        let t = std::thread::spawn({ let lost = lost.clone(); move || { std::thread::sleep(std::time::Duration::from_millis(100)); finish_restore(lost); } });
        let r = restore_report(std::time::Duration::from_secs(5));
        t.join().unwrap();
        assert_eq!(r["done"], true);
        assert_eq!(r["lost"], serde_json::to_value(&lost).unwrap());
        assert_eq!(r["lost"][0]["retry"], false, "画面は camelCase で読む");
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

#[cfg(test)]
mod real_restart {
    use super::*;
    use std::time::{Duration, Instant};

    fn config_dir_of(pid: u32) -> String {
        let ps = std::process::Command::new("/bin/ps").args(["eww", "-o", "command=", "-p", &pid.to_string()]).output().unwrap();
        String::from_utf8_lossy(&ps.stdout).split_whitespace().find(|w| w.starts_with("CLAUDE_CONFIG_DIR=")).unwrap_or("CLAUDE_CONFIG_DIR なし").to_string()
    }

    /// 本物の claude（haiku）で、立てる → 1往復 → 再起動 を通し、前後の pid・id・アカウント・会話の記録を出す。
    /// FC_RESTART_CWD に信頼済みの捨てのディレクトリを渡す。1往復分の API を使う。
    /// env -u CLAUDE_CONFIG_DIR FC_CAM_BIN=$HOME/.cam/bin/cam FC_RESTART_CWD=<dir> cargo test --lib real_restart -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_restart_keeps_the_id_and_replaces_the_process() {
        let cwd = std::env::var("FC_RESTART_CWD").expect("FC_RESTART_CWD");
        let start = pty::start_args(Some("haiku"), None).unwrap();
        let r = pty::spawn(&cwd, Some("ct-probe-restart"), &start, 120, 40, || {}).unwrap();
        let (id, pid1) = (r["id"].as_str().unwrap().to_string(), r["pid"].as_u64().unwrap() as u32);
        std::thread::sleep(Duration::from_secs(6));
        pty::write(&id, "ok とだけ返して\r").unwrap();
        let root = native::claude_home();
        let t0 = Instant::now();
        while native::sessions::find_jsonl(&root, &id).is_none() && t0.elapsed() < Duration::from_secs(90) {
            std::thread::sleep(Duration::from_millis(500));
        }
        let jsonl = native::sessions::find_jsonl(&root, &id).expect("1往復の後に jsonl が出来る");
        std::thread::sleep(Duration::from_secs(8));
        let lines_before = std::fs::read_to_string(&jsonl).unwrap().lines().count();
        println!("前: id {id} pid {pid1} {} jsonl {lines_before} 行", config_dir_of(pid1));
        println!("前の画面: {}", pty::screen_text(&id).unwrap_or_default().lines().filter(|l| !l.trim().is_empty()).take(8).collect::<Vec<_>>().join(" / "));
        let t1 = Instant::now();
        let r2 = restart_session(id.clone()).unwrap();
        let pid2 = r2["pid"].as_u64().unwrap() as u32;
        println!("後: id {} pid {pid2} {} 所要 {:.1}s", r2["id"], config_dir_of(pid2), t1.elapsed().as_secs_f32());
        std::thread::sleep(Duration::from_secs(6));
        println!("後の画面: {}", pty::screen_text(&id).unwrap_or_default().lines().filter(|l| !l.trim().is_empty()).take(8).collect::<Vec<_>>().join(" / "));
        let alive1 = unsafe { libc::kill(pid1 as i32, 0) } == 0;
        println!("前任の pid {pid1} 生存: {alive1}、jsonl {} 行", std::fs::read_to_string(&jsonl).unwrap().lines().count());
        pty::kill(&id).unwrap();
        assert_eq!(r2["id"].as_str(), Some(id.as_str()));
        assert_ne!(pid1, pid2);
        assert!(!alive1);
    }
}
