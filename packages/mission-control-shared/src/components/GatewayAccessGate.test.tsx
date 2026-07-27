import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayAccessGate } from "./GatewayAccessGate";

const shellMocks = vi.hoisted(() => ({
  clearGatewayAuthState: vi.fn(),
  createGatewayDeviceAccessRequest: vi.fn(),
  getGatewayAuthStorageMode: vi.fn(),
  persistGatewayAuthState: vi.fn(),
  pollGatewayDeviceAccessRequestStatus: vi.fn(),
  readStoredGatewayAuthState: vi.fn(),
}));

vi.mock("../api/shell-client", () => ({
  clearGatewayAuthState: shellMocks.clearGatewayAuthState,
  createGatewayDeviceAccessRequest: shellMocks.createGatewayDeviceAccessRequest,
  getGatewayAuthStorageMode: shellMocks.getGatewayAuthStorageMode,
  persistGatewayAuthState: shellMocks.persistGatewayAuthState,
  pollGatewayDeviceAccessRequestStatus: shellMocks.pollGatewayDeviceAccessRequestStatus,
  readStoredGatewayAuthState: shellMocks.readStoredGatewayAuthState,
}));

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length() {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function installBrowser(search = "") {
  const location = new URL(`http://localhost:5173/${search}`);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location,
      localStorage: new MemoryStorage(),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    },
  });
}

function installUserAgent(userAgent: string) {
  vi.stubGlobal("navigator", { userAgent });
}

function needsAuthAccess(overrides: Record<string, unknown> = {}) {
  return {
    status: "needs-auth",
    message: "Authentication required",
    healthDetail: "401 Unauthorized",
    authMode: "token",
    ...overrides,
  } as never;
}

function flushAsync() {
  return act(async () => {
    await Promise.resolve();
  });
}

function findButtonByText(root: ReturnType<typeof create>["root"], text: string) {
  return root.findAllByType("button").find((button) => button.children.join("") === text);
}

function findButtonById(root: ReturnType<typeof create>["root"], id: string) {
  return root.findAllByType("button").find((button) => button.props.id === id);
}

function pendingDeviceApproval(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "request-1",
    requestSecret: "secret-1",
    approvalId: "approval-1",
    expiresAt: "2026-01-01T12:05:00.000Z",
    pollAfterMs: 25,
    message: "Waiting for another device",
    status: "approved",
    ...overrides,
  };
}

describe("GatewayAccessGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    });
    installBrowser();
    window.localStorage.setItem("goatcitadel.ui.theme.v1", "light");
    shellMocks.getGatewayAuthStorageMode.mockReturnValue("session");
    shellMocks.readStoredGatewayAuthState.mockReturnValue(undefined);
    shellMocks.createGatewayDeviceAccessRequest.mockReset();
    shellMocks.pollGatewayDeviceAccessRequestStatus.mockReset();
    shellMocks.persistGatewayAuthState.mockReset();
    shellMocks.clearGatewayAuthState.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the noir theme when rendered outside a browser window", () => {
    vi.stubGlobal("window", undefined);

    const markup = renderToStaticMarkup(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={{ status: "checking", message: "Booting" }}
        busy={false}
        onRetry={() => undefined}
      />,
    );

    expect(markup).toContain("theme-signal-noir");
  });

  it("renders startup and unreachable gateway states without credential controls", () => {
    const checking = renderToStaticMarkup(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={{ status: "checking", message: "Booting", healthDetail: "warming" }}
        busy={false}
        onRetry={() => undefined}
      />,
    );
    expect(checking).toContain("Starting Mission Control");
    expect(checking).toContain("Checking gateway");
    expect(checking).toContain("theme-citadel-light");
    expect(checking).toContain("Reach gateway");
    expect(checking).toContain("Verify access");
    expect(checking).toContain("Open control plane");

    const unreachable = renderToStaticMarkup(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={
          {
            status: "unreachable",
            message: "Gateway is offline",
            healthDetail: "ECONNREFUSED",
          } as never
        }
        busy
        autoRetryPending
        onRetry={() => undefined}
      />,
    );
    expect(unreachable).toContain("Gateway unreachable");
    expect(unreachable).toContain("Mission Control will retry the gateway handshake automatically.");
    expect(unreachable).toContain("Re-checking...");
  });

  it("validates token credentials, persists remembered sessions, and clears stored auth", async () => {
    shellMocks.readStoredGatewayAuthState.mockReturnValue({ mode: "token", token: "stored-token" });
    shellMocks.getGatewayAuthStorageMode.mockReturnValue("persistent");
    const onRetry = vi.fn();
    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={needsAuthAccess()}
        busy={false}
        onRetry={onRetry}
      />,
    );
    await flushAsync();

    const clearButton = findButtonByText(renderer.root, "Clear saved credentials");
    expect(clearButton).toBeTruthy();
    await act(async () => {
      clearButton!.props.onClick();
    });
    expect(shellMocks.clearGatewayAuthState).toHaveBeenCalled();

    const tokenInput = renderer.root.findByProps({ id: "gateway-access-token" });
    await act(async () => {
      tokenInput.props.onChange({ target: { value: "" } });
      findButtonByText(renderer.root, "Connect to gateway")!.props.onClick();
    });
    expect(renderer.root.findAllByProps({ className: "error gateway-access-error" })[0]?.children.join("")).toBe(
      "Enter the gateway token before retrying.",
    );

    await act(async () => {
      tokenInput.props.onChange({ target: { value: "fresh-token" } });
      findButtonById(renderer.root, "gateway-access-remember")!.props.onClick();
    });
    await act(async () => {
      findButtonByText(renderer.root, "Connect to gateway")!.props.onClick();
    });

    expect(shellMocks.persistGatewayAuthState).toHaveBeenCalledWith(
      { mode: "token", token: "fresh-token", tokenQueryParam: "access_token" },
      "session",
    );
    expect(onRetry).toHaveBeenCalled();
  });

  it("supports basic credentials when requested by the gateway", async () => {
    const onRetry = vi.fn();
    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={needsAuthAccess({ authMode: "basic" })}
        busy={false}
        onRetry={onRetry}
      />,
    );
    await flushAsync();

    await act(async () => {
      findButtonByText(renderer.root, "Connect to gateway")!.props.onClick();
    });
    expect(renderer.root.findAllByProps({ className: "error gateway-access-error" })[0]?.children.join("")).toBe(
      "Enter both username and password before retrying.",
    );

    await act(async () => {
      renderer.root.findByProps({ id: "gateway-access-username" }).props.onChange({ target: { value: "operator" } });
      renderer.root.findByProps({ id: "gateway-access-password" }).props.onChange({ target: { value: "secret" } });
      findButtonById(renderer.root, "gateway-access-remember")!.props.onClick();
    });
    await act(async () => {
      findButtonByText(renderer.root, "Connect to gateway")!.props.onClick();
    });

    expect(shellMocks.persistGatewayAuthState).toHaveBeenCalledWith(
      { mode: "basic", username: "operator", password: "secret" },
      "persistent",
    );
    expect(onRetry).toHaveBeenCalled();
  });

  it("requests device approval and consumes an approved device token", async () => {
    shellMocks.createGatewayDeviceAccessRequest.mockResolvedValue(pendingDeviceApproval({ status: "pending" }));
    shellMocks.pollGatewayDeviceAccessRequestStatus.mockResolvedValue({
      status: "approved",
      message: "Approved",
      expiresAt: "2026-01-01T12:05:00.000Z",
      deviceToken: "device-token",
    });
    const onRetry = vi.fn();
    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={needsAuthAccess()}
        busy={false}
        onRetry={onRetry}
      />,
    );
    await flushAsync();

    await act(async () => {
      renderer.root.findByProps({ id: "gateway-access-device-label" }).props.onChange({ target: { value: "" } });
    });
    await act(async () => {
      findButtonByText(renderer.root, "Request approval from another device")!.props.onClick();
    });
    await flushAsync();

    expect(shellMocks.createGatewayDeviceAccessRequest).toHaveBeenCalledWith({
      deviceLabel: undefined,
      deviceType: "desktop",
      platform: "Windows",
    });
    expect(shellMocks.pollGatewayDeviceAccessRequestStatus).toHaveBeenCalledWith("request-1", "secret-1");
    expect(shellMocks.persistGatewayAuthState).toHaveBeenCalledWith(
      { mode: "token", token: "device-token", tokenQueryParam: "access_token" },
      "session",
    );
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows rejected device approval errors and resets pending requests", async () => {
    shellMocks.createGatewayDeviceAccessRequest.mockResolvedValue(
      pendingDeviceApproval({
        requestId: "request-2",
        requestSecret: "secret-2",
        approvalId: "approval-2",
        status: "pending",
      }),
    );
    shellMocks.pollGatewayDeviceAccessRequestStatus.mockResolvedValue({
      status: "rejected",
      message: "Denied by operator",
      expiresAt: "2026-01-01T12:05:00.000Z",
    });
    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={needsAuthAccess()}
        busy={false}
        onRetry={() => undefined}
      />,
    );
    await flushAsync();

    await act(async () => {
      findButtonByText(renderer.root, "Request approval from another device")!.props.onClick();
    });
    await flushAsync();

    expect(renderer.root.findAllByProps({ className: "error gateway-access-error" })[0]?.children.join("")).toBe(
      "Denied by operator",
    );
    expect(findButtonByText(renderer.root, "Reset request")).toBeTruthy();

    await act(async () => {
      findButtonByText(renderer.root, "Reset request")!.props.onClick();
    });
    expect(findButtonByText(renderer.root, "Reset request")).toBeUndefined();
  });

  it("derives device approval metadata from mobile, tablet, desktop, and browser user agents", async () => {
    const cases = [
      {
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
        expectedLabel: "iPad Safari",
        expectedType: "tablet",
        expectedPlatform: "iPad",
      },
      {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
        expectedLabel: "iPhone Safari",
        expectedType: "mobile",
        expectedPlatform: "iPhone",
      },
      {
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
        expectedLabel: "Android Chrome",
        expectedType: "mobile",
        expectedPlatform: "Android",
      },
      {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0.0.0 Safari/537.36",
        expectedLabel: "Windows Edge",
        expectedType: "desktop",
        expectedPlatform: "Windows",
      },
      {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.1; rv:120.0) Gecko/20100101 Firefox/120.0",
        expectedLabel: "macOS Firefox",
        expectedType: "desktop",
        expectedPlatform: "macOS",
      },
      {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        expectedLabel: "Linux Chrome",
        expectedType: "desktop",
        expectedPlatform: "Linux",
      },
      {
        userAgent: "Mozilla/5.0 AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
        expectedLabel: "Safari",
        expectedType: "browser",
        expectedPlatform: undefined,
      },
    ];

    for (const testCase of cases) {
      shellMocks.createGatewayDeviceAccessRequest.mockReset();
      shellMocks.createGatewayDeviceAccessRequest.mockResolvedValue(pendingDeviceApproval());
      installUserAgent(testCase.userAgent);
      const renderer = create(
        <GatewayAccessGate
          gatewayBaseUrl="http://localhost:8787"
          access={needsAuthAccess()}
          busy={false}
          onRetry={() => undefined}
        />,
      );
      await flushAsync();

      expect(renderer.root.findByProps({ id: "gateway-access-device-label" }).props.value).toBe(testCase.expectedLabel);
      await act(async () => {
        findButtonByText(renderer.root, "Request approval from another device")!.props.onClick();
      });

      expect(shellMocks.createGatewayDeviceAccessRequest).toHaveBeenCalledWith({
        deviceLabel: testCase.expectedLabel,
        deviceType: testCase.expectedType,
        platform: testCase.expectedPlatform,
      });
      renderer.unmount();
    }
  });

  it("falls back to unknown device metadata when navigator is unavailable", async () => {
    shellMocks.createGatewayDeviceAccessRequest.mockResolvedValue(pendingDeviceApproval());
    vi.stubGlobal("navigator", undefined);
    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={needsAuthAccess()}
        busy={false}
        onRetry={() => undefined}
      />,
    );
    await flushAsync();

    expect(renderer.root.findByProps({ id: "gateway-access-device-label" }).props.value).toBe("New device");
    await act(async () => {
      findButtonByText(renderer.root, "Request approval from another device")!.props.onClick();
    });

    expect(shellMocks.createGatewayDeviceAccessRequest).toHaveBeenCalledWith({
      deviceLabel: "New device",
      deviceType: "unknown",
      platform: undefined,
    });
  });

  it("shows pending and failed device approval request states", async () => {
    let rejectApprovalRequest: ((error: Error) => void) | undefined;
    shellMocks.createGatewayDeviceAccessRequest.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectApprovalRequest = reject;
      }),
    );
    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={needsAuthAccess()}
        busy={false}
        onRetry={() => undefined}
      />,
    );
    await flushAsync();

    act(() => {
      findButtonByText(renderer.root, "Request approval from another device")!.props.onClick();
    });
    expect(findButtonByText(renderer.root, "Requesting...")).toBeTruthy();

    await act(async () => {
      rejectApprovalRequest?.(new Error("Approval service unavailable"));
    });
    expect(renderer.root.findAllByProps({ className: "error gateway-access-error" })[0]?.children.join("")).toBe(
      "Approval service unavailable",
    );
  });

  it("surfaces device approval poll failures", async () => {
    shellMocks.createGatewayDeviceAccessRequest.mockResolvedValue(pendingDeviceApproval({ status: "pending" }));
    shellMocks.pollGatewayDeviceAccessRequestStatus.mockRejectedValue(new Error("Polling failed"));
    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={needsAuthAccess()}
        busy={false}
        onRetry={() => undefined}
      />,
    );
    await flushAsync();

    await act(async () => {
      findButtonByText(renderer.root, "Request approval from another device")!.props.onClick();
    });
    await flushAsync();

    expect(renderer.root.findAllByProps({ className: "error gateway-access-error" })[0]?.children.join("")).toBe(
      "Polling failed",
    );
  });

  it("covers dark theme query, manual retry, credential mode changes, and cancelled polling", async () => {
    installBrowser("?theme=signal-noir");
    const onRetry = vi.fn();
    const retryRenderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={{ status: "misconfigured", message: "Gateway auth is misconfigured" } as never}
        busy={false}
        onRetry={onRetry}
      />,
    );

    expect(
      retryRenderer.root
        .findAllByType("section")
        .some((node) => String(node.props.className ?? "").includes("theme-signal-noir")),
    ).toBe(true);
    await act(async () => {
      findButtonByText(retryRenderer.root, "Retry gateway check")!.props.onClick();
    });
    expect(onRetry).toHaveBeenCalled();
    retryRenderer.unmount();

    const authRenderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={needsAuthAccess()}
        busy={false}
        onRetry={() => undefined}
      />,
    );
    await flushAsync();
    await act(async () => {
      authRenderer.root.findByProps({ id: "gateway-access-mode" }).props.onChange("basic");
    });
    expect(authRenderer.root.findByProps({ id: "gateway-access-username" })).toBeTruthy();
    authRenderer.unmount();

    let resolvePoll: (value: unknown) => void = () => undefined;
    shellMocks.createGatewayDeviceAccessRequest.mockResolvedValue(pendingDeviceApproval({ status: "pending" }));
    shellMocks.pollGatewayDeviceAccessRequestStatus.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
    );
    const pollingRenderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://localhost:8787"
        access={needsAuthAccess()}
        busy={false}
        onRetry={() => undefined}
      />,
    );
    await flushAsync();
    await act(async () => {
      findButtonByText(pollingRenderer.root, "Request approval from another device")!.props.onClick();
    });
    pollingRenderer.unmount();
    await act(async () => {
      resolvePoll({ status: "approved", deviceToken: "late-token", message: "Late approval" });
      await Promise.resolve();
    });
    expect(shellMocks.persistGatewayAuthState).not.toHaveBeenCalledWith(
      expect.objectContaining({ token: "late-token" }),
      expect.anything(),
    );
  });
});
