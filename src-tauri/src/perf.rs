use super::*;

// ---------- 計測（#18） ----------

/// 画面の計測（src/term/perf.ts）の1行を書く。FC_PERF_LOG があればそのファイルに足し、無ければ標準エラーに出す
#[tauri::command]
pub(crate) fn perf_log(line: String) {
    match std::env::var("FC_PERF_LOG") {
        Ok(p) if !p.is_empty() => {
            use std::io::Write;
            if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "{line}");
            }
        }
        _ => eprintln!("[perf] {line}"),
    }
}

/// 何もしない命令。async を付けないので、メインスレッドで動く。往復が長ければ、メインスレッドが止まっている
#[tauri::command]
pub(crate) fn perf_ping() {}

/// 軽さの計測（scripts/bench.ts と src/term/bench.ts の hidden と minimized の scene、#2、#187）で、窓を隠すか最小化する。
/// FC_PERF_LOG があるとき（計測のとき）だけ動く
#[tauri::command]
pub(crate) fn perf_window(window: tauri::WebviewWindow, op: String) -> Result<(), String> {
    if std::env::var("FC_PERF_LOG").map(|p| p.is_empty()).unwrap_or(true) {
        return Err("計測のときだけ使える".into());
    }
    match op.as_str() {
        "hide" => window.hide(),
        "minimize" => window.minimize(),
        _ => return Err(format!("知らない操作: {op}")),
    }
    .map_err(|e| e.to_string())
}
