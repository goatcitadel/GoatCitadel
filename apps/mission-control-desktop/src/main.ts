import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import "./styles.css";

type ManagedPidState = "missing" | "invalid" | "running" | "stale";
type DesktopRuntimeStatusValue = "ready" | "degraded" | "stopped" | "stale";

interface ManagedPidInfo {
  pid?: number;
  state: ManagedPidState;
  raw?: string;
}

interface DesktopRuntimeStatus {
  status: DesktopRuntimeStatusValue;
  gatewayUrl: string;
  uiUrl: string;
  targetUrl: string;
  packaged: boolean;
  runtimeRoot: string;
  runtimeStateDir: string;
  pidFiles: {
    gateway: string;
    ui: string;
  };
  pids: {
    gateway: ManagedPidInfo;
    ui: ManagedPidInfo;
  };
  logFiles: {
    gatewayStdout: string;
    gatewayStderr: string;
    missionControlStdout: string;
    missionControlStderr: string;
  };
  readiness: {
    gateway: boolean;
    ui: boolean;
  };
  onboardingCompleted: boolean;
  checkedAt: string;
}

type DesktopLaunchResult = DesktopRuntimeStatus;

interface ApprovalNotificationPayload {
  approvalId: string;
  kind?: string;
  riskLevel?: string;
  status?: string;
}

const startup = mustGetElement<HTMLElement>("startup");
const frame = mustGetElement<HTMLIFrameElement>("mission-control-frame");
const statusCopy = mustGetElement<HTMLElement>("status-copy");
const progressBar = mustGetElement<HTMLElement>("progress-bar");
const runtimeMeta = mustGetElement<HTMLElement>("runtime-meta");
const recoveryActions = mustGetElement<HTMLElement>("recovery-actions");
const retryButton = mustGetElement<HTMLButtonElement>("retry-button");
const openBrowserButton = mustGetElement<HTMLButtonElement>("open-browser-button");
const openLogsButton = mustGetElement<HTMLButtonElement>("open-logs-button");
const openFolderButton = mustGetElement<HTMLButtonElement>("open-folder-button");
const desktopToast = mustGetElement<HTMLElement>("desktop-toast");

let lastRuntime: DesktopRuntimeStatus | null = null;
let toastTimer: number | undefined;

retryButton.addEventListener("click", () => {
  void launchRuntime();
});

openBrowserButton.addEventListener("click", () => {
  const url = lastRuntime?.targetUrl || lastRuntime?.uiUrl;
  if (url) {
    void invoke("open_browser", { url });
  }
});

openLogsButton.addEventListener("click", () => {
  void invoke("open_logs");
});

openFolderButton.addEventListener("click", () => {
  void invoke("open_install_folder");
});

void listen<ApprovalNotificationPayload>("desktop://approval-created", (event) => {
  void showApprovalNotification(event.payload);
});

void listen("desktop://runtime-status-requested", () => {
  void refreshRuntimeStatus();
});

void listen("desktop://runtime-restarted", () => {
  showToast("Runtime restarted. Refreshing Mission Control...");
  void launchRuntime();
});

void listen("desktop://runtime-stopped", () => {
  renderStopped();
  showToast("Runtime stopped. Browser fallback remains available after restart.");
});

void launchRuntime();

async function launchRuntime(): Promise<void> {
  renderStarting();
  try {
    const result = await invoke<DesktopLaunchResult>("launch_runtime");
    lastRuntime = result;
    renderRuntime(result);
    if (result.status === "ready") {
      frame.src = result.targetUrl;
      startup.classList.add("is-hidden");
      frame.classList.add("is-ready");
    } else {
      renderRecovery(`Runtime is ${result.status}. Gateway and Mission Control did not both become ready.`);
    }
  } catch (error) {
    renderRecovery(error instanceof Error ? error.message : String(error));
  }
}

function renderStarting(): void {
  startup.classList.remove("is-hidden");
  frame.classList.remove("is-ready");
  recoveryActions.classList.add("is-hidden");
  statusCopy.textContent = "Starting the local runtime...";
  progressBar.style.width = "42%";
  runtimeMeta.textContent = "Gateway and Mission Control will stay warm while the desktop app is open.";
}

function renderRuntime(result: DesktopRuntimeStatus): void {
  statusCopy.textContent =
    result.status === "ready" ? "Runtime ready. Opening Mission Control..." : `Runtime status: ${result.status}`;
  progressBar.style.width = result.status === "ready" ? "100%" : "64%";
  runtimeMeta.textContent = [
    `Gateway ${result.readiness.gateway ? "ready" : "not ready"}`,
    `UI ${result.readiness.ui ? "ready" : "not ready"}`,
    result.packaged ? "packaged install" : "source checkout",
  ].join(" / ");
}

function renderRecovery(message: string): void {
  startup.classList.remove("is-hidden");
  frame.classList.remove("is-ready");
  recoveryActions.classList.remove("is-hidden");
  statusCopy.textContent = message;
  progressBar.style.width = "18%";
  runtimeMeta.textContent = lastRuntime
    ? `Logs: ${lastRuntime.logFiles.gatewayStderr}`
    : "Runtime did not return a status payload. Open logs for the captured launcher output.";
}

function renderStopped(): void {
  startup.classList.remove("is-hidden");
  frame.classList.remove("is-ready");
  recoveryActions.classList.remove("is-hidden");
  statusCopy.textContent = "Runtime stopped.";
  progressBar.style.width = "0%";
  runtimeMeta.textContent = lastRuntime
    ? `Gateway ${lastRuntime.readiness.gateway ? "ready" : "not ready"} / UI ${
        lastRuntime.readiness.ui ? "ready" : "not ready"
      }`
    : "Use Retry to start GoatCitadel again.";
}

async function refreshRuntimeStatus(): Promise<void> {
  try {
    const result = await invoke<DesktopRuntimeStatus>("read_runtime_status");
    lastRuntime = result;
    showToast(
      `Runtime ${result.status}: gateway ${result.readiness.gateway ? "ready" : "not ready"}, UI ${
        result.readiness.ui ? "ready" : "not ready"
      }.`,
    );
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function showApprovalNotification(payload: ApprovalNotificationPayload): Promise<void> {
  const approvalId = payload.approvalId;
  const body = `${payload.kind ?? "Approval"}${payload.riskLevel ? ` / ${payload.riskLevel}` : ""}`;
  const title = "GoatCitadel approval waiting";
  const granted = await ensureNotificationPermission();

  if (granted && "Notification" in window) {
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      openApprovalRoute(approvalId);
      notification.close();
    };
    return;
  }

  if (granted) {
    sendNotification({ title, body });
  }
}

async function ensureNotificationPermission(): Promise<boolean> {
  if (await isPermissionGranted()) {
    return true;
  }
  const permission = await requestPermission();
  return permission === "granted";
}

function openApprovalRoute(approvalId: string): void {
  const uiUrl = lastRuntime?.uiUrl;
  if (!uiUrl) {
    return;
  }
  frame.src = `${trimTrailingSlash(uiUrl)}/ops/approvals?approvalId=${encodeURIComponent(approvalId)}`;
  startup.classList.add("is-hidden");
  frame.classList.add("is-ready");
}

function showToast(message: string): void {
  desktopToast.textContent = message;
  desktopToast.classList.remove("is-hidden");
  if (toastTimer !== undefined) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    desktopToast.classList.add("is-hidden");
  }, 5200);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function mustGetElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing desktop shell element: ${id}`);
  }
  return element as T;
}
