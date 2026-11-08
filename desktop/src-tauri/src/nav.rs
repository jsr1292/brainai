//! What stays inside BrainAI's window, and where a login item may point.

/// BrainAI's own pages (its server on this port, or the bundled starting page) open in the window; every other link
/// opens in the default browser, so the window never strands the owner on a site with no way back.
pub fn is_inside(url: &str, port: u16) -> bool {
    let local = [format!("http://localhost:{port}/"), format!("http://127.0.0.1:{port}/")];
    local.iter().any(|p| url.starts_with(p.as_str()) || url == p.trim_end_matches('/'))
        || url.starts_with("tauri://localhost/")
        || url.starts_with("http://tauri.localhost/")
}

/// A local path the server's safeNext accepts: one leading slash, then printable ASCII, never `//` or `/\`.
fn safe_path(p: &str) -> bool {
    p.starts_with('/') && !p.starts_with("//") && !p.starts_with("/\\") && p.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// The page to reopen after a fresh ticket: where the window was (or, from the login page, where it was going), as
/// long as it is one of BrainAI's own pages on this port; otherwise the home page. Never an old ticket link.
pub fn next_path(current: &str, port: u16) -> String {
    let prefix = format!("http://localhost:{port}");
    let Some(rest) = current.strip_prefix(&prefix) else { return "/".into() };
    let rest = rest.split('#').next().unwrap_or("");
    if !safe_path(rest) || rest.starts_with("/app/") {
        return "/".into();
    }
    if rest == "/login" || rest.starts_with("/login?") {
        let next = rest.split_once('?').map(|(_, q)| q).unwrap_or("")
            .split('&').find_map(|kv| kv.strip_prefix("next=")).map(percent_decode).unwrap_or_default();
        return if safe_path(&next) && !next.starts_with("/app/") && !next.starts_with("/login") { next } else { "/".into() };
    }
    rest.to_string()
}

/// Whether showing the window should fetch it a fresh ticket (D4 review): only when it was hidden (its session may
/// have ended meanwhile), or it is on the login page or not on BrainAI at all. A visible window on one of BrainAI's pages
/// is only brought forward, so a Dock click never reloads a page with unsaved edits or adds a session.
pub fn needs_ticket(current: &str, port: u16, was_visible: bool) -> bool {
    let Some(rest) = current.strip_prefix(&format!("http://localhost:{port}")) else { return true };
    !was_visible || rest == "/login" || rest.starts_with("/login?") || rest.starts_with("/login#")
}

/// BrainAI's goodbye page after a move (D5): the window going there means "remove BrainAI from this computer".
pub fn is_goodbye(url: &str, port: u16) -> bool {
    url == format!("http://localhost:{port}/app/goodbye")
}

/// What to do with start at login when the app starts.
#[derive(Debug, PartialEq, Eq)]
pub enum LoginAction {
    Enable,
    Leave,
}

/// The owner's choice is kept in a marker file ("on" or "off"): on at the first start, then as the menu item sets
/// it. "on" is applied again at every start, because a Windows upgrade's old uninstaller removes the login entry. An
/// empty marker (written by D2) keeps whatever is set now.
pub fn login_item_action(marker: Option<&str>, enabled: bool) -> LoginAction {
    match marker.map(str::trim) {
        None | Some("on") => LoginAction::Enable,
        Some("off") => LoginAction::Leave,
        Some(_) if enabled => LoginAction::Enable,
        Some(_) => LoginAction::Leave,
    }
}

/// The app's last words after a move: how to finish removing it on this system.
pub fn goodbye_text(windows: bool) -> &'static str {
    if windows {
        "BrainAI is off and will not start at login. Uninstall BrainAI from Settings › Apps to finish."
    } else {
        "BrainAI is off and will not start at login. Drag BrainAI from Applications to the Trash to finish."
    }
}

/// The window's link: a fresh one-time ticket, and the page to land on.
pub fn open_url(port: u16, ticket: &str, next: &str) -> String {
    format!("http://localhost:{port}/app/open?ticket={ticket}&next={}", percent_encode(next))
}

/// Where a login item may point: not a mounted disk image (gone after it is ejected) and not the temporary copy
/// macOS runs a quarantined app from (gone after the app is moved).
pub fn install_location_ok(exe: &str) -> bool {
    !exe.starts_with("/Volumes/") && !exe.contains("/AppTranslocation/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_at_login_follows_the_owners_choice_even_after_an_installer_removed_it() {
        assert_eq!(login_item_action(None, false), LoginAction::Enable, "first start: on");
        assert_eq!(login_item_action(Some("on"), false), LoginAction::Enable, "an upgrade's uninstaller removed it: back on");
        assert_eq!(login_item_action(Some("on"), true), LoginAction::Enable, "refreshed to this copy of the app");
        assert_eq!(login_item_action(Some("off"), false), LoginAction::Leave, "the owner turned it off");
        assert_eq!(login_item_action(Some("off"), true), LoginAction::Leave);
        assert_eq!(login_item_action(Some(""), true), LoginAction::Enable, "a D2 marker: keep it as it is");
        assert_eq!(login_item_action(Some(""), false), LoginAction::Leave);
    }

    #[test]
    fn the_last_goodbye_line_says_how_to_finish_on_each_system() {
        assert!(goodbye_text(false).contains("Trash"));
        assert!(goodbye_text(true).contains("Settings › Apps"));
    }

    #[test]
    fn the_goodbye_page_is_only_the_apps_own() {
        assert!(is_goodbye("http://localhost:3100/app/goodbye", 3100));
        assert!(!is_goodbye("http://localhost:3101/app/goodbye", 3100), "another port");
        assert!(!is_goodbye("http://127.0.0.1:3100/app/goodbye", 3100));
        assert!(!is_goodbye("http://localhost:3100/app/goodbye/x", 3100));
        assert!(!is_goodbye("http://localhost:3100/app/goodbyes", 3100));
        assert!(!is_goodbye("https://evil.example/app/goodbye", 3100));
    }

    #[test]
    fn a_visible_window_on_a_page_is_left_alone_and_only_a_hidden_one_or_the_login_page_gets_a_ticket() {
        assert!(!needs_ticket("http://localhost:3100/pages/abc", 3100, true), "a Dock click on an open window keeps its page and edits");
        assert!(needs_ticket("http://localhost:3100/pages/abc", 3100, false), "a hidden window may have outlived its session");
        assert!(needs_ticket("http://localhost:3100/login?next=%2F", 3100, true), "never left on the login page");
        assert!(needs_ticket("http://localhost:3100/login", 3100, true));
        assert!(needs_ticket("tauri://localhost/index.html", 3100, true), "not on BrainAI yet");
    }

    #[test]
    fn open_brainai_reopens_the_page_the_window_was_on_with_a_fresh_ticket() {
        assert_eq!(next_path("http://localhost:3100/pages/abc?x=1#top", 3100), "/pages/abc?x=1");
        assert_eq!(next_path("http://localhost:3100/login?next=%2Fsettings", 3100), "/settings", "from the login page, where it was going");
        for other in ["http://localhost:3100/app/open?ticket=old", "https://claude.ai/x", "http://localhost:3000/pages", "tauri://localhost/index.html", "not a url", "http://localhost:3100//evil.example"] {
            assert_eq!(next_path(other, 3100), "/", "{other}");
        }
        assert_eq!(open_url(3100, "T".repeat(43).as_str(), "/pages/abc?x=1&y=2"), format!("http://localhost:3100/app/open?ticket={}&next=%2Fpages%2Fabc%3Fx%3D1%26y%3D2", "T".repeat(43)));
    }

    #[test]
    fn only_the_apps_own_pages_open_in_the_window() {
        for inside in ["http://localhost:3100/", "http://localhost:3100/settings?x=1", "http://127.0.0.1:3100/pages", "tauri://localhost/index.html", "http://tauri.localhost/index.html"] {
            assert!(is_inside(inside, 3100), "{inside}");
        }
        for outside in ["https://claude.ai/new?q=x", "https://chatgpt.com/", "http://localhost:3000/", "http://localhost:31000/", "http://evil.example/", "mailto:a@b.c", "not a url"] {
            assert!(!is_inside(outside, 3100), "{outside}");
        }
    }

    #[test]
    fn a_login_item_never_points_into_a_disk_image_or_a_translocated_copy() {
        assert!(install_location_ok("/Applications/BrainAI.app/Contents/MacOS/brainai"));
        assert!(install_location_ok("/Users/a/Applications/BrainAI.app/Contents/MacOS/brainai"));
        assert!(!install_location_ok("/Volumes/BrainAI/BrainAI.app/Contents/MacOS/brainai"));
        assert!(!install_location_ok("/private/var/folders/x/AppTranslocation/1234/d/BrainAI.app/Contents/MacOS/brainai"));
    }
}
