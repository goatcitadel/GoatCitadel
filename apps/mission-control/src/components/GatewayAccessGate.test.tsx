// @vitest-environment happy-dom

import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shellMocks = vi.hoisted(() => ({
  authState: null as null | { mode: "token"; token?: string } | { mode: "basic"; username?: string; password?: string },
  storageMode: "session" as "session" | "persistent",
  clearGatewayAuthState: vi.fn(() => {
    shellMocks.authState = null;
  }),
  createGatewayDeviceAccessRequest: vi.fn(),
  pollGatewayDeviceAccessRequestStatus: vi.fn(),
  persistGatewayAuthState: vi.fn((state: unknown, mode: "session" | "persistent") => {
    shellMocks.authState = state as typeof shellMocks.authState;
    shellMocks.storageMode = mode;
  }),
  readStoredGatewayAuthState: vi.fn(() => shellMocks.authState),
}));

vi.mock("../api/shell-client", () => ({
  clearGatewayAuthState: shellMocks.clearGatewayAuthState,
  createGatewayDeviceAccessRequest: shellMocks.createGatewayDeviceAccessRequest,
  getGatewayAuthStorageMode: () => shellMocks.storageMode,
  pollGatewayDeviceAccessRequestStatus: shellMocks.pollGatewayDeviceAccessRequestStatus,
  persistGatewayAuthState: shellMocks.persistGatewayAuthState,
  readStoredGatewayAuthState: shellMocks.readStoredGatewayAuthState,
}));

vi.mock("./StatusChip", () => ({
  StatusChip: ({ children, tone }: { children?: React.ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
}));

vi.mock("./ui", () => ({
  GCSelect: ({
    id,
    value,
    options,
    onChange,
  }: {
    id?: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
  }) => (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  GCSwitch: ({
    id,
    checked,
    label,
    onCheckedChange,
  }: {
    id?: string;
    checked: boolean;
    label?: string;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <label htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} />
      {label}
    </label>
  ),
}));

import { GatewayAccessGate } from "./GatewayAccessGate";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => collectText(node.children as never).includes(label));
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GatewayAccessGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellMocks.authState = null;
    shellMocks.storageMode = "session";
    window.localStorage.clear();
    window.history.pushState(null, "", "/?theme=light");
  });

  it("renders checking state and routes retry without auth controls", async () => {
    const onRetry = vi.fn();
    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://127.0.0.1:8787"
        access={{ status: "checking", message: "Checking gateway", healthDetail: "probe pending" }}
        busy={false}
        onRetry={onRetry}
      />,
    );

    expect(renderer.root.findByType("section").props.className).toContain("theme-citadel-light");
    expect(rendererText(renderer)).toContain("Starting Mission Control");

    await act(async () => {
      findButton(renderer, "Retry gateway check").props.onClick();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("persists token credentials, clears saved credentials, and retries", async () => {
    const onRetry = vi.fn();
    shellMocks.authState = { mode: "token", token: "old-token" };
    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://127.0.0.1:8787"
        access={{ status: "needs-auth", message: "Token required", authMode: "token" } as never}
        busy={false}
        onRetry={onRetry}
      />,
    );
    await flush();

    await act(async () => {
      renderer.root.findByProps({ id: "gateway-access-token" }).props.onChange({ target: { value: "secret-token" } });
      renderer.root
        .findAllByType("input")
        .find((input) => input.props.id === "gateway-access-remember")!
        .props.onChange({ target: { checked: true } });
    });
    await flush();

    await act(async () => {
      findButton(renderer, "Connect to gateway").props.onClick();
    });

    expect(shellMocks.persistGatewayAuthState).toHaveBeenCalledWith(
      { mode: "token", token: "secret-token", tokenQueryParam: "access_token" },
      "persistent",
    );
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton(renderer, "Clear saved credentials").props.onClick();
    });

    expect(shellMocks.clearGatewayAuthState).toHaveBeenCalledTimes(1);
  });

  it("supports basic auth validation and device approval polling", async () => {
    const onRetry = vi.fn();
    shellMocks.createGatewayDeviceAccessRequest.mockResolvedValue({
      requestId: "request-1",
      requestSecret: "secret-1",
      approvalId: "approval-1",
      expiresAt: "2026-05-14T22:00:00.000Z",
      pollAfterMs: 2000,
      message: "Approve this device.",
      status: "pending",
    });
    shellMocks.pollGatewayDeviceAccessRequestStatus.mockResolvedValue({
      status: "approved",
      message: "Approved.",
      expiresAt: "2026-05-14T22:00:00.000Z",
      deviceToken: "device-token",
    });

    const renderer = create(
      <GatewayAccessGate
        gatewayBaseUrl="http://127.0.0.1:8787"
        access={{ status: "needs-auth", message: "Basic required", authMode: "basic" } as never}
        busy={false}
        onRetry={onRetry}
      />,
    );
    await flush();

    await act(async () => {
      findButton(renderer, "Connect to gateway").props.onClick();
    });
    expect(rendererText(renderer)).toContain("Enter both username and password");

    await act(async () => {
      renderer.root.findByProps({ id: "gateway-access-username" }).props.onChange({ target: { value: "operator" } });
      renderer.root.findByProps({ id: "gateway-access-password" }).props.onChange({ target: { value: "pw" } });
    });
    await flush();

    await act(async () => {
      findButton(renderer, "Connect to gateway").props.onClick();
    });

    expect(shellMocks.persistGatewayAuthState).toHaveBeenCalledWith(
      { mode: "basic", username: "operator", password: "pw" },
      "session",
    );

    await act(async () => {
      findButton(renderer, "Request approval from another device").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(shellMocks.createGatewayDeviceAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({ deviceLabel: expect.any(String), deviceType: expect.any(String) }),
    );
    expect(shellMocks.pollGatewayDeviceAccessRequestStatus).toHaveBeenCalledWith("request-1", "secret-1");
    expect(shellMocks.persistGatewayAuthState).toHaveBeenCalledWith(
      { mode: "token", token: "device-token", tokenQueryParam: "access_token" },
      "session",
    );
  });
});
