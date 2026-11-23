use super::*;

// ---------- お便りの通知（#292） ----------
//
// 子が承認待ちか返事待ち（src/mail.ts のお便りのうち、報告でないもの）に入ったら、macOS の通知を出して音を鳴らす。
// 判断をここ（Rust）に置くのは、町の一覧の見張り（watch.rs）が、窓が隠れると画面の town_unwatch で止まるため（src/town.ts）。
// 窓が見えている間は、見張りが作った一覧をそのまま受け取る（from_watch）。見張りが動いていない間だけ、このスレッドが一覧を作る。
// 一覧は agents_from(town_rows()) だけで作る。snapshot() のキャラの割り当ての保存とお手紙は要らない。
//
// 出す決まり（step が純関数で持つ。試験は下と src/notify-cases.json）:
// - 子（id）ごとに、「承認待ちか返事待ち」の外から中に入ったときに1回だけ出す。中にいる間に承認待ちと返事待ちが入れ替わっても出さない
//   （tmux のチームメイトは #180 の読み替えが当たらないので、同じ問いが承認待ちから返事待ちに変わる）
// - 待ち始めの時刻（src/mail.ts の since）は鍵にしない。hook の報告が無ければ一覧の最後の動きに落ち、読み直すたびに変わる
// - アプリを起動して最初の一覧で既に待っている子には出さない（お便りの欄に出ている）
// - 起動の後に初めて見た子でも、返事待ちが起動より前から続いている（hook の報告の時刻が起動より前か、無い）なら出さない。
//   アプリを立て直したときに戻ってくる端末（session_ops.rs）が、前の返事待ちを持ったまま一覧に現れるため
// - 一覧から消えた子の記録は、FORGET_AFTER 回続けて見えなかったら捨てる。1回読み損ねて消えた子が戻っても出し直さない
// - 取得の間隔（2〜8秒）より短い間に、待ち → 作業 → 待ち と変わると、作業を見ないので2回目は出ない
//
// 出したかどうかはメモリにだけ持つ。~/.family-computing/ には書かない（安定版も読むファイルの形を変えない）。
//
// 通知は tauri-plugin-notification（macOS では notify-rust → mac-notification-sys の NSUserNotificationCenter）で出す。
// - 音は sound に NSUserNotificationDefaultSoundName を渡すと既定の音になる（mac-notification-sys の objc/notify.m）。渡さなければ鳴らない
// - 押した知らせは on_action に "tap" で来る（2.6.0 から）。show の時点で handler が登録済みのときだけ追跡するので、最初の通知より前に登録する。
//   通知の extra に子のセッション ID を入れておくと、押した知らせの notification().extra() で読み戻せる（プラグインの desktop.rs の wait と performed）。
//   押されたら窓を前に出し、画面へ OPEN_EVENT でセッション ID を送って、その子のチャットを開く（2026-11-23、本人が押して窓だけ開いたため）
// - `bun tauri dev` の実行ファイル（tauri::is_dev()）では、通知は com.apple.Terminal の名義で出る（プラグインの desktop.rs）。
//   2026-11-23 にこの機械の開発版で出すと、usernoted が要求を断った（「Denying message 3 from connection <LegacyConnection identifier:
//   com.apple.Terminal>」）。ターミナルの通知を許可すれば出るかは確かめていない。開発版は FC_NOTIFY=1 のときだけ出す（wanted）
// - アプリが最前面のときは、macOS が通知を出さないはず（mac-notification-sys の delegate に shouldPresentNotification が無い）。確かめていない

/// 一覧から消えた子の記録を捨てるまでの、続けて見えなかった回数
const FORGET_AFTER: u32 = 30;
/// 通知の本文の長さの上限（文字）
const BODY_MAX: usize = 120;
/// 既定の通知の音（NSUserNotificationDefaultSoundName）
const SOUND: &str = "NSUserNotificationDefaultSoundName";
/// 押した通知の子のチャットを開く合図。画面（src/App.tsx）が受けて、その子を選びチャットを開く。中身はセッション ID
pub(crate) const OPEN_EVENT: &str = "notify-open";
/// 通知の extra に入れる、子のセッション ID の鍵
const EXTRA_ID: &str = "sessionId";
/// 見張り（watch.rs）が最後に一覧を渡してから、これより長く経ったら止まったとみなし、このスレッドが一覧を作る
const WATCH_STALE: Duration = Duration::from_secs(12);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Wait {
    Approval,
    Reply,
}

/// 子が人を待っているか。src/model.ts の moodOf の approval と reply と同じ規則（#180 の askClosed を含む）。
/// 事例は src/notify-cases.json にあり、bun test も同じものを moodOf に当てる
pub(crate) fn wait_of(a: &Value) -> Option<Wait> {
    match a["state"].as_str() {
        Some("waiting_permission") => return Some(Wait::Approval),
        Some("running") => return None,
        _ => {}
    }
    let r = &a["report"];
    (r["phase"] == "needs_you" && !ask_closed(a)).then_some(Wait::Reply)
}

/// src/model.ts の askClosed。承認の画面が hook に何も届かないまま閉じられた（並びが1件以上あり、status がその後に変わった）
fn ask_closed(a: &Value) -> bool {
    let r = &a["report"];
    if a["kind"] != "terminal" || !r.is_object() || r["pending_count"].as_f64().unwrap_or(0.0) <= 0.0 {
        return false;
    }
    matches!((a["lastActivityAt"].as_f64(), r["updated_at"].as_f64()), (Some(last), Some(up)) if last > up)
}

/// 出した記録。子の id ごとに、最後に見たとき待っていたかと、続けて見えなかった回数
#[derive(Default)]
pub(crate) struct Seen {
    primed: bool,
    ids: HashMap<String, (bool, u32)>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct Notice {
    pub id: String,
    pub wait: Wait,
    pub title: String,
    pub body: String,
}

/// 一覧を1回見て、出す通知を返す。seen を次の回のために書き換える。started_at はアプリの起動の時刻（ms）
pub(crate) fn step(seen: &mut Seen, agents: &[Value], started_at: u64) -> Vec<Notice> {
    let primed = std::mem::replace(&mut seen.primed, true);
    let mut out = vec![];
    let mut present = HashSet::new();
    for a in agents {
        let Some(id) = a["id"].as_str() else { continue };
        present.insert(id.to_string());
        let wait = wait_of(a);
        let before = seen.ids.insert(id.to_string(), (wait.is_some(), 0)).map(|(w, _)| w);
        let Some(wait) = wait else { continue };
        if !primed || before == Some(true) {
            continue;
        }
        let fresh = a["report"]["updated_at"].as_f64().is_some_and(|t| t >= started_at as f64);
        if before.is_none() && wait == Wait::Reply && !fresh {
            continue;
        }
        out.push(notice(a, id, wait));
    }
    seen.ids.retain(|id, (_, missing)| {
        if present.contains(id) {
            return true;
        }
        *missing += 1;
        *missing < FORGET_AFTER
    });
    out
}

/// 通知の題と本文。題は名前と待っているもの、本文は src/model.ts の taskOf と nowOf と同じ順に報告から選ぶ
fn notice(a: &Value, id: &str, wait: Wait) -> Notice {
    let name = a["name"].as_str().filter(|s| !s.is_empty()).unwrap_or("子");
    let r = &a["report"];
    let pick = |keys: &[&str]| keys.iter().find_map(|k| r[*k].as_str().map(str::trim).filter(|s| !s.is_empty())).map(String::from);
    let (title, body) = match wait {
        Wait::Approval => (format!("{name} が承認を待っています"), pick(&["needs", "doing"])),
        Wait::Reply => (format!("{name} が返事を待っています"), pick(&["next", "needs", "said"])),
    };
    let body = body.unwrap_or_default();
    let body = if body.chars().count() > BODY_MAX { format!("{}…", body.chars().take(BODY_MAX).collect::<String>()) } else { body };
    Notice { id: id.to_string(), wait, title, body }
}

static SEEN: std::sync::LazyLock<Mutex<Seen>> = std::sync::LazyLock::new(|| Mutex::new(Seen::default()));
/// 通知を出すアプリ。setup（start）で入れる。CLI の経路と試験では入らないので、何もしない
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
static STARTED_AT: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
/// 見張りが最後に一覧を渡した時刻
static FROM_WATCH_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// 一覧を見て、入った子の通知を出す。via は一覧の出どころ（記録に残す。watch は見張り、hidden はこのスレッド）
fn observe(agents: &[Value], via: &str) {
    let Some(app) = APP.get() else { return };
    let started_at = STARTED_AT.get().copied().unwrap_or(0);
    let notices = step(&mut SEEN.lock().unwrap_or_else(|e| e.into_inner()), agents, started_at);
    for n in &notices {
        show(app, n, via);
    }
}

/// 見張り（watch.rs の watch_loop）が一覧を作るたびに呼ぶ
pub(crate) fn from_watch(agents: &[Value]) {
    if APP.get().is_none() {
        return;
    }
    *FROM_WATCH_AT.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
    observe(agents, "watch");
}

fn watch_alive() -> bool {
    FROM_WATCH_AT.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed() < WATCH_STALE)
}

/// 見張りが止まっている間（窓が隠れている間）だけ一覧を作る。間隔は見張りと同じく、変化が無ければ2秒から8秒まで延ばす
fn hidden_loop() {
    let mut last: Option<String> = None;
    let mut wait = WATCH_MIN;
    loop {
        if watch_alive() {
            last = None;
            wait = WATCH_MIN;
            std::thread::sleep(WATCH_MIN);
            continue;
        }
        let agents = agents_from(town_rows());
        observe(&agents, "hidden");
        let key = Value::Array(agents).to_string();
        wait = next_wait(wait, last.as_deref() != Some(key.as_str()));
        last = Some(key);
        std::thread::sleep(wait);
    }
}

/// 窓を前に出す（2つ目の起動を断ったときの安定版と同じ）
fn bring_front(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn show(app: &tauri::AppHandle, n: &Notice, via: &str) {
    use tauri_plugin_notification::NotificationExt;
    let mut b = app.notification().builder().title(&n.title).sound(SOUND).extra(EXTRA_ID, &n.id);
    if !n.body.is_empty() {
        b = b.body(&n.body);
    }
    let r = b.show();
    let kind = match n.wait { Wait::Approval => "approval", Wait::Reply => "reply" };
    perf_log(json!({ "notify": kind, "id": n.id, "via": via, "ok": r.is_ok(), "err": r.err().map(|e| e.to_string()), "at": now_ms() as u64 }).to_string());
}

/// 通知を出すか。安定版はいつも出す。開発版は FC_NOTIFY=1 のときだけ出す。
/// 子は開発版を並列に起動し、本物の ~/.claude を読むので、出すと同じ子の通知が開発版の数だけ重なる
fn wanted(app_id: &str, flag: Option<&str>) -> bool {
    app_id == STABLE_ID || flag == Some("1")
}

/// 押した通知の子のセッション ID（extra に入れた値）。押したのが通知そのもの（tap）でなければ None
pub(crate) fn tapped_id(p: &tauri_plugin_notification::ActionPerformed) -> Option<String> {
    if p.action_id() != "tap" {
        return None;
    }
    p.notification()?.extra().get(EXTRA_ID)?.as_str().filter(|s| !s.is_empty()).map(String::from)
}

/// 押された通知で窓を前に出し、その子のチャットを開く合図を画面に送る
fn on_tap(app: &tauri::AppHandle, p: &tauri_plugin_notification::ActionPerformed) {
    use tauri::Emitter;
    bring_front(app);
    let id = tapped_id(p);
    perf_log(json!({ "notifyAction": p.action_id(), "id": id, "at": now_ms() as u64 }).to_string());
    if let Some(id) = id {
        let _ = app.emit(OPEN_EVENT, id);
    }
}

/// アプリの setup で呼ぶ。押した通知で窓を前に出してその子のチャットを開く口を登録し、通知を出す口を入れ、隠れている間の見張りを始める
pub(crate) fn start(app: &tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    if !wanted(&app.config().identifier, std::env::var("FC_NOTIFY").ok().as_deref()) {
        return;
    }
    let _ = STARTED_AT.set(now_ms() as u64);
    let h = app.clone();
    let _ = app.notification().on_action(move |p| on_tap(&h, p));
    if APP.set(app.clone()).is_ok() {
        let _ = std::thread::Builder::new().name("mail-notify".into()).spawn(hidden_loop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// src/notify-cases.json の事例（bun test も src/mail.test.ts で同じものを moodOf に当てる）
    #[test]
    fn wait_matches_shared_cases() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            agent: Value,
            wait: Option<String>,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../src/notify-cases.json")).unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            let got = wait_of(&c.agent).map(|w| match w { Wait::Approval => "approval", Wait::Reply => "reply" });
            assert_eq!(got, c.wait.as_deref(), "{}", c.name);
        }
    }

    const START: u64 = 10_000;
    fn approval(id: &str) -> Value {
        json!({ "id": id, "name": format!("名前{id}"), "kind": "terminal", "state": "waiting_permission", "lastActivityAt": START + 1,
                "report": { "phase": "needs_you", "needs": "Bash を使ってよいか", "updated_at": START + 1 } })
    }
    fn reply(id: &str, at: u64) -> Value {
        json!({ "id": id, "name": format!("名前{id}"), "kind": "terminal", "state": "idle", "lastActivityAt": at,
                "report": { "phase": "needs_you", "next": "どちらにするか", "said": "終わった", "updated_at": at } })
    }
    fn working(id: &str) -> Value {
        json!({ "id": id, "kind": "terminal", "state": "running", "report": { "phase": "working" } })
    }
    fn done(id: &str) -> Value {
        json!({ "id": id, "kind": "terminal", "state": "idle", "report": { "phase": "resting", "updated_at": START + 5 }, "closeCheck": { "status": "ok" } })
    }
    fn ids(v: &[Notice]) -> Vec<(&str, Wait)> {
        v.iter().map(|n| (n.id.as_str(), n.wait)).collect()
    }

    #[test]
    fn first_look_only_primes() {
        let mut s = Seen::default();
        assert!(step(&mut s, &[approval("a"), reply("b", START + 5)], START).is_empty(), "起動して最初の一覧では出さない");
        assert!(step(&mut s, &[approval("a"), reply("b", START + 5)], START).is_empty(), "読み直しでも出さない");
    }

    #[test]
    fn entering_fires_once() {
        let mut s = Seen::default();
        step(&mut s, &[working("a"), working("b")], START);
        let n = step(&mut s, &[approval("a"), reply("b", START + 5)], START);
        assert_eq!(ids(&n), vec![("a", Wait::Approval), ("b", Wait::Reply)]);
        assert_eq!(n[0].title, "名前a が承認を待っています");
        assert_eq!(n[0].body, "Bash を使ってよいか");
        assert_eq!(n[1].body, "どちらにするか");
        // 読み直し。最後の動き（since が落ちる先）が変わっても出さない
        let mut a2 = approval("a");
        a2["lastActivityAt"] = json!(START + 99);
        assert!(step(&mut s, &[a2, reply("b", START + 5)], START).is_empty());
    }

    #[test]
    fn switching_between_approval_and_reply_does_not_fire() {
        let mut s = Seen::default();
        step(&mut s, &[working("a")], START);
        assert_eq!(step(&mut s, &[approval("a")], START).len(), 1);
        assert!(step(&mut s, &[reply("a", START + 7)], START).is_empty(), "待ったまま中身が替わっただけ");
        assert!(step(&mut s, &[approval("a")], START).is_empty());
    }

    #[test]
    fn leaving_rearms() {
        let mut s = Seen::default();
        step(&mut s, &[working("a")], START);
        assert_eq!(step(&mut s, &[approval("a")], START).len(), 1);
        assert!(step(&mut s, &[working("a")], START).is_empty());
        assert_eq!(ids(&step(&mut s, &[reply("a", START + 9)], START)), vec![("a", Wait::Reply)], "作業を挟んで入り直したら出す");
    }

    #[test]
    fn done_never_fires() {
        let mut s = Seen::default();
        step(&mut s, &[working("a")], START);
        assert!(step(&mut s, &[done("a")], START).is_empty());
    }

    #[test]
    fn closed_ask_with_stale_needs_you_does_not_fire() {
        // #180: 承認の画面を閉じた後、needs_you と並びが残ったまま status が idle に変わる
        let mut s = Seen::default();
        step(&mut s, &[working("a")], START);
        let mut a = reply("a", START + 5);
        a["report"]["pending_count"] = json!(1);
        a["lastActivityAt"] = json!(START + 8);
        assert!(step(&mut s, &[a], START).is_empty());
    }

    #[test]
    fn new_kid_after_start() {
        let mut s = Seen::default();
        step(&mut s, &[], START);
        let n = step(&mut s, &[approval("a"), reply("b", START + 5), reply("c", START - 1), {
            let mut d = reply("d", START + 5);
            d["report"]["updated_at"] = Value::Null;
            d
        }], START);
        assert_eq!(ids(&n), vec![("a", Wait::Approval), ("b", Wait::Reply)], "起動より前からの返事待ち（c）と、時刻の無い返事待ち（d）は出さない");
    }

    #[test]
    fn short_disappearance_keeps_the_mark() {
        let mut s = Seen::default();
        step(&mut s, &[working("a")], START);
        assert_eq!(step(&mut s, &[approval("a")], START).len(), 1);
        for _ in 0..3 {
            step(&mut s, &[], START);
        }
        assert!(step(&mut s, &[approval("a")], START).is_empty(), "読み損ねて消えて戻っただけ");
        for _ in 0..FORGET_AFTER {
            step(&mut s, &[], START);
        }
        assert_eq!(step(&mut s, &[approval("a")], START).len(), 1, "長く消えた子は初めて見た子と同じ");
    }

    #[test]
    fn dev_notifies_only_when_asked() {
        assert!(wanted(STABLE_ID, None));
        assert!(!wanted("jp.fybe.family-computing.dev", None));
        assert!(!wanted("jp.fybe.family-computing.dev", Some("0")));
        assert!(wanted("jp.fybe.family-computing.dev", Some("1")));
    }

    #[test]
    fn tap_carries_the_session_id() {
        // プラグインが押した知らせとして渡す形（desktop.rs の performed: actionId と、show のときの通知の中身）
        let performed = |action: &str, extra: Value| -> tauri_plugin_notification::ActionPerformed {
            serde_json::from_value(json!({ "actionId": action, "inputValue": null, "notification": { "id": 1, "title": "t", "extra": extra } })).unwrap()
        };
        assert_eq!(tapped_id(&performed("tap", json!({ EXTRA_ID: "abc" }))).as_deref(), Some("abc"));
        assert_eq!(tapped_id(&performed("tap", json!({}))), None);
        assert_eq!(tapped_id(&performed("snooze", json!({ EXTRA_ID: "abc" }))), None);
    }

    #[test]
    fn long_body_is_cut() {
        let mut s = Seen::default();
        step(&mut s, &[], START);
        let mut a = approval("a");
        a["report"]["needs"] = json!("あ".repeat(500));
        let n = step(&mut s, &[a], START);
        assert_eq!(n[0].body.chars().count(), BODY_MAX + 1);
    }
}
