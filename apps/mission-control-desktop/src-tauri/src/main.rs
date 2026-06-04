use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
#[cfg(target_os = "windows")]
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WindowEvent,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

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
    working_dir: PathBuf,
    app_dir: Option<PathBuf>,
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
    desktop_event_stream: Option<DesktopEventStreamCredential>,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorAttentionPayload {
    title: String,
    body: String,
    route_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopEventStreamCredential {
    scope: Option<String>,
    token: Option<String>,
    expires_at: Option<String>,
    auth_mode: Option<String>,
    error: Option<String>,
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
fn launch_runtime(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<DesktopLaunchResult, String> {
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
    serde_json::from_str(&output)
        .map_err(|error| format!("Launcher returned invalid JSON: {error}. Output: {output}"))
}

#[tauri::command]
fn open_browser(url: String) -> Result<DesktopActionResult, String> {
    open_external(validate_browser_target(&url)?.as_str())?;
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
                    if let Some(state) = handle.try_state::<DesktopState>() {
                        let _ = stop_approval_watcher(&state);
                    }
                    let _ = run_launcher(["stop", "--json"]);
                    if let Ok(output) = run_launcher(["launch", "--no-open", "--json", "--wait"]) {
                        if let Ok(result) = serde_json::from_str::<DesktopLaunchResult>(&output) {
                            if let Some(state) = handle.try_state::<DesktopState>() {
                                if let Ok(mut last_runtime) = state.last_runtime.lock() {
                                    *last_runtime = Some(result.clone());
                                }
                                let _ = start_approval_watcher(handle.clone(), state, result);
                            }
                        }
                    }
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
                    let _ = path_to_open_target(&root.join("runtime").join("logs"))
                        .and_then(|target| open_external(&target));
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
        watch_approval_events(app, runtime, stop);
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

fn watch_approval_events(app: AppHandle, runtime: DesktopLaunchResult, stop: Arc<AtomicBool>) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(70))
        .connect_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let gateway_url = runtime.gateway_url.clone();
    let mut token = runtime
        .desktop_event_stream
        .as_ref()
        .and_then(|value| value.token.clone());
    if let Some(error) = runtime
        .desktop_event_stream
        .as_ref()
        .and_then(|value| value.error.clone())
    {
        emit_watcher_error(&app, "desktop_sse_token_unavailable", &error);
    }

    while !stop.load(Ordering::Relaxed) {
        let stream_url = build_event_stream_url(&gateway_url, token.as_deref());
        let response = client.get(&stream_url).send();
        let Ok(response) = response else {
            sleep_or_stop(&stop, Duration::from_secs(5));
            continue;
        };
        if !response.status().is_success() {
            if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
                token = refresh_desktop_event_stream_token(&gateway_url);
                emit_watcher_error(
                    &app,
                    "desktop_sse_auth_failed",
                    "Desktop approval notifications could not authenticate to the gateway event stream.",
                );
            }
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
                } else if let Some(payload) = parse_operator_attention_notification(&data) {
                    let _ = app.emit("desktop://operator-attention", payload);
                }
            }
        }
        sleep_or_stop(&stop, Duration::from_secs(2));
    }
}

fn build_event_stream_url(gateway_url: &str, token: Option<&str>) -> String {
    let mut url = format!(
        "{}/api/v1/events/stream?replay=0",
        trim_trailing_slash(gateway_url)
    );
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        url.push_str("&sse_token=");
        url.push_str(&url_encode_query_value(token));
    }
    url
}

fn refresh_desktop_event_stream_token(gateway_url: &str) -> Option<String> {
    let output = run_launcher(["status", "--json"]).ok()?;
    let status: DesktopRuntimeStatus = serde_json::from_str(&output).ok()?;
    if trim_trailing_slash(&status.gateway_url) != trim_trailing_slash(gateway_url) {
        return None;
    }
    status.desktop_event_stream?.token
}

fn emit_watcher_error(app: &AppHandle, code: &str, message: &str) {
    let _ = app.emit(
        "desktop://approval-watcher-error",
        json!({
            "code": code,
            "message": message,
        }),
    );
}

fn url_encode_query_value(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect::<Vec<_>>()
        .join("")
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
        kind: payload
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_string),
        risk_level: payload
            .get("riskLevel")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: payload
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_operator_attention_notification(data: &str) -> Option<OperatorAttentionPayload> {
    let value: Value = serde_json::from_str(data).ok()?;
    let event_type = value.get("eventType")?.as_str()?.to_lowercase();
    if event_type == "approval_created" {
        return None;
    }
    let payload = value.get("payload").and_then(Value::as_object);
    let payload_event = payload
        .and_then(|item| item.get("event"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let payload_status = payload
        .and_then(|item| item.get("status"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let signal = format!("{event_type} {payload_event} {payload_status}");

    if signal.contains("run_completed")
        || signal.contains("run.completed")
        || signal.contains("run.stopped")
        || signal.contains("run_stopped")
        || (is_run_like_signal(&signal) && signal.contains("completed"))
    {
        return Some(OperatorAttentionPayload {
            title: "GoatCitadel run completed".to_string(),
            body: "Results are ready to review.".to_string(),
            route_path: Some("/ops/activity".to_string()),
        });
    }

    if signal.contains("run_failed")
        || signal.contains("run.failed")
        || is_runtime_degraded_signal(&signal)
        || (is_run_like_signal(&signal)
            && (signal.contains("failed")
                || signal.contains("failure")
                || signal.contains("error")
                || signal.contains("critical")))
    {
        return Some(OperatorAttentionPayload {
            title: "GoatCitadel needs attention".to_string(),
            body: "A run or runtime signal needs operator review.".to_string(),
            route_path: Some("/ops/notifications".to_string()),
        });
    }

    if signal.contains("paused_for_approval")
        || signal.contains("waiting_for_operator")
        || (is_run_like_signal(&signal)
            && (signal.contains("blocked") || signal.contains("requires_operator")))
    {
        return Some(OperatorAttentionPayload {
            title: "GoatCitadel is waiting".to_string(),
            body: "Work is paused until the operator responds.".to_string(),
            route_path: Some("/ops/approvals".to_string()),
        });
    }

    None
}

fn is_run_like_signal(signal: &str) -> bool {
    signal.contains("run_")
        || signal.contains("run.")
        || signal.contains("orchestration")
        || signal.contains("durable")
        || signal.contains("code_mode")
}

fn is_runtime_degraded_signal(signal: &str) -> bool {
    signal.contains("degraded")
        || signal.contains("provider_failed")
        || signal.contains("gateway_failed")
        || signal.contains("health_failed")
        || signal.contains("daemon_stopped")
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
    command.current_dir(&launcher.working_dir);
    command.env("GOATCITADEL_HOME", &launcher.install_root);
    if let Some(app_dir) = &launcher.app_dir {
        command.env("GOATCITADEL_APP_DIR", app_dir);
    }
    command.env("GOATCITADEL_DESKTOP_HOST", "1");

    let output = command
        .output()
        .map_err(|error| format!("Failed to run GoatCitadel launcher: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "GoatCitadel launcher exited with {}: {}",
                output.status, stdout
            )
        } else {
            format!(
                "GoatCitadel launcher exited with {}: {}",
                output.status, stderr
            )
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn resolve_launcher() -> Result<LauncherInvocation, String> {
    if let Ok(raw) = env::var("GOATCITADEL_DESKTOP_LAUNCHER") {
        let launcher = PathBuf::from(raw);
        if launcher.exists() {
            return Ok(invocation_for_launcher(
                launcher,
                env::var("GOATCITADEL_HOME").ok().map(PathBuf::from),
            ));
        }
    }

    if let Ok(raw_home) = env::var("GOATCITADEL_HOME") {
        let home = PathBuf::from(raw_home);
        if let Some(invocation) = invocation_under_install_root(&home) {
            return Ok(invocation);
        }
    }

    let exe = env::current_exe()
        .map_err(|error| format!("Unable to locate current executable: {error}"))?;
    for ancestor in exe.ancestors() {
        let macos_resource_root = ancestor.join("Resources").join("goatcitadel");
        if let Some(invocation) = invocation_under_macos_resource_root(&macos_resource_root) {
            return Ok(invocation);
        }
        if let Some(invocation) = invocation_for_packaged_app_dir(ancestor) {
            return Ok(invocation);
        }
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
                working_dir: ancestor.to_path_buf(),
                app_dir: None,
                windows_shell: false,
            });
        }
    }

    Err("Unable to locate GoatCitadel launcher from the desktop app location.".to_string())
}

fn invocation_for_packaged_app_dir(app_dir: &Path) -> Option<LauncherInvocation> {
    if !app_dir.join("release-manifest.json").exists() {
        return None;
    }
    let install_root = app_dir.parent()?;
    invocation_under_install_root(install_root)
}

fn invocation_under_install_root(root: &Path) -> Option<LauncherInvocation> {
    let packaged_node =
        root.join("app")
            .join("runtime")
            .join("node")
            .join(if cfg!(target_os = "windows") {
                "node.exe"
            } else {
                "node"
            });
    let packaged_script = root.join("app").join("bin").join("goatcitadel.mjs");
    if packaged_node.exists() && packaged_script.exists() {
        return Some(LauncherInvocation {
            program: packaged_node.to_string_lossy().to_string(),
            args_prefix: vec![packaged_script.to_string_lossy().to_string()],
            install_root: root.to_path_buf(),
            working_dir: root.to_path_buf(),
            app_dir: None,
            windows_shell: false,
        });
    }

    if let Some(launcher) = launcher_under_install_root(root) {
        return Some(invocation_for_launcher(launcher, Some(root.to_path_buf())));
    }

    None
}

fn invocation_under_macos_resource_root(root: &Path) -> Option<LauncherInvocation> {
    let app_dir = root.join("app");
    if !app_dir.join("release-manifest.json").exists() {
        return None;
    }
    let packaged_node = app_dir.join("runtime").join("node").join("node");
    let packaged_script = app_dir.join("bin").join("goatcitadel.mjs");
    if !(packaged_node.exists() && packaged_script.exists()) {
        return None;
    }
    Some(LauncherInvocation {
        program: packaged_node.to_string_lossy().to_string(),
        args_prefix: vec![packaged_script.to_string_lossy().to_string()],
        install_root: resolve_desktop_home(),
        working_dir: root.to_path_buf(),
        app_dir: Some(app_dir),
        windows_shell: false,
    })
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

fn invocation_for_launcher(
    launcher: PathBuf,
    install_root_override: Option<PathBuf>,
) -> LauncherInvocation {
    let install_root = install_root_override.unwrap_or_else(|| {
        launcher
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    });
    if launcher.extension().and_then(|value| value.to_str()) == Some("mjs") {
        let app_dir = env::var("GOATCITADEL_APP_DIR").ok().map(PathBuf::from);
        return LauncherInvocation {
            program: "node".to_string(),
            args_prefix: vec![launcher.to_string_lossy().to_string()],
            working_dir: install_root.clone(),
            install_root,
            app_dir,
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
        working_dir: install_root.clone(),
        install_root,
        app_dir: env::var("GOATCITADEL_APP_DIR").ok().map(PathBuf::from),
        windows_shell,
    }
}

fn resolve_desktop_home() -> PathBuf {
    if let Ok(raw_home) = env::var("GOATCITADEL_HOME") {
        if !raw_home.trim().is_empty() {
            return PathBuf::from(raw_home);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("GoatCitadel");
        }
    }
    PathBuf::from(".")
}

fn launcher_command_args<const N: usize>(
    launcher: &LauncherInvocation,
    args: [&str; N],
) -> Vec<String> {
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
    if !value
        .chars()
        .any(|character| character.is_whitespace() || "\"&()^<>|".contains(character))
    {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn open_external(target: &str) -> Result<(), String> {
    let target = validate_open_target(target)?;
    #[cfg(target_os = "windows")]
    {
        let operation = to_wide_null("open");
        let file = to_wide_null(&target);
        let result = unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                operation.as_ptr(),
                file.as_ptr(),
                ptr::null(),
                ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err(format!(
                "Failed to open {target}: ShellExecuteW returned {result:?}"
            ));
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|error| format!("Failed to open {target}: {error}"))?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|error| format!("Failed to open {target}: {error}"))?;
        return Ok(());
    }
}

fn validate_open_target(target: &str) -> Result<String, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("Open target is empty.".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("Open target contains control characters.".to_string());
    }
    if looks_like_url(trimmed) {
        return validate_browser_target(trimmed);
    }
    if Path::new(trimmed).exists() {
        return Ok(trimmed.to_string());
    }
    Err("Open target must be a supported local URL or an existing local path.".to_string())
}

fn validate_browser_target(target: &str) -> Result<String, String> {
    let trimmed = target.trim();
    if trimmed.chars().any(char::is_control) {
        return Err("Browser target contains control characters.".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let scheme_end = lower
        .find("://")
        .ok_or_else(|| "Browser target must be an http or https URL.".to_string())?;
    let scheme = &lower[..scheme_end];
    if scheme != "http" && scheme != "https" {
        return Err("Browser target must use http or https.".to_string());
    }
    let authority_start = scheme_end + 3;
    let authority_end = trimmed[authority_start..]
        .char_indices()
        .find(|(_, character)| matches!(character, '/' | '?' | '#'))
        .map(|(index, _)| authority_start + index)
        .unwrap_or(trimmed.len());
    let authority = &trimmed[authority_start..authority_end];
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    }
    .to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Ok(trimmed.to_string());
    }
    Err("Browser target host is not an allowed local GoatCitadel host.".to_string())
}

fn looks_like_url(target: &str) -> bool {
    target.contains("://")
}

#[cfg(target_os = "windows")]
fn to_wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn path_to_open_target(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("Path is not valid UTF-8: {}", path.display()))
}

fn trim_trailing_slash(value: &str) -> &str {
    value.trim_end_matches('/')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn validates_browser_targets_to_loopback_hosts() {
        assert!(validate_browser_target("http://127.0.0.1:5174/?tab=dashboard").is_ok());
        assert!(validate_browser_target("https://localhost:8787/status").is_ok());
        assert!(validate_browser_target("http://[::1]:5174/").is_ok());
        assert!(validate_browser_target("https://example.com").is_err());
        assert!(validate_browser_target("file:///C:/Windows/System32/calc.exe").is_err());
    }

    #[test]
    fn encodes_sse_token_query_value() {
        assert_eq!(url_encode_query_value("abc 123+/="), "abc%20123%2B%2F%3D");
    }

    #[test]
    fn builds_event_stream_url_with_optional_sse_token() {
        assert_eq!(
            build_event_stream_url("http://127.0.0.1:8787/", Some("token value")),
            "http://127.0.0.1:8787/api/v1/events/stream?replay=0&sse_token=token%20value",
        );
        assert_eq!(
            build_event_stream_url("http://127.0.0.1:8787", None),
            "http://127.0.0.1:8787/api/v1/events/stream?replay=0",
        );
    }

    #[test]
    fn quotes_windows_command_arguments_with_shell_metacharacters() {
        assert_eq!(quote_windows_command_arg("plain"), "plain");
        assert_eq!(quote_windows_command_arg("with space"), "\"with space\"");
        assert_eq!(quote_windows_command_arg("a&b"), "\"a&b\"");
    }

    #[test]
    fn packaged_app_dir_resolves_to_parent_install_root() {
        let root = env::temp_dir().join(format!(
            "goatcitadel-desktop-launcher-test-{}",
            std::process::id()
        ));
        let app_dir = root.join("app");
        let node_name = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };
        let node_path = app_dir.join("runtime").join("node").join(node_name);
        let launcher_path = app_dir.join("bin").join("goatcitadel.mjs");

        fs::remove_dir_all(&root).ok();
        fs::create_dir_all(node_path.parent().expect("node parent")).expect("node dir");
        fs::create_dir_all(launcher_path.parent().expect("launcher parent")).expect("bin dir");
        fs::write(app_dir.join("release-manifest.json"), "{}").expect("manifest");
        fs::write(&node_path, "").expect("node");
        fs::write(&launcher_path, "").expect("launcher");

        let invocation =
            invocation_for_packaged_app_dir(&app_dir).expect("packaged app invocation");
        assert_eq!(invocation.install_root, root);
        assert_eq!(invocation.working_dir, root);
        assert_eq!(invocation.program, node_path.to_string_lossy());
        assert_eq!(
            invocation.args_prefix,
            vec![launcher_path.to_string_lossy()]
        );

        fs::remove_dir_all(invocation.install_root).ok();
    }

    #[test]
    fn parses_approval_created_notification() {
        let payload = parse_approval_notification(
            r#"{"eventType":"approval_created","payload":{"approvalId":"ap-1","kind":"tool","riskLevel":"medium","status":"pending"}}"#,
        )
        .expect("approval notification");
        assert_eq!(payload.approval_id, "ap-1");
        assert_eq!(payload.kind.as_deref(), Some("tool"));
        assert_eq!(payload.risk_level.as_deref(), Some("medium"));
        assert_eq!(payload.status.as_deref(), Some("pending"));
    }

    #[test]
    fn parses_operator_attention_notifications() {
        assert!(parse_operator_attention_notification(
            r#"{"eventType":"approval_created","payload":{"approvalId":"ap-1"}}"#,
        )
        .is_none());

        let completed = parse_operator_attention_notification(
            r#"{"eventType":"orchestration_event","payload":{"event":"run_completed","status":"completed"}}"#,
        )
        .expect("completed notification");
        assert_eq!(completed.title, "GoatCitadel run completed");
        assert_eq!(completed.route_path.as_deref(), Some("/ops/activity"));
        assert!(parse_operator_attention_notification(
            r#"{"eventType":"task_updated","payload":{"status":"completed"}}"#,
        )
        .is_none());

        let failed = parse_operator_attention_notification(
            r#"{"eventType":"orchestration_event","payload":{"event":"run_failed","status":"failed"}}"#,
        )
        .expect("failed notification");
        assert_eq!(failed.title, "GoatCitadel needs attention");
        assert_eq!(failed.route_path.as_deref(), Some("/ops/notifications"));
        let degraded = parse_operator_attention_notification(
            r#"{"eventType":"provider_failed","payload":{"status":"failed"}}"#,
        )
        .expect("degraded notification");
        assert_eq!(degraded.title, "GoatCitadel needs attention");

        let waiting = parse_operator_attention_notification(
            r#"{"eventType":"orchestration_event","payload":{"event":"run_paused_for_approval"}}"#,
        )
        .expect("waiting notification");
        assert_eq!(waiting.title, "GoatCitadel is waiting");
        assert_eq!(waiting.route_path.as_deref(), Some("/ops/approvals"));
    }
}
