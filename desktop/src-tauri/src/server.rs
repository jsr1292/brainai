//! Running the bundled server: its environment, waiting until it answers as ours, and the window's ticket.
use crate::proof;
use std::path::Path;
use std::time::{Duration, Instant};

/// Exactly what the server is started with: local mode on this port, data in the app-data folder, the bundled model,
/// this start's key, and a pipe it watches so it stops when the app is gone.
/// On Windows `system` carries the system variables Node and the tools need (empty on the Mac).
pub fn env(app_data: &Path, resources: &Path, port: u16, secret: &str, timezone: Option<&str>, tmpdir: Option<&str>, tool_path: &str, system: &[(String, String)]) -> Vec<(String, String)> {
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let mut env = vec![
        ("LOCAL_MODE".into(), "true".into()),
        ("HOST".into(), "127.0.0.1".into()),
        ("PORT".into(), port.to_string()),
        ("PUBLIC_URL".into(), format!("http://localhost:{port}")),
        ("DATA_DIR".into(), path(&app_data.join("data"))),
        ("BACKUP_DIR".into(), path(&app_data.join("backups"))),
        ("OVERLAY_DIR".into(), path(&app_data.join("overlay"))),
        ("MODEL_DIR".into(), path(&resources.join("server").join("models"))),
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
    env
}

/// How the server process is created: on Windows with no console window (the app is a window program, and a
/// console program it starts would otherwise get a visible black window that kills the server when closed). The
/// server's own commands (tar, the tools) share that hidden console.
pub fn creation_flags(windows: bool) -> u32 {
    if windows { 0x0800_0000 } else { 0 }
}

/// Microsoft's Visual C++ runtime files that the search engine (onnxruntime) and the password hashing (argon2) load.
pub const RUNTIME_DLLS: [&str; 5] = ["VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "MSVCP140.dll", "MSVCP140_1.dll", "MSVCP140_ATOMIC_WAIT.dll"];

/// The runtime files this Windows computer lacks (looked for with `exists`, in System32).
pub fn missing_runtime(exists: impl Fn(&str) -> bool) -> Vec<&'static str> {
    RUNTIME_DLLS.iter().copied().filter(|f| !exists(f)).collect()
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

#[cfg(test)]
mod tests {
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
        let env = env(&PathBuf::from("C:\\d"), &PathBuf::from("C:\\r"), 3100, "k", None, None, "C:\\npm", &system);
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
        let env = env(&PathBuf::from("/data/app"), &PathBuf::from("/bundle/Resources"), 3107, "k", None, None, "/opt/homebrew/bin:/usr/bin", &[]);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("LOCAL_MODE"), Some("true"));
        assert_eq!(get("HOST"), Some("127.0.0.1"));
        assert_eq!(get("PORT"), Some("3107"));
        assert_eq!(get("PUBLIC_URL"), Some("http://localhost:3107"));
        assert_eq!(get("DATA_DIR"), Some("/data/app/data"));
        assert_eq!(get("BACKUP_DIR"), Some("/data/app/backups"));
        assert_eq!(get("OVERLAY_DIR"), Some("/data/app/overlay"));
        assert_eq!(get("MODEL_DIR"), Some("/bundle/Resources/server/models"));
        assert_eq!(get("APP_SECRET"), Some("k"));
        assert_eq!(get("APP_PARENT"), Some("stdin"));
        assert_eq!(get("TRUST_CF_CONNECTING_IP"), Some("false"));
        assert_eq!(get("TOOL_PATH"), Some("/opt/homebrew/bin:/usr/bin"), "where Connect finds the coding tools");
        assert_eq!(env.len(), 13);
        assert_eq!(get("OWNER_TIMEZONE"), None);
    }

    #[test]
    fn weeks_and_days_follow_the_macs_own_time_zone() {
        let env = env(&PathBuf::from("/d"), &PathBuf::from("/r"), 3100, "k", Some("Europe/Berlin"), Some("/var/folders/ab/T/"), "/usr/bin", &[]);
        assert!(env.contains(&("TMPDIR".into(), "/var/folders/ab/T/".into())), "the owner's private temporary folder, not /tmp");
        assert!(env.contains(&("OWNER_TIMEZONE".into(), "Europe/Berlin".into())));
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

    #[test]
    fn nothing_listening_yet_means_keep_waiting_until_the_timeout() {
        let free = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        assert_eq!(check_once(free, "k"), Ok(false));
        assert_eq!(wait_until_ours(free, "k", Duration::from_millis(500), || true), Err(StartError::Timeout));
        assert_eq!(wait_until_ours(free, "k", Duration::from_secs(30), || false), Err(StartError::Timeout), "stops at once when the server died");
    }
}
