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

/// BrainAI's removed page: the window going there means "finish removing BrainAI from this computer" (the server has
/// already taken the tools and the hooks out and saved a copy). Exact match, like the goodbye page.
pub fn is_removed(url: &str, port: u16) -> bool {
    url == format!("http://localhost:{port}/app/removed")
}

/// BrainAI's restart page, where the server sends the window after it staged an import: the app stops the server and
/// starts it again, so the staged copy is swapped in at startup.
pub fn is_restart(url: &str, port: u16) -> bool {
    url == format!("http://localhost:{port}/app/restart")
}

/// The update card's Update and restart: the app downloads, checks, backs up, installs and reopens (plan 2). Exact
/// match, like the restart page: Later (`/app/update/later`) and the card's progress (`/app/update/state`) are the
/// server's own.
pub fn is_update(url: &str, port: u16) -> bool {
    url == format!("http://localhost:{port}/app/update")
}

/// Whether the window is on Home (any query or fragment): the only page the shell reloads to show the update card.
pub fn is_home(url: &str, port: u16) -> bool {
    let Some(rest) = url.strip_prefix(&format!("http://localhost:{port}")) else { return false };
    let path = rest.split(['?', '#']).next().unwrap_or("");
    path.is_empty() || path == "/"
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

/// The app's last words after removing itself.
pub fn removed_text(windows: bool) -> String {
    format!("BrainAI is removed from this {}. Your saved copy is where the last page said.", if windows { "PC" } else { "Mac" })
}

/// The question before removing (any link can lead the window to /app/removed, so the owner is always asked).
pub fn remove_confirm_text(windows: bool, folder: &str) -> String {
    format!("Remove BrainAI from this {}? Your saved copy is at {folder}.", if windows { "PC" } else { "Mac" })
}

/// Said instead, and nothing touched, when the server does not confirm a removal with a saved copy.
pub const NOT_SAVED: &str = "BrainAI can't confirm a saved copy for this removal, so nothing was removed. Run Remove BrainAI again from Settings.";

/// The `.app` bundle a Mac executable lives in: `/Applications/BrainAI.app` for `/Applications/BrainAI.app/Contents/MacOS/brainai`.
pub fn app_bundle(exe: &str) -> Option<&str> {
    let end = exe.rfind(".app/Contents/")? + ".app".len();
    Some(&exe[..end])
}

/// What removing BrainAI deletes inside its data folder, entry by entry, while the app is still running. On Windows
/// the window's WebView2 keeps its own data (`EBWebView`) open there, so that one entry is left to the detached
/// command that runs after the app has exited; everything else (the database first of all) goes at once.
pub fn deletable_now(entry: &str, windows: bool) -> bool {
    !(windows && entry.eq_ignore_ascii_case("EBWebView"))
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
    fn update_and_restart_is_only_the_apps_own_update_address() {
        assert!(is_update("http://localhost:3100/app/update", 3100));
        assert!(!is_update("http://localhost:3100/app/update/later", 3100), "Later is the server's own form");
        assert!(!is_update("http://localhost:3100/app/update?x", 3100), "a query string");
        assert!(!is_update("http://localhost:3101/app/update", 3100), "another port");
        assert!(!is_update("http://127.0.0.1:3100/app/update", 3100), "another host");
        assert!(!is_update("http://localhost:3100/app/updater", 3100), "a look-alike");
        assert!(!is_update("http://localhost:3100/app/update/state", 3100));
        assert!(!is_update("https://evil.example/app/update", 3100));
    }

    #[test]
    fn only_a_window_on_home_is_reloaded_for_the_update_card() {
        for home in ["http://localhost:3100/", "http://localhost:3100/?x=1", "http://localhost:3100/#top", "http://localhost:3100"] {
            assert!(is_home(home, 3100), "{home}");
        }
        for other in ["http://localhost:3100/pages/abc", "http://localhost:3100/settings", "http://localhost:3100/app/update", "http://localhost:3101/", "http://127.0.0.1:3100/", "tauri://localhost/index.html", "https://example.com/"] {
            assert!(!is_home(other, 3100), "{other}");
        }
    }

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
    fn removed_and_restart_addresses_are_only_ours() {
        for (check, page) in [(is_removed as fn(&str, u16) -> bool, "removed"), (is_restart, "restart")] {
            assert!(check(&format!("http://localhost:3100/app/{page}"), 3100));
            assert!(!check(&format!("http://localhost:3101/app/{page}"), 3100), "another port");
            assert!(!check(&format!("http://localhost:3100/app/{page}?x=1"), 3100), "a query string");
            assert!(!check(&format!("http://127.0.0.1:3100/app/{page}"), 3100), "another host");
            assert!(!check(&format!("http://localhost:3100/app/{page}/x"), 3100));
            assert!(!check(&format!("https://evil.example/app/{page}"), 3100));
        }
        assert!(!is_removed("http://localhost:3100/app/restart", 3100));
        assert!(!is_restart("http://localhost:3100/app/removed", 3100));
        assert!(removed_text(false).contains("this Mac") && removed_text(true).contains("this PC"));
    }

    #[test]
    fn removing_asks_first_and_names_the_saved_copy() {
        assert_eq!(
            remove_confirm_text(false, "/Users/alex/Documents/BrainAI saved 2026-11-12"),
            "Remove BrainAI from this Mac? Your saved copy is at /Users/alex/Documents/BrainAI saved 2026-11-12."
        );
        assert!(remove_confirm_text(true, r"C:\Users\alex\Documents\BrainAI saved 2026-11-12").starts_with("Remove BrainAI from this PC? "));
        assert_eq!(NOT_SAVED, "BrainAI can't confirm a saved copy for this removal, so nothing was removed. Run Remove BrainAI again from Settings.");
    }

    #[test]
    fn the_webview_folder_is_left_for_after_exit_on_windows_only() {
        assert!(!deletable_now("EBWebView", true));
        assert!(deletable_now("EBWebView", false));
        assert!(deletable_now("memory.db", true));
        assert!(deletable_now("logs", true));
    }

    #[test]
    fn the_bundle_to_trash_is_the_app_the_executable_is_in() {
        assert_eq!(app_bundle("/Applications/BrainAI.app/Contents/MacOS/brainai"), Some("/Applications/BrainAI.app"));
        assert_eq!(app_bundle("/Users/a/My.app Files/BrainAI.app/Contents/MacOS/brainai"), Some("/Users/a/My.app Files/BrainAI.app"));
        assert_eq!(app_bundle("/usr/local/bin/brainai"), None);
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
