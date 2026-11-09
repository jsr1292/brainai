//! The BrainAI Mac app (D2): runs the bundled server in local mode, checks it is its own, opens the window signed in
//! with a one-time ticket, and lives in the menu bar. See docs/DESKTOP.md.
pub mod nav;
pub mod port;
pub mod proof;
pub mod server;

use server::StartError;
use std::fs::OpenOptions;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
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
const NEW_WINDOW_LINKS: &str = r#"document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[target="_blank"]') : null;
  if (a && a.href) { e.preventDefault(); window.location.href = a.href; }
}, true);"#;

/// The running server and what the rest of the app needs to know about it.
#[derive(Default)]
struct Running {
    child: Mutex<Option<Child>>,
    port: Arc<AtomicU16>,
    /** This start's key, to fetch the window a fresh ticket whenever it is opened again (D4). */
    secret: Mutex<String>,
    quitting: AtomicBool,
    restarts: AtomicU32,
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

/// The bundled Node sits next to the app's own executable (Tauri's externalBin, `binaries/node`).
fn node_path() -> PathBuf {
    std::env::current_exe().expect("the app's path").parent().expect("its folder").join("node")
}

/// The owner's tools' PATH, asked of their login shell once per run (it can take a moment).
fn tool_path() -> &'static str {
    static PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PATH.get_or_init(server::tool_path)
}

fn start_server(app: &AppHandle, port: u16, secret: &str) -> std::io::Result<Child> {
    let data = app_data(app);
    let resources = app.path().resource_dir().expect("the app's resources");
    std::fs::create_dir_all(data.join("logs"))?;
    let log = OpenOptions::new().create(true).append(true).open(log_path(app))?;
    let tmpdir = std::env::var("TMPDIR").ok();
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
        .envs(server::env(&data, &resources, port, secret, server::local_timezone().as_deref(), tmpdir.as_deref(), tool_path(), &system))
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

/// Shows the window. When it was hidden, or is on the login page, it also gets a fresh one-time ticket at the page it
/// was on: once a password exists (Reach) a session may have ended, and the window must never be left on the login
/// page (D4). A visible window on a page is only brought forward (D4 review: no reload, no extra session), and the
/// app key goes only to a server that has just proved it is ours (D2).
fn show_main(app: &AppHandle) {
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
    if !nav::needs_ticket(&current, port, was_visible) {
        return;
    }
    std::thread::spawn(move || {
        if !matches!(server::check_once(port, &secret), Ok(true)) {
            return;
        }
        if let Ok(ticket) = server::ticket(port, &secret) {
            if let Ok(url) = nav::open_url(port, &ticket, &nav::next_path(&current, port)).parse() {
                let _ = w.navigate(url);
            }
        }
    });
}

/// After a move to a server (D5): the server has disconnected the tools and shows its goodbye page; the app asks,
/// then stops starting at login and quits. The data folder stays where it is.
fn goodbye(app: &AppHandle) {
    let data = app_data(app);
    let stop = app
        .dialog()
        .message(format!("BrainAI is moving out of this Mac. Stop it now and stop starting it at login?\n\nYour data folder stays at {}.", data.display()))
        .title("BrainAI")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Stop BrainAI".into(), "Not now".into()))
        .blocking_show();
    if !stop {
        return;
    }
    let _ = app.autolaunch().disable();
    remember_login_choice(app, false);
    tell(app, MessageDialogKind::Info, nav::goodbye_text(cfg!(windows)).into());
    quit(app);
}

fn tell(app: &AppHandle, kind: MessageDialogKind, text: String) {
    app.dialog().message(text).title("BrainAI").kind(kind).blocking_show();
}

/// Stops with a message, unless the owner is already quitting (then the stop is the point, not a failure).
fn give_up(app: &AppHandle, why: &str) {
    if quitting(app) {
        return;
    }
    stop_server(app);
    tell(app, MessageDialogKind::Error, format!("{why}\n\nThe server's log is at {}.", log_path(app).display()));
    app.exit(1);
}

/// Starts the server in the background; any failure, even a panic, ends in a message, never a stuck window.
fn launch(app: AppHandle) {
    std::thread::spawn(move || {
        if catch_unwind(AssertUnwindSafe(|| start_and_open(&app))).is_err() {
            give_up(&app, "BrainAI stopped unexpectedly while starting.");
        }
    });
}

/// Starts the server, waits until it proves it is ours, and opens the dashboard in the window with a fresh ticket.
/// The key is never sent to anything that has not proved it is ours. A new port is saved only once it worked.
fn start_and_open(app: &AppHandle) {
    // Windows: the search engine and the password hashing need Microsoft's Visual C++ runtime, which Windows itself
    // does not include. The app ships its own copy in the folder of each native module that loads it (B8); should one
    // be gone and the PC lack the runtime too, say so plainly rather than "the server did not start".
    if cfg!(windows) {
        let system32 = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32");
        let dirs = server::runtime_dirs(&app.path().resource_dir().expect("the app's resources").join("server"));
        let missing = server::missing_runtime(|f| server::runtime_found(f, &dirs, &system32, |p| p.exists()));
        if !missing.is_empty() {
            return give_up(app, &format!(
                "BrainAI needs Microsoft's Visual C++ Redistributable (x64), which this computer does not have yet (missing: {}).\n\nInstall it from https://aka.ms/vs/17/release/vc_redist.x64.exe (it asks for an administrator), then open BrainAI again.",
                missing.join(", ")
            ));
        }
    }
    let data = app_data(app);
    let saved = port::load(&data);
    let Some(mut port) = port::settle(saved, port::is_free, 20, || std::thread::sleep(Duration::from_millis(500))) else {
        return give_up(app, "Every port BrainAI can use (3100 to 3199) is taken.");
    };
    let mut tried = Vec::new();
    for _attempt in 0..3 {
        let secret = proof::random_hex();
        match start_server(app, port, &secret) {
            Ok(child) => *app.state::<Running>().child.lock().unwrap() = Some(child),
            Err(e) => return give_up(app, &format!("BrainAI could not start its server: {e}.")),
        }
        match server::wait_until_ours(port, &secret, START_TIMEOUT, || alive(app)) {
            Ok(()) => {
                let ticket = match server::ticket(port, &secret) {
                    Ok(t) => t,
                    Err(e) => return give_up(app, &format!("BrainAI could not open its window: {e}.")),
                };
                app.state::<Running>().port.store(port, Ordering::SeqCst);
                *app.state::<Running>().secret.lock().unwrap() = secret.clone();
                if let Some(w) = app.get_webview_window(MAIN) {
                    let _ = w.navigate(nav::open_url(port, &ticket, "/").parse().expect("a localhost URL"));
                }
                if saved != Some(port) {
                    let _ = port::save(&data, port);
                    if let Some(old) = saved {
                        tell(app, MessageDialogKind::Info, format!(
                            "Another program is using port {old}, so BrainAI now uses port {port}.\n\nApps you connected to http://localhost:{old} need connecting again: Settings › Set up an app."));
                    }
                }
                watch_server(app.clone());
                return;
            }
            Err(StartError::NotOurs) => {
                stop_server(app);
                tried.push(port);
                match (port::FIRST..=port::LAST).find(|q| !tried.contains(q) && port::is_free(*q)) {
                    Some(next) => port = next,
                    None => return give_up(app, "Every port BrainAI can use is taken."),
                }
            }
            Err(StartError::Timeout) => return give_up(app, "BrainAI's server did not start."),
        }
    }
    give_up(app, "Another program keeps answering on BrainAI's port.");
}

/// After a good start: if the server stops by itself, say so and start it again (a few times), so the window never
/// just shows "could not connect".
fn watch_server(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        if quitting(&app) {
            return;
        }
        if !alive(&app) {
            if quitting(&app) {
                return;
            }
            let n = app.state::<Running>().restarts.fetch_add(1, Ordering::SeqCst) + 1;
            if n > MAX_RESTARTS {
                return give_up(&app, "BrainAI's server keeps stopping.");
            }
            app.state::<Running>().child.lock().unwrap().take();
            // Start it again first; the message must not keep BrainAI down until it is read.
            launch(app.clone());
            tell(&app, MessageDialogKind::Warning, format!(
                "BrainAI's server stopped unexpectedly, so BrainAI started it again.\n\nThe log is at {}.", log_path(&app).display()));
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
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Running::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let port = app.state::<Running>().port.clone();
            let opener = handle.clone();
            let leaving = handle.clone();
            WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("BrainAI")
                .inner_size(1200.0, 800.0)
                .min_inner_size(420.0, 520.0)
                .visible(!std::env::args().any(|a| a == HIDDEN_ARG))
                .initialization_script(NEW_WINDOW_LINKS)
                .on_navigation(move |url| {
                    if nav::is_goodbye(url.as_str(), port.load(Ordering::SeqCst)) {
                        let app = leaving.clone();
                        std::thread::spawn(move || goodbye(&app));
                        return true;
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

            let open = MenuItem::with_id(app, "open", "Open BrainAI", true, None::<&str>)?;
            let login = CheckMenuItem::with_id(app, "login", "Start at login", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit BrainAI", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &login, &PredefinedMenuItem::separator(app)?, &quit_item])?;
            let login_item = login.clone();
            TrayIconBuilder::with_id("brainai")
                .icon(app.default_window_icon().expect("the app icon").clone())
                .tooltip("BrainAI")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "login" => {
                        let on = login_item.is_checked().unwrap_or(false);
                        let _ = if on { app.autolaunch().enable() } else { app.autolaunch().disable() };
                        remember_login_choice(app, on);
                    }
                    "quit" => quit(app),
                    _ => {}
                })
                .build(app)?;

            launch(handle);
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
