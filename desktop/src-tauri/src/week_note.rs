//! The Monday notice: once a week the shell shows a desktop notification with last week's review in one line, so the
//! summary reaches the owner without asking. The server decides whether there is anything worth saying and writes the
//! text (`GET /app/week-note`, 204 for nothing); the shell decides only *when to ask* and remembers it showed one.
//!
//! "Notified" is the Monday of the week the notice was shown in (the current week's Monday, for example `2026-11-23`
//! on any day from Mon 23 to Sun 29 Nov). The review it announces is the one for the week before that Monday
//! (`2026-11-16`), which the server works out itself.
use chrono::{Datelike, Duration as Days, Local, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const FILE: &str = "week-note.json";
/// How often the thread looks at the clock.
/// The first look comes this long after the thread starts.
const FIRST_LOOK: Duration = Duration::from_secs(60);
const LOOK_EVERY: Duration = Duration::from_secs(10 * 60);
/// The notice is never earlier than this on a Monday.
const FROM_HOUR: u32 = 9;

/// The Monday of the week `date` is in (a Sunday belongs to the week that began the Monday before).
pub fn monday_of(date: NaiveDate) -> NaiveDate {
    date - Days::days(i64::from(date.weekday().num_days_from_monday()))
}

/// Whether to ask the server now. Yes from Monday 09:00, and on any later day of the same week (Tuesday to Saturday)
/// when the Monday moment was missed because the app was not running; never on a Sunday, never before 09:00 on a
/// Monday, and never twice for the same week (`notified` is that week's Monday, or later).
pub fn should_ask(now: NaiveDateTime, notified: Option<NaiveDate>) -> bool {
    let monday = monday_of(now.date());
    if notified.is_some_and(|n| n >= monday) {
        return false;
    }
    match now.weekday().num_days_from_monday() {
        0 => now.time() >= NaiveTime::from_hms_opt(FROM_HOUR, 0, 0).expect("a valid time"),
        1..=5 => true,
        _ => false,
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    notified: Option<String>,
}

/// The week's Monday last notified, or None for no file, a broken file or a date that does not read.
pub fn read_notified(data: &Path) -> Option<NaiveDate> {
    let text = std::fs::read_to_string(data.join(FILE)).ok()?;
    let saved: Saved = serde_json::from_str(&text).ok()?;
    NaiveDate::parse_from_str(saved.notified.as_deref()?, "%Y-%m-%d").ok()
}

/// Written whole: to a temporary file, then renamed over `week-note.json`, so a stop never leaves half a file.
pub fn write_notified(data: &Path, monday: NaiveDate) -> std::io::Result<()> {
    std::fs::create_dir_all(data)?;
    let tmp = data.join(format!("{FILE}.tmp"));
    let body = serde_json::to_string(&Saved { notified: Some(monday.format("%Y-%m-%d").to_string()) })?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, data.join(FILE)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// The server's answer: Some((monday, text)) for 200 `{ monday, text }`, None for 204 or anything unusable.
pub fn note_of(status: u16, body: &str) -> Option<(String, String)> {
    if status != 200 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let text = v.get("text")?.as_str()?.trim();
    let monday = v.get("monday")?.as_str()?;
    (!text.is_empty()).then(|| (monday.to_string(), text.to_string()))
}

/// Whether the review's Monday is the one just before this week's Monday. A time-zone change while the app runs can
/// leave the server and the shell a week apart; then nothing is shown.
pub fn is_last_week(review_monday: &str, today: NaiveDate) -> bool {
    NaiveDate::parse_from_str(review_monday, "%Y-%m-%d").is_ok_and(|m| m == monday_of(today) - Days::days(7))
}

static STARTED: AtomicBool = AtomicBool::new(false);

/// Starts the thread (once, however often the server is restarted): a first look a minute after it starts, then every
/// 10 minutes. It only calls the server while the app holds a port and key from a start that proved the server is ours.
pub fn start(app: tauri::AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        // Kept in memory too, so a notice whose file could not be written is still never shown twice.
        let mut shown: Option<NaiveDate> = None;
        std::thread::sleep(FIRST_LOOK);
        loop {
            if crate::quitting(&app) {
                return;
            }
            let now = Local::now().naive_local();
            let data = crate::app_data(&app);
            let notified = read_notified(&data).max(shown);
            if should_ask(now, notified) {
                if let Err(e) = look(&app, now, &data, &mut shown) {
                    eprintln!("week note: {e}");
                }
            }
            std::thread::sleep(LOOK_EVERY);
        }
    });
}

fn look(app: &tauri::AppHandle, now: NaiveDateTime, data: &Path, shown: &mut Option<NaiveDate>) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let state = app.state::<crate::Running>();
    let port = state.port.load(Ordering::SeqCst);
    let secret = state.secret.lock().unwrap().clone();
    if port == 0 || secret.is_empty() {
        return Ok(()); // no proven server yet
    }
    // The key goes only to a server that has just proved it holds it.
    if !matches!(crate::server::check_once(port, &secret), Ok(true)) {
        return Ok(());
    }
    let Some((review_monday, text)) = crate::server::week_note(port, &secret)? else { return Ok(()) };
    if !is_last_week(&review_monday, now.date()) {
        return Ok(());
    }
    let notification = app.notification();
    // On the desktop the plugin always reports Granted; the request only matters on a phone. Not granted: nothing to do.
    if notification.permission_state().map_err(|e| e.to_string())? != PermissionState::Granted
        && notification.request_permission().map_err(|e| e.to_string())? != PermissionState::Granted
    {
        return Ok(());
    }
    notification.builder().title("BrainAI").body(text).show().map_err(|e| e.to_string())?;
    let monday = monday_of(now.date());
    *shown = Some(monday);
    write_notified(data, monday).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, min, 0).unwrap()
    }
    fn day(y: i32, m: u32, d: u32) -> Option<NaiveDate> {
        NaiveDate::from_ymd_opt(y, m, d)
    }

    #[test]
    fn a_monday_before_nine_is_too_early_and_at_nine_it_is_time() {
        // 2026-11-23 is a Monday.
        assert!(!should_ask(at(2026, 11, 23, 8, 59), None));
        assert!(should_ask(at(2026, 11, 23, 9, 0), None));
        assert!(should_ask(at(2026, 11, 23, 17, 30), day(2026, 11, 16)));
    }

    #[test]
    fn a_missed_monday_is_caught_up_on_a_later_day_of_the_week() {
        assert!(should_ask(at(2026, 11, 24, 7, 0), day(2026, 11, 16)));
        assert!(should_ask(at(2026, 11, 28, 22, 0), None));
    }

    #[test]
    fn once_notified_this_week_it_waits_for_next_monday() {
        assert!(!should_ask(at(2026, 11, 23, 9, 10), day(2026, 11, 23)));
        assert!(!should_ask(at(2026, 11, 26, 12, 0), day(2026, 11, 23)));
        assert!(should_ask(at(2026, 11, 30, 9, 0), day(2026, 11, 23)));
        // A date from the future (the clock was moved back) counts as done.
        assert!(!should_ask(at(2026, 11, 24, 12, 0), day(2026, 11, 30)));
    }

    #[test]
    fn a_sunday_never_asks() {
        assert!(!should_ask(at(2026, 11, 29, 12, 0), None));
        assert!(!should_ask(at(2026, 11, 29, 12, 0), day(2026, 11, 16)));
    }

    #[test]
    fn a_sunday_belongs_to_the_week_that_began_the_monday_before() {
        assert_eq!(monday_of(NaiveDate::from_ymd_opt(2026, 11, 29).unwrap()), NaiveDate::from_ymd_opt(2026, 11, 23).unwrap());
        assert_eq!(monday_of(NaiveDate::from_ymd_opt(2026, 11, 23).unwrap()), NaiveDate::from_ymd_opt(2026, 11, 23).unwrap());
        assert_eq!(monday_of(NaiveDate::from_ymd_opt(2026, 11, 24).unwrap()), NaiveDate::from_ymd_opt(2026, 11, 23).unwrap());
    }

    #[test]
    fn the_notified_week_is_written_whole_and_read_back() {
        let dir = std::env::temp_dir().join(format!("brainai-week-note-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_notified(&dir), None);
        write_notified(&dir, NaiveDate::from_ymd_opt(2026, 11, 23).unwrap()).unwrap();
        assert_eq!(read_notified(&dir), day(2026, 11, 23));
        assert_eq!(std::fs::read_to_string(dir.join("week-note.json")).unwrap(), r#"{"notified":"2026-11-23"}"#);
        assert!(!dir.join("week-note.json.tmp").exists());
        std::fs::write(dir.join("week-note.json"), "{broken").unwrap();
        assert_eq!(read_notified(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_200_with_text_is_shown() {
        assert_eq!(note_of(200, r#"{"monday":"2026-11-16","text":"Your week"}"#), Some(("2026-11-16".into(), "Your week".into())));
        assert_eq!(note_of(204, ""), None);
        assert_eq!(note_of(200, r#"{"monday":"x","text":"  "}"#), None);
        assert_eq!(note_of(200, "not json"), None);
    }

    #[test]
    fn only_the_review_of_the_week_before_this_monday_is_shown() {
        let sunday = NaiveDate::from_ymd_opt(2026, 11, 29).unwrap();
        let monday = NaiveDate::from_ymd_opt(2026, 11, 23).unwrap();
        assert!(is_last_week("2026-11-16", monday));
        assert!(is_last_week("2026-11-16", sunday));
        assert!(!is_last_week("2026-11-23", monday));
        assert!(!is_last_week("2026-11-09", monday));
        assert!(!is_last_week("garbage", monday));
    }
}
