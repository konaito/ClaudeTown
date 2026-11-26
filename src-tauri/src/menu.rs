// macOS のメニューバー（#300）。Tauri の既定のメニュー（英語の File、Edit、View、Window、Help）の代わりに、日本語のメニューを組む。
//
// - 並びは Ghostty（MIT）の macos/Sources/App/MainMenu.xib に倣い、アプリ名、ファイル、編集、表示、ウインドウ、ヘルプの6つにする。
//   文言は macOS の日本語訳（AppKit、テキストエディット、ターミナルの loctable）に合わせる
// - 木は tree() が純関数で作り、build() が tauri::menu（中身は muda）の部品に写す。id、文言、キー、並びは下の試験で固める
// - 編集、ウインドウ、アプリ名のメニューの標準の項目は PredefinedMenuItem にする。押したときの selector（copy:、paste:、undo: など）は
//   既定のメニューと同じなので、入力欄とターミナルの ⌘C、⌘V、⌘Z、⌘A は前と同じ経路で動く（muda の platform_impl/macos の selector()）
// - 自前の項目を押すと、id を EVENT で画面に送る。画面（src/menu.ts、src/App.tsx）が受けて既存の操作を呼ぶ。
//   リポジトリを開く項目だけは、画面を通さずここで既定のブラウザに渡す
// - 押せる・押せないと文言の切り替え（選んでいるセッション、ターミナルの有無、左のペイン、更新）は、画面が menu_state で渡す。
//   状態が来るまでは、選んでいるセッションに関わる項目を押せなくしておく
// - キーは tauri の MenuItem が muda の物理キー（Code）として読む。読めない文字列は黙って捨てられる（tauri の menu/normal.rs の parse().ok()）ので、
//   試験で全部のキーが読めることを確かめる。「+」は物理キーに無いので、拡大は「=」の位置のキーで書く

use std::collections::HashMap;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 自前の項目を押したときに画面へ送る出来事の名前。中身は項目の id
pub(crate) const EVENT: &str = "menu";
/// Claude Town のリポジトリ
const REPO_URL: &str = "https://github.com/konaito/ClaudeTown";

// 自前の項目の id。画面（src/menu.ts の MENU_IDS）と同じ文字列にする
pub(crate) const UPDATE: &str = "update";
pub(crate) const SETTINGS: &str = "settings";
pub(crate) const NEW_HOUSE: &str = "new-house";
pub(crate) const RESUME: &str = "resume";
pub(crate) const OPEN_CHAT: &str = "open-chat";
pub(crate) const OPEN_TERM: &str = "open-term";
pub(crate) const SIDEBAR: &str = "sidebar";
pub(crate) const ZOOM_IN: &str = "zoom-in";
pub(crate) const ZOOM_OUT: &str = "zoom-out";
pub(crate) const ZOOM_FIT: &str = "zoom-fit";
pub(crate) const TAB_CHAT: &str = "tab-chat";
pub(crate) const TAB_STATE: &str = "tab-state";
pub(crate) const TAB_TERM: &str = "tab-term";
pub(crate) const HELP_KEYS: &str = "help-keys";
pub(crate) const CREDITS: &str = "credits";
pub(crate) const REPO: &str = "repo";

/// 更新の項目の文言
const UPDATE_CHECK: &str = "アップデートを確認…";
const UPDATE_FOUND: &str = "アップデートがあります…";
/// 左のペイン（新しい世帯のペイン、#89）の開け閉めの文言
const SIDEBAR_HIDE: &str = "サイドバーを非表示";
const SIDEBAR_SHOW: &str = "サイドバーを表示";

/// 標準の項目（PredefinedMenuItem）の種類
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Std {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
    BringAllToFront,
}

/// メニューの木の1つ
#[derive(Debug, PartialEq)]
pub(crate) enum Node {
    Sub { id: &'static str, text: String, items: Vec<Node> },
    /// 自前の項目。key は tauri の accelerator の書き方（CmdOrCtrl+N など）。on は最初に押せるか
    Item { id: &'static str, text: String, key: Option<&'static str>, on: bool },
    Std { kind: Std, text: String },
    Sep,
}

fn item(id: &'static str, text: &str, key: Option<&'static str>, on: bool) -> Node {
    Node::Item { id, text: text.into(), key, on }
}
fn std(kind: Std, text: &str) -> Node {
    Node::Std { kind, text: text.into() }
}
fn sub(id: &'static str, text: &str, items: Vec<Node>) -> Node {
    Node::Sub { id, text: text.into(), items }
}

/// 町の拡大、縮小、全体を表示のキー。⌘+、⌘-、⌘0 は画面全体の拡大縮小（tauri.conf.json の zoomHotkeysEnabled、WCAG 1.4.4）が
/// 使っているので、町の項目にはキーを付けない（issue #300 の案では ⌘+、⌘-、⌘0。両方が同時に走るのを避けた。本人の判断で替えるときはここだけ直す）
const ZOOM_KEYS: [Option<&str>; 3] = [None, None, None];

/// メニューの木。name はアプリ名（productName）。最初の状態（セッションを選んでいない、左のペインが開いている、更新は分からない）で作る
pub(crate) fn tree(name: &str) -> Vec<Node> {
    vec![
        sub("app", name, vec![
            std(Std::About, &format!("{name}について")),
            item(UPDATE, UPDATE_CHECK, None, false),
            Node::Sep,
            item(SETTINGS, "設定…", Some("CmdOrCtrl+,"), true),
            Node::Sep,
            std(Std::Services, "サービス"),
            Node::Sep,
            std(Std::Hide, &format!("{name}を非表示")),
            std(Std::HideOthers, "ほかを非表示"),
            std(Std::ShowAll, "すべてを表示"),
            Node::Sep,
            std(Std::Quit, &format!("{name}を終了")),
        ]),
        sub("file", "ファイル", vec![
            item(NEW_HOUSE, "新しい世帯", Some("CmdOrCtrl+N"), true),
            item(RESUME, "セッション id で開き直す…", Some("CmdOrCtrl+Shift+O"), true),
            Node::Sep,
            item(OPEN_CHAT, "チャットを開く", None, false),
            item(OPEN_TERM, "ターミナルを開く", None, false),
            Node::Sep,
            std(Std::CloseWindow, "ウインドウを閉じる"),
        ]),
        sub("edit", "編集", vec![
            std(Std::Undo, "取り消す"),
            std(Std::Redo, "やり直す"),
            Node::Sep,
            std(Std::Cut, "カット"),
            std(Std::Copy, "コピー"),
            std(Std::Paste, "ペースト"),
            std(Std::SelectAll, "すべてを選択"),
        ]),
        sub("view", "表示", vec![
            item(SIDEBAR, SIDEBAR_HIDE, Some("CmdOrCtrl+Ctrl+S"), true),
            Node::Sep,
            item(ZOOM_IN, "拡大", ZOOM_KEYS[0], true),
            item(ZOOM_OUT, "縮小", ZOOM_KEYS[1], true),
            item(ZOOM_FIT, "全体を表示", ZOOM_KEYS[2], true),
            Node::Sep,
            item(TAB_CHAT, "チャット", Some("CmdOrCtrl+1"), false),
            item(TAB_STATE, "状態", Some("CmdOrCtrl+2"), false),
            item(TAB_TERM, "ターミナル", Some("CmdOrCtrl+3"), false),
            Node::Sep,
            std(Std::Fullscreen, "フルスクリーンにする"),
        ]),
        sub(WINDOW_SUBMENU_ID, "ウインドウ", vec![
            std(Std::Minimize, "しまう"),
            std(Std::Maximize, "拡大/縮小"),
            Node::Sep,
            std(Std::BringAllToFront, "すべてを手前に移動"),
        ]),
        sub(HELP_SUBMENU_ID, "ヘルプ", vec![
            item(HELP_KEYS, "キーボードショートカット", None, false),
            item(CREDITS, "素材のクレジット", None, true),
            Node::Sep,
            item(REPO, &format!("{} のリポジトリ", base_name(name)), None, true),
        ]),
    ]
}

/// 開発版の productName（Claude Town Dev）からも、リポジトリの名前は Claude Town で出す
fn base_name(name: &str) -> &str {
    name.strip_suffix(" Dev").unwrap_or(name)
}

/// 画面が渡す状態（src/menu.ts の MenuState と同じ形）
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MenuState {
    /// セッションを選んでいる
    pub selected: bool,
    /// 選んでいるセッションにこのアプリの端末がある（右パネルにターミナルのタブが出る）
    pub terminal: bool,
    /// 左のペイン（新しい世帯）が開いている
    pub sidebar: bool,
    /// 安定版の更新。null は更新の欄が無い版（開発版、まだ読めていない）。true は更新がある
    pub update: Option<bool>,
}

/// 状態で変わる項目の、押せるかと文言。文言を変えない項目は None
pub(crate) fn changes(s: &MenuState) -> Vec<(&'static str, bool, Option<&'static str>)> {
    let term = s.selected && s.terminal;
    vec![
        (UPDATE, s.update.is_some(), Some(if s.update == Some(true) { UPDATE_FOUND } else { UPDATE_CHECK })),
        (OPEN_CHAT, s.selected, None),
        (OPEN_TERM, term, None),
        (SIDEBAR, true, Some(if s.sidebar { SIDEBAR_HIDE } else { SIDEBAR_SHOW })),
        (TAB_CHAT, s.selected, None),
        (TAB_STATE, s.selected, None),
        (TAB_TERM, term, None),
        (HELP_KEYS, s.selected, None),
    ]
}

/// 状態で変える項目の部品。build で作って app に持たせる（Menu::get は最上位しか探さないため）
struct Items<R: Runtime>(HashMap<&'static str, MenuItem<R>>);

/// 木を tauri の部品に写し、状態で変える項目を app に持たせる。Builder::menu から呼ぶ
pub(crate) fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    let mut items = HashMap::new();
    let menu = Menu::new(app)?;
    for node in tree(&info.name) {
        if let Node::Sub { id, text, items: children } = node {
            let s = Submenu::with_id(app, id, text, true)?;
            for c in children {
                append(app, &s, c, &about, &mut items)?;
            }
            menu.append(&s)?;
        }
    }
    app.manage(Items(items));
    Ok(menu)
}

fn append<R: Runtime>(
    app: &AppHandle<R>,
    s: &Submenu<R>,
    node: Node,
    about: &AboutMetadata,
    items: &mut HashMap<&'static str, MenuItem<R>>,
) -> tauri::Result<()> {
    match node {
        Node::Sep => s.append(&PredefinedMenuItem::separator(app)?),
        Node::Item { id, text, key, on } => {
            let it = MenuItem::with_id(app, id, text, on, key)?;
            s.append(&it)?;
            items.insert(id, it);
            Ok(())
        }
        Node::Std { kind, text } => {
            let t = Some(text.as_str());
            let p = match kind {
                Std::About => PredefinedMenuItem::about(app, t, Some(about.clone()))?,
                Std::Services => PredefinedMenuItem::services(app, t)?,
                Std::Hide => PredefinedMenuItem::hide(app, t)?,
                Std::HideOthers => PredefinedMenuItem::hide_others(app, t)?,
                Std::ShowAll => PredefinedMenuItem::show_all(app, t)?,
                Std::Quit => PredefinedMenuItem::quit(app, t)?,
                Std::CloseWindow => PredefinedMenuItem::close_window(app, t)?,
                Std::Undo => PredefinedMenuItem::undo(app, t)?,
                Std::Redo => PredefinedMenuItem::redo(app, t)?,
                Std::Cut => PredefinedMenuItem::cut(app, t)?,
                Std::Copy => PredefinedMenuItem::copy(app, t)?,
                Std::Paste => PredefinedMenuItem::paste(app, t)?,
                Std::SelectAll => PredefinedMenuItem::select_all(app, t)?,
                Std::Fullscreen => PredefinedMenuItem::fullscreen(app, t)?,
                Std::Minimize => PredefinedMenuItem::minimize(app, t)?,
                Std::Maximize => PredefinedMenuItem::maximize(app, t)?,
                Std::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, t)?,
            };
            s.append(&p)
        }
        Node::Sub { .. } => Ok(()),
    }
}

/// 自前の項目の id か
fn is_ours(id: &str) -> bool {
    [UPDATE, SETTINGS, NEW_HOUSE, RESUME, OPEN_CHAT, OPEN_TERM, SIDEBAR, ZOOM_IN, ZOOM_OUT, ZOOM_FIT, TAB_CHAT, TAB_STATE, TAB_TERM, HELP_KEYS, CREDITS]
        .contains(&id)
}

/// 項目を押したとき（Builder::on_menu_event）。標準の項目は AppKit が selector で処理するので、ここには来ない
pub(crate) fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == REPO {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app.opener().open_url(REPO_URL, None::<&str>) {
            eprintln!("[menu] リポジトリを開けなかった: {e}");
        }
        return;
    }
    if is_ours(id) {
        let _ = app.emit(EVENT, id);
    }
}

/// 画面から状態を受け取り、項目の押せる・押せないと文言を合わせる
#[tauri::command]
pub(crate) fn menu_state<R: Runtime>(app: AppHandle<R>, state: MenuState) -> Result<(), String> {
    let Some(items) = app.try_state::<Items<R>>() else { return Ok(()) };
    for (id, on, text) in changes(&state) {
        if let Some(it) = items.0.get(id) {
            it.set_enabled(on).map_err(|e| e.to_string())?;
            if let Some(t) = text {
                it.set_text(t).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// 開発版の確認用（#300）。FC_MENU_CTL に置いたファイルを0.3秒ごとに読み、中身が変わったら、その JSON の命令をメインスレッドで動かす。
/// 結果は FC_PERF_LOG に {"bench":"menu-ctl", ...} の行で書く。`bun tauri dev` の実行ファイル（tauri::is_dev()）でだけ動く。
/// - {"n":1,"op":"dump"}   NSApp のメニューを読む（題、キー、押せるか。macOS が足した項目も含む）。押せるかは NSMenu の update で確かめ直した値
/// - {"n":2,"op":"press","menu":"表示","item":"拡大"}   その項目を NSMenu の performActionForItemAtIndex で押す（メニューを開いて選んだときと同じ action）
///
/// AX（System Events）は、走らせるプロセスにアクセシビリティの許可が要る。許可が無いところでは、この口で同じことを確かめる（scripts/menu-ax.ts）
pub(crate) fn start_dev_ctl<R: Runtime>(app: &AppHandle<R>) {
    let Ok(path) = std::env::var("FC_MENU_CTL") else { return };
    if path.is_empty() || !tauri::is_dev() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let Ok(s) = std::fs::read_to_string(&path) else { continue };
            if s == last || s.trim().is_empty() {
                continue;
            }
            last = s.clone();
            let Ok(req) = serde_json::from_str::<serde_json::Value>(&s) else { continue };
            let _ = app.run_on_main_thread(move || {
                let res = native::run(&req);
                crate::perf::perf_log(serde_json::json!({ "bench": "menu-ctl", "req": req, "res": res }).to_string());
            });
        }
    });
}

#[cfg(not(target_os = "macos"))]
mod native {
    pub(super) fn run(_req: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "error": "macOS だけ" })
    }
}

#[cfg(target_os = "macos")]
mod native {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu};
    use serde_json::{json, Value};

    /// キーの書き方（⌃⌥⇧⌘ の順に記号、最後にキー）。scripts/menu-ax.ts の keyLabel と同じ
    fn label(key: &str, m: NSEventModifierFlags) -> String {
        if key.is_empty() {
            return String::new();
        }
        let mut out = String::new();
        if m.contains(NSEventModifierFlags::Control) { out.push('⌃'); }
        if m.contains(NSEventModifierFlags::Option) { out.push('⌥'); }
        if m.contains(NSEventModifierFlags::Shift) { out.push('⇧'); }
        if m.contains(NSEventModifierFlags::Command) { out.push('⌘'); }
        out + &key.to_uppercase()
    }

    fn sub_of(main: &NSMenu, title: &str) -> Option<objc2::rc::Retained<NSMenu>> {
        main.itemArray().iter().filter_map(|t| t.submenu()).find(|s| s.title().to_string() == title)
    }

    pub(super) fn run(req: &Value) -> Value {
        let Some(mtm) = MainThreadMarker::new() else { return json!({ "error": "メインスレッドでない" }) };
        let Some(main) = NSApplication::sharedApplication(mtm).mainMenu() else { return json!({ "error": "メニューが無い" }) };
        match req["op"].as_str() {
            Some("dump") => {
                let mut lines = vec![];
                for top in main.itemArray().iter() {
                    let Some(sub) = top.submenu() else { continue };
                    sub.update();
                    lines.push(format!("# {}", sub.title()));
                    for it in sub.itemArray().iter() {
                        if it.isSeparatorItem() {
                            lines.push("---".into());
                            continue;
                        }
                        let key = label(&it.keyEquivalent().to_string(), it.keyEquivalentModifierMask());
                        let hidden = if it.isHidden() { "\thidden" } else { "" };
                        lines.push(format!("{}\t{key}\t{}{hidden}", it.title(), if it.isEnabled() { "on" } else { "off" }));
                    }
                }
                json!({ "lines": lines })
            }
            Some("press") => {
                let (Some(menu), Some(item)) = (req["menu"].as_str(), req["item"].as_str()) else { return json!({ "error": "menu と item が要る" }) };
                let Some(sub) = sub_of(&main, menu) else { return json!({ "error": format!("{menu} が無い") }) };
                sub.update();
                let items = sub.itemArray();
                let Some(i) = items.iter().position(|it| it.title().to_string() == item) else { return json!({ "error": format!("{item} が無い") }) };
                if !items.objectAtIndex(i).isEnabled() {
                    return json!({ "error": format!("{item} は押せない") });
                }
                sub.performActionForItemAtIndex(i as isize);
                json!({ "ok": true })
            }
            _ => json!({ "error": "知らない op" }),
        }
    }
}

/// macOS のメニューに出るキーの書き方（⌃⌥⇧⌘ の順に記号、最後にキー）。tauri の accelerator の文字列から作る
fn key_label(accel: &str) -> String {
    let parts: Vec<&str> = accel.split('+').collect();
    let (key, mods) = parts.split_last().map(|(k, m)| (*k, m)).unwrap_or(("", &[]));
    let has = |names: &[&str]| mods.iter().any(|m| names.iter().any(|n| m.eq_ignore_ascii_case(n)));
    let mut out = String::new();
    if has(&["Ctrl", "Control"]) { out.push('⌃'); }
    if has(&["Alt", "Option"]) { out.push('⌥'); }
    if has(&["Shift"]) { out.push('⇧'); }
    if has(&["CmdOrCtrl", "CommandOrControl", "Cmd", "Command", "Super", "Meta"]) { out.push('⌘'); }
    out + &key.to_uppercase()
}

/// 標準の項目のキー（muda の PredefinedMenuItemType::accelerator の macOS の分）
fn std_key(kind: Std) -> &'static str {
    match kind {
        Std::Hide => "⌘H",
        Std::HideOthers => "⌥⌘H",
        Std::Quit => "⌘Q",
        Std::CloseWindow => "⌘W",
        Std::Undo => "⌘Z",
        Std::Redo => "⇧⌘Z",
        Std::Cut => "⌘X",
        Std::Copy => "⌘C",
        Std::Paste => "⌘V",
        Std::SelectAll => "⌘A",
        Std::Fullscreen => "⌃⌘F",
        Std::Minimize => "⌘M",
        Std::About | Std::Services | Std::ShowAll | Std::Maximize | Std::BringAllToFront => "",
    }
}

/// 木を1行ずつの文にする。メニューは「# 題」、区切りは「---」、項目は「文言\tキー」。
/// scripts/menu-ax.ts が、開発版の実物のメニューを AX で読んだものと同じ書き方で比べる
pub(crate) fn plain_lines(name: &str) -> Vec<String> {
    let mut out = vec![];
    for n in tree(name) {
        let Node::Sub { text, items, .. } = n else { continue };
        out.push(format!("# {text}"));
        for c in items {
            out.push(match c {
                Node::Sep => "---".into(),
                Node::Std { kind, text } => format!("{text}\t{}", std_key(kind)),
                Node::Item { text, key, .. } => format!("{text}\t{}", key.map(key_label).unwrap_or_default()),
                Node::Sub { .. } => continue,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 木を「題 > 項目」の行に平たくする。区切りは ---、標準の項目は [種類]、キーは ␣(キー)、最初に押せない項目は (off)
    fn lines(nodes: &[Node]) -> Vec<String> {
        let mut out = vec![];
        for n in nodes {
            let Node::Sub { id, text, items } = n else { panic!("最上位はメニューだけ") };
            out.push(format!("# {text} <{id}>"));
            for c in items {
                out.push(match c {
                    Node::Sep => "---".into(),
                    Node::Std { kind, text } => format!("{text} [{kind:?}]"),
                    Node::Item { id, text, key, on } => format!(
                        "{text} <{id}>{}{}",
                        key.map(|k| format!(" ({k})")).unwrap_or_default(),
                        if *on { "" } else { " (off)" }
                    ),
                    Node::Sub { .. } => panic!("入れ子のメニューは使わない"),
                });
            }
        }
        out
    }

    #[test]
    fn tree_matches_the_plan() {
        let want = [
            "# Claude Town <app>",
            "Claude Townについて [About]",
            "アップデートを確認… <update> (off)",
            "---",
            "設定… <settings> (CmdOrCtrl+,)",
            "---",
            "サービス [Services]",
            "---",
            "Claude Townを非表示 [Hide]",
            "ほかを非表示 [HideOthers]",
            "すべてを表示 [ShowAll]",
            "---",
            "Claude Townを終了 [Quit]",
            "# ファイル <file>",
            "新しい世帯 <new-house> (CmdOrCtrl+N)",
            "セッション id で開き直す… <resume> (CmdOrCtrl+Shift+O)",
            "---",
            "チャットを開く <open-chat> (off)",
            "ターミナルを開く <open-term> (off)",
            "---",
            "ウインドウを閉じる [CloseWindow]",
            "# 編集 <edit>",
            "取り消す [Undo]",
            "やり直す [Redo]",
            "---",
            "カット [Cut]",
            "コピー [Copy]",
            "ペースト [Paste]",
            "すべてを選択 [SelectAll]",
            "# 表示 <view>",
            "サイドバーを非表示 <sidebar> (CmdOrCtrl+Ctrl+S)",
            "---",
            "拡大 <zoom-in>",
            "縮小 <zoom-out>",
            "全体を表示 <zoom-fit>",
            "---",
            "チャット <tab-chat> (CmdOrCtrl+1) (off)",
            "状態 <tab-state> (CmdOrCtrl+2) (off)",
            "ターミナル <tab-term> (CmdOrCtrl+3) (off)",
            "---",
            "フルスクリーンにする [Fullscreen]",
            "# ウインドウ <__tauri_window_menu__>",
            "しまう [Minimize]",
            "拡大/縮小 [Maximize]",
            "---",
            "すべてを手前に移動 [BringAllToFront]",
            "# ヘルプ <__tauri_help_menu__>",
            "キーボードショートカット <help-keys> (off)",
            "素材のクレジット <credits>",
            "---",
            "Claude Town のリポジトリ <repo>",
        ];
        assert_eq!(lines(&tree("Claude Town")), want);
    }

    #[test]
    fn dev_name_keeps_repo_label() {
        let t = lines(&tree("Claude Town Dev"));
        assert!(t.contains(&"Claude Town Devについて [About]".to_string()));
        assert!(t.contains(&"Claude Town のリポジトリ <repo>".to_string()));
    }

    /// tauri は読めないキーを黙って捨てるので、全部が muda の物理キーとして読めることを確かめる
    #[test]
    fn every_key_parses() {
        fn walk(n: &Node, out: &mut Vec<&'static str>) {
            match n {
                Node::Sub { items, .. } => items.iter().for_each(|c| walk(c, out)),
                Node::Item { key: Some(k), .. } => out.push(k),
                _ => {}
            }
        }
        let mut keys = vec![];
        tree("Claude Town").iter().for_each(|n| walk(n, &mut keys));
        assert_eq!(keys.len(), 7);
        for k in keys {
            assert!(k.parse::<muda::accelerator::Accelerator>().is_ok(), "{k} を読めない");
        }
    }

    /// 自前の項目の id は重ならず、押したときに画面へ送る一覧（is_ours）とリポジトリの項目で全部になる
    #[test]
    fn ids_are_unique_and_routed() {
        fn walk(n: &Node, out: &mut Vec<&'static str>) {
            match n {
                Node::Sub { items, .. } => items.iter().for_each(|c| walk(c, out)),
                Node::Item { id, .. } => out.push(id),
                _ => {}
            }
        }
        let mut ids = vec![];
        tree("Claude Town").iter().for_each(|n| walk(n, &mut ids));
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), ids.len());
        for id in ids {
            assert_eq!(is_ours(id), id != REPO, "{id}");
        }
    }

    /// 状態で変わる項目は、木の自前の項目にある
    #[test]
    fn changes_target_tree_items() {
        let t = lines(&tree("Claude Town"));
        for (id, _, _) in changes(&MenuState::default()) {
            assert!(t.iter().any(|l| l.contains(&format!("<{id}>"))), "{id}");
        }
    }

    fn on(s: &MenuState, id: &str) -> bool {
        changes(s).into_iter().find(|c| c.0 == id).unwrap().1
    }
    fn text(s: &MenuState, id: &str) -> &'static str {
        changes(s).into_iter().find(|c| c.0 == id).unwrap().2.unwrap()
    }

    #[test]
    fn nothing_selected_disables_session_items() {
        let s = MenuState { sidebar: true, ..Default::default() };
        for id in [OPEN_CHAT, OPEN_TERM, TAB_CHAT, TAB_STATE, TAB_TERM, HELP_KEYS] {
            assert!(!on(&s, id), "{id}");
        }
        assert!(on(&s, SIDEBAR));
    }

    #[test]
    fn terminal_items_need_a_terminal() {
        let s = MenuState { selected: true, terminal: false, ..Default::default() };
        assert!(on(&s, OPEN_CHAT) && on(&s, TAB_CHAT) && on(&s, TAB_STATE) && on(&s, HELP_KEYS));
        assert!(!on(&s, OPEN_TERM) && !on(&s, TAB_TERM));
        let s = MenuState { selected: true, terminal: true, ..Default::default() };
        assert!(on(&s, OPEN_TERM) && on(&s, TAB_TERM));
        // 選んでいないのに端末ありと来ても押せない
        let s = MenuState { selected: false, terminal: true, ..Default::default() };
        assert!(!on(&s, OPEN_TERM));
    }

    #[test]
    fn sidebar_text_follows_pane() {
        assert_eq!(text(&MenuState { sidebar: true, ..Default::default() }, SIDEBAR), "サイドバーを非表示");
        assert_eq!(text(&MenuState { sidebar: false, ..Default::default() }, SIDEBAR), "サイドバーを表示");
    }

    #[test]
    fn update_item_follows_status() {
        let none = MenuState::default();
        assert!(!on(&none, UPDATE));
        assert_eq!(text(&none, UPDATE), "アップデートを確認…");
        let same = MenuState { update: Some(false), ..Default::default() };
        assert!(on(&same, UPDATE));
        assert_eq!(text(&same, UPDATE), "アップデートを確認…");
        let found = MenuState { update: Some(true), ..Default::default() };
        assert!(on(&found, UPDATE));
        assert_eq!(text(&found, UPDATE), "アップデートがあります…");
    }

    #[test]
    fn key_labels_follow_macos_order() {
        assert_eq!(key_label("CmdOrCtrl+Shift+O"), "⇧⌘O");
        assert_eq!(key_label("CmdOrCtrl+Ctrl+S"), "⌃⌘S");
        assert_eq!(key_label("CmdOrCtrl+,"), "⌘,");
        let p = plain_lines("Claude Town");
        assert_eq!(p[0], "# Claude Town");
        assert!(p.contains(&"設定…\t⌘,".to_string()));
        assert!(p.contains(&"コピー\t⌘C".to_string()));
    }

    #[test]
    fn state_reads_screen_shape() {
        let s: MenuState = serde_json::from_str(r#"{"selected":true,"terminal":false,"sidebar":true,"update":null}"#).unwrap();
        assert_eq!(s, MenuState { selected: true, terminal: false, sidebar: true, update: None });
    }
}
