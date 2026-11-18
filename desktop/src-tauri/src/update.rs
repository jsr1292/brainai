//! Updates (plan 2): the daily check for a signed release, the state the server shows on Home (update.json), the tray
//! dot, and Update and restart (download, signature check, backup, install, reopen).
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Url;

/// How often the app asks GitHub for a newer signed release.
pub const CHECK_EVERY: Duration = Duration::from_secs(24 * 3600);

/// Whether a check is due: never checked, at least a day ago, or a clock that moved backwards.
pub fn due(last_check_unix: Option<u64>, now_unix: u64) -> bool {
    match last_check_unix {
        None => true,
        Some(last) => last > now_unix || now_unix - last >= CHECK_EVERY.as_secs(),
    }
}

/// Said on the card when the app runs from a disk image or from the temporary copy macOS makes of a quarantined app.
pub const MOVE_FIRST: &str = "BrainAI can't update itself while it runs from a disk image or a temporary copy. Move BrainAI to Applications and open it from there, or download the new version.";
/// Said on the card when the app cannot replace its own files where it is installed.
pub const NOT_WRITABLE: &str = "BrainAI can't replace its own files where it is installed, so download it again and install it over this one.";

/// Whether this copy of the app can replace itself: a real install (the same rule as the login item) in a folder it
/// can write to. Err is the sentence for the `blocked` card.
pub fn can_self_update(exe: &str, bundle_dir_writable: bool) -> Result<(), &'static str> {
    if !crate::nav::install_location_ok(exe) {
        return Err(MOVE_FIRST);
    }
    if !bundle_dir_writable {
        return Err(NOT_WRITABLE);
    }
    Ok(())
}

/// Where an update stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stage {
    Download,
    Signature,
    Install,
    /// With the server's own plain sentence.
    Backup(String),
}

/// What the `failed` card says went wrong: fixed plain sentences, never a path or a raw error. The card itself adds
/// that `current` is still running, so it is not repeated here.
pub fn problem_text(stage: Stage, current: &str) -> String {
    let _ = current;
    match stage {
        Stage::Download => "The new version could not be downloaded. Check the internet connection and try again.".into(),
        Stage::Signature => "The download did not pass its signature check, so nothing was installed.".into(),
        Stage::Install => "The new version could not be installed.".into(),
        Stage::Backup(said) => {
            // The server cleans its folders out of the sentence; anything that still looks like a path is not shown.
            let said = said.trim();
            let said = if said.is_empty() || said.contains('/') || said.contains('\\') { "The backup did not finish." } else { said };
            format!("A backup could not be made, so nothing was changed: {said}")
        }
    }
}

/// The plugin's download also checks the signature: an error from that check is a signature failure, the rest are
/// download failures.
pub fn download_stage(e: &tauri_plugin_updater::Error) -> Stage {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => Stage::Signature,
        _ => Stage::Download,
    }
}

/// The percentage to write after `done` of `total` bytes, when it moved at least two points since `last_written` (or
/// reached 100); None otherwise, or when the size is unknown.
pub fn progress(done: u64, total: Option<u64>, last_written: Option<u8>) -> Option<u8> {
    let total = total.filter(|t| *t > 0)?;
    let p = (done.saturating_mul(100) / total).min(100) as u8;
    match last_written {
        None => Some(p),
        Some(last) if p >= last.saturating_add(2) || (p == 100 && last < 100) => Some(p),
        Some(_) => None,
    }
}

/// The update's state as the server reads it (`src/desktop/updateState.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Available,
    BackingUp,
    Downloading,
    Installing,
    Failed,
    Blocked,
}

impl State {
    fn busy(self) -> bool {
        matches!(self, State::BackingUp | State::Downloading | State::Installing)
    }
}

/// `<data>/update.json`, written only by the app; the server only reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateFile {
    pub current: String,
    pub version: String,
    pub notes: String,
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub problem: Option<String>,
}

const STATE_FILE: &str = "update.json";

/// Writes the state whole: to `update.json.tmp`, then renamed over `update.json`, so the server never reads half a file.
pub fn write_state(data: &Path, f: &UpdateFile) -> io::Result<()> {
    std::fs::create_dir_all(data)?;
    let tmp = data.join(format!("{STATE_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(f)?)?;
    std::fs::rename(&tmp, data.join(STATE_FILE)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

pub fn read_state(data: &Path) -> Option<UpdateFile> {
    serde_json::from_slice(&std::fs::read(data.join(STATE_FILE)).ok()?).ok()
}

/// `<data>/update-check.json`, written only by the app (the server reads it for Settings): how the checks for a newer
/// release have gone, in unix seconds. `failingSince` starts with the first failed check after a good one and goes
/// with the next good one; `lastFailAt` is the latest failed check.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateCheck {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ok_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failing_since: Option<u64>,
    /// The time of the latest failed check; Settings warns only when this is two days past `failing_since`, so a
    /// laptop that was off for days after one failure says nothing before it has tried again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_fail_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

const CHECK_FILE: &str = "update-check.json";

/// A good check: the time is kept, the failure is gone.
pub fn record_ok(prev: UpdateCheck, now: u64) -> UpdateCheck {
    let _ = prev;
    UpdateCheck { last_ok_at: Some(now), failing_since: None, last_fail_at: None, last_error: None }
}

/// A failed check: the failing clock starts if it is not running, and the reason is the latest.
pub fn record_failure(prev: UpdateCheck, now: u64, error: &str) -> UpdateCheck {
    UpdateCheck { failing_since: prev.failing_since.or(Some(now)), last_fail_at: Some(now), last_error: Some(short_error(error)), ..prev }
}

/// The reason as Settings shows it: the first line, at most 200 characters.
pub fn short_error(e: &str) -> String {
    let line = e.trim().lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return "The check failed.".into();
    }
    line.chars().take(200).collect()
}

/// An error and each of its causes (`Error::source`), so the log shows the real reason (a proxy, a certificate, DNS)
/// and not only the plugin's own sentence.
pub fn error_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cause = e.source();
    while let Some(c) = cause {
        out.push_str(&format!(": caused by: {c}"));
        cause = c.source();
    }
    out
}

/// Where the release endpoints are written in tauri.conf.json (`plugins.updater.endpoints`).
pub fn configured_endpoints(updater_config: Option<&serde_json::Value>) -> Vec<String> {
    updater_config
        .and_then(|c| c.get("endpoints"))
        .and_then(|e| e.as_array())
        .map(|a| a.iter().filter_map(|u| u.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

/// What an endpoint's answer means in a sentence: "github.com answered HTTP 407 (Proxy Authentication Required)".
pub fn status_reason(host: &str, status: u16, canonical: Option<&str>) -> String {
    match canonical {
        Some(text) if !text.is_empty() => format!("{host} answered HTTP {status} ({text})"),
        _ => format!("{host} answered HTTP {status}"),
    }
}

/// The plugin reports a non-2xx answer only as "Could not fetch a valid release JSON from the remote" and logs the
/// status where nothing reads it. One plain GET of the same endpoint (same timeout, the system proxy) finds the
/// real reason: the status the server or a proxy gave, or why the connection failed.
async fn probe_endpoint(url: &Url, timeout: Duration) -> String {
    let host = url.host_str().unwrap_or("the update server").to_owned();
    let client = match reqwest::Client::builder().timeout(timeout).user_agent("BrainAI update check").build() {
        Ok(c) => c,
        Err(e) => return error_chain(&e.without_url()),
    };
    match client.get(url.as_str()).send().await {
        Ok(res) => {
            let status = res.status();
            status_reason(&host, status.as_u16(), status.canonical_reason())
        }
        Err(e) => error_chain(&e.without_url()),
    }
}

/// Written whole, like `write_state`: to a temporary file, then renamed.
pub fn write_check(data: &Path, c: &UpdateCheck) -> io::Result<()> {
    std::fs::create_dir_all(data)?;
    let tmp = data.join(format!("{CHECK_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(c)?)?;
    std::fs::rename(&tmp, data.join(CHECK_FILE)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Absent or broken reads as nothing known yet.
pub fn read_check(data: &Path) -> UpdateCheck {
    std::fs::read(data.join(CHECK_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// No update known: the card goes away.
pub fn clear_state(data: &Path) {
    let _ = std::fs::remove_file(data.join(STATE_FILE));
}

/// x.y.z compared as numbers, exactly as the server compares them (updateState.ts: `parseInt` of each part, which
/// reads its leading digits, so `3-beta` is 3; no digits counts as 0).
fn newer(a: &str, b: &str) -> bool {
    let num = |n: &str| -> u64 {
        let n = n.trim_start();
        let end = n.find(|c: char| !c.is_ascii_digit()).unwrap_or(n.len());
        n[..end].parse().unwrap_or(0)
    };
    let parts = |v: &str| -> Vec<u64> { v.split('.').map(num).collect() };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..3 {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// What to do at start with the state an earlier run left.
#[derive(Debug, Clone, PartialEq)]
pub enum Leftover {
    Keep,
    /// An older version's state: the card goes away.
    Remove,
    /// The update that just ran (its version is this app's now): the card goes away, and the window shows even when
    /// the app was started hidden at login (the restart keeps `--hidden`).
    JustUpdated,
    /// An update stopped half way: offered again rather than left showing progress that will never move.
    Reset(UpdateFile),
}

pub fn left_over(f: &UpdateFile, app_version: &str) -> Leftover {
    if !newer(&f.version, app_version) {
        return if f.state == State::Installing { Leftover::JustUpdated } else { Leftover::Remove };
    }
    if f.state.busy() {
        return Leftover::Reset(UpdateFile { state: State::Available, percent: None, problem: None, ..f.clone() });
    }
    Leftover::Keep
}

/// BRAINAI_UPDATE_ENDPOINT, for testing a release by hand: https anywhere, plain http only to this computer.
/// tauri.conf.json sets `dangerousInsecureTransportProtocol` only so this http-to-127.0.0.1 test works: the configured
/// endpoint stays https, this refuses http anywhere else, and every download must pass the signature check whatever
/// carried it.
pub fn endpoint_override(env: Option<&str>) -> Option<Url> {
    let url = Url::parse(env?.trim()).ok()?;
    match url.scheme() {
        "https" => Some(url),
        "http" if matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")) => Some(url),
        _ => None,
    }
}

// ---- The app's side: checking, the dot, and Update and restart. ----

use crate::{app_data, server, Running};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The first check waits a minute after the app starts; then the app looks every hour whether a day has passed.
const FIRST_CHECK: Duration = Duration::from_secs(60);
const LOOK_EVERY: Duration = Duration::from_secs(3600);
/// The whole check (the small latest.json).
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// The download has no overall limit (it can be large on a slow line); it gives up when nothing arrives for a minute.
const STALLED: Duration = Duration::from_secs(60);

/// The server's data folder (its DATA_DIR), where it reads update.json.
fn state_dir(app: &AppHandle) -> PathBuf {
    app_data(app).join("data")
}

fn checked_file(app: &AppHandle) -> PathBuf {
    app_data(app).join(".update-checked")
}

fn now_unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// One line in `logs/update.log`; nothing on screen.
fn log(app: &AppHandle, line: &str) {
    use std::io::Write;
    let dir = app_data(app).join("logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("update.log")) {
        let _ = writeln!(f, "{} {line}", now_unix());
    }
}

/// Whether the folder the app is replaced in can be written: the one holding the `.app` on the Mac, the
/// executable's own on Windows. Tried by creating a file there.
fn bundle_dir_writable(exe: &str) -> bool {
    let dir = match crate::nav::app_bundle(exe) {
        Some(bundle) => Path::new(bundle).parent().map(Path::to_path_buf),
        None => Path::new(exe).parent().map(Path::to_path_buf),
    };
    let Some(dir) = dir else { return false };
    let probe = dir.join(format!(".brainai-update-{}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => std::fs::remove_file(&probe).is_ok(),
        Err(_) => false,
    }
}

fn self_update_check() -> Result<(), &'static str> {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    can_self_update(&exe, bundle_dir_writable(&exe))
}

/// Asks the release endpoint (or BRAINAI_UPDATE_ENDPOINT) whether a newer signed release exists.
fn check(app: &AppHandle) -> Result<Option<Update>, tauri_plugin_updater::Error> {
    let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT).configure_client(|c| c.read_timeout(STALLED));
    if let Some(url) = endpoint_override(std::env::var("BRAINAI_UPDATE_ENDPOINT").ok().as_deref()) {
        builder = builder.endpoints(vec![url])?;
    }
    // Windows: the installer exits the app itself; that exit is the update, never a crash.
    let leaving = app.clone();
    builder = builder.on_before_exit(move || leaving.state::<Running>().quitting.store(true, Ordering::SeqCst));
    let updater = builder.build()?;
    tauri::async_runtime::block_on(updater.check())
}

/// The endpoint a check asked: BRAINAI_UPDATE_ENDPOINT when set, else the first of tauri.conf.json's.
fn probe_url(app: &AppHandle) -> Option<Url> {
    if let Some(url) = endpoint_override(std::env::var("BRAINAI_UPDATE_ENDPOINT").ok().as_deref()) {
        return Some(url);
    }
    let cfg = app.config().plugins.0.get("updater");
    configured_endpoints(cfg).first().and_then(|u| Url::parse(u).ok())
}

/// One update job at a time: a check and its write, or the whole Update and restart. Only ever taken on background
/// threads (never the main thread, never inside on_navigation), so a click during a check just waits for it.
fn update_lock(app: &AppHandle) -> std::sync::MutexGuard<'_, ()> {
    let state = app.state::<Running>().inner();
    state.update_lock.lock().unwrap_or_else(|e| e.into_inner())
}

fn file_for(update: &Update, state: State, problem: Option<String>) -> UpdateFile {
    UpdateFile {
        current: update.current_version.clone(),
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        state,
        percent: None,
        problem,
    }
}

/// A newer release: kept for Update and restart, shown on Home (or `blocked` with why), and the dot in the tray.
fn offer(app: &AppHandle, update: Update) {
    let state = match self_update_check() {
        Ok(()) => file_for(&update, State::Available, None),
        Err(why) => file_for(&update, State::Blocked, Some(why.into())),
    };
    if let Err(e) = write_state(&state_dir(app), &state) {
        log(app, &format!("update.json could not be written: {e}"));
    }
    crate::show_update_dot(app, Some(&update.version));
    *app.state::<Running>().update.lock().unwrap() = Some(update);
}

fn no_update(app: &AppHandle) {
    *app.state::<Running>().update.lock().unwrap() = None;
    clear_state(&state_dir(app));
    crate::show_update_dot(app, None);
}

/// One check, then the time it was made. An error is logged with its causes and recorded in update-check.json (Settings
/// says so after two days); nothing else changes on screen, and the next look tries again.
fn check_now(app: &AppHandle) {
    let _job = update_lock(app);
    // Update and restart may have started (and finished) while this waited: its state is not overwritten.
    if app.state::<Running>().updating.load(Ordering::SeqCst) {
        return;
    }
    match check(app) {
        Ok(Some(update)) => offer(app, update),
        Ok(None) => no_update(app),
        Err(e) => {
            let mut chain = error_chain(&e);
            if matches!(e, tauri_plugin_updater::Error::ReleaseNotFound) {
                if let Some(url) = probe_url(app) {
                    chain = tauri::async_runtime::block_on(probe_endpoint(&url, CHECK_TIMEOUT));
                }
            }
            log(app, &format!("The update check failed: {chain}"));
            let dir = state_dir(app);
            if let Err(w) = write_check(&dir, &record_failure(read_check(&dir), now_unix(), &chain)) {
                log(app, &format!("update-check.json could not be written: {w}"));
            }
            return;
        }
    }
    let dir = state_dir(app);
    if let Err(w) = write_check(&dir, &record_ok(read_check(&dir), now_unix())) {
        log(app, &format!("update-check.json could not be written: {w}"));
    }
    let _ = std::fs::write(checked_file(app), now_unix().to_string());
}

/// Before the server starts: the state of the update that just ran (its version is this app's now) is removed, and an
/// update stopped half way is offered again. A state that stays shows the dot.
/// Returns true right after an update, when the window must show whatever the start's arguments say.
pub fn settle_at_start(app: &AppHandle) -> bool {
    let dir = state_dir(app);
    let Some(f) = read_state(&dir) else { return false };
    let kept = match left_over(&f, &app.package_info().version.to_string()) {
        Leftover::Remove => {
            clear_state(&dir);
            return false;
        }
        Leftover::JustUpdated => {
            clear_state(&dir);
            return true;
        }
        Leftover::Keep => f,
        Leftover::Reset(f) => {
            let _ = write_state(&dir, &f);
            f
        }
    };
    crate::show_update_dot(app, Some(&kept.version));
    false
}

/// A minute after the start, then every hour, a check when the last one is a day old.
pub fn start_checker(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            let state = app.state::<Running>();
            if state.quitting.load(Ordering::SeqCst) {
                return;
            }
            let last = std::fs::read_to_string(checked_file(&app)).ok().and_then(|s| s.trim().parse().ok());
            // check_now also waits for a running Update and restart, and then leaves its state alone.
            if due(last, now_unix()) && !state.updating.load(Ordering::SeqCst) {
                check_now(&app);
            }
            std::thread::sleep(LOOK_EVERY);
        }
    });
}

/// Home again (the window has its session), so the card shows the new state and follows it while busy. Only when the
/// window is still on Home: after a slow re-check it may have moved on, and is left where it is.
fn reload_home(app: &AppHandle, port: u16) {
    let Some(w) = app.get_webview_window(crate::MAIN) else { return };
    let on_home = w.url().map(|u| crate::nav::is_home(u.as_str(), port)).unwrap_or(false);
    if let (true, Ok(url)) = (on_home, format!("http://localhost:{port}/").parse()) {
        let _ = w.navigate(url);
    }
}

/// Update and restart, from the card on Home: download, check the signature, back up, install, reopen. Only for a
/// server that proves it is ours, one at a time, and never during a restart.
pub fn update_and_restart(app: &AppHandle) {
    let state = app.state::<Running>();
    let port = state.port.load(Ordering::SeqCst);
    let secret = state.secret.lock().unwrap().clone();
    if port == 0 || secret.is_empty() || !matches!(server::check_once(port, &secret), Ok(true)) {
        return;
    }
    if state.updating.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }
    // Set first, then checked (restart_server does the reverse with `restarting`): the two never both go ahead.
    if state.restarting.load(Ordering::SeqCst) {
        state.updating.store(false, Ordering::SeqCst);
        return;
    }
    {
        // Waits for a check under way, which then leaves the state to this job.
        let _job = update_lock(app);
        run_update(app, port, &secret);
    }
    state.updating.store(false, Ordering::SeqCst);
}

fn run_update(app: &AppHandle, port: u16, secret: &str) {
    let dir = state_dir(app);
    let state = app.state::<Running>();
    let kept = state.update.lock().unwrap().clone();
    let update = match kept {
        Some(u) => u,
        None => match check(app) {
            Ok(Some(u)) => {
                *state.update.lock().unwrap() = Some(u.clone());
                u
            }
            Ok(None) => {
                no_update(app);
                return reload_home(app, port);
            }
            Err(e) => {
                log(app, &format!("The update check failed: {e}"));
                if let Some(f) = read_state(&dir) {
                    let _ = write_state(&dir, &UpdateFile { state: State::Failed, percent: None, problem: Some(problem_text(Stage::Download, &f.current)), ..f });
                }
                return reload_home(app, port);
            }
        },
    };
    let current = update.current_version.clone();
    let write = |s: State, percent: Option<u8>, problem: Option<String>| {
        let _ = write_state(&dir, &UpdateFile { percent, ..file_for(&update, s, problem) });
    };
    // After a failure the kept release is dropped: Try again asks the endpoint afresh (a release may have been fixed).
    let failed = |stage: Stage| {
        *state.update.lock().unwrap() = None;
        write(State::Failed, None, Some(problem_text(stage, &current)));
    };

    if let Err(why) = self_update_check() {
        write(State::Blocked, None, Some(why.into()));
        return reload_home(app, port);
    }

    write(State::Downloading, None, None);
    reload_home(app, port);
    let mut download = update.clone();
    download.timeout = None; // the 30 s were for the check; a stalled download still stops (STALLED)
    let (mut done, mut last) = (0u64, None);
    let bytes = tauri::async_runtime::block_on(download.download(
        |n, total| {
            done += n as u64;
            if let Some(p) = progress(done, total, last) {
                last = Some(p);
                write(State::Downloading, Some(p), None);
            }
        },
        || {},
    ));
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            log(app, &format!("The update download failed: {e}"));
            return failed(download_stage(&e));
        }
    };
    if let Err(e) = update.verify(&bytes) {
        log(app, &format!("The update did not pass its signature check: {e}"));
        return failed(Stage::Signature);
    }

    // After the download and its check, so a failed download never costs a backup.
    write(State::BackingUp, None, None);
    if let Err(said) = server::backup_now(port, secret) {
        log(app, &format!("The backup before the update failed: {said}"));
        return failed(Stage::Backup(said));
    }

    write(State::Installing, None, None);
    // The app stops its own server: the crash watcher of this start stands down.
    state.restarting.store(true, Ordering::SeqCst);
    state.epoch.fetch_add(1, Ordering::SeqCst);
    crate::stop_server(app);
    // Windows: install runs the installer (passive, with its own progress window) and exits the app; its NSIS hooks
    // stop any node.exe left. The Mac: the new app is in place, and the restart opens it on Home, where the button was.
    match update.install(&bytes) {
        Ok(()) => {
            state.quitting.store(true, Ordering::SeqCst);
            app.restart();
        }
        Err(e) => {
            log(app, &format!("The update could not be installed: {e}"));
            failed(Stage::Install);
            // The running version stays: its server starts again and the window shows the failed card.
            state.restarts.store(0, Ordering::SeqCst);
            crate::launch(app.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3600;

    #[test]
    fn a_check_is_due_once_a_day_and_whenever_the_clock_looks_wrong() {
        let now = 1_800_000_000;
        assert!(due(None, now), "never checked");
        assert!(!due(Some(now - 23 * HOUR), now), "23 hours ago");
        assert!(due(Some(now - 24 * HOUR), now), "24 hours ago");
        assert!(due(Some(now + HOUR), now), "the clock moved backwards");
        assert_eq!(CHECK_EVERY, Duration::from_secs(24 * HOUR));
    }

    #[test]
    fn the_app_updates_itself_only_from_a_real_install_it_can_write_to() {
        assert_eq!(can_self_update("/Applications/BrainAI.app/Contents/MacOS/brainai", true), Ok(()));
        let translocated = can_self_update("/private/var/folders/x/AppTranslocation/1234/d/BrainAI.app/Contents/MacOS/brainai", true);
        assert!(translocated.unwrap_err().contains("Move BrainAI to Applications"));
        assert_eq!(can_self_update("/Volumes/BrainAI/BrainAI.app/Contents/MacOS/brainai", true), translocated, "a disk image: the same");
        assert!(can_self_update("/Applications/BrainAI.app/Contents/MacOS/brainai", false).unwrap_err().contains("download it again"));
        assert_eq!(can_self_update(r"C:\Users\Ana\AppData\Local\BrainAI\brainai.exe", true), Ok(()), "Windows, under %LOCALAPPDATA%");
    }

    #[test]
    fn what_went_wrong_is_a_fixed_plain_sentence() {
        assert_eq!(problem_text(Stage::Download, "1.2.0"), "The new version could not be downloaded. Check the internet connection and try again.");
        assert_eq!(problem_text(Stage::Signature, "1.2.0"), "The download did not pass its signature check, so nothing was installed.");
        assert_eq!(problem_text(Stage::Install, "1.2.0"), "The new version could not be installed.");
        assert_eq!(problem_text(Stage::Backup("The disk is full.".into()), "1.2.0"), "A backup could not be made, so nothing was changed: The disk is full.");
        let all = [Stage::Download, Stage::Signature, Stage::Install, Stage::Backup("The disk is full.".into()), Stage::Backup("EACCES /Users/ana/x".into()), Stage::Backup(r"C:\Users\ana".into())];
        for stage in all {
            let t = problem_text(stage, "1.2.0");
            assert!(!t.contains("/Users/") && !t.contains('\\'), "{t}");
        }
    }

    #[test]
    fn a_download_that_fails_its_signature_says_so() {
        use tauri_plugin_updater::Error;
        assert_eq!(download_stage(&Error::Network("timed out".into())), Stage::Download);
        assert_eq!(download_stage(&Error::SignatureUtf8("x".into())), Stage::Signature);
        assert_eq!(download_stage(&Error::MissingSignedVersion), Stage::Signature);
        assert_eq!(download_stage(&Error::SignedVersionMismatch { signed: "1.0.0".into(), announced: "9.0.0".into() }), Stage::Signature);
    }

    #[test]
    fn the_percentage_is_written_at_most_every_two_points() {
        assert_eq!(progress(0, Some(1000), None), Some(0), "the first one");
        assert_eq!(progress(10, Some(1000), Some(0)), None, "1%");
        assert_eq!(progress(20, Some(1000), Some(0)), Some(2));
        assert_eq!(progress(1000, Some(1000), Some(99)), Some(100), "the end always counts");
        assert_eq!(progress(500, None, None), None, "no size known");
        assert_eq!(progress(2000, Some(1000), Some(98)), Some(100), "never over 100");
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("brainai-update-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_state_is_written_whole_with_the_servers_field_names() {
        let d = scratch("write");
        let f = UpdateFile { current: "1.2.0".into(), version: "1.2.1".into(), notes: "- Faster search".into(), state: State::Downloading, percent: Some(42), problem: None };
        write_state(&d, &f).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(d.join("update.json")).unwrap()).unwrap();
        assert_eq!(v, serde_json::json!({ "current": "1.2.0", "version": "1.2.1", "notes": "- Faster search", "state": "downloading", "percent": 42 }));
        let failed = UpdateFile { state: State::Failed, percent: None, problem: Some(problem_text(Stage::Install, "1.2.0")), ..f };
        write_state(&d, &failed).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(d.join("update.json")).unwrap()).unwrap();
        assert_eq!(v["state"], "failed");
        assert_eq!(v["problem"], "The new version could not be installed.");
        assert!(v.get("percent").is_none());
        assert!(!d.join("update.json.tmp").exists(), "no temporary file left");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
        for (s, name) in [(State::Available, "available"), (State::BackingUp, "backing-up"), (State::Installing, "installing"), (State::Blocked, "blocked")] {
            assert_eq!(serde_json::to_value(s).unwrap(), name);
        }
        assert_eq!(read_state(&d), Some(failed));
        clear_state(&d);
        assert!(!d.join("update.json").exists());
        clear_state(&d); // nothing there: no panic
        assert_eq!(read_state(&d), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn at_start_the_state_of_the_update_that_just_ran_is_removed() {
        let f = |version: &str, state: State| UpdateFile { current: "1.2.0".into(), version: version.into(), notes: String::new(), state, percent: Some(40), problem: None };
        assert_eq!(left_over(&f("1.2.1", State::Installing), "1.2.1"), Leftover::JustUpdated, "this is that version now: the window shows");
        assert_eq!(left_over(&f("1.2.1", State::Installing), "1.2.2"), Leftover::JustUpdated, "or a newer one");
        assert_eq!(left_over(&f("1.2.1", State::Failed), "1.2.1"), Leftover::Remove, "not an install that just ran");
        assert_eq!(left_over(&f("1.2.0", State::Available), "1.2.1"), Leftover::Remove, "older");
        assert_eq!(left_over(&f("1.2.10", State::Available), "1.2.9"), Leftover::Keep, "compared as numbers");
        assert_eq!(left_over(&f("1.3.0", State::Failed), "1.2.0"), Leftover::Keep);
        assert_eq!(left_over(&f("1.3.0", State::Blocked), "1.2.0"), Leftover::Keep);
        // An update stopped half way (the app was quit or crashed): still on offer, not stuck "busy".
        let reset = UpdateFile { state: State::Available, percent: None, ..f("1.3.0", State::Available) };
        for busy in [State::BackingUp, State::Downloading, State::Installing] {
            assert_eq!(left_over(&f("1.3.0", busy), "1.2.0"), Leftover::Reset(reset.clone()));
        }
    }

    #[test]
    fn versions_compare_as_the_server_compares_them() {
        // updateState.ts: parseInt of each of the first three parts (its leading digits), anything else 0.
        assert!(!newer("1.2.3-beta.1", "1.2.3"), "parseInt('3-beta') is 3: the same version");
        assert!(!newer("1.2.3", "1.2.3-beta.1"));
        assert!(newer("1.2.10-rc", "1.2.9"), "parseInt('10-rc') is 10");
        assert!(!newer("1.2.9", "1.2.10-rc"));
        assert!(newer("1.10.0", "1.9.9"));
        assert!(!newer("1.2.0", "1.2.0"));
        assert!(newer("2", "1.9.9"), "missing parts are 0");
        assert!(!newer("x.y.z", "0.0.0"), "parseInt('x') is NaN, so 0");
    }

    #[test]
    fn a_test_endpoint_is_https_or_this_computer_only() {
        assert_eq!(endpoint_override(Some("https://example.com/l.json")).map(|u| u.to_string()), Some("https://example.com/l.json".into()));
        assert!(endpoint_override(Some("http://127.0.0.1:8765/latest.json")).is_some());
        assert!(endpoint_override(Some("http://localhost:8765/latest.json")).is_some());
        assert_eq!(endpoint_override(Some("http://example.com/l.json")), None);
        assert_eq!(endpoint_override(Some("http://127.0.0.1.example.com/l.json")), None);
        assert_eq!(endpoint_override(Some("file:///etc/passwd")), None);
        assert_eq!(endpoint_override(Some("not a url")), None);
        assert_eq!(endpoint_override(Some("")), None);
        assert_eq!(endpoint_override(None), None);
    }

    #[test]
    fn a_failed_check_starts_the_failing_clock_once_and_keeps_the_last_good_time() {
        let first = record_failure(UpdateCheck { last_ok_at: Some(100), ..Default::default() }, 1000, "no route");
        assert_eq!(first, UpdateCheck { last_ok_at: Some(100), failing_since: Some(1000), last_fail_at: Some(1000), last_error: Some("no route".into()) });
        let again = record_failure(first, 5000, "still no route");
        assert_eq!(again.failing_since, Some(1000), "the start does not move");
        assert_eq!(again.last_fail_at, Some(5000), "the latest failure does");
        assert_eq!(again.last_error.as_deref(), Some("still no route"), "the reason is the latest");
        assert_eq!(again.last_ok_at, Some(100));
    }

    #[test]
    fn a_good_check_clears_the_failure() {
        let failing = UpdateCheck { last_ok_at: Some(100), failing_since: Some(1000), last_fail_at: Some(2000), last_error: Some("no route".into()) };
        assert_eq!(record_ok(failing, 9000), UpdateCheck { last_ok_at: Some(9000), failing_since: None, last_fail_at: None, last_error: None });
    }

    #[test]
    fn the_short_error_is_one_line_and_cut() {
        assert_eq!(short_error("  first line\nsecond line  "), "first line");
        assert_eq!(short_error(""), "The check failed.");
        assert_eq!(short_error(&"x".repeat(500)).chars().count(), 200);
    }

    #[test]
    fn the_error_chain_lists_every_cause() {
        #[derive(Debug)]
        struct Inner;
        impl std::fmt::Display for Inner {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "proxy refused the connection") }
        }
        impl std::error::Error for Inner {}
        #[derive(Debug)]
        struct Outer(Inner);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "Could not fetch a valid release JSON from the remote") }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(&self.0) }
        }
        assert_eq!(error_chain(&Outer(Inner)), "Could not fetch a valid release JSON from the remote: caused by: proxy refused the connection");
        assert_eq!(error_chain(&Inner), "proxy refused the connection", "no source, no suffix");
    }

    #[test]
    fn the_check_file_uses_the_names_the_server_reads_and_leaves_out_what_is_unset() {
        let c = UpdateCheck { last_ok_at: Some(5), failing_since: None, last_fail_at: None, last_error: None };
        assert_eq!(serde_json::to_string(&c).unwrap(), r#"{"lastOkAt":5}"#);
        let c = UpdateCheck { last_ok_at: None, failing_since: Some(7), last_fail_at: Some(9), last_error: Some("x".into()) };
        assert_eq!(serde_json::to_string(&c).unwrap(), r#"{"failingSince":7,"lastFailAt":9,"lastError":"x"}"#);
    }

    #[test]
    fn the_check_file_round_trips_and_a_broken_one_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("brainai-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_check(&dir), UpdateCheck::default());
        let c = UpdateCheck { last_ok_at: Some(1), failing_since: Some(2), last_fail_at: Some(3), last_error: Some("e".into()) };
        write_check(&dir, &c).unwrap();
        assert_eq!(read_check(&dir), c);
        assert!(!dir.join("update-check.json.tmp").exists());
        std::fs::write(dir.join("update-check.json"), b"{nope").unwrap();
        assert_eq!(read_check(&dir), UpdateCheck::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_status_becomes_a_short_reason() {
        assert_eq!(status_reason("github.com", 407, Some("Proxy Authentication Required")), "github.com answered HTTP 407 (Proxy Authentication Required)");
        assert_eq!(status_reason("github.com", 403, Some("Forbidden")), "github.com answered HTTP 403 (Forbidden)");
        assert_eq!(status_reason("example.org", 599, None), "example.org answered HTTP 599");
        assert_eq!(status_reason("example.org", 599, Some("")), "example.org answered HTTP 599");
    }

    #[test]
    fn the_endpoints_are_read_from_the_updater_config() {
        let cfg = serde_json::json!({ "endpoints": ["https://a.example/latest.json", 5, "https://b.example/l.json"], "pubkey": "k" });
        assert_eq!(configured_endpoints(Some(&cfg)), vec!["https://a.example/latest.json", "https://b.example/l.json"]);
        assert!(configured_endpoints(Some(&serde_json::json!({}))).is_empty());
        assert!(configured_endpoints(None).is_empty());
    }

    #[test]
    fn an_old_check_file_without_the_latest_failure_still_reads() {
        let c: UpdateCheck = serde_json::from_str(r#"{"failingSince":7,"lastError":"x"}"#).unwrap();
        assert_eq!(c.last_fail_at, None);
        assert_eq!(c.failing_since, Some(7));
    }
}
