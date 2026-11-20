//! Waiting for a running installer (Windows update). The installer writes `updating` next to the app's exe before it
//! clears the server folder and deletes it when the copy is done. An app opened in between (the owner clicking
//! BrainAI) must not start a server from a half-copied folder: it waits here, then starts normally.
use std::path::Path;
use std::time::Duration;

/// A marker older than this is a leftover of an aborted install: ignored. Short on purpose: the template's own
/// CheckIfAppIsRunning can abort without running the hooks' cleanup, and an install takes seconds (bundled server).
pub const MARKER_FRESH: Duration = Duration::from_secs(3 * 60);
/// The longest the app waits for the marker to go.
pub const MARKER_WAIT_MAX: Duration = Duration::from_secs(3 * 60);
/// The longest the app waits for the server's entry file when there is no marker (an installer from before the marker).
pub const ENTRY_WAIT_MAX: Duration = Duration::from_secs(30);
pub const POLL: Duration = Duration::from_millis(500);
/// Extra pause after the marker is gone, for the installer to release its last files.
pub const SETTLE: Duration = Duration::from_secs(1);

#[derive(Debug, PartialEq, Eq)]
pub enum Wait {
    /// Start the server now.
    Go,
    /// An installer is running: keep waiting for the marker.
    Installer,
    /// No marker but the server is missing: keep waiting a little.
    Entry,
    /// Waited as long as allowed: start anyway (the reason goes to the log).
    GiveUp(&'static str),
}

/// What to do now. `marker_age` is None when there is no marker; `entry_present` says whether the server's entry
/// file exists; `waited` is how long this start has already waited.
pub fn decide(marker_age: Option<Duration>, entry_present: bool, waited: Duration) -> Wait {
    match marker_age {
        Some(age) if age < MARKER_FRESH => {
            if waited >= MARKER_WAIT_MAX {
                Wait::GiveUp("the installer's marker did not go away within 3 minutes")
            } else {
                Wait::Installer
            }
        }
        // A stale marker is a leftover; judge by the entry file like no marker at all.
        _ => {
            if entry_present {
                Wait::Go
            } else if waited >= ENTRY_WAIT_MAX {
                Wait::GiveUp("the server's entry file is still missing after 30 seconds")
            } else {
                Wait::Entry
            }
        }
    }
}

/// Age of the marker file; a missing file is None, an unreadable time counts as brand new (the safe side: wait).
/// A time more than MARKER_FRESH in the future (the clock was set back) counts as stale, so it cannot make every start wait.
pub fn marker_age(marker: &Path) -> Option<Duration> {
    let meta = std::fs::metadata(marker).ok()?;
    Some(age_of(meta.modified().ok(), std::time::SystemTime::now()))
}

fn age_of(modified: Option<std::time::SystemTime>, now: std::time::SystemTime) -> Duration {
    match modified.map(|m| now.duration_since(m)) {
        Some(Ok(age)) => age,
        Some(Err(ahead)) if ahead.duration() > MARKER_FRESH => MARKER_FRESH,
        _ => Duration::ZERO,
    }
}

/// Blocks until it is time to start the server. `on_wait` is called on every poll while waiting (the page may not have loaded yet, so the caller re-applies its text), `log` gets the
/// notable events. `sleep` and `quitting` are parameters so tests need no real time.
pub fn wait_for_install(
    marker: &Path,
    entry: &Path,
    mut on_wait: impl FnMut(),
    mut log: impl FnMut(&str),
    mut sleep: impl FnMut(Duration),
    quitting: impl Fn() -> bool,
) {
    let mut waited = Duration::ZERO;
    let mut announced = false;
    let mut saw_installer = false;
    loop {
        match decide(marker_age(marker), entry.exists(), waited) {
            Wait::Go => {
                if saw_installer {
                    sleep(SETTLE);
                }
                return;
            }
            Wait::GiveUp(why) => {
                log(&format!("update wait: {why}; starting anyway"));
                return;
            }
            w => {
                saw_installer |= w == Wait::Installer;
                if !announced {
                    announced = true;
                    log("update wait: an installer is running, waiting for it to finish");
                }
                on_wait();
                if quitting() {
                    return;
                }
                sleep(POLL);
                waited += POLL;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn a_fresh_marker_means_wait() {
        assert_eq!(decide(Some(S(5)), true, S(0)), Wait::Installer);
        assert_eq!(decide(Some(S(179)), false, S(100)), Wait::Installer);
    }

    #[test]
    fn a_stale_marker_is_ignored() {
        assert_eq!(decide(Some(S(180)), true, S(0)), Wait::Go);
        assert_eq!(decide(Some(S(3600)), true, S(0)), Wait::Go);
        assert_eq!(decide(Some(S(3600)), false, S(0)), Wait::Entry);
    }

    #[test]
    fn the_wait_for_a_marker_ends_after_three_minutes() {
        assert_eq!(decide(Some(S(5)), true, S(179)), Wait::Installer);
        assert!(matches!(decide(Some(S(5)), true, S(180)), Wait::GiveUp(_)));
    }

    #[test]
    fn a_marker_time_in_the_future_is_stale_when_far_ahead() {
        use std::time::SystemTime;
        let now = SystemTime::now();
        assert_eq!(age_of(Some(now - S(5)), now), S(5));
        assert_eq!(age_of(Some(now + S(30)), now), Duration::ZERO); // a small skew: fresh
        assert_eq!(age_of(None, now), Duration::ZERO);
        assert!(age_of(Some(now + S(181)), now) >= MARKER_FRESH);
        assert_eq!(decide(Some(age_of(Some(now + S(3600)), now)), true, S(0)), Wait::Go);
    }

    #[test]
    fn no_marker_and_the_server_there_means_go() {
        assert_eq!(decide(None, true, S(0)), Wait::Go);
    }

    #[test]
    fn no_marker_and_no_entry_waits_up_to_thirty_seconds() {
        assert_eq!(decide(None, false, S(0)), Wait::Entry);
        assert_eq!(decide(None, false, S(29)), Wait::Entry);
        assert!(matches!(decide(None, false, S(30)), Wait::GiveUp(_)));
    }

    #[test]
    fn the_loop_waits_for_the_marker_to_go_then_settles() {
        let dir = std::env::temp_dir().join(format!("brainai-updating-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("updating");
        let entry = dir.join("index.js");
        std::fs::write(&marker, "1").unwrap();
        std::fs::write(&entry, "").unwrap();
        let mut sleeps = Vec::new();
        let mut announced = 0;
        let mut logs = Vec::new();
        wait_for_install(&marker, &entry, || announced += 1, |l| logs.push(l.to_string()), |d| {
            sleeps.push(d);
            if sleeps.len() == 3 {
                let _ = std::fs::remove_file(&marker);
            }
        }, || false);
        assert_eq!(announced, 3); // on every poll, logged once
        assert_eq!(sleeps, vec![POLL, POLL, POLL, SETTLE]);
        assert_eq!(logs.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_to_wait_for_returns_at_once() {
        let dir = std::env::temp_dir().join(format!("brainai-updating-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let entry = dir.join("index.js");
        std::fs::write(&entry, "").unwrap();
        wait_for_install(&dir.join("updating"), &entry, || panic!("no wait"), |_| {}, |_| panic!("no sleep"), || false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
