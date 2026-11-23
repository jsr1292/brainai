//! BrainAI's port: chosen once and remembered in `<app data>/brainai.json`, because the apps the owner connects keep the
//! address (http://localhost:<port>/mcp). A port counts as free only if both loopback addresses can be bound.
//!
//! The file is `{ "port": <running now>, "home": <the usual port>, "misses": <starts in a row that could not use it>,
//! "previous": [<ports the home moved away from>] }`.
//! The usual ("home") port is the one the apps were connected to: every start tries it first. When it is busy, that run uses
//! another port and the home port stays; only after `ADOPT_AFTER` starts in a row without it does the new port become the home
//! (`after_start`); the ports it gave up are kept in `previous` so the server can recognise tools still connected there (stale, to be
//! connected again or removed) and not mistake them for another BrainAI. A file from an older version has only `port`, which then is the home. Readers that want the running port
//! (Claude's bridge, the server) keep reading `port`.
use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::Path;

pub const FIRST: u16 = 3100;
pub const LAST: u16 = 3199;

/// How many starts in a row may run on another port before that port becomes the usual one.
pub const ADOPT_AFTER: u32 = 3;

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Saved {
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<u16>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub misses: u32,
    /// Home ports given up, newest last (at most `KEEP_PREVIOUS`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous: Vec<u16>,
}

const KEEP_PREVIOUS: usize = 5;

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl Saved {
    /// The port the apps are connected to: tried first at every start.
    pub fn usual(&self) -> Option<u16> {
        self.home.or(self.port)
    }
}

/// What to remember after the server came up on `ran`, and whether that run is on a temporary port or moved the home for good.
#[derive(Debug, PartialEq)]
pub struct Remembered {
    pub saved: Saved,
    /// This run uses a port other than the home one (the apps connected there cannot reach BrainAI now).
    pub temporary: bool,
    /// The home port was given up after `ADOPT_AFTER` starts without it; `Some(old)` is the one given up.
    pub moved_from: Option<u16>,
}

/// The pure decision: first start (nothing remembered) makes `ran` the home; the home port in use resets the count; any other
/// port counts one miss and stays temporary until the miss is the `ADOPT_AFTER`-th in a row, when it becomes the home.
///
/// `counts` is false for a restart inside the same app run (after a crash, an update check or a restore): that is not another
/// start, so it neither adds a miss nor moves the home.
pub fn after_start(before: &Saved, ran: u16, counts: bool) -> Remembered {
    let Some(usual) = before.usual() else {
        return Remembered { saved: Saved { port: Some(ran), home: Some(ran), misses: 0, previous: before.previous.clone() }, temporary: false, moved_from: None };
    };
    if usual == ran {
        return Remembered { saved: Saved { port: Some(ran), home: Some(usual), misses: 0, previous: before.previous.clone() }, temporary: false, moved_from: None };
    }
    if !counts {
        return Remembered { saved: Saved { port: Some(ran), home: Some(usual), misses: before.misses, previous: before.previous.clone() }, temporary: true, moved_from: None };
    }
    let misses = before.misses + 1;
    if misses >= ADOPT_AFTER {
        let mut previous: Vec<u16> = before.previous.iter().copied().filter(|p| *p != usual && *p != ran).collect();
        previous.push(usual);
        if previous.len() > KEEP_PREVIOUS {
            previous.remove(0);
        }
        return Remembered { saved: Saved { port: Some(ran), home: Some(ran), misses: 0, previous }, temporary: false, moved_from: Some(usual) };
    }
    Remembered { saved: Saved { port: Some(ran), home: Some(usual), misses, previous: before.previous.clone() }, temporary: true, moved_from: None }
}

/// The saved port if it is free, else the first free one in FIRST..=LAST.
pub fn choose(saved: Option<u16>, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    if let Some(p) = saved {
        if is_free(p) {
            return Some(p);
        }
    }
    (FIRST..=LAST).find(|&p| is_free(p))
}

/// The saved port, given a few looks first: right after a crash or a quick relaunch, the last server may still be
/// shutting down (up to ~5 s), and moving would break every app connected to it. Only a port that stays busy is
/// left for another; `pause` waits between looks.
pub fn settle(saved: Option<u16>, is_free: impl Fn(u16) -> bool, tries: u32, pause: impl Fn()) -> Option<u16> {
    if let Some(p) = saved {
        for _ in 0..tries {
            if is_free(p) {
                return Some(p);
            }
            pause();
        }
        if is_free(p) {
            return Some(p);
        }
        return (FIRST..=LAST).find(|&q| q != p && is_free(q));
    }
    choose(None, is_free)
}

/// Free on this computer: nothing on 127.0.0.1:<port> or [::1]:<port>. A machine with no IPv6 loopback only checks IPv4.
pub fn is_free(port: u16) -> bool {
    let v4 = TcpListener::bind(("127.0.0.1", port)).is_ok();
    let v6 = match TcpListener::bind(("::1", port)) {
        Ok(_) => true,
        Err(e) => e.kind() == std::io::ErrorKind::AddrNotAvailable,
    };
    v4 && v6
}

/// Everything remembered (nothing when the file is missing or unreadable).
pub fn load_saved(dir: &Path) -> Saved {
    std::fs::read_to_string(dir.join("brainai.json")).ok().and_then(|t| serde_json::from_str::<Saved>(&t).ok()).unwrap_or_default()
}

/// The usual port.
#[cfg(test)]
pub fn load(dir: &Path) -> Option<u16> {
    load_saved(dir).usual()
}

/// Writes the file in one step (a temp file renamed over it, so a reader, such as Claude's bridge, never sees half of it), and
/// not at all when it already says this.
pub fn write_saved(dir: &Path, saved: &Saved) -> std::io::Result<()> {
    if dir.join("brainai.json").exists() && load_saved(dir) == *saved {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".brainai.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(saved)?)?;
    std::fs::rename(&tmp, dir.join("brainai.json")).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
pub fn save(dir: &Path, port: u16) -> std::io::Result<()> {
    write_saved(dir, &Saved { port: Some(port), home: None, misses: 0, previous: Vec::new() })
}

/// The remembered port while it is free; otherwise a new one, remembered.
#[cfg(test)]
pub fn load_or_choose(dir: &Path, is_free: impl Fn(u16) -> bool) -> std::io::Result<u16> {
    let saved = load(dir);
    let port = choose(saved, is_free)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::AddrInUse, "every port from 3100 to 3199 is in use"))?;
    if saved != Some(port) {
        save(dir, port)?;
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn waits_for_the_saved_port_before_moving_so_a_quick_relaunch_keeps_it() {
        let tries = Cell::new(0);
        let pauses = Cell::new(0);
        // Busy for the first two looks (the last server still shutting down), then free.
        let got = settle(Some(3100), |p| { if p == 3100 { tries.set(tries.get() + 1); tries.get() > 2 } else { true } }, 10, || pauses.set(pauses.get() + 1));
        assert_eq!(got, Some(3100));
        assert_eq!(pauses.get(), 2);
    }

    #[test]
    fn moves_only_after_the_saved_port_stays_busy() {
        let pauses = Cell::new(0);
        assert_eq!(settle(Some(3100), |p| p != 3100, 5, || pauses.set(pauses.get() + 1)), Some(3101));
        assert_eq!(pauses.get(), 5);
        assert_eq!(settle(None, |p| p == 3150, 5, || panic!("no pause without a saved port")), Some(3150));
    }

    #[test]
    fn keeps_the_saved_port_while_it_is_free() {
        assert_eq!(choose(Some(3105), |_| true), Some(3105));
    }

    #[test]
    fn moves_to_the_first_free_port_when_the_saved_one_is_taken() {
        assert_eq!(choose(Some(3100), |p| p != 3100 && p != 3101), Some(3102));
        assert_eq!(choose(None, |p| p >= 3150), Some(3150));
        assert_eq!(choose(None, |_| false), None);
    }

    #[test]
    fn remembers_the_port_in_brainai_json_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("brainai-port-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load_or_choose(&dir, |p| p == 3107).unwrap(), 3107);
        assert_eq!(load(&dir), Some(3107));
        let text = std::fs::read_to_string(dir.join("brainai.json")).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap(), serde_json::json!({ "port": 3107 }));
        assert_eq!(load_or_choose(&dir, |_| true).unwrap(), 3107, "kept while free");
        assert_eq!(load_or_choose(&dir, |p| p == 3120).unwrap(), 3120, "moved when taken");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn saved(port: u16, home: Option<u16>, misses: u32) -> Saved {
        Saved { port: Some(port), home, misses, previous: Vec::new() }
    }

    #[test]
    fn the_first_start_makes_its_port_the_home() {
        let r = after_start(&Saved::default(), 3100, true);
        assert_eq!(r, Remembered { saved: saved(3100, Some(3100), 0), temporary: false, moved_from: None });
    }

    #[test]
    fn one_clash_runs_on_another_port_for_this_run_only() {
        let r = after_start(&saved(3100, None, 0), 3101, true);
        assert_eq!(r.saved, saved(3101, Some(3100), 1), "the home is still 3100");
        assert!(r.temporary);
        assert_eq!(r.moved_from, None);
        // The next start tries 3100 first, and when it works the count starts over.
        let back = after_start(&r.saved, 3100, true);
        assert_eq!(back.saved, saved(3100, Some(3100), 0));
        assert!(!back.temporary);
    }

    #[test]
    fn the_home_moves_only_after_several_starts_in_a_row_without_it() {
        let mut now = saved(3100, Some(3100), 0);
        for miss in 1..ADOPT_AFTER {
            let r = after_start(&now, 3105, true);
            assert!(r.temporary, "miss {miss}");
            assert_eq!(r.saved.home, Some(3100));
            assert_eq!(r.saved.misses, miss);
            now = r.saved;
        }
        let r = after_start(&now, 3105, true);
        assert_eq!(r.saved, Saved { previous: vec![3100], ..saved(3105, Some(3105), 0) }, "the port given up is remembered");
        assert_eq!(r.moved_from, Some(3100));
        assert!(!r.temporary);
    }

    #[test]
    fn given_up_ports_are_kept_and_stay_through_later_starts() {
        let moved = after_start(&saved(3105, Some(3100), ADOPT_AFTER - 1), 3105, true);
        let later = after_start(&moved.saved, 3105, true);
        assert_eq!(later.saved.previous, vec![3100]);
        // A second move adds to the list, never repeats a port, and keeps at most KEEP_PREVIOUS.
        let mut now = moved.saved.clone();
        for port in 3110..3118u16 {
            now = Saved { misses: ADOPT_AFTER - 1, port: Some(now.home.unwrap()), ..now };
            now = after_start(&now, port, true).saved;
        }
        assert_eq!(now.previous.len(), KEEP_PREVIOUS);
        assert_eq!(now.previous.last(), Some(&3116));
        assert!(!now.previous.contains(&now.home.unwrap()));
    }

    #[test]
    fn the_file_is_written_whole_and_left_alone_when_it_says_the_same() {
        let dir = std::env::temp_dir().join(format!("brainai-port-w-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Saved { previous: vec![3100], ..saved(3105, Some(3105), 0) };
        write_saved(&dir, &s).unwrap();
        assert_eq!(load_saved(&dir), s);
        let first = std::fs::metadata(dir.join("brainai.json")).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_saved(&dir, &s).unwrap();
        assert_eq!(std::fs::metadata(dir.join("brainai.json")).unwrap().modified().unwrap(), first, "not rewritten");
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["brainai.json".to_string()], "no temp file left");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_restart_inside_the_same_run_is_not_another_start() {
        let now = saved(3105, Some(3100), ADOPT_AFTER - 1);
        let r = after_start(&now, 3105, false);
        assert_eq!(r.saved, now, "no extra miss, so no move");
        assert!(r.temporary);
        assert_eq!(r.moved_from, None);
        assert_eq!(after_start(&now, 3100, false).saved, saved(3100, Some(3100), 0), "back on the home port: the count starts over");
    }

    #[test]
    fn an_older_file_with_only_a_port_keeps_that_port_as_the_home() {
        let dir = std::env::temp_dir().join(format!("brainai-port-old-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("brainai.json"), r#"{ "port": 3104 }"#).unwrap();
        assert_eq!(load(&dir), Some(3104));
        let r = after_start(&load_saved(&dir), 3110, true);
        assert!(r.temporary);
        write_saved(&dir, &r.saved).unwrap();
        // The file keeps the running port in `port` (what Claude's bridge reads) and the usual one in `home`.
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("brainai.json")).unwrap()).unwrap();
        assert_eq!(v, serde_json::json!({ "port": 3110, "home": 3104, "misses": 1 }));
        assert_eq!(load(&dir), Some(3104), "the next start tries the home port first");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_bound_port_is_not_free() {
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        assert!(!is_free(held.local_addr().unwrap().port()));
    }
}
