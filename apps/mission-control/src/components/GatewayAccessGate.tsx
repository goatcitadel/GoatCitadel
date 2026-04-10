import { useEffect, useState } from "react";
import {
  clearGatewayAuthState,
  createGatewayDeviceAccessRequest,
  getGatewayAuthStorageMode,
  pollGatewayDeviceAccessRequestStatus,
  persistGatewayAuthState,
  readStoredGatewayAuthState,
  type GatewayAccessPreflightResult,
  type GatewayAuthState,
} from "../api/shell-client";
import { deriveShellGatewayAccessState } from "../state/gateway-shell-state";
import { StatusChip } from "./StatusChip";
import { GCSelect, GCSwitch } from "./ui";

type GatewayAccessView =
  | GatewayAccessPreflightResult
  | {
    status: "checking";
    message: string;
    healthDetail?: string;
    authMode?: GatewayAuthState["mode"];
  };

interface GatewayAccessGateProps {
  gatewayBaseUrl: string;
  access: GatewayAccessView;
  busy: boolean;
  autoRetryPending?: boolean;
  onRetry: () => void | Promise<void>;
}

interface PendingDeviceApprovalRequest {
  requestId: string;
  requestSecret: string;
  approvalId: string;
  expiresAt: string;
  pollAfterMs: number;
  message: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

type AccessAuthMode = "token" | "basic";

export function GatewayAccessGate({
  gatewayBaseUrl,
  access,
  busy,
  autoRetryPending = false,
  onRetry,
}: GatewayAccessGateProps) {
  const shellState = deriveShellGatewayAccessState(access);
  const isChecking = access.status === "checking";
  const [authMode, setAuthMode] = useState<AccessAuthMode>("token");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [deviceApprovalError, setDeviceApprovalError] = useState<string | null>(null);
  const [deviceApprovalBusy, setDeviceApprovalBusy] = useState(false);
  const [pendingDeviceApproval, setPendingDeviceApproval] = useState<PendingDeviceApprovalRequest | null>(null);

  useEffect(() => {
    const stored = readStoredGatewayAuthState();
    setAuthMode(access.authMode === "basic" ? "basic" : stored?.mode === "basic" ? "basic" : "token");
    setToken(stored?.token ?? "");
    setUsername(stored?.username ?? "");
    setPassword(stored?.password ?? "");
    setRemember(getGatewayAuthStorageMode() === "persistent");
    setFormError(null);
    setDeviceApprovalError(null);
    setDeviceLabel(inferPendingDeviceLabel());
  }, [access.authMode, access.status]);

  useEffect(() => {
    if (access.status !== "needs-auth" || pendingDeviceApproval?.status !== "pending") {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const status = await pollGatewayDeviceAccessRequestStatus(
          pendingDeviceApproval.requestId,
          pendingDeviceApproval.requestSecret,
        );
        if (cancelled) {
          return;
        }

        setPendingDeviceApproval((current) => current ? {
          ...current,
          status: status.status,
          expiresAt: status.expiresAt,
          message: status.message,
        } : current);

        if (status.status === "approved" && status.deviceToken) {
          persistGatewayAuthState({
            mode: "token",
            token: status.deviceToken,
            tokenQueryParam: "access_token",
          }, "session");
          await onRetry();
          return;
        }

        if (status.status === "rejected" || status.status === "expired") {
          setDeviceApprovalError(status.message);
        }
      } catch (error) {
        if (!cancelled) {
          setDeviceApprovalError((error as Error).message);
        }
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, Math.max(1500, pendingDeviceApproval.pollAfterMs));

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    access.status,
    onRetry,
    pendingDeviceApproval?.pollAfterMs,
    pendingDeviceApproval?.requestId,
    pendingDeviceApproval?.requestSecret,
    pendingDeviceApproval?.status,
  ]);

  const storedAuthPresent = Boolean(readStoredGatewayAuthState());
  const needsAuth = access.status === "needs-auth";
  const headerKicker = isChecking ? "Mission Control startup" : "Remote gateway handshake";
  const headerTitle = isChecking ? "Starting Mission Control" : "Mission Control access gate";
  const headerSubtitle = isChecking
    ? "Connecting to the gateway, validating access, and warming up live control surfaces."
    : "Mission Control is waiting for a verified gateway session before it starts live data and control surfaces.";

  const handleConnect = async () => {
    setFormError(null);
    if (authMode === "token") {
      if (!token.trim()) {
        setFormError("Enter the gateway token before retrying.");
        return;
      }
      persistGatewayAuthState({
        mode: "token",
        token,
        tokenQueryParam: "access_token",
      }, remember ? "persistent" : "session");
      await onRetry();
      return;
    }

    if (!username.trim() || !password) {
      setFormError("Enter both username and password before retrying.");
      return;
    }

    persistGatewayAuthState({
      mode: "basic",
      username,
      password,
    }, remember ? "persistent" : "session");
    await onRetry();
  };

  const handleRequestApproval = async () => {
    setFormError(null);
    setDeviceApprovalError(null);
    setDeviceApprovalBusy(true);
    try {
      const created = await createGatewayDeviceAccessRequest({
        deviceLabel: deviceLabel.trim() || undefined,
        deviceType: inferPendingDeviceType(),
        platform: inferPendingDevicePlatform(),
      });
      setPendingDeviceApproval({
        ...created,
        status: created.status,
      });
    } catch (error) {
      setDeviceApprovalError((error as Error).message);
    } finally {
      setDeviceApprovalBusy(false);
    }
  };

  return (
    <section className="gateway-access-shell theme-citadel-light" aria-live="polite">
      <div className="panel panel-pad-spacious panel-accent gateway-access-card">
        <div className="gateway-access-header">
          <div className="gateway-access-copy">
            <p className="shell-topbar-kicker">{headerKicker}</p>
            <h1 className="gateway-access-title">{headerTitle}</h1>
            <p className="office-subtitle gateway-access-subtitle">
              {headerSubtitle}
            </p>
          </div>
          <StatusChip tone={shellState.tone}>{shellState.label}</StatusChip>
        </div>

        <div className="gateway-access-meta">
          <div>
            <span className="gc-meta-label">Gateway target</span>
            <p className="gateway-access-mono">{gatewayBaseUrl}</p>
          </div>
          {!isChecking ? (
            <div>
              <span className="gc-meta-label">Stored credentials</span>
              <p className="gateway-access-note">{storedAuthPresent ? "Present on this browser." : "None stored yet."}</p>
            </div>
          ) : null}
        </div>

        <div className="gateway-access-status">
          <p>{shellState.summary}</p>
          <p className="gateway-access-note"><strong>Next:</strong> {shellState.nextStep}</p>
          {access.status === "unreachable" && autoRetryPending ? (
            <p className="gateway-access-note">Mission Control will retry the gateway handshake automatically.</p>
          ) : null}
        </div>

        {shellState.detail ? (
          <details className="gateway-access-details">
            <summary>Technical details</summary>
            <p className="gateway-access-note">{shellState.detail}</p>
          </details>
        ) : null}

        {formError ? <p className="error gateway-access-error">{formError}</p> : null}
        {deviceApprovalError ? <p className="error gateway-access-error">{deviceApprovalError}</p> : null}

        {needsAuth ? (
          <div className="gateway-access-form">
            <div className="controls-row gateway-access-row">
              <label htmlFor="gateway-access-mode">Credential type</label>
              <GCSelect
                id="gateway-access-mode"
                aria-label="Gateway credential type"
                value={authMode}
                onChange={(value) => setAuthMode(value as AccessAuthMode)}
                options={[
                  { value: "token", label: "Token" },
                  { value: "basic", label: "Basic" },
                ]}
              />
            </div>

            {authMode === "token" ? (
              <div className="controls-row gateway-access-row">
                <label htmlFor="gateway-access-token">Gateway token</label>
                <input
                  className="gc-input"
                  id="gateway-access-token"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                />
              </div>
            ) : (
              <>
                <div className="controls-row gateway-access-row">
                  <label htmlFor="gateway-access-username">Username</label>
                  <input
                    className="gc-input"
                    id="gateway-access-username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                  />
                </div>
                <div className="controls-row gateway-access-row">
                  <label htmlFor="gateway-access-password">Password</label>
                  <input
                    className="gc-input"
                    id="gateway-access-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              </>
            )}

            <div className="controls-row gateway-access-row">
              <GCSwitch
                id="gateway-access-remember"
                checked={remember}
                onCheckedChange={setRemember}
                label="Remember credentials on this browser"
              />
            </div>

            <div className="controls-row gateway-access-row">
              <label htmlFor="gateway-access-device-label">Request label</label>
              <input
                className="gc-input"
                id="gateway-access-device-label"
                value={deviceLabel}
                onChange={(event) => setDeviceLabel(event.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
        ) : null}

        {needsAuth && pendingDeviceApproval ? (
          <div className="gateway-access-status">
            <p>{pendingDeviceApproval.message}</p>
            <p className="gateway-access-note">
              Request expires at {new Date(pendingDeviceApproval.expiresAt).toLocaleTimeString()}.
            </p>
          </div>
        ) : null}

        <div className="gateway-access-actions">
          {needsAuth ? (
            <>
              <button type="button" className="gc-button" onClick={() => void handleConnect()} disabled={busy || deviceApprovalBusy}>
                {busy ? "Connecting..." : "Connect to gateway"}
              </button>
              <button
                type="button"
                className="gc-button"
                onClick={() => void handleRequestApproval()}
                disabled={busy || deviceApprovalBusy || pendingDeviceApproval?.status === "pending"}
              >
                {deviceApprovalBusy
                  ? "Requesting..."
                  : pendingDeviceApproval?.status === "pending"
                    ? "Waiting for approval..."
                    : "Request approval from another device"}
              </button>
            </>
          ) : (
            <button type="button" className="gc-button" onClick={() => void onRetry()} disabled={busy}>
              {busy ? (isChecking ? "Checking..." : "Re-checking...") : "Retry gateway check"}
            </button>
          )}

          {needsAuth && pendingDeviceApproval ? (
            <button
              type="button"
              className="gc-button"
              onClick={() => {
                setPendingDeviceApproval(null);
                setDeviceApprovalError(null);
              }}
              disabled={busy || deviceApprovalBusy}
            >
              Reset request
            </button>
          ) : null}

          {storedAuthPresent && !isChecking ? (
            <button
              type="button"
              className="gc-button danger"
              onClick={() => {
                clearGatewayAuthState();
                setToken("");
                setUsername("");
                setPassword("");
                setPendingDeviceApproval(null);
              }}
              disabled={busy}
            >
              Clear saved credentials
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function inferPendingDeviceType(): "mobile" | "desktop" | "tablet" | "browser" | "unknown" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("ipad") || userAgent.includes("tablet")) {
    return "tablet";
  }
  if (userAgent.includes("iphone") || userAgent.includes("android") || userAgent.includes("mobile")) {
    return "mobile";
  }
  if (userAgent.includes("windows") || userAgent.includes("macintosh") || userAgent.includes("linux")) {
    return "desktop";
  }
  return "browser";
}

function inferPendingDevicePlatform(): string | undefined {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("iphone")) {
    return "iPhone";
  }
  if (userAgent.includes("ipad")) {
    return "iPad";
  }
  if (userAgent.includes("android")) {
    return "Android";
  }
  if (userAgent.includes("windows")) {
    return "Windows";
  }
  if (userAgent.includes("mac os x") || userAgent.includes("macintosh")) {
    return "macOS";
  }
  if (userAgent.includes("linux")) {
    return "Linux";
  }
  return undefined;
}

function inferPendingDeviceBrowser(): string | undefined {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("edg/")) {
    return "Edge";
  }
  if (userAgent.includes("chrome/") && !userAgent.includes("edg/")) {
    return "Chrome";
  }
  if (userAgent.includes("firefox/")) {
    return "Firefox";
  }
  if (userAgent.includes("safari/") && !userAgent.includes("chrome/")) {
    return "Safari";
  }
  return undefined;
}

function inferPendingDeviceLabel(): string {
  const platform = inferPendingDevicePlatform();
  const browser = inferPendingDeviceBrowser();
  if (platform && browser) {
    return `${platform} ${browser}`;
  }
  return platform ?? browser ?? "New device";
}
