//! The pure rules of the server watcher: when the restart budget refills, when a silent server counts as hung, which
//! text the starting page shows, and what the fatal-start dialog's buttons mean.
use std::time::{Duration, Instant};
use tauri_plugin_dialog::MessageDialogResult;

/// A server that has run this long without stopping has earned its restarts back.
pub const REFILL_AFTER: Duration = Duration::from_secs(10 * 60);
/// The health check runs every this many watcher ticks (the watcher ticks every 3 s: about every 9 s).
pub const HEALTH_EVERY: u32 = 3;
/// No health check at all during the first minutes of a start: the daily backup, the hashing of the model files and
/// the catch-up of search by meaning all block the server's one thread then.
pub const HEALTH_GRACE: Duration = Duration::from_secs(5 * 60);
/// A server counts as hung only after this long without one good answer...
pub const HUNG_AFTER: Duration = Duration::from_secs(180);
/// ...and only after this many failed checks in a row.
pub const MIN_FAILS: u32 = 3;
/// A marker the server wrote (`busy.json`) for long blocking work is believed for this long at most.
pub const BUSY_FRESH: Duration = Duration::from_secs(30 * 60);
/// A hang restart counts towards the restart budget at most once in this time.
pub const HANG_COUNTS_EVERY: Duration = Duration::from_secs(60 * 60);
/// A marker dated more than this ahead of the clock is ignored.
pub const MARKER_FUTURE: Duration = Duration::from_secs(5 * 60);
/// While the server stays silent the log gets a line about it this often.
pub const LOG_SILENCE_EVERY: Duration = Duration::from_secs(10 * 60);

/// Whether a failed health check is written to the log: the first one, then one line per LOG_SILENCE_EVERY.
pub fn should_log_silence(since_last_line: Option<Duration>) -> bool {
    since_last_line.is_none_or(|d| d >= LOG_SILENCE_EVERY)
}

/// The starting page says "taking longer than usual" after this long.
pub const SLOW_AFTER: Duration = Duration::from_secs(15);

/// The crash counter after `up` of uptime: back to zero after REFILL_AFTER, else unchanged.
pub fn refilled(restarts: u32, up: Duration) -> u32 {
    if up >= REFILL_AFTER { 0 } else { restarts }
}

/// How old the server's busy marker is (`{"what": .., "since": <ms since 1970>}`), None when there is none or it does
/// not read. A `since` in the future (clock moved) counts as just written.
pub fn busy_age(content: &str, now_ms: u64) -> Option<Duration> {
    let since = serde_json::from_str::<serde_json::Value>(content).ok()?.get("since")?.as_u64()?;
    // Well ahead of this clock (it was moved back since): not a marker to trust.
    if since > now_ms.saturating_add(MARKER_FUTURE.as_millis() as u64) {
        return None;
    }
    Some(Duration::from_millis(now_ms.saturating_sub(since)))
}

/// Whether the server is to be treated as hung: silent for HUNG_AFTER, after at least MIN_FAILS failed checks, not in
/// the first HEALTH_GRACE of its run, and not while it says (freshly) that it is busy.
pub fn hung(silent_for: Duration, fails: u32, up: Duration, busy_age: Option<Duration>) -> bool {
    if up < HEALTH_GRACE || busy_age.is_some_and(|a| a < BUSY_FRESH) {
        return false;
    }
    fails >= MIN_FAILS && silent_for >= HUNG_AFTER
}

/// Never two hang restarts in a row: a slow server is better than none.
pub fn may_hang_kill(previous_restart_was_hang: bool) -> bool {
    !previous_restart_was_hang
}

/// Whether a hang restart counts towards MAX_RESTARTS: the first, then at most one an hour.
pub fn counts_toward_budget(since_last_counted: Option<Duration>) -> bool {
    since_last_counted.is_none_or(|d| d >= HANG_COUNTS_EVERY)
}

/// Whether the app may restart the server now (the tray's Restart): not while a start is under way, not while the
/// start-failed message is open, not during its own restart or update.
pub fn restart_allowed(starting: bool, fatal_open: bool, busy: bool) -> bool {
    !(starting || fatal_open || busy)
}

/// Consecutive failed health checks, and when the server last answered well.
#[derive(Debug)]
pub struct Health {
    fails: u32,
    last_ok: Instant,
}

impl Health {
    pub fn new(now: Instant) -> Self {
        Health { fails: 0, last_ok: now }
    }
    pub fn ok(&mut self, now: Instant) {
        self.fails = 0;
        self.last_ok = now;
    }
    pub fn fail(&mut self) {
        self.fails += 1;
    }
    /// The answer does not count (the app was restarting, or the server said it was busy): start the silence again.
    pub fn reset(&mut self, now: Instant) {
        self.ok(now);
    }
    pub fn fails(&self) -> u32 {
        self.fails
    }
    pub fn silent_for(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_ok)
    }
}

/// The key of the text the starting page shows after `elapsed`.
pub fn start_text_key(elapsed: Duration) -> &'static str {
    if elapsed >= SLOW_AFTER { "start.slow" } else { "start.starting" }
}

#[derive(Debug, PartialEq, Eq)]
pub enum FatalChoice {
    Retry,
    ShowLog,
    Quit,
}

/// Which button of the fatal-start dialog (Yes = Try again, No = Show the log, Cancel or closing = Quit) was pressed;
/// some platforms answer with the custom label instead.
pub fn fatal_choice(result: &MessageDialogResult, retry: &str, log: &str) -> FatalChoice {
    match result {
        MessageDialogResult::Yes => FatalChoice::Retry,
        MessageDialogResult::No => FatalChoice::ShowLog,
        MessageDialogResult::Custom(s) if s == retry => FatalChoice::Retry,
        MessageDialogResult::Custom(s) if s == log => FatalChoice::ShowLog,
        _ => FatalChoice::Quit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_refills_after_ten_minutes_up() {
        assert_eq!(refilled(3, Duration::from_secs(599)), 3);
        assert_eq!(refilled(3, Duration::from_secs(600)), 0);
        assert_eq!(refilled(0, Duration::from_secs(5)), 0);
    }

    #[test]
    fn hung_needs_silence_failures_grace_and_no_fresh_busy_marker() {
        let s = Duration::from_secs;
        let up = s(20 * 60);
        assert!(hung(s(180), 3, up, None));
        assert!(!hung(s(179), 9, up, None), "silence under 180 s");
        assert!(!hung(s(600), 2, up, None), "fewer than 3 failed checks");
        assert!(!hung(s(600), 9, s(299), None), "first 5 minutes of the run");
        assert!(hung(s(600), 9, s(300), None));
        assert!(!hung(s(600), 9, up, Some(s(10))), "busy, freshly");
        assert!(!hung(s(600), 9, up, Some(s(29 * 60))));
        assert!(hung(s(600), 9, up, Some(s(30 * 60))), "a marker older than 30 minutes is not believed");
    }

    #[test]
    fn busy_marker_age() {
        assert_eq!(busy_age(r#"{"what":"backing up","since":1000}"#, 6000), Some(Duration::from_millis(5000)));
        assert_eq!(busy_age(r#"{"what":"x","since":9000}"#, 6000), Some(Duration::ZERO), "slightly ahead: just written");
        assert_eq!(busy_age(r#"{"what":"x","since":400000}"#, 6000), None, "more than 5 minutes ahead: ignored");
        assert_eq!(busy_age(r#"{"what":"x","since":306000}"#, 6000), Some(Duration::ZERO), "exactly 5 minutes ahead");
        assert_eq!(busy_age("", 6000), None);
        assert_eq!(busy_age("{}", 6000), None);
        assert_eq!(busy_age(r#"{"since":"soon"}"#, 6000), None);
    }

    #[test]
    fn no_two_hang_kills_in_a_row_and_one_budget_count_an_hour() {
        assert!(may_hang_kill(false));
        assert!(!may_hang_kill(true));
        assert!(counts_toward_budget(None));
        assert!(!counts_toward_budget(Some(Duration::from_secs(3599))));
        assert!(counts_toward_budget(Some(Duration::from_secs(3600))));
    }

    #[test]
    fn restart_only_when_nothing_else_is_going_on() {
        assert!(restart_allowed(false, false, false));
        assert!(!restart_allowed(true, false, false), "a start is under way");
        assert!(!restart_allowed(false, true, false), "the fatal message is open");
        assert!(!restart_allowed(false, false, true));
    }

    #[test]
    fn the_silence_is_logged_once_then_every_ten_minutes() {
        assert!(should_log_silence(None));
        assert!(!should_log_silence(Some(Duration::from_secs(599))));
        assert!(should_log_silence(Some(Duration::from_secs(600))));
    }

    #[test]
    fn health_counts_failures_and_silence() {
        let t0 = Instant::now();
        let mut h = Health::new(t0);
        h.fail();
        h.fail();
        assert_eq!(h.fails(), 2);
        assert_eq!(h.silent_for(t0 + Duration::from_secs(50)), Duration::from_secs(50));
        h.ok(t0 + Duration::from_secs(60));
        assert_eq!(h.fails(), 0);
        assert_eq!(h.silent_for(t0 + Duration::from_secs(70)), Duration::from_secs(10));
        h.fail();
        h.reset(t0 + Duration::from_secs(80));
        assert_eq!(h.fails(), 0);
    }

    #[test]
    fn start_text_turns_slow_after_fifteen_seconds() {
        assert_eq!(start_text_key(Duration::from_secs(14)), "start.starting");
        assert_eq!(start_text_key(Duration::from_secs(15)), "start.slow");
    }

    #[test]
    fn fatal_buttons() {
        let r = |x| fatal_choice(&x, "Try again", "Show the log");
        assert_eq!(r(MessageDialogResult::Yes), FatalChoice::Retry);
        assert_eq!(r(MessageDialogResult::No), FatalChoice::ShowLog);
        assert_eq!(r(MessageDialogResult::Cancel), FatalChoice::Quit);
        assert_eq!(r(MessageDialogResult::Custom("Try again".into())), FatalChoice::Retry);
        assert_eq!(r(MessageDialogResult::Custom("Show the log".into())), FatalChoice::ShowLog);
        assert_eq!(r(MessageDialogResult::Custom("Quit".into())), FatalChoice::Quit);
    }
}
