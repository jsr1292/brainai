//! The BrainAI Mac app (D2): runs the bundled server in local mode, checks it is its own, opens the window signed in
//! with a one-time ticket, and lives in the menu bar. See docs/DESKTOP.md.
pub mod lang;
pub mod nav;
pub mod port;
pub mod proof;
pub mod server;
pub mod update;
pub mod updating;
pub mod watch;
pub mod week_note;

use server::StartError;
use std::fs::OpenOptions;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use lang::{tr, tr_with};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const MAIN: &str = "main";
/// The first start loads the search model, which can take a while on a slow disk.
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// How long the server gets to close cleanly (its own shutdown cuts connections after 5 s).
const STOP_GRACE: Duration = Duration::from_secs(7);
/// Restarts after the server stopped by itself, before BrainAI gives up.
const MAX_RESTARTS: u32 = 3;
/// Started by the login item: the window stays hidden until the owner opens it.
const HIDDEN_ARG: &str = "--hidden";
/// Links that would open a new window open in the same one, where the navigation rule below sends outside links to
/// the browser. Runs in every page the window loads.
const NEW_WINDOW_LINKS: &str = r#"window.__brainaiApp = true;
document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[target="_blank"]') : null;
  if (a && a.href) { e.preventDefault(); window.location.href = a.href; }
}, true);"#;

/// The window's own look follows Settings › Appearance: the title bar and scroll bars are native. Remembered in the
/// app's data folder (outside the brain's own data), so the next start opens the window already in it.
fn theme_file(app: &AppHandle) -> PathBuf {
    app_data(app).join("ui-theme.json")
}

fn saved_window_theme(app: &AppHandle) -> Option<tauri::Theme> {
    match nav::saved_theme(std::fs::read_to_string(theme_file(app)).ok().as_deref()) {
        Some("light") => Some(tauri::Theme::Light),
        Some("dark") => Some(tauri::Theme::Dark),
        _ => None,
    }
}

/// `auto` hands the title bar back to the system; light and dark force it. Saved so a restart keeps it.
/// Numbers the choices in the order the page made them: a thread holding an older one does nothing.
static THEME_SEQ: AtomicU64 = AtomicU64::new(0);

fn set_window_theme(app: &AppHandle, choice: &str, seq: u64) {
    // Two quick choices run on two threads: one at a time, and only the newest is applied, so the title bar and the
    // saved file always end on the last choice.
    static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    if seq != THEME_SEQ.load(Ordering::SeqCst) {
        return;
    }
    let theme = match choice {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_theme(theme);
    }
    let _ = std::fs::create_dir_all(app_data(app));
    let _ = std::fs::write(theme_file(app), format!("{{\"theme\":\"{choice}\"}}"));
}

/// The running server and what the rest of the app needs to know about it.
#[derive(Default)]
struct Running {
    child: Mutex<Option<Child>>,
    port: Arc<AtomicU16>,
    /** This start's key, to fetch the window a fresh ticket whenever it is opened again (D4). */
    secret: Mutex<String>,
    quitting: AtomicBool,
    restarts: AtomicU32,
    /// Counts the starts the app chose to make (a restart after an import, or leaving): a watcher from an earlier
    /// start sees it change and stops, so a stop the app asked for is never mistaken for a crash.
    epoch: AtomicU32,
    /// A restart is under way: another /app/restart is ignored and the crash watcher stands down.
    restarting: AtomicBool,
    /// Starts under way (a start can overlap a restart the page asked for): the tray's Restart waits for none.
    starting: AtomicU32,
    /// The last restart of the server was after it stopped answering (never two of those in a row).
    last_was_hang: AtomicBool,
    /// When a hang restart last counted towards the restart budget.
    last_hang_counted: Mutex<Option<Instant>>,
    /// The newer release the last check found, kept for Update and restart.
    update: Mutex<Option<tauri_plugin_updater::Update>>,
    /// The release the last check found, downloaded and signature-checked, with its version: kept in memory only (a
    /// restart of the app downloads it again). Set means the update is `ready`.
    downloaded: Mutex<Option<(String, Vec<u8>)>>,
    /// Quit from the tray is installing an update first: another Quit click does nothing meanwhile.
    quitting_with_update: AtomicBool,
    /// A download is running (on the check's thread, holding `update_lock`): Check for updates answers at once.
    downloading: AtomicBool,
    /// Update and restart is under way: a second one is ignored, and so is /app/restart.
    updating: AtomicBool,
    /// Held by the update check (with its write) and by the whole Update and restart, on background threads only.
    update_lock: Mutex<()>,
}

/// The tray's menu and its "BrainAI <v> is ready…" item, shown only while an update is known.
struct Tray {
    menu: Menu<Wry>,
    open_item: MenuItem<Wry>,
    login_item: CheckMenuItem<Wry>,
    restart_item: MenuItem<Wry>,
    log_item: MenuItem<Wry>,
    quit_item: MenuItem<Wry>,
    update_item: MenuItem<Wry>,
    shown: AtomicBool,
    /// The update is downloaded: the item reads "Restart to update" and restarts instead of opening Home.
    ready: AtomicBool,
    /// The version the update item names while it is shown, kept to write it again when the language changes.
    version: Mutex<Option<String>>,
}

const TRAY_ID: &str = "brainai";
/// The app icon with a red dot (scripts/make-icons.mjs).
const TRAY_UPDATE_ICON: &[u8] = include_bytes!("../icons/tray-update.png");

/// The tray's dot and its menu item for an update to `version`; the plain icon and no item for None.
/// With `ready`, the menu item restarts into the new version ("Restart to update").
fn show_update_dot(app: &AppHandle, version: Option<&str>, ready: bool) {
    let (Some(tray), Some(icon)) = (app.try_state::<Tray>(), app.tray_by_id(TRAY_ID)) else { return };
    match version {
        Some(v) => {
            let _ = icon.set_icon(tauri::image::Image::from_bytes(TRAY_UPDATE_ICON).ok());
            *tray.version.lock().unwrap() = Some(v.to_string());
            tray.ready.store(ready, Ordering::SeqCst);
            let _ = tray.update_item.set_text(update_item_text(v, ready));
            if !tray.shown.swap(true, Ordering::SeqCst) {
                let _ = tray.menu.insert(&tray.update_item, 0);
            }
        }
        None => {
            *tray.version.lock().unwrap() = None;
            tray.ready.store(false, Ordering::SeqCst);
            let _ = icon.set_icon(app.default_window_icon().cloned());
            if tray.shown.swap(false, Ordering::SeqCst) {
                let _ = tray.menu.remove(&tray.update_item);
            }
        }
    }
}

fn update_item_text(version: &str, ready: bool) -> String {
    if ready { tr("tray.restart_update") } else { tr_with("tray.update_version", &[("version", version)]) }
}

/// The tray's tooltip: a line like "Downloading update… 42%" while one runs, plain "BrainAI" for None.
fn set_tray_tooltip(app: &AppHandle, text: Option<String>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text.unwrap_or_else(|| "BrainAI".into())));
    }
}

/// Writes the tray menu's texts again in the language now in use (it can change in the dashboard's Settings).
fn retitle_tray(app: &AppHandle) {
    let Some(tray) = app.try_state::<Tray>() else { return };
    let _ = tray.open_item.set_text(tr("tray.open"));
    let _ = tray.login_item.set_text(tr("tray.login"));
    let _ = tray.quit_item.set_text(tr("tray.quit"));
    let _ = tray.restart_item.set_text(tr("tray.restart"));
    let _ = tray.log_item.set_text(tr("tray.log"));
    let text = match tray.version.lock().unwrap().as_deref() {
        Some(v) => update_item_text(v, tray.ready.load(Ordering::SeqCst)),
        None => tr("tray.update"),
    };
    let _ = tray.update_item.set_text(text);
}

/// Watches ui-language.json: when the owner changes the language in Settings, the menu follows within a few seconds.
/// (Dialogs read the file again each time they open.)
fn watch_language(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(4));
        if lang::refresh() {
            retitle_tray(&app);
        }
    });
}

/// ~/Library/Application Support/<id> on the Mac; %LOCALAPPDATA%\<id> on Windows (not the roaming folder, which
/// some offices sync between computers: a live database must not travel).
fn app_data(app: &AppHandle) -> PathBuf {
    if cfg!(windows) {
        return app.path().app_local_data_dir().expect("the local app-data folder");
    }
    app.path().app_data_dir().expect("the app-data folder")
}

fn log_path(app: &AppHandle) -> PathBuf {
    app_data(app).join("logs").join("server.log")
}

/// A server log over this size is set aside at the shell's start, so the log cannot grow for years.
const LOG_LIMIT_BYTES: u64 = 5 * 1024 * 1024;

/// If the log at `path` is over `limit` bytes, it becomes `<path>.1` (replacing an older one) and a fresh log starts.
/// A missing log, or any failure, is not an error: the log is only a convenience.
fn rotate_log(path: &Path, limit: u64) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() <= limit {
        return;
    }
    let mut older = path.as_os_str().to_owned();
    older.push(".1");
    let older = PathBuf::from(older);
    // A rename replaces an older file (also on Windows); if it fails, both files stay as they are.
    let _ = std::fs::rename(path, &older);
}

/// `rotate_log`, but only the first time `done` is clear: the log is set aside at the shell's start, not when the server is
/// started again (a crash trace must stay in server.log, where "Show log" points).
fn rotate_log_once(path: &Path, limit: u64, done: &std::sync::atomic::AtomicBool) {
    if !done.swap(true, std::sync::atomic::Ordering::SeqCst) {
        rotate_log(path, limit);
    }
}

/// The app's resource folder in a form Node can open (on Windows, without the `\\?\` that canonicalize adds).
fn resources_dir(app: &AppHandle) -> PathBuf {
    let raw = app.path().resource_dir().expect("the app's resources");
    raw.to_str().map(|s| PathBuf::from(server::plain_path(s))).unwrap_or(raw)
}

/// The bundled Node sits next to the app's own executable (Tauri's externalBin, `binaries/node`).
fn node_path() -> PathBuf {
    std::env::current_exe().expect("the app's path").parent().expect("its folder").join("node")
}

/// The owner's tools' PATH and moved settings folders, asked of their login shell once per run (it can take a moment).
fn login() -> &'static server::LoginEnv {
    static LOGIN: std::sync::OnceLock<server::LoginEnv> = std::sync::OnceLock::new();
    LOGIN.get_or_init(server::login_env)
}

/// The settings-folder variables the server gets: the app's own environment first (a launch from a terminal), else the login shell's.
fn config_envs() -> Vec<(String, String)> {
    let mut out = server::config_dirs(|k| std::env::var(k).ok());
    for (k, v) in &login().config {
        if !out.iter().any(|(name, _)| name == k) {
            out.push((k.clone(), v.clone()));
        }
    }
    out
}

fn start_server(app: &AppHandle, port: u16, secret: &str) -> std::io::Result<Child> {
    let data = app_data(app);
    let resources = resources_dir(app);
    std::fs::create_dir_all(data.join("logs"))?;
    let log = OpenOptions::new().create(true).append(true).open(log_path(app))?;
    let tmpdir = std::env::var("TMPDIR").ok();
    let locale = lang::system_locale();
    let system = if cfg!(windows) { server::windows_system_env(|k| std::env::var(k).ok()) } else { Vec::new() };
    let mut cmd = Command::new(node_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(server::creation_flags(true));
    }
    cmd.arg(resources.join("server").join("dist").join("index.js"))
        .current_dir(resources.join("server"))
        // Only what the server needs: nothing else from the owner's environment reaches it.
        .env_clear()
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .envs(config_envs())
        .envs(server::env(&data, port, secret, server::local_timezone().as_deref(), locale.as_deref(), tmpdir.as_deref(), &login().path, &system, &server::system_proxy()))
        // The server watches this pipe (APP_PARENT=stdin): when the app is gone, it closes and the server stops.
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .spawn()
}

/// Closes the pipe so the server shuts down cleanly (finishing writes, closing the database); kills it only if it
/// is still there after STOP_GRACE.
fn stop_server(app: &AppHandle) {
    let Some(mut child) = app.state::<Running>().child.lock().unwrap().take() else { return };
    drop(child.stdin.take());
    let until = Instant::now() + STOP_GRACE;
    while Instant::now() < until {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn alive(app: &AppHandle) -> bool {
    app.state::<Running>().child.lock().unwrap().as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false)
}

fn quitting(app: &AppHandle) -> bool {
    app.state::<Running>().quitting.load(Ordering::SeqCst)
}

fn quit(app: &AppHandle) {
    app.state::<Running>().quitting.store(true, Ordering::SeqCst);
    stop_server(app);
    app.exit(0);
}

/// Quit from the tray menu: an update that is `ready` is backed up and installed first (the next start is the new
/// version), on its own thread so the menu never freezes; if that fails it is logged and the quit goes ahead.
fn quit_from_tray(app: &AppHandle) {
    // First of all: while the install runs (it takes the downloaded bytes at once, so `is_ready` is already false) a
    // further Quit does nothing, and never cuts the backup or the unpack short.
    if app.state::<Running>().quitting_with_update.load(Ordering::SeqCst) {
        return;
    }
    if !update::is_ready(app) {
        return quit(app);
    }
    if app.state::<Running>().quitting_with_update.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.hide();
    }
    set_tray_tooltip(app, Some(tr("tray.installing")));
    let app = app.clone();
    std::thread::spawn(move || {
        update::install_on_quit(&app);
        quit(&app);
    });
}

/// Whether a confirmation for a window link (restart, update) is already on screen: a page that fires the link many
/// times must not stack dialogs.
static CONFIRMING: AtomicBool = AtomicBool::new(false);

/// The app's own question before it acts on a link in the page (/app/restart, /app/update): stored text can contain a
/// link, so the click alone is not the owner's decision. Blocks; call it off the navigation callback.
fn confirm_link_action(app: &AppHandle, text_key: &str, button_key: &str) -> bool {
    if CONFIRMING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return false;
    }
    lang::refresh();
    let ok = app
        .dialog()
        .message(tr(text_key))
        .title("BrainAI")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(tr(button_key), tr("common.cancel")))
        .blocking_show();
    CONFIRMING.store(false, Ordering::SeqCst);
    ok
}

/// After an import was staged (Task 7's /app/restart): stops the server and starts it again, which swaps the staged
/// copy in, and lands on the welcome page's Search step (the third). Not a crash: the watcher of the old start stands down and
/// the restart counter starts again from zero.
fn restart_server(app: &AppHandle) {
    restart_server_to(app, "/welcome?step=3".to_string());
}

/// The restart for the tray's item: back to the page the window was on.
fn restart_from_tray(app: &AppHandle) {
    if !restart_allowed_now(app) {
        return;
    }
    let page = current_page(app);
    restart_server_to(app, page);
}

/// Whether the server may be restarted by the owner now.
fn restart_allowed_now(app: &AppHandle) -> bool {
    let s = app.state::<Running>();
    watch::restart_allowed(s.starting.load(Ordering::SeqCst) > 0, FATAL_OPEN.load(Ordering::SeqCst), app_busy(app))
}

fn restart_server_to(app: &AppHandle, page: String) {
    let state = app.state::<Running>();
    // Not while a start is under way or the start-failed message is open: a second server on the same data (and the
    // first one's start would fail for want of its server).
    if !watch::restart_allowed(state.starting.load(Ordering::SeqCst) > 0, FATAL_OPEN.load(Ordering::SeqCst), false) {
        return;
    }
    // Two restarts at once could start two servers and move BrainAI to another port, breaking the connected tools.
    if state.restarting.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }
    // Never during an update (it stops and starts the server itself). Set first, then checked; the update does the
    // reverse with `updating`, so the two never both go ahead.
    if state.updating.load(Ordering::SeqCst) {
        state.restarting.store(false, Ordering::SeqCst);
        return;
    }
    state.epoch.fetch_add(1, Ordering::SeqCst);
    stop_server(app);
    state.restarts.store(0, Ordering::SeqCst);
    launch_to(app.clone(), page);
}

/// The running app's `.app` folder, only when this is a real install (the same rule as the login item), so a copy run
/// from a disk image or a translocated copy is never trashed.
#[cfg(target_os = "macos")]
fn installed_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.to_string_lossy().into_owned();
    if !nav::install_location_ok(&exe) {
        return None;
    }
    nav::app_bundle(&exe).map(PathBuf::from)
}

/// Windows: once this app has exited, a hidden, detached command waits a moment, removes what the app could not
/// (the data folder with WebView2's own files) and runs Tauri's silent uninstaller (`uninstall.exe` in the install
/// folder). `ping` is the wait: `timeout` returns at once when its input is redirected.
#[cfg(windows)]
fn spawn_uninstaller(data: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    let dir = std::env::current_exe()?.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let uninstall = dir.join("uninstall.exe");
    // CREATE_NO_WINDOW, and its own process group so it outlives this app.
    const NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    Command::new("cmd")
        .raw_arg(format!("/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"{}\" & \"{}\" /S", data.display(), uninstall.display()))
        .creation_flags(server::creation_flags(true) | NEW_PROCESS_GROUP)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

/// Deletes what is inside the app's data folder now (on Windows all but WebView2's own folder, which the detached
/// command removes after exit); on the Mac the whole folder. The first thing that cannot be deleted is the error.
fn delete_data(data: &std::path::Path) -> std::io::Result<()> {
    if !data.exists() {
        return Ok(());
    }
    if !cfg!(windows) {
        return std::fs::remove_dir_all(data);
    }
    let mut first = Ok(());
    for entry in std::fs::read_dir(data)?.flatten() {
        if !nav::deletable_now(&entry.file_name().to_string_lossy(), true) {
            continue;
        }
        let path = entry.path();
        let r = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        if r.is_err() && first.is_ok() {
            first = r;
        }
    }
    first
}

/// After the removed page (D-remove): the server has already taken the tools and hooks out and saved a copy. The app
/// stops the server, deletes the folder it made for its data (only that one), and removes itself: the Mac app goes
/// to the Trash; on Windows the silent uninstaller is started as the app exits. Any link can lead the window to
/// /app/removed, so first its own server must confirm, with the app's key, that a removal finished with a saved
/// folder, and then the owner must say yes; otherwise nothing is touched.
fn finish_removal(app: &AppHandle) {
    lang::refresh();
    let state = app.state::<Running>();
    let port = state.port.load(Ordering::SeqCst);
    let secret = state.secret.lock().unwrap().clone();
    let ours = port != 0 && !secret.is_empty() && matches!(server::check_once(port, &secret), Ok(true));
    let Some(folder) = (if ours { server::removal_ready(port, &secret) } else { None }) else {
        tell(app, MessageDialogKind::Error, nav::not_saved_text());
        return;
    };
    let remove = app
        .dialog()
        .message(nav::remove_confirm_text(cfg!(windows), &folder))
        .title("BrainAI")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(tr("remove.button"), tr("common.cancel")))
        .blocking_show();
    if !remove {
        // The server stopped accepting saves when the removal began: open them again.
        if !server::removal_cancel(port, &secret) {
            tell(app, MessageDialogKind::Error, nav::not_reopened_text());
            return;
        }
        // Back to the brain, so the owner is not left on the bare last page of the removal.
        if let Some(w) = app.get_webview_window(MAIN) {
            if let Ok(url) = format!("http://localhost:{port}/settings/tools").parse() {
                let _ = w.navigate(url);
            }
        }
        return;
    }
    // Nothing changed while the owner decided? Ask again, and only go on for the same saved folder.
    if server::removal_ready(port, &secret).as_deref() != Some(folder.as_str()) {
        tell(app, MessageDialogKind::Error, nav::not_saved_text());
        return;
    }
    state.quitting.store(true, Ordering::SeqCst);
    state.epoch.fetch_add(1, Ordering::SeqCst);
    let _ = app.autolaunch().disable();
    stop_server(app);
    // Only this app's own data folder, and only after the server (which holds the database) has stopped.
    let data = app_data(app);
    let mut problems = Vec::new();
    if let Err(e) = delete_data(&data) {
        problems.push(tr_with("remove.data_failed", &[("path", &data.display().to_string()), ("error", &e.to_string())]));
    }
    #[cfg(target_os = "macos")]
    match installed_bundle() {
        Some(bundle) => {
            // NSFileManager, not Finder: asking Finder needs an Automation permission this app does not have.
            use trash::macos::TrashContextExtMacos;
            let mut ctx = trash::TrashContext::default();
            ctx.set_delete_method(trash::macos::DeleteMethod::NsFileManager);
            if ctx.delete(&bundle).is_err() {
                problems.push(tr_with("remove.trash_failed", &[("path", &bundle.display().to_string())]));
            }
        }
        None => problems.push(tr("remove.drag_trash")),
    }
    let mut text = nav::removed_text(cfg!(windows));
    for p in problems {
        text.push_str("\n\n");
        text.push_str(&p);
    }
    tell(app, MessageDialogKind::Info, text);
    // After the message, so the uninstaller's two-second wait starts when the app is about to be gone.
    #[cfg(windows)]
    if spawn_uninstaller(&data).is_err() {
        tell(app, MessageDialogKind::Info, tr("remove.uninstall_manual"));
    }
    app.exit(0);
}

/// Shows the window. When it was hidden, or is on the login page, it also gets a fresh one-time ticket at the page it
/// was on: once a password exists (Reach) a session may have ended, and the window must never be left on the login
/// page (D4). A visible window on a page is only brought forward (D4 review: no reload, no extra session), and the
/// app key goes only to a server that has just proved it is ours (D2).
fn show_main(app: &AppHandle) {
    show_window(app, false);
}

/// Shows the window on Home (the tray's update item: the card is there), with a fresh ticket.
fn show_home(app: &AppHandle) {
    show_window(app, true);
}

fn show_window(app: &AppHandle, home: bool) {
    // The window was hidden because an update is installing on quit: Open and the Dock icon leave it hidden.
    if app.state::<Running>().quitting_with_update.load(Ordering::SeqCst) {
        return;
    }
    let Some(w) = app.get_webview_window(MAIN) else { return };
    let was_visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let state = app.state::<Running>();
    let port = state.port.load(Ordering::SeqCst);
    let secret = state.secret.lock().unwrap().clone();
    if port == 0 || secret.is_empty() {
        return; // still starting: launch() opens it
    }
    let current = w.url().map(|u| u.to_string()).unwrap_or_default();
    if !home && !nav::needs_ticket(&current, port, was_visible) {
        return;
    }
    std::thread::spawn(move || {
        if !matches!(server::check_once(port, &secret), Ok(true)) {
            return;
        }
        if let Ok(ticket) = server::ticket(port, &secret) {
            let next = if home { "/".to_string() } else { nav::next_path(&current, port) };
            if let Ok(url) = nav::open_url(port, &ticket, &next).parse() {
                let _ = w.navigate(url);
            }
        }
    });
}

/// Settings › Choose folder…: the system's folder picker. The page cannot call the app; it only navigates to
/// /app/choose-folder, which the window's navigation handler turns into this (the same way as Update and restart). The
/// window then goes to Settings with the path in the address, which only fills the box: nothing is saved or run.
fn choose_folder(app: &AppHandle) {
    lang::refresh();
    // One picker at a time: a second click (or a second navigation) while it is open does nothing.
    static PICKING: AtomicBool = AtomicBool::new(false);
    if PICKING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            PICKING.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release;
    let Some(w) = app.get_webview_window(MAIN) else { return };
    // Parented to the BrainAI window, so the picker opens in front of it and is modal to it.
    let Some(picked) = app.dialog().file().set_title(tr("folder.pick_title")).set_parent(&w).blocking_pick_folder() else { return };
    let Ok(path) = picked.into_path() else { return };
    let state = app.state::<Running>();
    let port = state.port.load(Ordering::SeqCst);
    if port == 0 {
        return;
    }
    if let Ok(url) = nav::folder_page(port, &path.to_string_lossy()).parse() {
        let _ = w.navigate(url);
    }
}

/// The welcome's "Choose the folder with your copy…": a folder picker, then the server is asked (with the app's key) to
/// look for a saved copy in the real folder, and the window opens the preview. Cancel returns to the choice.
fn pick_restore_folder(app: &AppHandle) {
    lang::refresh();
    static PICKING: AtomicBool = AtomicBool::new(false);
    if PICKING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            PICKING.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release;
    let Some(w) = app.get_webview_window(MAIN) else { return };
    let state = app.state::<Running>();
    let go = |found: bool| {
        let port = state.port.load(Ordering::SeqCst);
        if port == 0 {
            return;
        }
        if let Ok(url) = nav::restore_page(port, found).parse() {
            let _ = w.navigate(url);
        }
    };
    let picked = app.dialog().file().set_title(tr("restore.pick_title")).set_parent(&w).blocking_pick_folder().and_then(|p| p.into_path().ok());
    let Some(path) = picked else { return go(false) };
    let port = state.port.load(Ordering::SeqCst);
    let secret = state.secret.lock().unwrap().clone();
    let ours = port != 0 && !secret.is_empty() && matches!(server::check_once(port, &secret), Ok(true));
    go(ours && server::restore_find(port, &secret, &path.to_string_lossy()));
}

/// Settings › Show in Finder/Explorer: opens the folder the daily backups are made in.
fn reveal_backups(app: &AppHandle) {
    use tauri_plugin_opener::OpenerExt;
    let dir = app_data(app).join("backups");
    let _ = std::fs::create_dir_all(&dir);
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}

/// After a move to a server (D5): the server has disconnected the tools and shows its goodbye page; the app asks,
/// then stops starting at login and quits. The data folder stays where it is.
fn goodbye(app: &AppHandle) {
    lang::refresh();
    let data = app_data(app);
    let stop = app
        .dialog()
        .message(tr_with("goodbye.confirm", &[("path", &data.display().to_string())]))
        .title("BrainAI")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(tr("goodbye.stop"), tr("goodbye.not_now")))
        .blocking_show();
    if !stop {
        return;
    }
    let _ = app.autolaunch().disable();
    remember_login_choice(app, false);
    tell(app, MessageDialogKind::Info, nav::goodbye_text(cfg!(windows)));
    quit(app);
}

fn tell(app: &AppHandle, kind: MessageDialogKind, text: String) {
    app.dialog().message(text).title("BrainAI").kind(kind).blocking_show();
}

/// The window's page as a path to land on after a start (never an app link or a token), "/" when there is none.
fn current_page(app: &AppHandle) -> String {
    let port = app.state::<Running>().port.load(Ordering::SeqCst);
    app.get_webview_window(MAIN)
        .and_then(|w| w.url().ok())
        .and_then(|u| nav::restore_path(u.as_str(), port))
        .unwrap_or_else(|| "/".to_string())
}

/// Settings and the tray: the server's log in Finder or Explorer (selected there); its folder when there is no log yet.
fn reveal_log(app: &AppHandle) {
    use tauri_plugin_opener::OpenerExt;
    let log = log_path(app);
    if log.exists() && app.opener().reveal_item_in_dir(&log).is_ok() {
        return;
    }
    let dir = app_data(app).join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}

/// The start-failed message is on screen.
static FATAL_OPEN: AtomicBool = AtomicBool::new(false);

/// Stops with a message, unless the owner is already quitting (then the stop is the point, not a failure). The
/// message offers Try again (the same page again, with the restart budget back), Show the log, and Quit.
fn give_up(app: &AppHandle, why: &str) {
    if quitting(app) {
        return;
    }
    // From the first moment (stopping can take seconds), and until the message is answered: nothing may start a
    // server, so the tray's Restart waits.
    FATAL_OPEN.store(true, Ordering::SeqCst);
    struct Open;
    impl Drop for Open {
        fn drop(&mut self) {
            FATAL_OPEN.store(false, Ordering::SeqCst);
        }
    }
    let open = Open;
    stop_server(app);
    loop {
        lang::refresh();
        let (retry, log, quit) = (tr("err.try_again"), tr("err.show_log"), tr("err.quit"));
        let answer = app
            .dialog()
            .message(tr_with("err.log_at", &[("why", why), ("log", &log_path(app).display().to_string())]))
            .title("BrainAI")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::YesNoCancelCustom(retry.clone(), log.clone(), quit))
            .blocking_show_with_result();
        match watch::fatal_choice(&answer, &retry, &log) {
            watch::FatalChoice::ShowLog => reveal_log(app),
            watch::FatalChoice::Retry => {
                if quitting(app) {
                    return;
                }
                let state = app.state::<Running>();
                // A start of the app's own choosing: nothing from before may mistake it for a crash.
                state.epoch.fetch_add(1, Ordering::SeqCst);
                state.restarts.store(0, Ordering::SeqCst);
                // The new start counts as `starting` before the flag comes down, so there is no gap for a Restart.
                launch_to(app.clone(), current_page(app));
                drop(open);
                return;
            }
            watch::FatalChoice::Quit => break,
        }
    }
    app.exit(1);
}

/// Starts the server in the background; any failure, even a panic, ends in a message, never a stuck window.
fn launch(app: AppHandle) {
    launch_to(app, "/".to_string());
}

/// Like launch, landing on `page` once the server is up.
fn launch_to(app: AppHandle, page: String) {
    launch_with(app, page, None);
}

/// Like launch_to; `notice` is shown in the window once the page is open again (only set for a restart after a stop).
fn launch_with(app: AppHandle, page: String, notice: Option<String>) {
    app.state::<Running>().starting.fetch_add(1, Ordering::SeqCst);
    std::thread::spawn(move || {
        // Whether the app itself chose another start meanwhile (a restart, Try again): then this one ends quietly.
        let epoch = app.state::<Running>().epoch.load(Ordering::SeqCst);
        let result = catch_unwind(AssertUnwindSafe(|| start_and_open(&app, &page, notice)));
        let state = app.state::<Running>();
        // The last start under way ends the restart too.
        if state.starting.fetch_sub(1, Ordering::SeqCst) == 1 {
            state.restarting.store(false, Ordering::SeqCst);
        }
        let superseded = state.epoch.load(Ordering::SeqCst) != epoch;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(why)) if !superseded => give_up(&app, &why),
            Err(_) if !superseded => give_up(&app, &tr("err.crashed_start")),
            _ => {}
        }
    });
}

/// Windows update: the installer writes `updating` next to the exe while it replaces the server folder. An app opened
/// meanwhile shows a waiting text and holds back the server until the marker is gone (or the limits in `updating` pass).
/// Harmless elsewhere: no marker, and the entry file is there.
fn wait_for_installer(app: &AppHandle) {
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) else { return };
    let marker = dir.join("updating");
    let entry = resources_dir(app).join("server").join("dist").join("index.js");
    updating::wait_for_install(
        &marker,
        &entry,
        || {
            if let Some(w) = app.get_webview_window(MAIN) {
                let text = tr("start.finishing_update").replace('\\', "\\\\").replace('\'', "\\'");
                // Called on every poll: the first calls may run before the page has loaded, so it is applied again.
                let _ = w.eval(format!("var p=document.querySelector('p');if(p&&p.lastChild){{p.lastChild.textContent='{text}'}}"));
            }
        },
        |line| {
            use std::io::Write;
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path(app)) {
                let _ = writeln!(f, "{line}");
            }
        },
        std::thread::sleep,
        || quitting(app),
    );
}

/// A text as the inside of a JavaScript string in single quotes.
fn js_str(text: &str) -> String {
    text.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', "\\n").replace('\r', "")
}

/// The starting page's line, in the owner's language: "Starting BrainAI…", and after 15 s "Taking longer than usual…".
/// Written only while the window is still on the bundled starting page, and never over the installer wait's own text.
/// Runs until `done` (the start finished or failed).
fn start_texts(app: AppHandle, done: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let began = Instant::now();
        // The same marker wait_for_installer watches: while it is there that text stays.
        let marker = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("updating")));
        while !done.load(Ordering::SeqCst) && !quitting(&app) {
            let installing = marker.as_ref().is_some_and(|m| m.exists());
            if let (false, Some(w)) = (installing, app.get_webview_window(MAIN)) {
                if w.url().map(|u| nav::is_start_page(u.as_str())).unwrap_or(false) {
                    let text = js_str(&tr(watch::start_text_key(began.elapsed())));
                    // Called on every poll: the first calls may run before the page has loaded.
                    let _ = w.eval(format!("var p=document.getElementById('msg');if(p){{p.textContent='{text}'}}"));
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

/// Sets `done` when the start ends, however it ends.
struct StartDone(Arc<AtomicBool>);
impl Drop for StartDone {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Starts the server, waits until it proves it is ours, and opens the dashboard in the window with a fresh ticket.
/// The key is never sent to anything that has not proved it is ours. A new port is saved only once it worked.
fn start_and_open(app: &AppHandle, page: &str, notice: Option<String>) -> Result<(), String> {
    lang::refresh();
    let done = Arc::new(AtomicBool::new(false));
    let _done = StartDone(done.clone());
    start_texts(app.clone(), done);
    let epoch = app.state::<Running>().epoch.load(Ordering::SeqCst);
    // First: the runtime check below looks inside server/node_modules, which an installer may still be replacing.
    wait_for_installer(app);
    if quitting(app) {
        return Ok(());
    }
    // Windows: the search engine and the password hashing need Microsoft's Visual C++ runtime, which Windows itself
    // does not include. The app ships its own copy in the folder of each native module that loads it (B8); should one
    // be gone and the PC lack the runtime too, say so plainly rather than "the server did not start".
    if cfg!(windows) {
        let system32 = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32");
        let dirs = server::runtime_dirs(&resources_dir(app).join("server"));
        let missing = server::missing_runtime(|f| server::runtime_found(f, &dirs, &system32, |p| p.exists()));
        if !missing.is_empty() {
            return Err(tr_with("err.vcredist", &[("missing", &missing.join(", "))]));
        }
    }
    let data = app_data(app);
    static LOG_ROTATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    rotate_log_once(&log_path(app), LOG_LIMIT_BYTES, &LOG_ROTATED);
    let before = port::load_saved(&data);
    // The usual port first, every start; another port is for this run only (see port::after_start).
    let saved = before.usual();
    let Some(mut port) = port::settle(saved, port::is_free, 20, || std::thread::sleep(Duration::from_millis(500))) else {
        return Err(tr("err.ports_all"));
    };
    // On a temporary port because the usual one is held: when the holder does not answer like a BrainAI, say so (a notice only: the
    // server refuses a tool's usual-address token on a temporary port whatever the holder is).
    let foreign_holder = matches!(saved, Some(usual) if usual != port) && server::usual_holder(saved.unwrap()) == server::Holder::Foreign;
    let mut tried = Vec::new();
    for _attempt in 0..3 {
        let secret = proof::random_hex();
        match start_server(app, port, &secret) {
            Ok(child) => *app.state::<Running>().child.lock().unwrap() = Some(child),
            Err(e) => return Err(tr_with("err.start", &[("error", &e.to_string())])),
        }
        match server::wait_until_ours(port, &secret, START_TIMEOUT, || alive(app)) {
            Ok(()) => {
                let ticket = match server::ticket(port, &secret) {
                    Ok(t) => t,
                    Err(e) => return Err(tr_with("err.window", &[("error", &e.to_string())])),
                };
                app.state::<Running>().port.store(port, Ordering::SeqCst);
                *app.state::<Running>().secret.lock().unwrap() = secret.clone();
                // The notice is armed only now, so no other page that loads meanwhile takes it.
                if let Some(text) = notice {
                    *NOTICE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), text));
                }
                if let Some(w) = app.get_webview_window(MAIN) {
                    let _ = w.navigate(nav::open_url(port, &ticket, page).parse().expect("a localhost URL"));
                }
                // Only the app's first start of this run counts: a restart after a crash or an update check is the same run.
                static FIRST_START: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
                let remembered = port::after_start(&before, port, FIRST_START.swap(false, Ordering::SeqCst));
                let _ = port::write_saved(&data, &remembered.saved);
                // Only a home port given up after several starts in a row is worth a dialog; a temporary port is said on the Tools page.
                if let Some(old) = remembered.moved_from {
                    // Off this thread: the start is over, and a confirmed restart must not be ignored behind a dialog.
                    let (app, text) = (app.clone(), tr_with("err.port_changed", &[("old", &old.to_string()), ("port", &port.to_string())]));
                    std::thread::spawn(move || tell(&app, MessageDialogKind::Info, text));
                }
                // Said once per run of the app (a restart after a crash does not repeat it); the server refuses those tokens anyway.
                static HOLDER_SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
                if foreign_holder && !HOLDER_SAID.swap(true, Ordering::SeqCst) {
                    let (app, text) = (app.clone(), tr_with("err.usual_port_held", &[("old", &saved.unwrap_or(0).to_string())]));
                    std::thread::spawn(move || tell(&app, MessageDialogKind::Warning, text));
                }
                watch_server(app.clone());
                week_note::start(app.clone());
                return Ok(());
            }
            Err(StartError::NotOurs) => {
                // The app restarted the server meanwhile (its stop made this check fail): that start is not ours to judge.
                if app.state::<Running>().epoch.load(Ordering::SeqCst) != epoch {
                    return Ok(());
                }
                stop_server(app);
                tried.push(port);
                match (port::FIRST..=port::LAST).find(|q| !tried.contains(q) && port::is_free(*q)) {
                    Some(next) => port = next,
                    None => return Err(tr("err.ports_all_short")),
                }
            }
            Err(StartError::Timeout) => {
                if app.state::<Running>().epoch.load(Ordering::SeqCst) != epoch {
                    return Ok(());
                }
                // A server that stopped because the brain is from a newer BrainAI says why (its log has both versions).
                let code = app.state::<Running>().child.lock().unwrap().as_mut().and_then(|c| c.try_wait().ok().flatten()).and_then(|s| s.code());
                if server::refused_newer_brain(code) {
                    return Err(tr("err.schema_newer"));
                }
                return Err(tr("err.timeout"));
            }
        }
    }
    Err(tr("err.squatter"))
}

/// Said in the window (not in a dialog that would hold the restart back) once the page is back after a restart.
static NOTICE: Mutex<Option<(Instant, String)>> = Mutex::new(None);

/// Shows the pending notice in the window, once, when a BrainAI page has just loaded (never on the starting page).
fn show_notice(w: &tauri::WebviewWindow<Wry>) {
    let Some(url) = w.url().ok() else { return };
    if url.scheme() != "http" || !matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) {
        return;
    }
    let text = {
        let mut slot = NOTICE.lock().unwrap_or_else(|e| e.into_inner());
        match slot.take() {
            Some((at, text)) if at.elapsed() < Duration::from_secs(120) => text,
            _ => return,
        }
    };
    let text = js_str(&text);
    let _ = w.eval(format!(
        "(function(t){{if(!document.body)return;var d=document.createElement('div');d.setAttribute('role','status');d.textContent=t;\
d.style.cssText='position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;max-width:90vw;padding:10px 16px;border-radius:8px;background:#1c1a17;color:#f2efe9;font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);cursor:pointer';\
d.onclick=function(){{d.remove()}};document.body.appendChild(d);setTimeout(function(){{d.remove()}},20000)}})('{text}')"
    ));
}

fn log_line(app: &AppHandle, line: &str) {
    use std::io::Write;
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path(app)) {
        let _ = writeln!(f, "{line}");
    }
}

/// The app is in the middle of its own restart, update or move: the server may be down or slow on purpose.
fn app_busy(app: &AppHandle) -> bool {
    let s = app.state::<Running>();
    s.restarting.load(Ordering::SeqCst) || s.updating.load(Ordering::SeqCst) || s.quitting_with_update.load(Ordering::SeqCst)
}

/// The notice after a restart, in the owner's language and for this system's notification icon (the menu bar icon on
/// the Mac, the notification area on Windows).
fn restarted_notice(hung: bool) -> String {
    tr(match (hung, cfg!(windows)) {
        (false, false) => "err.restarted_page",
        (false, true) => "err.restarted_page_win",
        (true, false) => "err.restarted_hung_page",
        (true, true) => "err.restarted_hung_page_win",
    })
}

/// How old the server's busy marker is, when it wrote one (src/busyMarker.ts: long blocking work such as a backup).
fn busy_marker_age(app: &AppHandle) -> Option<Duration> {
    let text = std::fs::read_to_string(app_data(app).join("data").join("busy.json")).ok()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    watch::busy_age(&text, now)
}

/// After a good start: if the server stops by itself (or stops answering for minutes), start it again (a few times),
/// landing on the page the window was on, so the window never just shows "could not connect". Ten minutes up give the
/// restarts back. A server that is only busy is never touched: no check in the first minutes of a start, none while the
/// server's own busy marker is fresh, and a stop is asked for gently first.
fn watch_server(app: AppHandle) {
    let epoch = app.state::<Running>().epoch.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut health = watch::Health::new(started);
        let mut tick: u32 = 0;
        let mut last_logged: Option<Instant> = None;
        // Nothing may act on a state the app has since changed on purpose.
        let stale = |app: &AppHandle| quitting(app) || app.state::<Running>().epoch.load(Ordering::SeqCst) != epoch || app_busy(app);
        loop {
            std::thread::sleep(Duration::from_secs(3));
            // The app itself restarted or removed the server: that start has its own watcher (or none).
            if quitting(&app) || app.state::<Running>().epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            tick += 1;
            let mut dead = !alive(&app);
            let mut hung = false;
            if dead && app_busy(&app) {
                continue;
            }
            if !dead {
                let state = app.state::<Running>();
                let n = state.restarts.load(Ordering::SeqCst);
                if n > 0 && watch::refilled(n, started.elapsed()) == 0 {
                    state.restarts.store(0, Ordering::SeqCst);
                }
                if app_busy(&app) || busy_marker_age(&app).is_some_and(|a| a < watch::BUSY_FRESH) {
                    health.reset(Instant::now());
                } else if started.elapsed() >= watch::HEALTH_GRACE && tick % watch::HEALTH_EVERY == 0 {
                    let port = state.port.load(Ordering::SeqCst);
                    let secret = state.secret.lock().unwrap().clone();
                    let ok = matches!(server::check_once(port, &secret), Ok(true));
                    // The check can take seconds: if the app began its own restart meanwhile, the answer means nothing.
                    if stale(&app) {
                        health.reset(Instant::now());
                    } else if ok {
                        health.ok(Instant::now());
                        last_logged = None;
                        // It answers well again: a later hang may be dealt with.
                        state.last_was_hang.store(false, Ordering::SeqCst);
                    } else {
                        health.fail();
                        let silent = health.silent_for(Instant::now());
                        // The first failed check, then one line every 10 minutes while it stays silent.
                        let say = watch::should_log_silence(last_logged.map(|t| t.elapsed()));
                        if say {
                            last_logged = Some(Instant::now());
                            log_line(&app, &format!("BrainAI: no good answer from the server for {} s ({} failed checks in a row).", silent.as_secs(), health.fails()));
                        }
                        if watch::hung(silent, health.fails(), started.elapsed(), busy_marker_age(&app)) {
                            if !watch::may_hang_kill(state.last_was_hang.load(Ordering::SeqCst)) {
                                if say {
                                    log_line(&app, "BrainAI: the server was already restarted once for not answering and still does not; leaving it running.");
                                }
                            } else if !stale(&app) {
                                log_line(&app, &format!("BrainAI: the server has not answered for {} s, so it is being stopped and started again.", silent.as_secs()));
                                // The gentle way first: closing its input lets a server that is only busy end cleanly.
                                stop_server(&app);
                                dead = true;
                                hung = true;
                            }
                        }
                    }
                }
            }
            if !dead {
                continue;
            }
            // The stop above can take seconds: look again before acting on it.
            if stale(&app) {
                return;
            }
            let state = app.state::<Running>();
            state.restarts.store(watch::refilled(state.restarts.load(Ordering::SeqCst), started.elapsed()), Ordering::SeqCst);
            let counts = if hung {
                let mut last = state.last_hang_counted.lock().unwrap();
                let counts = watch::counts_toward_budget(last.map(|t| t.elapsed()));
                if counts {
                    *last = Some(Instant::now());
                }
                counts
            } else {
                true
            };
            state.last_was_hang.store(hung, Ordering::SeqCst);
            let n = if counts { state.restarts.fetch_add(1, Ordering::SeqCst) + 1 } else { state.restarts.load(Ordering::SeqCst) };
            if n > MAX_RESTARTS {
                return give_up(&app, &tr("err.keeps_stopping"));
            }
            // Where the window was, before the new start moves it.
            let page = current_page(&app);
            state.child.lock().unwrap().take();
            log_line(&app, &format!("BrainAI: the server stopped; starting it again (restart {n} of {MAX_RESTARTS})."));
            launch_with(app.clone(), page, Some(restarted_notice(hung)));
            return;
        }
    });
}

/// The login item starts BrainAI hidden. It is switched on at the first start from a real install (never from a disk
/// image or a translocated copy), and refreshed at every start so it follows the app if it was moved.
fn set_up_login_item(app: &tauri::App) {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    if !nav::install_location_ok(&exe) {
        return;
    }
    let marker = app_data(app.handle()).join(".start-at-login-set");
    let saved = std::fs::read_to_string(&marker).ok();
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    if nav::login_item_action(saved.as_deref(), enabled) == nav::LoginAction::Enable {
        let _ = app.autolaunch().enable();
        if saved.is_none() {
            remember_login_choice(app.handle(), true);
        }
    }
}

/// The owner's start-at-login choice, kept so it can be put back after an installer removed it.
fn remember_login_choice(app: &AppHandle, on: bool) {
    let _ = std::fs::create_dir_all(app_data(app));
    let _ = std::fs::write(app_data(app).join(".start-at-login-set"), if on { "on" } else { "off" });
}

pub fn run() {
    tauri::Builder::default()
        // A second launch shows the window of the one already running: never two servers on the same data.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Running::default())
        .setup(|app| {
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let handle = app.handle().clone();
            let port = app.state::<Running>().port.clone();
            let opener = handle.clone();
            let leaving = handle.clone();
            WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("BrainAI")
                .inner_size(1200.0, 800.0)
                .min_inner_size(420.0, 520.0)
                .theme(saved_window_theme(app.handle()))
                .visible(!std::env::args().any(|a| a == HIDDEN_ARG))
                .initialization_script(NEW_WINDOW_LINKS)
                .on_page_load(|w, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        show_notice(&w);
                    }
                })
                .on_navigation(move |url| {
                    if nav::is_goodbye(url.as_str(), port.load(Ordering::SeqCst)) {
                        let app = leaving.clone();
                        std::thread::spawn(move || goodbye(&app));
                        return true;
                    }
                    if nav::is_removed(url.as_str(), port.load(Ordering::SeqCst)) {
                        // Cancelled: the window keeps its page while the app checks and asks, so a refusal or a
                        // Cancel leaves it where it was.
                        let app = leaving.clone();
                        std::thread::spawn(move || finish_removal(&app));
                        return false;
                    }
                    if nav::is_restart(url.as_str(), port.load(Ordering::SeqCst)) {
                        // Cancelled: the window keeps its page until the new server opens it with a ticket.
                        let app = leaving.clone();
                        std::thread::spawn(move || {
                            if confirm_link_action(&app, "restart.confirm", "restart.button") {
                                restart_server(&app);
                            }
                        });
                        return false;
                    }
                    if nav::is_update(url.as_str(), port.load(Ordering::SeqCst)) {
                        // Cancelled: the window stays on Home, where the card follows the update until it reopens.
                        let app = leaving.clone();
                        std::thread::spawn(move || {
                            if confirm_link_action(&app, "update.confirm", "update.button") {
                                update::update_and_restart(&app);
                            }
                        });
                        return false;
                    }
                    if nav::is_check_updates(url.as_str(), port.load(Ordering::SeqCst)) {
                        // Cancelled: the window stays on Settings, which follows update-check.json for the answer.
                        let app = leaving.clone();
                        std::thread::spawn(move || update::check_now_manual(&app));
                        return false;
                    }
                    if let Some(choice) = nav::theme_choice(url.as_str(), port.load(Ordering::SeqCst)) {
                        // Cancelled: the page already applied its look; the title bar follows.
                        // Off this callback (WebView2's NavigationStarting runs on the main thread).
                        let app = leaving.clone();
                        let choice = choice.to_string();
                        let seq = THEME_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
                        std::thread::spawn(move || set_window_theme(&app, &choice, seq));
                        return false;
                    }
                    if nav::is_choose_folder(url.as_str(), port.load(Ordering::SeqCst)) {
                        // Cancelled: the window keeps its page; a chosen folder is sent to Settings to fill a box.
                        let app = leaving.clone();
                        std::thread::spawn(move || choose_folder(&app));
                        return false;
                    }
                    if nav::restore_pick(url.as_str(), port.load(Ordering::SeqCst)) {
                        // Cancelled: the window keeps its page; the chosen folder goes to the server, then the preview opens.
                        let app = leaving.clone();
                        std::thread::spawn(move || pick_restore_folder(&app));
                        return false;
                    }
                    if nav::is_reveal_backups(url.as_str(), port.load(Ordering::SeqCst)) {
                        let app = leaving.clone();
                        std::thread::spawn(move || reveal_backups(&app));
                        return false;
                    }
                    if nav::is_inside(url.as_str(), port.load(Ordering::SeqCst)) {
                        return true;
                    }
                    use tauri_plugin_opener::OpenerExt;
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                .build()?;

            set_up_login_item(app);

            lang::init(app_data(app.handle()).join("data"));
            let open = MenuItem::with_id(app, "open", tr("tray.open"), true, None::<&str>)?;
            let login = CheckMenuItem::with_id(app, "login", tr("tray.login"), true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", tr("tray.quit"), true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", tr("tray.restart"), true, None::<&str>)?;
            let log_item = MenuItem::with_id(app, "log", tr("tray.log"), true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &login, &PredefinedMenuItem::separator(app)?, &restart_item, &log_item, &PredefinedMenuItem::separator(app)?, &quit_item])?;
            let update_item = MenuItem::with_id(app, "update", tr("tray.update"), true, None::<&str>)?;
            app.manage(Tray { menu: menu.clone(), open_item: open.clone(), login_item: login.clone(), restart_item, log_item, quit_item: quit_item.clone(), update_item, shown: AtomicBool::new(false), ready: AtomicBool::new(false), version: Mutex::new(None) });
            let login_item = login.clone();
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().expect("the app icon").clone())
                .tooltip("BrainAI")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| {
                    use nav::TrayAction as A;
                    match nav::tray_action(event.id().as_ref()) {
                        Some(A::Open) => show_main(app),
                        Some(A::Update) if update::is_ready(app) => {
                            // Home first, so the card shows the steps of the restart.
                            let app = app.clone();
                            std::thread::spawn(move || {
                                show_home(&app);
                                update::update_and_restart(&app);
                            });
                        }
                        Some(A::Update) => show_home(app),
                        Some(A::Login) => {
                            let on = login_item.is_checked().unwrap_or(false);
                            let _ = if on { app.autolaunch().enable() } else { app.autolaunch().disable() };
                            remember_login_choice(app, on);
                        }
                        Some(A::Restart) => {
                            // The same question as the page's restart link (1.10.3): the click alone is not enough.
                            let app = app.clone();
                            std::thread::spawn(move || {
                                if restart_allowed_now(&app) && !quitting(&app) && confirm_link_action(&app, "restart.confirm_tray", "restart.button") {
                                    restart_from_tray(&app);
                                }
                            });
                        }
                        Some(A::Log) => {
                            // Off the menu's thread: on Windows the shell can take a moment to answer.
                            let app = app.clone();
                            std::thread::spawn(move || reveal_log(&app));
                        }
                        Some(A::Quit) => quit_from_tray(app),
                        None => {}
                    }
                })
                .build(app)?;

            // Before the server starts, so it never shows the update that just ran. Right after an update the window
            // shows even when this start is the login item's hidden one (the restart keeps its `--hidden`).
            if update::settle_at_start(&handle) {
                if let Some(w) = app.get_webview_window(MAIN) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            watch_language(handle.clone());
            launch(handle.clone());
            update::start_checker(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window leaves BrainAI running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("BrainAI could not start")
        .run(|app, event| match event {
            // Clicking the Dock icon brings the window back (the Mac only; on Windows the tray icon does).
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            RunEvent::ExitRequested { .. } => app.state::<Running>().quitting.store(true, Ordering::SeqCst),
            RunEvent::Exit => {
                app.state::<Running>().quitting.store(true, Ordering::SeqCst);
                stop_server(app);
            }
            _ => {}
        });
}

#[cfg(test)]
mod log_tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("brainai-log-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rotate_log_sets_a_big_log_aside() {
        let d = dir("big");
        let log = d.join("server.log");
        std::fs::write(d.join("server.log.1"), b"older").unwrap();
        std::fs::write(&log, vec![b'x'; 6 * 1024 * 1024]).unwrap();
        rotate_log(&log, LOG_LIMIT_BYTES);
        assert!(!log.exists());
        assert_eq!(std::fs::metadata(d.join("server.log.1")).unwrap().len(), 6 * 1024 * 1024);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rotate_log_once_rotates_only_the_first_time() {
        let d = dir("once");
        let log = d.join("server.log");
        let done = std::sync::atomic::AtomicBool::new(false);
        std::fs::write(&log, vec![b'x'; 100]).unwrap();
        rotate_log_once(&log, 10, &done);
        assert!(!log.exists() && d.join("server.log.1").exists());
        std::fs::write(&log, b"crash trace, longer than ten bytes").unwrap();
        rotate_log_once(&log, 10, &done);
        assert!(log.exists(), "a restart leaves the log alone");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rotate_log_keeps_both_files_when_the_rename_fails() {
        let d = dir("fail");
        let log = d.join("server.log");
        std::fs::write(&log, vec![b'x'; 100]).unwrap();
        std::fs::create_dir_all(d.join("server.log.1").join("inner")).unwrap(); // cannot be replaced by a file
        rotate_log(&log, 10);
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 100);
        assert!(d.join("server.log.1").join("inner").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rotate_log_leaves_a_small_or_missing_log() {
        let d = dir("small");
        let log = d.join("server.log");
        rotate_log(&log, LOG_LIMIT_BYTES);
        assert!(!log.exists() && !d.join("server.log.1").exists());
        std::fs::write(&log, b"small").unwrap();
        rotate_log(&log, LOG_LIMIT_BYTES);
        assert_eq!(std::fs::read(&log).unwrap(), b"small");
        assert!(!d.join("server.log.1").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
