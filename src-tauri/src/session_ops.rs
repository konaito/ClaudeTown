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
        std::thread::sleep(crate::composer::STUCK_AFTER + Duration::from_millis(300));
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
        let _jam = jam(&id, Duration::from_millis(300));
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
