// ---------- macOS の通知センター（#330） ----------
//
// お便りの通知（notify.rs）を NSUserNotificationCenter に直接出し、押された知らせを delegate の
// userNotificationCenter:didActivateNotification: で受ける。tauri と notify.rs に依らない（計測用の小さい .app からも読み込む）。
//
// 前は tauri-plugin-notification 2.8.1 → notify-rust 4.19.0 → mac-notification-sys 0.6.15 で出していた。
// on_action を登録すると、プラグインは通知ごとに待ちのスレッドを作り（desktop.rs の show_tracked と wait）、
// mac-notification-sys は通知ごとに main の run loop へ 0.5 秒おきのタイマーを足して deliveredNotifications を呼ぶ
// （objc/notify.m の sendNotification）。タイマーは押されるか通知センターから消えるまで止まらず、残った通知の数だけ
// main スレッドの問い合わせが増えた（#330）。
// ここでは delegate を1つだけ置き、押されたときに AppKit から呼ばれるのを待つ。通知ごとのスレッドもタイマーも作らず、
// deliveredNotifications も呼ばない。閉じた知らせ（バナーが消えた、通知センターで消した）は受け取らない。要らないため。
//
// - 呼ぶのは main スレッドから（install は setup、deliver は notify.rs が run_on_main_thread で呼ぶ）。delegate の知らせも main に来る
// - 束の ID が無いプロセス（cargo test の実行ファイルなど）では defaultUserNotificationCenter が nil を返すことがある。
//   objc2-foundation の束縛は戻り値を nil にできない形で、nil なら panic するので、msg_send で Option として受ける
// - API は macOS 11 から deprecated。今の安定版もこの API（mac-notification-sys 経由）で出しているので、許可の設定と見た目は変わらない
#![allow(deprecated)]

use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, ClassType};
use objc2_foundation::{
    NSDictionary, NSString, NSUserNotification, NSUserNotificationActivationType, NSUserNotificationCenter,
    NSUserNotificationCenterDelegate, NSUserNotificationDefaultSoundName,
};

/// 通知の userInfo に入れる、子のセッション ID の鍵
pub const KEY_ID: &str = "sessionId";

/// 押された通知
#[derive(Debug, PartialEq, Eq)]
pub struct Tap {
    /// 押し方（tap は通知そのものを押した。前のプラグインの action_id と同じ名前）。記録に残す
    pub kind: &'static str,
    /// 通知に入れた子のセッション ID。古い安定版が出した通知（userInfo が無い）では None
    pub session_id: Option<String>,
}

type Handler = Box<dyn Fn(Tap) + Send + Sync>;
static HANDLER: OnceLock<Handler> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "FCNotifyTapDelegate"]
    struct TapDelegate;

    unsafe impl NSObjectProtocol for TapDelegate {}

    unsafe impl NSUserNotificationCenterDelegate for TapDelegate {
        #[unsafe(method(userNotificationCenter:didActivateNotification:))]
        fn did_activate(&self, center: Option<&NSUserNotificationCenter>, notification: &NSUserNotification) {
            let tap = tap_of(notification);
            // Objective-C の呼び出しの中で panic を外へ出さない
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if let Some(h) = HANDLER.get() {
                    h(tap);
                }
            }));
            // 押した通知は通知センターから外す（mac-notification-sys の didActivateNotification と同じ）。
            // AppKit は center を必ず渡す。試験は center 無しで呼ぶ（通知センターの無いプロセスで外すと例外になる）
            if let Some(center) = center {
                center.removeDeliveredNotification(notification);
            }
        }
    }
);

impl TapDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// 押された通知の中身。押し方と、userInfo の子のセッション ID
pub fn tap_of(n: &NSUserNotification) -> Tap {
    let kind = match n.activationType() {
        NSUserNotificationActivationType::ContentsClicked => "tap",
        NSUserNotificationActivationType::ActionButtonClicked => "action",
        NSUserNotificationActivationType::Replied => "replied",
        NSUserNotificationActivationType::AdditionalActionClicked => "additional",
        _ => "none",
    };
    Tap { kind, session_id: session_id_of(n) }
}

fn session_id_of(n: &NSUserNotification) -> Option<String> {
    let v = n.userInfo()?.objectForKey(&NSString::from_str(KEY_ID))?;
    let s = v.downcast::<NSString>().ok()?.to_string();
    (!s.is_empty()).then_some(s)
}

/// 既定の通知センター。束の ID が無いプロセスでは None
pub fn center() -> Option<Retained<NSUserNotificationCenter>> {
    unsafe { msg_send![NSUserNotificationCenter::class(), defaultUserNotificationCenter] }
}

/// 押された知らせを handler に渡す delegate を通知センターに付ける。main スレッドで1回だけ呼ぶ。
/// 通知センターが無ければ付けずに false を返す
pub fn install(handler: impl Fn(Tap) + Send + Sync + 'static) -> bool {
    let Some(center) = center() else { return false };
    if HANDLER.set(Box::new(handler)).is_err() {
        return false;
    }
    let delegate = TapDelegate::new();
    unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    // 通知センターは delegate を保持しない（assign）。アプリが終わるまで生かす
    std::mem::forget(delegate);
    true
}

/// 通知の中身を組む。userInfo に子のセッション ID を入れ、押されたときに tap_of で読み戻す
pub fn build(title: &str, body: &str, sound: bool, session_id: &str) -> Retained<NSUserNotification> {
    let n = NSUserNotification::new();
    n.setTitle(Some(&NSString::from_str(title)));
    if !body.is_empty() {
        n.setInformativeText(Some(&NSString::from_str(body)));
    }
    if sound {
        n.setSoundName(Some(unsafe { NSUserNotificationDefaultSoundName }));
    }
    // ボタンを出さない（mac-notification-sys が mainButtonLabel の無いときにしていたのと同じ）
    n.setHasActionButton(false);
    let key = NSString::from_str(KEY_ID);
    let value = NSString::from_str(session_id);
    let info = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[value.as_ref()]);
    unsafe { n.setUserInfo(Some(&info)) };
    n
}

/// 通知を出す。main スレッドで呼ぶ。通知センターが無ければ Err
pub fn deliver(title: &str, body: &str, sound: bool, session_id: &str) -> Result<(), &'static str> {
    let center = center().ok_or("通知センターが無い（束の ID が無いプロセス）")?;
    center.deliverNotification(&build(title, body, sound, session_id));
    Ok(())
}

/// 試験用: delegate に押された知らせを渡す（AppKit が押されたときに呼ぶのと同じ selector）
#[cfg(test)]
pub(crate) fn activate_for_test(n: &NSUserNotification) {
    let delegate = TapDelegate::new();
    let center: Option<&NSUserNotificationCenter> = None;
    let _: () = unsafe { msg_send![&*delegate, userNotificationCenter: center, didActivateNotification: n] };
}

/// 試験用: handler を入れる（install は通知センターの無い試験の実行ファイルでは付けない）
#[cfg(test)]
pub(crate) fn set_handler_for_test(handler: impl Fn(Tap) + Send + Sync + 'static) {
    let _ = HANDLER.set(Box::new(handler));
}
