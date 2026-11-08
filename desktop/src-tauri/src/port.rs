//! BrainAI's port: chosen once and remembered in `<app data>/brainai.json`, because the apps the owner connects keep the
//! address (http://localhost:<port>/mcp). A port counts as free only if both loopback addresses can be bound.
use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::Path;

pub const FIRST: u16 = 3100;
pub const LAST: u16 = 3199;

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    port: Option<u16>,
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

pub fn load(dir: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(dir.join("brainai.json")).ok()?;
    serde_json::from_str::<Saved>(&text).ok()?.port
}

pub fn save(dir: &Path, port: u16) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("brainai.json"), serde_json::to_string_pretty(&Saved { port: Some(port) })?)
}

/// The remembered port while it is free; otherwise a new one, remembered.
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

    #[test]
    fn a_bound_port_is_not_free() {
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        assert!(!is_free(held.local_addr().unwrap().port()));
    }
}
