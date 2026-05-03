use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WindowEvent,
};

#[derive(Default)]
struct DesktopState {
    watcher_stop: Mutex<Option<Arc<AtomicBool>>>,
    last_runtime: Mutex<Option<DesktopLaunchResult>>,
}

#[derive(Clone, Debug)]
struct LauncherInvocation {
    program: String,
    args_prefix: Vec<String>,
    install_root: PathBuf,
    windows_shell: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedPidInfo {
    pid: Option<u32>,
    state: String,
    raw: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReadiness {
    gateway: bool,
    ui: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePidFiles {
    gateway: String,
    ui: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePids {
    gateway: ManagedPidInfo,
    ui: ManagedPidInfo,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLogFiles {
    gateway_stdout: String,
    gateway_stderr: String,
    mission_control_stdout: String,
    mission_control_stderr: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLaunchResult {
    status: String,
    gateway_url: String,
    ui_url: String,
    target_url: String,
    packaged: bool,
    runtime_root: String,
    runtime_state_dir: String,
    pid_files: RuntimePidFiles,
    pids: RuntimePids,
    log_files: RuntimeLogFiles,
    readiness: RuntimeReadiness,
    onboarding_completed: bool,
    checked_at: String,
}

type DesktopRuntimeStatus = DesktopLaunchResult;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopActionResult {
    ok: bool,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalNotificationPayload {
    approval_id: String,
    kind: Option<String>,
    risk_level: Option<String>,
    status: Option<String>,
}

fn main() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = show_main_window(app);
        }))
        .setup(|app| {
            install_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            launch_runtime,
            read_runtime_status,
            stop_runtime,
            open_browser,
            open_logs,
            open_install_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running GoatCitadel Mission Control desktop");
}

#[tauri::command]
fn launch_runtime(app: AppHandle, state: State<'_, DesktopState>) -> Result<DesktopLaunchResult, String> {
    let output = run_launcher(["launch", "--no-open", "--json", "--wait"])?;
    let result: DesktopLaunchResult = serde_json::from_str(&output)
        .map_err(|error| format!("Launcher returned invalid JSON: {error}. Output: {output}"))?;
    {
        let mut last_runtime = state
            .last_runtime
            .lock()
            .map_err(|_| "Desktop runtime state is unavailable.".to_string())?;
        *last_runtime = Some(result.clone());
    }
    start_approval_watcher(app, state, result.clone())?;
    Ok(result)
}

#[tauri::command]
fn read_runtime_status(state: State<'_, DesktopState>) -> Result<DesktopRuntimeStatus, String> {
    let output = run_launcher(["status", "--json"])?;
    let result: DesktopRuntimeStatus = serde_json::from_str(&output)
        .map_err(|error| format!("Launcher returned invalid JSON: {error}. Output: {output}"))?;
    {
        let mut last_runtime = state
            .last_runtime
            .lock()
            .map_err(|_| "Desktop runtime state is unavailable.".to_string())?;
        *last_runtime = Some(result.clone());
    }
    Ok(result)
}

#[tauri::command]
fn stop_runtime(state: State<'_, DesktopState>) -> Result<Value, String> {
    stop_approval_watcher(&state)?;
    let output = run_launcher(["stop", "--json"])?;
    serde_json::from_str(&output).map_err(|error| format!("Launcher returned invalid JSON: {error}. Output: {output}"))
}

#[tauri::command]
fn open_browser(url: String) -> Result<DesktopActionResult, String> {
    open_external(&url)?;
    Ok(DesktopActionResult {
        ok: true,
        message: "Opened browser fallback.".to_string(),
    })
}

#[tauri::command]
fn open_logs() -> Result<DesktopActionResult, String> {
    let root = resolve_launcher()?.install_root;
    let log_dir = root.join("runtime").join("logs");
    open_external(path_to_open_target(&log_dir)?)?;
    Ok(DesktopActionResult {
        ok: true,
        message: "Opened runtime logs.".to_string(),
    })
}

#[tauri::command]
fn open_install_folder() -> Result<DesktopActionResult, String> {
    let root = resolve_launcher()?.install_root;
    open_external(path_to_open_target(&root)?)?;
    Ok(DesktopActionResult {
        ok: true,
        message: "Opened install folder.".to_string(),
    })
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "Open Mission Control", true, None::<&str>)?;
    let browser_item = MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)?;
    let status_item = MenuItem::with_id(app, "status", "Runtime Status", true, None::<&str>)?;
    let restart_item = MenuItem::with_id(app, "restart", "Restart Runtime", true, None::<&str>)?;
    let stop_item = MenuItem::with_id(app, "stop", "Stop Runtime", true, None::<&str>)?;
    let logs_item = MenuItem::with_id(app, "logs", "Open Logs", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_item,
            &browser_item,
            &status_item,
            &restart_item,
            &stop_item,
            &logs_item,
            &quit_item,
        ],
    )?;

    TrayIconBuilder::new()
        .tooltip("GoatCitadel Mission Control")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = show_main_window(app);
            }
            "browser" => {
                if let Some(url) = read_last_runtime(app).map(|runtime| runtime.target_url) {
                    let _ = open_external(&url);
                }
            }
            "status" => {
                let _ = show_main_window(app);
                let _ = app.emit("desktop://runtime-status-requested", ());
            }
            "restart" => {
                let handle = app.clone();
                thread::spawn(move || {
                    let _ = run_launcher(["stop", "--json"]);
                    let _ = run_launcher(["launch", "--no-open", "--json", "--wait"]);
                    let _ = handle.emit("desktop://runtime-restarted", ());
                });
            }
            "stop" => {
                let handle = app.clone();
                thread::spawn(move || {
                    if let Some(state) = handle.try_state::<DesktopState>() {
                        let _ = stop_approval_watcher(&state);
                    }
                    let _ = run_launcher(["stop", "--json"]);
                    let _ = handle.emit("desktop://runtime-stopped", ());
                });
            }
            "logs" => {
                if let Ok(root) = resolve_launcher().map(|launcher| launcher.install_root) {
                    let _ = path_to_open_target(&root.join("runtime").join("logs")).and_then(|target| open_external(&target));
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

fn read_last_runtime(app: &AppHandle) -> Option<DesktopLaunchResult> {
    let state = app.try_state::<DesktopState>()?;
    let last_runtime = state.last_runtime.lock().ok()?.clone();
    last_runtime
}

fn start_approval_watcher(
    app: AppHandle,
    state: State<'_, DesktopState>,
    runtime: DesktopLaunchResult,
) -> Result<(), String> {
    stop_approval_watcher(&state)?;
    if runtime.status != "ready" {
        return Ok(());
    }

    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut watcher_stop = state
            .watcher_stop
            .lock()
            .map_err(|_| "Desktop notification watcher state is unavailable.".to_string())?;
        *watcher_stop = Some(stop.clone());
    }

    thread::spawn(move || {
        watch_approval_events(app, runtime.gateway_url, stop);
    });
    Ok(())
}

fn stop_approval_watcher(state: &State<'_, DesktopState>) -> Result<(), String> {
    let mut watcher_stop = state
        .watcher_stop
        .lock()
        .map_err(|_| "Desktop notification watcher state is unavailable.".to_string())?;
    if let Some(stop) = watcher_stop.take() {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn watch_approval_events(app: AppHandle, gateway_url: String, stop: Arc<AtomicBool>) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(None)
        .connect_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let stream_url = format!("{}/api/v1/events/stream?replay=0", trim_trailing_slash(&gateway_url));

    while !stop.load(Ordering::Relaxed) {
        let response = client.get(&stream_url).send();
        let Ok(response) = response else {
            sleep_or_stop(&stop, Duration::from_secs(5));
            continue;
        };
        if !response.status().is_success() {
            sleep_or_stop(&stop, Duration::from_secs(10));
            continue;
        }

        let mut data_lines: Vec<String> = Vec::new();
        let reader = BufReader::new(response);
        for line in reader.lines() {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let Ok(line) = line else {
                break;
            };
            if let Some(data) = line.strip_prefix("data:") {
                data_lines.push(data.trim_start().to_string());
                continue;
            }
            if line.trim().is_empty() && !data_lines.is_empty() {
                let data = data_lines.join("\n");
                data_lines.clear();
                if let Some(payload) = parse_approval_notification(&data) {
                    let _ = app.emit("desktop://approval-created", payload);
                }
            }
        }
        sleep_or_stop(&stop, Duration::from_secs(2));
    }
}

fn parse_approval_notification(data: &str) -> Option<ApprovalNotificationPayload> {
    let value: Value = serde_json::from_str(data).ok()?;
    if value.get("eventType")?.as_str()? != "approval_created" {
        return None;
    }
    let payload = value.get("payload")?;
    let approval_id = payload
        .get("approvalId")
        .and_then(Value::as_str)
        .or_else(|| value.get("links")?.get("approvalId")?.as_str())?;
    Some(ApprovalNotificationPayload {
        approval_id: approval_id.to_string(),
        kind: payload.get("kind").and_then(Value::as_str).map(str::to_string),
        risk_level: payload
            .get("riskLevel")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: payload.get("status").and_then(Value::as_str).map(str::to_string),
    })
}

fn sleep_or_stop(stop: &Arc<AtomicBool>, duration: Duration) {
    let mut elapsed = Duration::ZERO;
    while elapsed < duration {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let step = Duration::from_millis(200);
        thread::sleep(step);
        elapsed += step;
    }
}

fn run_launcher<const N: usize>(args: [&str; N]) -> Result<String, String> {
    let launcher = resolve_launcher()?;
    let command_args = launcher_command_args(&launcher, args);
    let mut command = if launcher.windows_shell && cfg!(target_os = "windows") {
        let mut shell = Command::new("cmd");
        shell.args(["/d", "/s", "/c"]);
        shell.arg(build_windows_command(&command_args));
        shell
    } else {
        let mut direct = Command::new(&launcher.program);
        direct.args(command_args.iter().skip(1));
        direct
    };
    command.current_dir(&launcher.install_root);
    command.env("GOATCITADEL_HOME", &launcher.install_root);
    command.env("GOATCITADEL_DESKTOP_HOST", "1");

    let output = command
        .output()
        .map_err(|error| format!("Failed to run GoatCitadel launcher: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("GoatCitadel launcher exited with {}: {}", output.status, stdout)
        } else {
            format!("GoatCitadel launcher exited with {}: {}", output.status, stderr)
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn resolve_launcher() -> Result<LauncherInvocation, String> {
    if let Ok(raw) = env::var("GOATCITADEL_DESKTOP_LAUNCHER") {
        let launcher = PathBuf::from(raw);
        if launcher.exists() {
            return Ok(invocation_for_launcher(launcher, env::var("GOATCITADEL_HOME").ok().map(PathBuf::from)));
        }
    }

    if let Ok(raw_home) = env::var("GOATCITADEL_HOME") {
        let home = PathBuf::from(raw_home);
        if let Some(invocation) = invocation_under_install_root(&home) {
            return Ok(invocation);
        }
    }

    let exe = env::current_exe().map_err(|error| format!("Unable to locate current executable: {error}"))?;
    for ancestor in exe.ancestors() {
        if ancestor.join("app").join("release-manifest.json").exists() {
            if let Some(invocation) = invocation_under_install_root(ancestor) {
                return Ok(invocation);
            }
        }
        let source_launcher = ancestor.join("bin").join("goatcitadel.mjs");
        if source_launcher.exists() {
            return Ok(LauncherInvocation {
                program: "node".to_string(),
                args_prefix: vec![source_launcher.to_string_lossy().to_string()],
                install_root: ancestor.to_path_buf(),
                windows_shell: false,
            });
        }
    }

    Err("Unable to locate GoatCitadel launcher from the desktop app location.".to_string())
}

fn invocation_under_install_root(root: &Path) -> Option<LauncherInvocation> {
    let packaged_node = root
        .join("app")
        .join("runtime")
        .join("node")
        .join(if cfg!(target_os = "windows") { "node.exe" } else { "node" });
    let packaged_script = root.join("app").join("bin").join("goatcitadel.mjs");
    if packaged_node.exists() && packaged_script.exists() {
        return Some(LauncherInvocation {
            program: packaged_node.to_string_lossy().to_string(),
            args_prefix: vec![packaged_script.to_string_lossy().to_string()],
            install_root: root.to_path_buf(),
            windows_shell: false,
        });
    }

    if let Some(launcher) = launcher_under_install_root(root) {
        return Some(invocation_for_launcher(launcher, Some(root.to_path_buf())));
    }

    None
}

fn launcher_under_install_root(root: &Path) -> Option<PathBuf> {
    let cmd = root.join("bin").join("goatcitadel.cmd");
    if cmd.exists() {
        return Some(cmd);
    }
    let script = root.join("app").join("bin").join("goatcitadel.mjs");
    if script.exists() {
        return Some(script);
    }
    None
}

fn invocation_for_launcher(launcher: PathBuf, install_root_override: Option<PathBuf>) -> LauncherInvocation {
    let install_root = install_root_override.unwrap_or_else(|| {
        launcher
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    });
    if launcher.extension().and_then(|value| value.to_str()) == Some("mjs") {
        return LauncherInvocation {
            program: "node".to_string(),
            args_prefix: vec![launcher.to_string_lossy().to_string()],
            install_root,
            windows_shell: false,
        };
    }
    let windows_shell = launcher
        .extension()
        .and_then(|value| value.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false);
    LauncherInvocation {
        program: launcher.to_string_lossy().to_string(),
        args_prefix: Vec::new(),
        install_root,
        windows_shell,
    }
}

fn launcher_command_args<const N: usize>(launcher: &LauncherInvocation, args: [&str; N]) -> Vec<String> {
    let mut command_args = vec![launcher.program.clone()];
    command_args.extend(launcher.args_prefix.iter().cloned());
    command_args.extend(args.into_iter().map(str::to_string));
    command_args
}

fn build_windows_command(parts: &[String]) -> String {
    parts
        .iter()
        .map(|value| quote_windows_command_arg(value))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_windows_command_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }
    if !value.chars().any(|character| character.is_whitespace() || "\"&()^<>|".contains(character)) {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn open_external(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/d", "/s", "/c", "start", "", target])
            .spawn()
            .map_err(|error| format!("Failed to open {target}: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|error| format!("Failed to open {target}: {error}"))?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|error| format!("Failed to open {target}: {error}"))?;
        return Ok(());
    }
}

fn path_to_open_target(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("Path is not valid UTF-8: {}", path.display()))
}

fn trim_trailing_slash(value: &str) -> &str {
    value.trim_end_matches('/')
}
