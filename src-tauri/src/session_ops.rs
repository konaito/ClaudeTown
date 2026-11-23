use super::*;

// ---------- 作る・止める ----------

crate::blocking_command! {
/// 新しい世帯を立てる。claude をこのアプリの中の端末で起動する（pty.rs）。cwd を省くと ~/Documents/meta（本人の指定）。
/// cols と rows は、画面のターミナルの今の大きさ。渡せば claude を最初からその大きさで起動し、開いた直後の描き直しを省く（#18）
/// model、permission_mode、effort は設定の既定（src/session/defaults.ts）。claude の --model、--permission-mode、--effort で起動する（pty::start_args）
pub(crate) fn create_session(cwd: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>, model: Option<String>, permission_mode: Option<String>, effort: Option<String>) -> Result<Value, String> {
    refuse_if_disabled()?;
    let cwd = cwd.filter(|c| !c.is_empty()).unwrap_or_else(default_place);
    let ok = |v: Option<u16>, d: u16| v.filter(|n| (10..=1000).contains(n)).unwrap_or(d);
    let start = pty::start_args(model.as_deref(), permission_mode.as_deref(), effort.as_deref())?;
    let r = pty::spawn(&cwd, name.as_deref(), &start, ok(cols, 120), ok(rows, 40), town_kick)?;
    // 起動に渡した effort は transcript に残らないので、今の値として覚えておく（switch::status）
    if let (Some(id), Some(e)) = (r["id"].as_str(), effort.as_deref().map(str::trim).filter(|e| !e.is_empty())) {
        switch::launched_with(id, e);
    }
    town_kick();
    Ok(r)
}
}

/// 場所を設定していないときに新しい世帯を立てる場所（本人の指定）
pub(crate) fn default_place() -> String {
    home().join("Documents/meta").to_string_lossy().to_string()
}

crate::blocking_command! {
/// 新しい世帯のペイン（#89）の「最近使った場所」の材料。形は画面の src/newHouse/places.ts の PlacesInput。
/// defaultPlace は、画面が設定の場所を持っていないときに、一覧から除く場所（決定 4、2026-11-21）
pub(crate) fn house_places() -> Result<Value, String> {
    let live: Vec<Value> = town_rows().into_iter().filter(|r| r["kind"] == "terminal").map(|r| json!({ "cwd": r["cwd"], "lastActivityAt": r["lastActivityAt"] })).collect();
    Ok(json!({ "roots": [], "lobby": null, "sessions": live, "places": places::recent(&native::claude_home()), "defaultPlace": default_place() }))
}
}

crate::blocking_command! {
/// このアプリが立てたセッションを止める
pub(crate) fn stop_session(session_id: String) -> Result<(), String> {
    app_guard(&session_id)?;
    refuse_if_disabled()?;
    pty::kill(&session_id)?;
    town_kick();
    Ok(())
}
}

// ---------- 再起動（カードの「再起動」） ----------

/// 再起動で、前任の claude が消えるのを待つ上限（SIGHUP で2秒、効かなければ SIGKILL）
const RESTART_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

crate::blocking_command! {
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

crate::blocking_command! {
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
}

/// 画面から呼ぶ命令。中身の関数の定義から crate::blocking_command! が作ったものを並べる
pub(crate) mod cmd {
    use serde_json::Value;

    pub use super::create_session::*;
    pub use super::resume_session::*;
    pub use super::restart_session::*;
    pub use super::house_places::*;
    pub use super::stop_session::*;

    /// 起動のときの立て直しの結果（#262）。済むまで最大60秒待つ。済んでいなければ done が false で、画面はもう一度呼ぶ。
    /// 中身の restore_report は待つ上限を引数で受け、Value を返す（命令は引数なしで Result を返す）。署名が違うので
    /// crate::blocking_command! では包めず、手で書いたまま残す（#288 の「型違い」）
    #[tauri::command]
    pub async fn restore_report() -> Result<Value, String> {
        crate::blocking(|| Ok(super::restore_report(std::time::Duration::from_secs(60)))).await
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
        let start = pty::start_args(Some("haiku"), None, None).unwrap();
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

/// 書き込みが詰まった端末（#240 の 2）。代役の claude は raw にしてから入力を読まずに寝る。
/// 本物の claude も raw で動くので、読まない間に PTY の入力の欄が埋まると、書き込みが戻らなくなる
#[cfg(test)]
mod stuck {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// 入力を読まない代役。raw にしてから寝る
    const UNREAD: &str = "exec sleep 30";

    /// 代役を立てる準備。代役は起動のたびに「pid 引数」を log に足し、raw にして ready を書いてから last を実行する。
    /// 返す錠は FC_CLAUDE_BIN と町の一覧の試験を分けるもので、立て直しが済むまで持つ（取る順は pty.rs の試験と同じ）
    fn stand_in(tag: &str, last: &str) -> (PathBuf, [std::sync::MutexGuard<'static, ()>; 2]) {
        use std::os::unix::fs::PermissionsExt;
        let native = crate::NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let bin_lock = pty::BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("fc-stuck-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("place")).unwrap();
        let d = dir.display();
        let script = format!("#!/bin/sh\necho \"$$ $*\" >> '{d}/log'\nstty raw -echo\n: > '{d}/ready'\n{}\n", last.replace("__DIR__", &d.to_string()));
        fs::write(dir.join("claude"), script).unwrap();
        fs::set_permissions(dir.join("claude"), fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var("FC_CLAUDE_BIN", dir.join("claude")) };
        (dir, [native, bin_lock])
    }

    fn start(dir: &std::path::Path) -> (String, u32) {
        let r = pty::spawn(dir.join("place").to_str().unwrap(), None, &[], 80, 24, || {}).unwrap();
        wait_for("代役が raw にならない", Duration::from_secs(5), || dir.join("ready").exists());
        (r["id"].as_str().unwrap().to_string(), r["pid"].as_u64().unwrap() as u32)
    }

    fn finish(id: &str) {
        let _ = pty::kill(id);
        wait_for("代役が止まらない", Duration::from_secs(5), || !pty::owns(id));
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
    }

    fn wait_for(what: &str, limit: Duration, mut f: impl FnMut() -> bool) {
        let t0 = Instant::now();
        while !f() {
            assert!(t0.elapsed() < limit, "{what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// 入力の欄を埋める書き込み（1MB）を別のスレッドで投げ、wait たっても戻っていないのを確かめる。戻り値は、その書き込みの結果の受け口
    fn jam(id: &str, wait: Duration) -> mpsc::Receiver<Result<(), String>> {
        let (tx, rx) = mpsc::channel();
        let id2 = id.to_string();
        std::thread::spawn(move || { let _ = tx.send(pty::write(&id2, &"x".repeat(1 << 20))); });
        std::thread::sleep(wait);
        assert!(rx.try_recv().is_err(), "書き込みが戻った（詰まっていない）");
        rx
    }

    /// interrupt_session を別のスレッドで呼び、limit まで待つ
    fn interrupt_within(id: &str, limit: Duration) -> (Result<Result<Value, String>, mpsc::RecvTimeoutError>, Duration) {
        let (tx, rx) = mpsc::channel();
        let id2 = id.to_string();
        let t0 = Instant::now();
        std::thread::spawn(move || { let _ = tx.send(crate::composer::interrupt_session(id2)); });
        let got = rx.recv_timeout(limit);
        (got, t0.elapsed())
    }

    /// 詰まりが STUCK_AFTER を超えた端末で interrupt_session を呼ぶと、Esc を並べずに1秒以内に { stuck: true } で戻る
    #[test]
    fn interrupt_returns_on_a_stuck_terminal() {
        let (dir, _locks) = stand_in("int", UNREAD);
        let (id, _) = start(&dir);
        let _jam = jam(&id, crate::composer::STUCK_AFTER + Duration::from_millis(300));
        let (got, took) = interrupt_within(&id, Duration::from_secs(1));
        finish(&id);
        let v = got.unwrap_or_else(|_| panic!("詰まった端末で interrupt_session が1秒で戻らなかった（{took:?}）")).unwrap();
        assert_eq!(v["stuck"], true, "{v}");
        assert!(v["stuckMs"].as_u64().unwrap() >= crate::composer::STUCK_AFTER.as_millis() as u64, "{v}");
    }

    /// ターミナルの欄の打鍵（term_input）で詰まった端末でも同じ。#231（PR #239）で打鍵は端末ごとの列から書き手のスレッドが書くようになるが、
    /// 書き手は同じ書き口を通るので、詰まりは同じように測れる。term_input がすぐ戻る版でも待つ版でも通るよう、別のスレッドで呼ぶ
    #[test]
    fn interrupt_sees_a_jam_from_terminal_keys() {
        let (dir, _locks) = stand_in("keys", UNREAD);
        let (id, _) = start(&dir);
        let id2 = id.clone();
        std::thread::spawn(move || { let _ = crate::terminal::term_input(id2, "x".repeat(1 << 20)); });
        let t0 = Instant::now();
        while pty::stalled_for(&id).is_none_or(|d| d < crate::composer::STUCK_AFTER) && t0.elapsed() < crate::composer::STUCK_AFTER * 3 {
            std::thread::sleep(Duration::from_millis(20));
        }
        let stalled = pty::stalled_for(&id);
        let (got, took) = interrupt_within(&id, Duration::from_secs(1));
        finish(&id);
        assert!(stalled.is_some_and(|d| d >= crate::composer::STUCK_AFTER), "打鍵の書き込みが詰まっていない: {stalled:?}");
        let v = got.unwrap_or_else(|_| panic!("interrupt_session が1秒で戻らなかった（{took:?}）")).unwrap();
        assert_eq!(v["stuck"], true, "{v}");
    }

    /// 詰まり始めたばかりの端末では、STUCK_AFTER まで待ってから { stuck: true } で戻る（並んだまま待ち続けない）
    #[test]
    fn interrupt_waits_until_the_jam_counts_as_stuck() {
        let (dir, _locks) = stand_in("young", UNREAD);
        let (id, _) = start(&dir);
        let _jam = jam(&id, Duration::from_secs(1));
        let (got, took) = interrupt_within(&id, crate::composer::STUCK_AFTER + Duration::from_secs(1));
        finish(&id);
        let v = got.unwrap_or_else(|_| panic!("interrupt_session が戻らなかった（{took:?}）")).unwrap();
        assert_eq!(v["stuck"], true, "{v}");
        assert!(took < crate::composer::STUCK_AFTER, "詰まりが始まってから STUCK_AFTER より長く待った: {took:?}");
    }

    /// 入力を読む端末では、今までどおり Esc を書いて { stuck: false } で戻る
    #[test]
    fn interrupt_writes_esc_when_the_terminal_reads() {
        let (dir, _locks) = stand_in("reads", "exec cat > '__DIR__/got'");
        let (id, _) = start(&dir);
        let (got, took) = interrupt_within(&id, Duration::from_secs(1));
        let got_esc = || fs::read(dir.join("got")).unwrap_or_default() == b"\x1b";
        let t0 = Instant::now();
        while !got_esc() && t0.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let esc = got_esc();
        finish(&id);
        let v = got.unwrap_or_else(|_| panic!("interrupt_session が1秒で戻らなかった（{took:?}）")).unwrap();
        assert_eq!(v["stuck"], false, "{v}");
        assert!(esc, "Esc が届かなかった");
    }

    /// 確かめの画面で「はい」を押したときの道。詰まった端末で restart_session を呼ぶと、代役が止まり、同じ id の代役が --resume で立つ。
    /// restart_session は会話の jsonl から cwd を読むので、試験用の claude の置き場所（TEST_HOME、このスレッドだけに効く）に置く
    #[test]
    fn restart_replaces_a_stuck_terminal_with_the_same_id() {
        let (dir, _locks) = stand_in("restart", UNREAD);
        let (id, pid1) = start(&dir);
        let place = dir.join("place").to_string_lossy().to_string();
        let home = dir.join("home");
        let proj = home.join("projects").join(native::sessions::project_dir_name(&place));
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join(format!("{id}.jsonl")), format!("{{\"type\":\"user\",\"cwd\":{}}}\n", serde_json::to_string(&place).unwrap())).unwrap();
        native::TEST_HOME.with(|h| *h.borrow_mut() = Some(home.clone()));
        let jammed = jam(&id, crate::composer::STUCK_AFTER + Duration::from_millis(300));
        let (got, _) = interrupt_within(&id, Duration::from_secs(1));
        assert_eq!(got.expect("interrupt_session が戻らなかった").unwrap()["stuck"], true);
        let t0 = Instant::now();
        let r = restart_session(id.clone());
        let took = t0.elapsed();
        // 前任が止まった後、詰まっていた書き込みが戻るか（戻らなければ、そのスレッドは残る）
        let old_write = jammed.recv_timeout(Duration::from_secs(3));
        let pid2 = r.as_ref().ok().and_then(|v| v["pid"].as_u64()).map(|p| p as u32);
        if pid2.is_some() {
            wait_for("立て直した代役が raw にならない", Duration::from_secs(5), || fs::read_to_string(dir.join("log")).unwrap_or_default().lines().count() >= 2);
        }
        let log = fs::read_to_string(dir.join("log")).unwrap_or_default();
        let stalled_after = pty::stalled_for(&id);
        let old_alive = unsafe { libc::kill(pid1 as i32, 0) } == 0;
        native::TEST_HOME.with(|h| *h.borrow_mut() = None);
        finish(&id);
        eprintln!("立て直しにかかった時間 {took:?}、詰まっていた書き込み {old_write:?}");
        let r = r.unwrap();
        let pid2 = pid2.unwrap();
        assert_eq!(r["id"].as_str(), Some(id.as_str()));
        assert_ne!(pid1, pid2);
        assert!(!old_alive, "前任の代役 {pid1} がまだ生きている");
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines, vec![format!("{pid1} --session-id {id}"), format!("{pid2} --resume {id}")], "{log}");
        assert_eq!(stalled_after, None, "立て直した端末に前の詰まりが残っている");
        // 前任が終わると、詰まっていた書き込みは EIO で戻る（書き手のスレッドは残らない）
        assert!(matches!(old_write, Ok(Err(_))), "詰まっていた書き込みが戻らなかった: {old_write:?}");
    }
}

#[cfg(test)]
mod real_effort {
    use super::*;
    use std::time::{Duration, Instant};

    fn wait_for(sec: u64, f: impl Fn() -> bool) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(sec) {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        false
    }

    /// 本物の claude（haiku）を --effort high で立て、送信先の行と同じ口（switch::request）で effort を替える。
    /// 1往復した後（会話があると `/effort <値>` は既定を書き換える）と作業中に替えて、今の値が替わり、settings.json が変わらないことを確かめる。
    /// FC_EFFORT_CWD に信頼済みの捨てのディレクトリを渡す。2往復分の API を使う。
    /// env -u CLAUDE_CONFIG_DIR FC_CAM_BIN=$HOME/.cam/bin/cam FC_EFFORT_CWD=<dir> cargo test --lib real_effort -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_effort_switches_for_this_session_only() {
        let cwd = std::env::var("FC_EFFORT_CWD").expect("FC_EFFORT_CWD");
        let settings = home().join(".claude/settings.json");
        let before = std::fs::read_to_string(&settings).unwrap();
        assert!(!before.trim().is_empty(), "settings.json が空で読めた。戻せないので試さない");
        let effort_of = |id: &str| switch::status(id)["effort"].as_str().map(str::to_string);
        let start = pty::start_args(Some("haiku"), None, Some("high")).unwrap();
        let r = pty::spawn(&cwd, Some("ct-probe-effort"), &start, 120, 40, || {}).unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        switch::launched_with(&id, "high");
        let done = |id: &str, v: &str| {
            let s = switch::status(id);
            s["pending"]["effort"].is_null() && s["last"]["what"] == "effort" && s["last"]["value"] == v
        };
        let result = (|| -> Result<(), String> {
            std::thread::sleep(Duration::from_secs(6));
            println!("起動の後: {:?}", effort_of(&id));
            if effort_of(&id).as_deref() != Some("high") { return Err("起動に渡した high が今の値に出ない".into()); }
            pty::write(&id, "ok とだけ返して\r")?;
            let root = native::claude_home();
            if !wait_for(90, || native::sessions::find_jsonl(&root, &id).is_some()) { return Err("jsonl が出来ない".into()); }
            std::thread::sleep(Duration::from_secs(8));
            // 待機中に替える
            switch::request(&id, None, None, Some("low".into()))?;
            if !wait_for(20, || done(&id, "low")) { return Err(format!("low に替わらない: {}", switch::status(&id))); }
            println!("待機中に low: last {} / 今 {:?}", switch::status(&id)["last"], effort_of(&id));
            if switch::status(&id)["last"]["ok"] != true { return Err(format!("失敗: {}", switch::status(&id)["last"])); }
            if effort_of(&id).as_deref() != Some("low") { return Err("今の値が low にならない".into()); }
            // 作業中に替える
            pty::write(&id, "\x1b[200~Bash で sleep 8 を実行してから done とだけ返して\x1b[201~")?;
            std::thread::sleep(Duration::from_millis(200));
            pty::write(&id, "\r")?;
            std::thread::sleep(Duration::from_secs(4));
            println!("作業中に max を頼む時の状態: {}", switch::status(&id)["status"]);
            switch::request(&id, None, None, Some("max".into()))?;
            if !wait_for(40, || done(&id, "max")) { return Err(format!("max に替わらない: {}", switch::status(&id))); }
            println!("作業中に max: last {} / 今 {:?}", switch::status(&id)["last"], effort_of(&id));
            if switch::status(&id)["last"]["ok"] != true { return Err(format!("失敗: {}", switch::status(&id)["last"])); }
            if effort_of(&id).as_deref() != Some("max") { return Err("今の値が max にならない".into()); }
            // モデルを替えた後の effort（settings.json は effortLevel をモデルごとに持つので、替わるかもしれない）。
            // 作業が終わってから替え、/effort のピッカーが開いたときの段と、今の値を比べる
            if !wait_for(60, || switch::status(&id)["status"] == "idle") { return Err("作業が終わらない".into()); }
            switch::request(&id, Some("sonnet".into()), None, None)?;
            if !wait_for(30, || { let s = switch::status(&id); s["pending"]["model"].is_null() && s["last"]["what"] == "model" }) { return Err(format!("モデルが替わらない: {}", switch::status(&id))); }
            println!("モデルを替えた: last {}", switch::status(&id)["last"]);
            std::thread::sleep(Duration::from_secs(1));
            let shown = effort_of(&id);
            let opened = pty::serial(&id, || {
                pty::write(&id, "\x1b[200~/effort\x1b[201~")?;
                std::thread::sleep(Duration::from_millis(150));
                pty::write(&id, "\r")?;
                let t0 = Instant::now();
                let mut cur = None;
                while t0.elapsed() < Duration::from_secs(4) && cur.is_none() {
                    cur = pty::screen_text(&id).as_deref().filter(|s| s.contains(switch::EFFORT_PICKER)).and_then(switch::effort_cursor);
                    std::thread::sleep(Duration::from_millis(100));
                }
                if cur.is_none() {
                    println!("読めなかった画面:\n{}", pty::screen_text(&id).unwrap_or_default());
                }
                pty::write(&id, "\x1b")?;
                std::thread::sleep(Duration::from_millis(800));
                Ok::<_, String>(cur)
            })?;
            println!("モデルを替えた後: 今の値 {shown:?} / ピッカーの段 {opened:?}");
            if opened.is_none() { return Err("ピッカーの段が読めない".into()); }
            if shown.as_deref() != opened { return Err(format!("モデルを替えた後の今の値 {shown:?} がピッカーの段 {opened:?} と違う")); }
            // モデルを替えた後はピッカーの案内が「Enter to use this session only」の形になる。その形でも替えられて、既定は変わらない
            switch::request(&id, None, None, Some("medium".into()))?;
            if !wait_for(20, || done(&id, "medium")) { return Err(format!("medium に替わらない: {}", switch::status(&id))); }
            println!("モデルを替えた後に medium: last {} / 今 {:?}", switch::status(&id)["last"], effort_of(&id));
            if switch::status(&id)["last"]["ok"] != true { return Err(format!("失敗: {}", switch::status(&id)["last"])); }
            if effort_of(&id).as_deref() != Some("medium") { return Err("今の値が medium にならない".into()); }
            Ok(())
        })();
        println!("画面: {}", pty::screen_text(&id).unwrap_or_default().lines().filter(|l| !l.trim().is_empty()).rev().take(10).collect::<Vec<_>>().join(" / "));
        let _ = pty::kill(&id);
        let after = std::fs::read_to_string(&settings).unwrap();
        if before != after {
            // 書き換えられていたら元に戻してから落とす
            std::fs::write(&settings, &before).unwrap();
            panic!("settings.json が書き換えられた（元に戻した）");
        }
        println!("settings.json は変わらなかった");
        result.unwrap();
    }
}
