// @vitest-environment happy-dom

import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const apiMocks = vi.hoisted(() => ({
  evaluateUiChangeRisk: vi.fn(),
  fetchNpuModels: vi.fn(),
  fetchNpuStatus: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  refreshNpuRuntime: vi.fn(),
  startNpuRuntime: vi.fn(),
  stopNpuRuntime: vi.fn(),
}));

vi.mock("../api/client", () => ({
  evaluateUiChangeRisk: apiMocks.evaluateUiChangeRisk,
  fetchNpuModels: apiMocks.fetchNpuModels,
  fetchNpuStatus: apiMocks.fetchNpuStatus,
  fetchSettings: apiMocks.fetchSettings,
  patchSettings: apiMocks.patchSettings,
  refreshNpuRuntime: apiMocks.refreshNpuRuntime,
  startNpuRuntime: apiMocks.startNpuRuntime,
  stopNpuRuntime: apiMocks.stopNpuRuntime,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: (signal: unknown) => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../components/ActionButton", () => ({
  ActionButton: (props: { label: string; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  ),
}));

vi.mock("../components/ChangeReviewPanel", () => ({
  ChangeReviewPanel: (props: {
    title: string;
    overall: string;
    requireCriticalConfirm?: boolean;
    criticalConfirmed?: boolean;
    onCriticalConfirmChange?: (checked: boolean) => void;
  }) => (
    <section>
      <h3>{props.title}</h3>
      <p>Risk: {props.overall}</p>
      {props.requireCriticalConfirm ? (
        <label>
          <input
            id="criticalConfirm"
            type="checkbox"
            checked={props.criticalConfirmed}
            onChange={(event) => props.onCriticalConfirmChange?.(event.target.checked)}
          />
          Confirm critical
        </label>
      ) : null}
    </section>
  ),
}));

vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ actions, subtitle, title }: { actions?: React.ReactNode; subtitle?: string; title: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ actions, children, title }: { actions?: React.ReactNode; children?: React.ReactNode; title: string }) => (
    <section>
      <h3>{title}</h3>
      {actions}
      {children}
    </section>
  ),
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/ui", () => ({
  GCSwitch: (props: { id?: string; checked: boolean; onCheckedChange: (checked: boolean) => void; label?: string }) => (
    <label>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onCheckedChange(event.target.checked)}
      />
      {props.label}
    </label>
  ),
}));

import { NpuPage } from "./NpuPage";

function makeStatus(overrides?: Record<string, unknown>) {
  return {
    processState: "stopped",
    desiredState: "stopped",
    healthy: false,
    backend: "onnx",
    sidecarUrl: "http://127.0.0.1:11440",
    sidecarPid: null,
    activeModelId: null,
    updatedAt: "2026-04-01T00:00:00.000Z",
    lastError: null,
    capability: {
      isWindowsArm64: true,
      onnxRuntimeAvailable: true,
      onnxRuntimeGenAiAvailable: true,
      qnnExecutionProviderAvailable: true,
      supported: true,
      details: ["QNN provider loaded"],
    },
    ...overrides,
  };
}

function makeModel(overrides?: Record<string, unknown>) {
  return {
    modelId: "npu-model-1",
    label: "NPU Model One",
    family: "phi",
    source: "sidecar",
    default: true,
    enabled: true,
    requiresQnn: true,
    contextWindow: 8192,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function collectText(node: ReactTestInstance | string | number | null | undefined): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return node.children.map((child) => collectText(child as ReactTestInstance | string | number)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.root).replace(/\s+/g, " ").trim();
}

function findButton(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const button = renderer.root.findAllByType("button").find((node) => collectText(node).includes(label));
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

describe("NpuPage runtime actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    apiMocks.fetchNpuStatus.mockResolvedValue(makeStatus());
    apiMocks.fetchSettings.mockResolvedValue({
      npu: {
        enabled: false,
        autoStart: false,
        sidecarUrl: "http://127.0.0.1:11440",
      },
    });
    apiMocks.fetchNpuModels.mockResolvedValue({ items: [] });
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({
      overall: "safe",
      items: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a healthy sidecar, loads models, then clears the catalog after stop", async () => {
    apiMocks.startNpuRuntime.mockResolvedValue(
      makeStatus({
        processState: "running",
        desiredState: "running",
        healthy: true,
        activeModelId: "npu-model-1",
        sidecarPid: 4242,
      }),
    );
    apiMocks.stopNpuRuntime.mockResolvedValue(makeStatus());
    apiMocks.fetchNpuModels.mockResolvedValue({ items: [makeModel()] });

    let renderer: ReactTestRenderer = create(<div />);
    await act(async () => {
      renderer = create(<NpuPage />);
    });
    await flush();

    expect(rendererText(renderer)).toContain("Model catalog is unavailable until the sidecar is running and healthy.");
    expect(apiMocks.fetchNpuModels).not.toHaveBeenCalled();

    await act(async () => {
      findButton(renderer, "Start").props.onClick();
    });
    await flush();

    expect(apiMocks.startNpuRuntime).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchNpuModels).toHaveBeenCalledTimes(1);
    expect(rendererText(renderer)).toContain("NPU Model One");
    expect(rendererText(renderer)).toContain("npu-model-1");

    await act(async () => {
      findButton(renderer, "Stop").props.onClick();
    });
    await flush();

    expect(apiMocks.stopNpuRuntime).toHaveBeenCalledTimes(1);
    expect(rendererText(renderer)).toContain("Model catalog is unavailable until the sidecar is running and healthy.");
    expect(rendererText(renderer)).not.toContain("NPU Model One");
  });

  it("shows model catalog failures and recovers on refresh", async () => {
    apiMocks.fetchNpuStatus.mockResolvedValue(
      makeStatus({
        processState: "running",
        desiredState: "running",
        healthy: true,
      }),
    );
    apiMocks.fetchNpuModels
      .mockRejectedValueOnce(new Error("sidecar catalog offline"))
      .mockResolvedValue({ items: [makeModel({ modelId: "npu-model-2", label: "Recovered Model" })] });
    apiMocks.refreshNpuRuntime.mockResolvedValue(
      makeStatus({
        processState: "running",
        desiredState: "running",
        healthy: true,
        activeModelId: "npu-model-2",
      }),
    );

    let renderer: ReactTestRenderer = create(<div />);
    await act(async () => {
      renderer = create(<NpuPage />);
    });
    await flush();

    expect(rendererText(renderer)).toContain("sidecar catalog offline");

    await act(async () => {
      findButton(renderer, "Refresh").props.onClick();
    });
    await flush();

    expect(apiMocks.refreshNpuRuntime).toHaveBeenCalledTimes(1);
    expect(rendererText(renderer)).toContain("Recovered Model");
    expect(rendererText(renderer)).not.toContain("sidecar catalog offline");
  });

  it("blocks critical configuration saves until the operator confirms the risk panel", async () => {
    vi.useFakeTimers();
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({
      overall: "critical",
      items: [
        {
          field: "npu.sidecarUrl",
          level: "critical",
          hint: "Remote sidecars need explicit review.",
        },
      ],
    });
    apiMocks.patchSettings.mockResolvedValue({
      npu: {
        enabled: true,
        autoStart: true,
        sidecarUrl: "http://10.0.0.5:11440",
      },
    });
    apiMocks.fetchNpuStatus.mockResolvedValue(makeStatus());

    let renderer: ReactTestRenderer = create(<div />);
    await act(async () => {
      renderer = create(<NpuPage />);
    });
    await flush();

    await act(async () => {
      renderer.root.findByProps({ id: "npuEnabled", type: "checkbox" }).props.onChange({ target: { checked: true } });
      renderer.root.findByProps({ id: "npuAutoStart", type: "checkbox" }).props.onChange({
        target: { checked: true },
      });
      renderer.root.findByProps({ id: "npuSidecarUrl" }).props.onChange({
        target: { value: "  http://10.0.0.5:11440  " },
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await flush();

    expect(rendererText(renderer)).toContain("Risk: critical");
    expect(findButton(renderer, "Save NPU Config").props.disabled).toBe(true);

    await act(async () => {
      renderer.root.findByProps({ id: "criticalConfirm", type: "checkbox" }).props.onChange({
        target: { checked: true },
      });
    });

    expect(findButton(renderer, "Save NPU Config").props.disabled).toBe(false);

    await act(async () => {
      findButton(renderer, "Save NPU Config").props.onClick();
    });
    await flush();

    expect(apiMocks.patchSettings).toHaveBeenCalledWith({
      npu: {
        enabled: true,
        autoStart: true,
        sidecarUrl: "http://10.0.0.5:11440",
      },
    });
  });
});
