//! Running the bundled server: its environment, waiting until it answers as ours, and the window's ticket.
use crate::proof;
use std::path::Path;
use std::time::{Duration, Instant};

/// A Windows long-form path (`\\?\C:\…`, `\\?\UNC\server\share\…`) in its plain form, which Node can open: Tauri's
/// resource folder comes from `canonicalize`, which adds the prefix, and Node fails on such a script path with
/// "EISDIR … lstat 'C:'". Left as it is when the plain form would mean something else or not work: over 259
/// characters, or a part that Windows treats specially in plain form (CON, NUL, COM1…, or ending in a dot or space).
pub fn plain_path(p: &str) -> String {
    let plain = if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' { rest.to_string() } else { return p.to_string() }
    } else {
        return p.to_string();
    };
    let special = |part: &str| {
        let stem = part.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        part.ends_with('.') || part.ends_with(' ')
            || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
            || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit())
    };
    if plain.chars().count() > 259 || plain.split('\\').skip(1).any(special) { p.to_string() } else { plain }
}

/// Exactly what the server is started with: local mode on this port, data in the app-data folder, the models it
/// downloads in the app-data folder too (never in the app, which an update replaces), this start's key, a pipe it
/// watches so it stops when the app is gone, and the system proxy (for those downloads).
/// On Windows `system` carries the system variables Node and the tools need (empty on the Mac).
#[allow(clippy::too_many_arguments)]
pub fn env(app_data: &Path, port: u16, secret: &str, timezone: Option<&str>, locale: Option<&str>, tmpdir: Option<&str>, tool_path: &str, system: &[(String, String)], proxy: &Proxy) -> Vec<(String, String)> {
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let mut env = vec![
        ("LOCAL_MODE".into(), "true".into()),
        ("HOST".into(), "127.0.0.1".into()),
        ("PORT".into(), port.to_string()),
        ("PUBLIC_URL".into(), format!("http://localhost:{port}")),
        ("DATA_DIR".into(), path(&app_data.join("data"))),
        ("BACKUP_DIR".into(), path(&app_data.join("backups"))),
        ("OVERLAY_DIR".into(), path(&app_data.join("overlay"))),
        ("MODEL_DIR".into(), path(&app_data.join("models"))),
        ("APP_SECRET".into(), secret.into()),
        ("APP_PARENT".into(), "stdin".into()),
        ("NODE_ENV".into(), "production".into()),
        ("TRUST_CF_CONNECTING_IP".into(), "false".into()),
        // Where Connect finds claude, codex and opencode (D3): the owner's login-shell PATH.
        ("TOOL_PATH".into(), tool_path.into()),
    ];
    // Days and weeks follow the owner's clock (UTC when it isn't set).
    if let Some(tz) = timezone {
        env.push(("OWNER_TIMEZONE".into(), tz.into()));
    }
    // The operating system's language (`es-ES`), for a server whose language choice is `auto`: the desktop WebView
    // sends Accept-Language en-US even on a Spanish Mac (docs/I18N.md).
    if let Some(l) = locale.filter(|l| !l.trim().is_empty()) {
        env.push(("BRAINAI_SYSTEM_LOCALE".into(), l.trim().into()));
    }
    // The owner's private temporary folder: the backup's working copy (with sign-in data) must not go to /tmp.
    if let Some(t) = tmpdir {
        env.push(("TMPDIR".into(), t.into()));
    }
    // Windows (D6): the home, app-data and temp folders Node and the tools use, and a PATH with the system's own
    // commands (tar for the moving file, explorer to show it); the coding tools are found on TOOL_PATH instead.
    env.extend(system.iter().cloned());
    if let Some((_, root)) = system.iter().find(|(k, _)| k == "SystemRoot") {
        env.push(("PATH".into(), format!("{root}\\System32;{root}")));
    }
    env.extend(proxy_env(proxy));
    env
}

/// The system's web proxy, as Node's fetch takes it: proxy URLs for http and https, and the hosts that skip it.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Proxy {
    pub http: Option<String>,
    pub https: Option<String>,
    pub no_proxy: Vec<String>,
}

/// The variables for `p` (none without an https proxy). Node 22's own fetch reads HTTPS_PROXY / HTTP_PROXY / NO_PROXY
/// only with NODE_USE_ENV_PROXY=1; this computer's own addresses never go through the proxy. With only a proxy for
/// plain http nothing is passed: Node would send https through it too (the system does not), and every download the
/// server makes is https.
pub fn proxy_env(p: &Proxy) -> Vec<(String, String)> {
    if p.https.is_none() {
        return Vec::new();
    }
    let mut env = Vec::new();
    if let Some(u) = &p.https {
        env.push(("HTTPS_PROXY".into(), u.clone()));
    }
    if let Some(u) = &p.http {
        env.push(("HTTP_PROXY".into(), u.clone()));
    }
    let mut skip = p.no_proxy.clone();
    for own in ["localhost", "127.0.0.1", "::1"] {
        if !skip.iter().any(|s| s == own) {
            skip.push(own.into());
        }
    }
    env.push(("NO_PROXY".into(), skip.join(",")));
    env.push(("NODE_USE_ENV_PROXY".into(), "1".into()));
    env
}

/// `host` and `port` as a proxy URL (an address that already names its scheme is kept as it is).
fn proxy_url(host: &str, port: Option<&str>) -> Option<String> {
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    if host.contains("://") {
        return Some(host.to_string());
    }
    let host = if host.contains(':') && !host.starts_with('[') && port.is_some() { format!("[{host}]") } else { host.to_string() };
    Some(match port.map(str::trim).filter(|p| !p.is_empty() && *p != "0") {
        Some(port) => format!("http://{host}:{port}"),
        None => format!("http://{host}"),
    })
}

/// A bypass entry as NO_PROXY writes it: `*.example.com` is `.example.com`; WinINet's `<local>` has no equivalent.
fn bypass(entry: &str) -> Option<String> {
    let e = entry.trim();
    if e.is_empty() || e == "<local>" {
        return None;
    }
    Some(e.strip_prefix('*').filter(|r| r.starts_with('.')).unwrap_or(e).to_string())
}

/// The Mac's proxy from `scutil --proxy` (System Settings › Network › Proxies). A proxy set up but switched off
/// counts as none; an automatic configuration (PAC) is not read.
pub fn proxy_from_scutil(out: &str) -> Proxy {
    // Only the top-level dictionary counts: the per-interface dictionaries under __SCOPED__ come after it and would
    // otherwise overwrite its values and add their exceptions.
    let mut keys = std::collections::HashMap::new();
    let mut exceptions = Vec::new();
    let mut in_exceptions = false;
    let mut depth = 0usize;
    for line in out.lines() {
        let line = line.trim();
        if line == "}" {
            depth = depth.saturating_sub(1);
            if depth < 2 {
                in_exceptions = false;
            }
            continue;
        }
        if depth == 1 && line.starts_with("ExceptionsList : <array>") {
            in_exceptions = true;
        } else if depth == 2 && in_exceptions {
            if let Some((_, v)) = line.split_once(" : ") {
                exceptions.extend(bypass(v));
            }
        } else if depth == 1 && !line.ends_with('{') {
            if let Some((k, v)) = line.split_once(" : ") {
                keys.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
        if line.ends_with('{') {
            depth += 1;
        }
    }
    let one = |scheme: &str| {
        if keys.get(&format!("{scheme}Enable")).map(String::as_str) != Some("1") {
            return None;
        }
        proxy_url(keys.get(&format!("{scheme}Proxy"))?, keys.get(&format!("{scheme}Port")).map(String::as_str))
    };
    let (http, https) = (one("HTTP"), one("HTTPS"));
    if http.is_none() && https.is_none() {
        return Proxy::default();
    }
    Proxy { http, https, no_proxy: exceptions }
}

/// Windows' proxy from the WinINet settings, as `reg query "HKCU\…\Internet Settings"` prints them: ProxyEnable,
/// ProxyServer (`host:port` for everything, or `http=…;https=…`) and ProxyOverride (`;`-separated).
pub fn proxy_from_wininet(out: &str) -> Proxy {
    let mut values = std::collections::HashMap::new();
    for line in out.lines() {
        let mut parts = line.trim().splitn(2, char::is_whitespace);
        let (Some(name), Some(rest)) = (parts.next(), parts.next()) else { continue };
        let mut rest = rest.trim_start().splitn(2, char::is_whitespace);
        let (Some(kind), Some(value)) = (rest.next(), rest.next()) else { continue };
        if kind.starts_with("REG_") {
            values.insert(name.to_string(), value.trim().to_string());
        }
    }
    let enabled = values.get("ProxyEnable").map(|v| v.trim_start_matches("0x").trim_start_matches('0')).is_some_and(|v| !v.is_empty());
    let Some(server) = values.get("ProxyServer").filter(|_| enabled) else { return Proxy::default() };
    let (mut http, mut https) = (None, None);
    if server.contains('=') {
        for part in server.split(';') {
            match part.split_once('=') {
                Some((k, v)) if k.trim().eq_ignore_ascii_case("http") => http = proxy_url(v, None),
                Some((k, v)) if k.trim().eq_ignore_ascii_case("https") => https = proxy_url(v, None),
                _ => {}
            }
        }
    } else {
        http = proxy_url(server, None);
        https = http.clone();
    }
    if http.is_none() && https.is_none() {
        return Proxy::default();
    }
    let no_proxy = values.get("ProxyOverride").map(|o| o.split(';').filter_map(bypass).collect()).unwrap_or_default();
    Proxy { http, https, no_proxy }
}

/// This computer's proxy, read at each server start. Anything that goes wrong reading it means no proxy: the app
/// always starts.
pub fn system_proxy() -> Proxy {
    let run = |program: &str, args: &[&str]| -> Option<String> {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(creation_flags(true));
        }
        let out = cmd.output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    };
    if cfg!(target_os = "macos") {
        run("/usr/sbin/scutil", &["--proxy"]).map(|o| proxy_from_scutil(&o)).unwrap_or_default()
    } else if cfg!(windows) {
        run("reg", &["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"]).map(|o| proxy_from_wininet(&o)).unwrap_or_default()
    } else {
        Proxy::default()
    }
}

/// How the server process is created: on Windows with no console window (the app is a window program, and a
/// console program it starts would otherwise get a visible black window that kills the server when closed). The
/// server's own commands (tar, the tools) share that hidden console.
pub fn creation_flags(windows: bool) -> u32 {
    if windows { 0x0800_0000 } else { 0 }
}

/// Microsoft's Visual C++ runtime files that the search engine (onnxruntime) and the password hashing (argon2) load.
pub const RUNTIME_DLLS: [&str; 5] = ["VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "MSVCP140.dll", "MSVCP140_1.dll", "MSVCP140_ATOMIC_WAIT.dll"];

/// The runtime files this Windows computer lacks (`exists` says whether one can be loaded).
pub fn missing_runtime(exists: impl Fn(&str) -> bool) -> Vec<&'static str> {
    RUNTIME_DLLS.iter().copied().filter(|f| !exists(f)).collect()
}

/// The folders of the native modules that load the runtime, inside the server folder (B8). Node loads a module with
/// LoadLibraryEx(LOAD_WITH_ALTERED_SEARCH_PATH), so Windows looks for its DLLs in the module's own folder, then
/// System32 — never next to node.exe. The app ships a copy of the runtime in each of these folders.
pub fn runtime_dirs(server: &std::path::Path) -> Vec<std::path::PathBuf> {
    vec![
        server.join("node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64"),
        server.join("node_modules\\@node-rs\\argon2-win32-x64-msvc"),
    ]
}

/// Whether a runtime file can be loaded by every native module: it is in System32, or in each module's own folder.
pub fn runtime_found(file: &str, dirs: &[std::path::PathBuf], system32: &std::path::Path, exists: impl Fn(&std::path::Path) -> bool) -> bool {
    exists(&system32.join(file)) || dirs.iter().all(|d| exists(&d.join(file)))
}

/// The system variables a Windows server and its tools need, in this order; each only if it is set.
pub const WINDOWS_VARS: [&str; 11] = ["USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SystemRoot", "windir", "COMSPEC", "PATHEXT"];

pub fn windows_system_env(from: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    WINDOWS_VARS.iter().filter_map(|k| from(k).map(|v| (k.to_string(), v))).collect()
}

/// Where Connect looks for the coding tools on Windows: this session's PATH first (an app started from the Start
/// menu has the person's own), then where npm, installers and winget put command-line tools.
pub fn windows_tool_path(path: Option<String>, home: &str, appdata: &str, localappdata: &str) -> String {
    let mut parts: Vec<String> = path.into_iter().filter(|p| !p.is_empty()).collect();
    parts.push(format!("{appdata}\\npm"));
    parts.push(format!("{home}\\.local\\bin"));
    parts.push(format!("{localappdata}\\Microsoft\\WinGet\\Links"));
    parts.join(";")
}

/// The PATH on a `BRAINAI_PATH=` line, wherever it sits in the line (an interactive shell may print escape codes first).
pub fn login_path(shell_output: &str) -> Option<String> {
    shell_output
        .lines()
        .find_map(|l| l.find("BRAINAI_PATH=").map(|i| l[i + "BRAINAI_PATH=".len()..].trim().to_string()))
        .filter(|p| !p.is_empty())
}

/// Used when the login shell cannot be asked (or does not answer within 5 s).
pub fn fallback_path(home: &str) -> String {
    format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{home}/.local/bin")
}

/// Runs a command and returns the PATH from its `BRAINAI_PATH=` line as soon as that line arrives, never waiting for
/// the command to finish (something a .zshrc starts may keep its output open) and never longer than `limit`.
pub fn path_from_command(program: &str, args: &[&str], limit: Duration) -> Option<String> {
    use std::io::BufRead;
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let until = Instant::now() + limit;
    let mut found = None;
    while let Some(left) = until.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(line) => {
                if let Some(p) = login_path(&line) {
                    found = Some(p);
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    found
}

/// The owner's login-shell PATH, with the usual folders after it as a safety net: a Mac app opened from the Finder
/// gets a short PATH that misses Homebrew, npm and ~/.local/bin, where the coding tools usually are.
pub fn tool_path() -> String {
    if cfg!(windows) {
        let var = |k: &str| std::env::var(k).unwrap_or_default();
        return windows_tool_path(std::env::var("PATH").ok(), &var("USERPROFILE"), &var("APPDATA"), &var("LOCALAPPDATA"));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // Interactive too: many people add ~/.local/bin and the like in .zshrc, which a login shell alone skips.
    match path_from_command(&shell, &["-l", "-i", "-c", "printf 'BRAINAI_PATH=%s\\n' \"$PATH\""], Duration::from_secs(5)) {
        Some(p) => format!("{p}:{}", fallback_path(&home)),
        None => fallback_path(&home),
    }
}

/// The IANA name in the target of /etc/localtime (…/zoneinfo/Europe/Berlin → Europe/Berlin).
pub fn timezone_from_link(target: &str) -> Option<String> {
    target.split("zoneinfo/").nth(1).filter(|s| !s.is_empty()).map(String::from)
}

/// This Mac's time zone, from System Settings (the /etc/localtime link).
pub fn local_timezone() -> Option<String> {
    std::fs::read_link("/etc/localtime").ok().and_then(|p| timezone_from_link(&p.to_string_lossy()))
}

#[derive(Debug, PartialEq)]
pub enum StartError {
    /// Something else answers on the port: the key was not sent to it.
    NotOurs,
    /// Nothing answered in time, or the server stopped.
    Timeout,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(5)).redirects(0).build()
}

/// One check: Ok(true) when the server proves it holds the key, Ok(false) when nothing is listening yet,
/// Err(NotOurs) when anything else answers.
pub fn check_once(port: u16, secret: &str) -> Result<bool, StartError> {
    let challenge = proof::random_hex();
    let url = format!("http://localhost:{port}/app/hello?challenge={challenge}");
    match agent().get(&url).call() {
        Ok(resp) => {
            let body: serde_json::Value = resp.into_json().map_err(|_| StartError::NotOurs)?;
            if body.get("proof").and_then(|v| v.as_str()) == Some(proof::expected(secret, &challenge).as_str()) {
                Ok(true)
            } else {
                Err(StartError::NotOurs)
            }
        }
        Err(ureq::Error::Status(_, _)) => Err(StartError::NotOurs),
        Err(ureq::Error::Transport(_)) => Ok(false),
    }
}

/// Polls until our server answers (the first start loads the search model), giving up after `timeout` or as soon as
/// `alive()` says the server stopped.
pub fn wait_until_ours(port: u16, secret: &str, timeout: Duration, alive: impl Fn() -> bool) -> Result<(), StartError> {
    let start = Instant::now();
    loop {
        if check_once(port, secret)? {
            return Ok(());
        }
        if !alive() || start.elapsed() > timeout {
            return Err(StartError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// What the server's tickets look like (32 random bytes, base64url): anything else is never put in a URL.
pub fn valid_ticket(t: &str) -> bool {
    t.len() == 43 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn ticket_once(port: u16, secret: &str) -> Result<String, String> {
    let resp = agent()
        .post(&format!("http://localhost:{port}/app/ticket"))
        .set("X-App-Key", secret)
        .call()
        .map_err(|e| e.to_string())?;
    let body: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    let t = body.get("ticket").and_then(|v| v.as_str()).unwrap_or_default();
    if valid_ticket(t) { Ok(t.to_string()) } else { Err("the server's answer held no ticket".into()) }
}

/// A one-time ticket for the window (D1: POST /app/ticket with X-App-Key). Only called once the server proved it is
/// ours. Three tries: right after it starts listening the server may still be busy.
pub fn ticket(port: u16, secret: &str) -> Result<String, String> {
    let mut last = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(1));
        }
        match ticket_once(port, secret) {
            Ok(t) => return Ok(t),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Before the app deletes anything for a removal: asks its own server (GET /app/removed/ready with X-App-Key) whether
/// a removal finished there, and where its saved folder is. Any other answer, or none, is None: nothing is removed.
/// Only called once the server proved it is ours.
pub fn removal_ready(port: u16, secret: &str) -> Option<String> {
    let resp = agent().get(&format!("http://localhost:{port}/app/removed/ready")).set("X-App-Key", secret).call().ok()?;
    if resp.status() != 200 {
        return None;
    }
    let body: serde_json::Value = resp.into_json().ok()?;
    body.get("folder").and_then(|v| v.as_str()).filter(|f| !f.is_empty()).map(str::to_string)
}

/// Before an update is installed: a backup now (POST /app/backup-now with X-App-Key). A large brain can take a while,
/// hence the long wait. Err carries the server's own plain sentence, or a fixed one when it did not answer. Only called
/// once the server proved it is ours.
pub fn backup_now(port: u16, secret: &str) -> Result<(), String> {
    const NO_ANSWER: &str = "BrainAI's server did not answer.";
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(180)).redirects(0).build();
    match agent.post(&format!("http://localhost:{port}/app/backup-now")).set("X-App-Key", secret).call() {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(_, resp)) => {
            let body: serde_json::Value = resp.into_json().unwrap_or_default();
            let said = body.get("error").and_then(|v| v.as_str()).map(str::trim).filter(|e| !e.is_empty());
            Err(said.unwrap_or("The backup did not finish.").to_string())
        }
        Err(ureq::Error::Transport(_)) => Err(NO_ANSWER.into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_long_form_windows_path_is_given_to_node_in_its_plain_form() {
        // Tauri's resource folder comes from canonicalize, which on Windows adds \\?\ ; Node then fails on "lstat 'C:'".
        assert_eq!(super::plain_path(r"\\?\C:\Users\Ana Gil\AppData\Local\BrainAI"), r"C:\Users\Ana Gil\AppData\Local\BrainAI");
        assert_eq!(super::plain_path(r"\\?\UNC\nas\apps\BrainAI"), r"\\nas\apps\BrainAI");
        // Already plain, a Mac path, or a long-form path that only works long-form (over 259 characters): unchanged.
        assert_eq!(super::plain_path(r"C:\Program Files\BrainAI"), r"C:\Program Files\BrainAI");
        assert_eq!(super::plain_path("/Applications/BrainAI.app/Contents/Resources"), "/Applications/BrainAI.app/Contents/Resources");
        let long = format!(r"\\?\C:\{}", "a".repeat(260));
        assert_eq!(super::plain_path(&long), long);
        assert_eq!(super::plain_path(r"\\?\Volume{0b1c}\x"), r"\\?\Volume{0b1c}\x");
    }

    #[test]
    fn on_windows_the_server_starts_without_a_console_window() {
        assert_eq!(creation_flags(true), 0x0800_0000, "CREATE_NO_WINDOW");
        assert_eq!(creation_flags(false), 0);
    }

    #[test]
    fn the_visual_cpp_runtime_files_the_server_needs_are_looked_for() {
        assert!(missing_runtime(|_| true).is_empty());
        let missing = missing_runtime(|f| f != "MSVCP140.dll" && f != "VCRUNTIME140_1.dll");
        assert_eq!(missing, vec!["VCRUNTIME140_1.dll", "MSVCP140.dll"]);
    }

    #[test]
    fn the_runtime_counts_when_every_native_module_folder_has_it_or_system32_does() {
        use std::path::{Path, PathBuf};
        let server = PathBuf::from("C:\\Users\\Ana\\AppData\\Local\\BrainAI\\server");
        let system32 = PathBuf::from("C:\\Windows\\System32");
        let dirs = runtime_dirs(&server);
        assert_eq!(dirs.len(), 2);
        assert!(dirs[0].ends_with("node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64"));
        assert!(dirs[1].ends_with("node_modules\\@node-rs\\argon2-win32-x64-msvc"));
        let in_both_modules = |p: &Path| dirs.iter().any(|d| p.starts_with(d));
        assert!(missing_runtime(|f| runtime_found(f, &dirs, &system32, in_both_modules)).is_empty());
        let only_onnx = |p: &Path| p.starts_with(&dirs[0]);
        assert_eq!(missing_runtime(|f| runtime_found(f, &dirs, &system32, only_onnx)).len(), 5, "argon2's folder lacks them");
        let only_system32 = |p: &Path| p.starts_with(&system32);
        assert!(missing_runtime(|f| runtime_found(f, &dirs, &system32, only_system32)).is_empty());
        let next_to_node_exe = |p: &Path| p.starts_with("C:\\Users\\Ana\\AppData\\Local\\BrainAI") && !p.starts_with(&server);
        assert_eq!(missing_runtime(|f| runtime_found(f, &dirs, &system32, next_to_node_exe)).len(), 5, "Node never looks there");
    }

    #[test]
    fn on_windows_the_server_gets_the_system_variables_it_needs_and_nothing_else() {
        let parent = |k: &str| match k {
            "USERPROFILE" => Some("C:\\Users\\Ana".to_string()),
            "SystemRoot" => Some("C:\\Windows".to_string()),
            "TEMP" => Some("C:\\Users\\Ana\\AppData\\Local\\Temp".to_string()),
            "LOCALAPPDATA" => Some("C:\\Users\\Ana\\AppData\\Local".to_string()),
            "SECRET_TOKEN" => Some("never".to_string()),
            _ => None,
        };
        let system = windows_system_env(parent);
        let names: Vec<&str> = system.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, vec!["USERPROFILE", "LOCALAPPDATA", "TEMP", "SystemRoot"], "the list, in its order, missing ones skipped");
        let env = env(&PathBuf::from("C:\\d"), 3100, "k", None, None, None, "C:\\npm", &system, &Proxy::default());
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("USERPROFILE"), Some("C:\\Users\\Ana"));
        assert_eq!(get("PATH"), Some("C:\\Windows\\System32;C:\\Windows"), "for tar and explorer");
        assert_eq!(get("SECRET_TOKEN"), None);
        assert_eq!(get("TOOL_PATH"), Some("C:\\npm"));
    }

    #[test]
    fn on_windows_tools_are_looked_for_on_the_path_then_where_npm_and_installers_put_them() {
        assert_eq!(
            windows_tool_path(Some("C:\\Windows\\System32;C:\\Program Files\\nodejs".into()), "C:\\Users\\Ana", "C:\\Users\\Ana\\AppData\\Roaming", "C:\\Users\\Ana\\AppData\\Local"),
            "C:\\Windows\\System32;C:\\Program Files\\nodejs;C:\\Users\\Ana\\AppData\\Roaming\\npm;C:\\Users\\Ana\\.local\\bin;C:\\Users\\Ana\\AppData\\Local\\Microsoft\\WinGet\\Links"
        );
        assert_eq!(windows_tool_path(None, "C:\\U", "C:\\R", "C:\\L"), "C:\\R\\npm;C:\\U\\.local\\bin;C:\\L\\Microsoft\\WinGet\\Links");
    }

    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;

    #[test]
    fn the_server_runs_in_local_mode_with_its_data_in_the_app_data_folder() {
        let env = env(&PathBuf::from("/data/app"), 3107, "k", None, None, None, "/opt/homebrew/bin:/usr/bin", &[], &Proxy::default());
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("LOCAL_MODE"), Some("true"));
        assert_eq!(get("HOST"), Some("127.0.0.1"));
        assert_eq!(get("PORT"), Some("3107"));
        assert_eq!(get("PUBLIC_URL"), Some("http://localhost:3107"));
        assert_eq!(get("DATA_DIR"), Some("/data/app/data"));
        assert_eq!(get("BACKUP_DIR"), Some("/data/app/backups"));
        assert_eq!(get("OVERLAY_DIR"), Some("/data/app/overlay"));
        assert_eq!(get("MODEL_DIR"), Some("/data/app/models"), "the models are downloaded into the app-data folder, not the bundle");
        assert_eq!(get("HTTPS_PROXY"), None, "no system proxy, none passed");
        assert_eq!(get("APP_SECRET"), Some("k"));
        assert_eq!(get("APP_PARENT"), Some("stdin"));
        assert_eq!(get("TRUST_CF_CONNECTING_IP"), Some("false"));
        assert_eq!(get("TOOL_PATH"), Some("/opt/homebrew/bin:/usr/bin"), "where Connect finds the coding tools");
        assert_eq!(env.len(), 13);
        assert_eq!(get("OWNER_TIMEZONE"), None);
        assert_eq!(get("BRAINAI_SYSTEM_LOCALE"), None, "no locale, none passed");
        let with = super::env(&PathBuf::from("/data/app"), 3107, "k", None, Some(" es-ES "), None, "/usr/bin", &[], &Proxy::default());
        assert_eq!(with.len(), 14);
        assert!(with.contains(&("BRAINAI_SYSTEM_LOCALE".into(), "es-ES".into())));
        assert_eq!(super::env(&PathBuf::from("/d"), 3100, "k", None, Some(""), None, "/usr/bin", &[], &Proxy::default()).len(), 13, "an empty locale is not passed");
    }

    #[test]
    fn weeks_and_days_follow_the_macs_own_time_zone() {
        let env = env(&PathBuf::from("/d"), 3100, "k", Some("Europe/Berlin"), Some("es-ES"), Some("/var/folders/ab/T/"), "/usr/bin", &[], &Proxy::default());
        assert!(env.contains(&("TMPDIR".into(), "/var/folders/ab/T/".into())), "the owner's private temporary folder, not /tmp");
        assert!(env.contains(&("OWNER_TIMEZONE".into(), "Europe/Berlin".into())));
        assert!(env.contains(&("BRAINAI_SYSTEM_LOCALE".into(), "es-ES".into())), "the system language, for the server's auto");
        assert_eq!(timezone_from_link("/var/db/timezone/zoneinfo/Europe/Berlin"), Some("Europe/Berlin".into()));
        assert_eq!(timezone_from_link("/usr/share/zoneinfo/America/Argentina/Buenos_Aires"), Some("America/Argentina/Buenos_Aires".into()));
        assert_eq!(timezone_from_link("/etc/localtime"), None);
        assert_eq!(timezone_from_link("/usr/share/zoneinfo/"), None);
    }

    /// A one-shot HTTP server on a free port that answers with `body` (a squatter, or a server with the wrong key).
    fn answer_once(status: &str, body: &'static str) -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let status = status.to_string();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        port
    }

    #[test]
    fn the_login_shells_path_is_read_from_its_marked_line_whatever_else_it_prints() {
        assert_eq!(login_path("BRAINAI_PATH=/opt/homebrew/bin:/usr/bin:/bin"), Some("/opt/homebrew/bin:/usr/bin:/bin".into()));
        assert_eq!(login_path("Welcome to zsh!\nnvm loaded\nBRAINAI_PATH=/Users/a/.local/bin:/usr/bin\n"), Some("/Users/a/.local/bin:/usr/bin".into()));
        assert_eq!(login_path("motd only\n"), None);
        assert_eq!(login_path("BRAINAI_PATH=\n"), None);
    }

    #[test]
    fn the_path_line_is_taken_as_soon_as_it_arrives_even_if_the_shell_keeps_running() {
        let start = Instant::now();
        let got = path_from_command("/bin/sh", &["-c", "printf 'hello\\nBRAINAI_PATH=/x/bin:/usr/bin\\n'; sleep 20"], Duration::from_secs(5));
        assert_eq!(got, Some("/x/bin:/usr/bin".into()));
        assert!(start.elapsed() < Duration::from_secs(3), "it did not wait for the shell to finish");
        let start = Instant::now();
        assert_eq!(path_from_command("/bin/sh", &["-c", "sleep 20"], Duration::from_millis(500)), None);
        assert!(start.elapsed() < Duration::from_secs(3), "a silent shell gives up at the limit");
        assert_eq!(login_path("\u{1b}]0;title\u{7}BRAINAI_PATH=/y/bin"), Some("/y/bin".into()), "escape codes before it on the same line");
    }

    #[test]
    fn a_ticket_is_43_url_safe_characters_and_nothing_else() {
        assert!(valid_ticket(&"A".repeat(43)));
        assert!(valid_ticket("abcdefghijklmnopqrstuvwxyz-_0123456789ABCDE"));
        for bad in ["", "short", &"A".repeat(44), "abc&next=//evil.example/abcdefghijklmnopqrst", "abcdefghijklmnopqrstuvwxyz/_0123456789ABCDE"] {
            assert!(!valid_ticket(bad), "{bad}");
        }
    }

    #[test]
    fn a_server_with_the_wrong_proof_or_none_is_not_ours() {
        assert_eq!(check_once(answer_once("200 OK", r#"{"proof":"0000"}"#), "k"), Err(StartError::NotOurs));
        assert_eq!(check_once(answer_once("404 Not Found", "{}"), "k"), Err(StartError::NotOurs));
        assert_eq!(check_once(answer_once("200 OK", "not json"), "k"), Err(StartError::NotOurs));
    }

    /// Like answer_once, and also hands back the request it got.
    fn answer_once_seen(status: &str, body: &'static str) -> (u16, std::sync::mpsc::Receiver<String>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let status = status.to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 2048];
                let n = s.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        (port, rx)
    }

    #[test]
    fn a_removal_is_ready_only_when_the_server_names_the_saved_folder() {
        let (port, seen) = answer_once_seen("200 OK", r#"{"folder":"/Users/alex/Documents/BrainAI saved 2026-11-12"}"#);
        assert_eq!(removal_ready(port, "k"), Some("/Users/alex/Documents/BrainAI saved 2026-11-12".into()));
        let request = seen.recv().unwrap().to_lowercase();
        assert!(request.starts_with("get /app/removed/ready "), "{request}");
        assert!(request.contains("x-app-key: k\r\n"), "the app's key goes with it");
        assert_eq!(removal_ready(answer_once("409 Conflict", r#"{"error":"No saved copy"}"#), "k"), None, "no removal finished");
        assert_eq!(removal_ready(answer_once("404 Not Found", "{}"), "k"), None);
        assert_eq!(removal_ready(answer_once("200 OK", "{}"), "k"), None);
        assert_eq!(removal_ready(answer_once("200 OK", r#"{"folder":""}"#), "k"), None);
        assert_eq!(removal_ready(answer_once("200 OK", "not json"), "k"), None);
        let free = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        assert_eq!(removal_ready(free, "k"), None, "nothing listening");
    }

    #[test]
    fn a_backup_before_an_update_is_asked_of_the_server_with_the_apps_key() {
        let (port, seen) = answer_once_seen("200 OK", r#"{"ok":true}"#);
        assert_eq!(backup_now(port, "k"), Ok(()));
        let request = seen.recv().unwrap().to_lowercase();
        assert!(request.starts_with("post /app/backup-now "), "{request}");
        assert!(request.contains("x-app-key: k\r\n"), "the app's key goes with it");
        assert_eq!(backup_now(answer_once("500 Internal Server Error", r#"{"error":"The disk is full."}"#), "k"), Err("The disk is full.".into()), "the server's own plain sentence");
        let free = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        assert!(backup_now(free, "k").is_err(), "nothing listening");
    }

    #[test]
    fn the_system_proxy_is_passed_to_the_server_for_its_downloads() {
        let proxy = Proxy {
            http: Some("http://proxy.example.test:8080".into()),
            https: Some("http://secure-proxy.example.test:3128".into()),
            no_proxy: vec![".local".into(), "intranet.example.test".into()],
        };
        let env = env(&PathBuf::from("/data/app"), 3107, "k", None, None, None, "/usr/bin", &[], &proxy);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("MODEL_DIR"), Some("/data/app/models"));
        assert_eq!(get("HTTPS_PROXY"), Some("http://secure-proxy.example.test:3128"));
        assert_eq!(get("HTTP_PROXY"), Some("http://proxy.example.test:8080"));
        assert_eq!(get("NO_PROXY"), Some(".local,intranet.example.test,localhost,127.0.0.1,::1"), "the server's own address never goes through it");
        assert_eq!(get("NODE_USE_ENV_PROXY"), Some("1"), "Node's fetch reads the variables only with this");
    }

    #[test]
    fn the_macs_proxy_is_read_from_scutil() {
        let out = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : 169.254/16\n  }\n  FTPPassive : 1\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : proxy.example.test\n  HTTPSEnable : 1\n  HTTPSPort : 3128\n  HTTPSProxy : secure-proxy.example.test\n}\n";
        assert_eq!(proxy_from_scutil(out), Proxy {
            http: Some("http://proxy.example.test:8080".into()),
            https: Some("http://secure-proxy.example.test:3128".into()),
            no_proxy: vec![".local".into(), "169.254/16".into()],
        });
        let off = "<dictionary> {\n  HTTPEnable : 0\n  HTTPProxy : proxy.example.test\n  HTTPPort : 8080\n  HTTPSEnable : 0\n}\n";
        assert_eq!(proxy_from_scutil(off), Proxy::default(), "set up but switched off");
        assert_eq!(proxy_from_scutil("<dictionary> {\n  FTPPassive : 1\n}\n"), Proxy::default());
        assert_eq!(proxy_from_scutil(""), Proxy::default());
        assert!(proxy_env(&Proxy::default()).is_empty(), "no proxy: nothing added");
    }

    #[test]
    fn only_the_top_level_scutil_settings_count_never_a_scoped_interfaces() {
        // The global settings first, then __SCOPED__ with one dictionary per network interface (en0 here).
        let scoped = |global: &str| format!("<dictionary> {{\n{global}  __SCOPED__ : <dictionary> {{\n    en0 : <dictionary> {{\n      ExceptionsList : <array> {{\n        0 : scoped.example.test\n      }}\n      HTTPEnable : 1\n      HTTPPort : 9090\n      HTTPProxy : scoped-proxy.example.test\n      HTTPSEnable : 1\n      HTTPSPort : 9443\n      HTTPSProxy : scoped-proxy.example.test\n    }}\n  }}\n}}\n");
        assert_eq!(proxy_from_scutil(&scoped("  FTPPassive : 1\n")), Proxy::default(), "no global proxy: none, whatever en0 says");
        let global = "  ExceptionsList : <array> {\n    0 : *.local\n  }\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : proxy.example.test\n  HTTPSEnable : 1\n  HTTPSPort : 3128\n  HTTPSProxy : secure-proxy.example.test\n";
        assert_eq!(proxy_from_scutil(&scoped(global)), Proxy {
            http: Some("http://proxy.example.test:8080".into()),
            https: Some("http://secure-proxy.example.test:3128".into()),
            no_proxy: vec![".local".into()],
        }, "the global proxy and exceptions, not en0's");
    }

    #[test]
    fn with_only_a_web_proxy_for_http_nothing_is_passed() {
        // Node would send https through HTTP_PROXY when HTTPS_PROXY is unset; the Mac would not. Every download is https.
        let http_only = Proxy { http: Some("http://proxy.example.test:8080".into()), https: None, no_proxy: vec![] };
        assert!(proxy_env(&http_only).is_empty());
        let out = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : proxy.example.test\n}\n";
        assert!(proxy_env(&proxy_from_scutil(out)).is_empty());
        let both = Proxy { https: Some("http://secure.example.test:443".into()), ..http_only };
        let env = proxy_env(&both);
        assert!(env.contains(&("HTTPS_PROXY".into(), "http://secure.example.test:443".into())));
        assert!(env.contains(&("HTTP_PROXY".into(), "http://proxy.example.test:8080".into())));
    }

    #[test]
    fn the_windows_proxy_is_read_from_the_wininet_settings() {
        let one = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    proxy.example.test:8080\r\n    ProxyOverride    REG_SZ    *.example.test;<local>\r\n";
        assert_eq!(proxy_from_wininet(one), Proxy {
            http: Some("http://proxy.example.test:8080".into()),
            https: Some("http://proxy.example.test:8080".into()),
            no_proxy: vec![".example.test".into()],
        });
        let each = "    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=web.example.test:80;https=secure.example.test:443;socks=socks.example.test:1080\n";
        assert_eq!(proxy_from_wininet(each), Proxy {
            http: Some("http://web.example.test:80".into()),
            https: Some("http://secure.example.test:443".into()),
            no_proxy: vec![],
        });
        let off = "    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    proxy.example.test:8080\n";
        assert_eq!(proxy_from_wininet(off), Proxy::default(), "switched off");
        assert_eq!(proxy_from_wininet("ERROR: The system was unable to find the specified registry key or value.\n"), Proxy::default());
    }

    #[test]
    fn nothing_listening_yet_means_keep_waiting_until_the_timeout() {
        let free = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        assert_eq!(check_once(free, "k"), Ok(false));
        assert_eq!(wait_until_ours(free, "k", Duration::from_millis(500), || true), Err(StartError::Timeout));
        assert_eq!(wait_until_ours(free, "k", Duration::from_secs(30), || false), Err(StartError::Timeout), "stops at once when the server died");
    }
}
