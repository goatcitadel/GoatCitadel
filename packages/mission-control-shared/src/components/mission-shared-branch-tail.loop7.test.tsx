import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "./CommandPalette";
import { GatewayAccessGate } from "./GatewayAccessGate";
import { Panel } from "./Panel";
import { SelectOrCustom } from "./SelectOrCustom";

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

class FakeElement {
  readonly focus = vi.fn();

  hasAttribute() {
    return false;
  }
}

class EmptyDialogElement extends FakeElement {
  querySelectorAll() {
    return [];
  }

  contains() {
    return false;
  }
}

function installWindow(search = "") {
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

function installDocument(activeElement: unknown) {
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    writable: true,
    value: FakeElement,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      activeElement,
    },
  });
}

function keyboardEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function needsAuthAccess() {
  return {
    status: "needs-auth",
    message: "Authentication required",
    healthDetail: "401 Unauthorized",
    authMode: "token",
  } as never;
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
  });
}

function findButtonByText(root: ReturnType<typeof create>["root"], text: string) {
  return root.findAllByType("button").find((button) => button.children.join("") === text);
}

describe("mission-control-shared branch-tail coverage", () => {
  beforeEach(() => {
    shellMocks.getGatewayAuthStorageMode.mockReturnValue("session");
    shellMocks.readStoredGatewayAuthState.mockReturnValue(undefined);
    shellMocks.createGatewayDeviceAccessRequest.mockResolvedValue({
      requestId: "request-loop7",
      requestSecret: "secret-loop7",
      approvalId: "approval-loop7",
      expiresAt: "2026-01-01T12:05:00.000Z",
      pollAfterMs: 1500,
      message: "Waiting for approval",
      status: "approved",
    });
    shellMocks.pollGatewayDeviceAccessRequestStatus.mockReset();
    shellMocks.persistGatewayAuthState.mockReset();
    shellMocks.clearGatewayAuthState.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLElement");
  });

  it("handles command-palette focus fallbacks without activating missing selections", async () => {
    installDocument({ notAnElement: true });
    const run = vi.fn();
    const onClose = vi.fn();
    const renderer = create(
      <CommandPalette open onClose={onClose} items={[{ id: "chat", label: "Open Chat", run }]} />,
      {
        createNodeMock: (element: { type: string; props: { className?: string } }) => {
          if (element.type === "div" && element.props.className === "modal-card command-palette") {
            return new EmptyDialogElement();
          }
          return new FakeElement();
        },
      },
    );
    await flushAsync();

    const dialog = renderer.root.findByProps({ className: "modal-card command-palette" });
    const tab = keyboardEvent("Tab");
    act(() => {
      dialog.props.onKeyDown(tab);
    });
    expect(tab.preventDefault).toHaveBeenCalled();

    const input = renderer.root.findByType("input");
    const other = keyboardEvent("F2");
    act(() => {
      input.props.onKeyDown(other);
    });
    expect(other.preventDefault).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(<CommandPalette open onClose={onClose} items={[]} />);
    });
    const enter = keyboardEvent("Enter");
    act(() => {
      input.props.onKeyDown(enter);
    });
    expect(run).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("honors gateway access theme query aliases and unknown browser labels", async () => {
    installWindow("?theme=theme-citadel-light");
    expect(
      renderToStaticMarkup(
        <GatewayAccessGate
          gatewayBaseUrl="http://localhost:8787"
          access={{ status: "checking", message: "Booting" }}
          busy={false}
          onRetry={() => undefined}
        />,
      ),
    ).toContain("theme-citadel-light");

    installWindow("?theme=dark");
    expect(
      renderToStaticMarkup(
        <GatewayAccessGate
          gatewayBaseUrl="http://localhost:8787"
          access={{ status: "checking", message: "Booting" }}
          busy={false}
          onRetry={() => undefined}
        />,
      ),
    ).toContain("theme-signal-noir");

    vi.stubGlobal("navigator", { userAgent: "CustomAgent/1.0" });
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
      findButtonByText(renderer.root, "Request approval from another device")?.props.onClick();
    });
    expect(shellMocks.createGatewayDeviceAccessRequest).toHaveBeenCalledWith({
      deviceLabel: "New device",
      deviceType: "browser",
      platform: undefined,
    });
  });

  it("covers compact panel defaults and select/custom fallback branches", async () => {
    expect(renderToStaticMarkup(<Panel collapsible>Compact details</Panel>)).toContain("Details");
    expect(renderToStaticMarkup(<Panel>Plain panel</Panel>)).toContain("Plain panel");

    const onChange = vi.fn();
    const onCustomModeChange = vi.fn();
    const renderer = create(
      <SelectOrCustom
        id="model"
        value="custom-model"
        onChange={onChange}
        onCustomModeChange={onCustomModeChange}
        options={[
          { value: "", label: "Blank" },
          { value: "gpt-5", label: "GPT-5" },
          { value: "gpt-5", label: "Duplicate GPT-5" },
        ]}
        allowCustom
        autoSelectFirstOption
        customLabel="Custom model"
        customPlaceholder="Enter model"
      />,
    );
    await flushAsync();
    expect(onChange).toHaveBeenCalledWith("gpt-5");

    const [suggestedButton, customButton] = renderer.root.findAllByType("button");
    await act(async () => {
      customButton.props.onClick();
    });
    expect(onCustomModeChange).toHaveBeenCalledWith(true);

    await act(async () => {
      renderer.root.findByType("input").props.onChange({ target: { value: "local-model" } });
    });
    expect(onChange).toHaveBeenCalledWith("local-model");

    await act(async () => {
      suggestedButton.props.onClick();
    });
    expect(onCustomModeChange).toHaveBeenCalledWith(false);
    expect(onChange).toHaveBeenCalledWith("gpt-5");

    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: "gpt-5" } });
    });
    expect(onCustomModeChange).toHaveBeenLastCalledWith(false);
  });
});
