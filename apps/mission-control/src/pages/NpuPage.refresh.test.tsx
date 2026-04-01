import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
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
  useRefreshSubscription: (
    _topic: string,
    callback: (signal: unknown) => Promise<void> | void,
  ) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../components/ActionButton", () => ({
  ActionButton: (props: {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  ),
}));

vi.mock("../components/ChangeReviewPanel", () => ({
  ChangeReviewPanel: () => <div>ChangeReviewPanel</div>,
}));

vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ children, title }: { children?: React.ReactNode; title: string }) => <div>{title}{children}</div>,
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ children, title }: { children?: React.ReactNode; title: string }) => <section><h3>{title}</h3>{children}</section>,
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/ui", () => ({
  GCSwitch: (props: {
    id?: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    label?: string;
  }) => (
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

function makeStatus(overrides?: Partial<Awaited<ReturnType<typeof apiMocks.fetchNpuStatus>>>) {
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
      details: [],
    },
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

describe("NpuPage refresh discipline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
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

  it("preserves in-progress config edits during background refresh and skips settings re-fetch", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<NpuPage />);
      });
      await flush();

      const enabled = renderer.root.findByProps({ id: "npuEnabled", type: "checkbox" });
      const autoStart = renderer.root.findByProps({ id: "npuAutoStart", type: "checkbox" });
      const sidecarUrl = renderer.root.findByProps({ id: "npuSidecarUrl" });

      await act(async () => {
        enabled.props.onChange({ target: { checked: true } });
        autoStart.props.onChange({ target: { checked: true } });
        sidecarUrl.props.onChange({ target: { value: "http://127.0.0.1:15432" } });
      });

      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
      expect(refreshState.callback).toBeTypeOf("function");

      await act(async () => {
        await refreshState.callback?.({
          topic: "npu",
          timestamp: Date.now(),
          reason: "test-refresh",
        });
      });
      await flush();

      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
      expect(renderer.root.findByProps({ id: "npuEnabled", type: "checkbox" }).props.checked).toBe(true);
      expect(renderer.root.findByProps({ id: "npuAutoStart", type: "checkbox" }).props.checked).toBe(true);
      expect(renderer.root.findByProps({ id: "npuSidecarUrl" }).props.value).toBe("http://127.0.0.1:15432");
    } finally {
      renderer.unmount();
    }
  });

  it("debounces remote risk evaluation while settings are changing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<NpuPage />);
      });
      await flush();

      apiMocks.evaluateUiChangeRisk.mockClear();

      const enabled = renderer.root.findByProps({ id: "npuEnabled", type: "checkbox" });
      const autoStart = renderer.root.findByProps({ id: "npuAutoStart", type: "checkbox" });

      await act(async () => {
        enabled.props.onChange({ target: { checked: true } });
        autoStart.props.onChange({ target: { checked: true } });
      });

      await act(async () => {
        vi.advanceTimersByTime(399);
      });
      expect(apiMocks.evaluateUiChangeRisk).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await flush();

      expect(apiMocks.evaluateUiChangeRisk).toHaveBeenCalledTimes(1);
    } finally {
      renderer.unmount();
    }
  });
});
