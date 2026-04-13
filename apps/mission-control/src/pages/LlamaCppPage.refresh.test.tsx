import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const apiMocks = vi.hoisted(() => ({
  cancelLlamaCppHuggingFaceDownload: vi.fn(),
  createLlmChatCompletion: vi.fn(),
  detectLlamaCppInstall: vi.fn(),
  evaluateUiChangeRisk: vi.fn(),
  fetchLlamaCppAdvisor: vi.fn(),
  fetchLlamaCppHuggingFaceDownload: vi.fn(),
  fetchLlamaCppModels: vi.fn(),
  fetchLlamaCppStatus: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  refreshLlamaCppRuntime: vi.fn(),
  startLlamaCppHuggingFaceDownload: vi.fn(),
  startLlamaCppRuntime: vi.fn(),
  stopLlamaCppRuntime: vi.fn(),
}));

vi.mock("../api/client", () => ({
  cancelLlamaCppHuggingFaceDownload: apiMocks.cancelLlamaCppHuggingFaceDownload,
  createLlmChatCompletion: apiMocks.createLlmChatCompletion,
  detectLlamaCppInstall: apiMocks.detectLlamaCppInstall,
  evaluateUiChangeRisk: apiMocks.evaluateUiChangeRisk,
  fetchLlamaCppAdvisor: apiMocks.fetchLlamaCppAdvisor,
  fetchLlamaCppHuggingFaceDownload: apiMocks.fetchLlamaCppHuggingFaceDownload,
  fetchLlamaCppModels: apiMocks.fetchLlamaCppModels,
  fetchLlamaCppStatus: apiMocks.fetchLlamaCppStatus,
  fetchSettings: apiMocks.fetchSettings,
  patchSettings: apiMocks.patchSettings,
  refreshLlamaCppRuntime: apiMocks.refreshLlamaCppRuntime,
  startLlamaCppHuggingFaceDownload: apiMocks.startLlamaCppHuggingFaceDownload,
  startLlamaCppRuntime: apiMocks.startLlamaCppRuntime,
  stopLlamaCppRuntime: apiMocks.stopLlamaCppRuntime,
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
  ChangeReviewPanel: () => <div>ChangeReviewPanel</div>,
}));

vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ children, title }: { children?: React.ReactNode; title: string }) => (
    <div>
      {title}
      {children}
    </div>
  ),
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ children, title }: { children?: React.ReactNode; title: string }) => (
    <section>
      <h3>{title}</h3>
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
  GCSelect: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { LlamaCppPage } from "./LlamaCppPage";

function makeStatus(overrides?: Partial<Awaited<ReturnType<typeof apiMocks.fetchLlamaCppStatus>>>) {
  return {
    enabled: false,
    desiredState: "stopped",
    processState: "stopped",
    baseUrl: "http://127.0.0.1:8080/v1",
    pid: null,
    healthy: false,
    activeModelId: "gemma-4-local",
    command: "llama-server",
    commandSource: "missing",
    modelPath: null,
    lastError: null,
    updatedAt: "2026-04-09T00:00:00.000Z",
    launchCommandPreview: "llama-server -m <model.gguf>",
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

describe("LlamaCppPage refresh discipline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    apiMocks.fetchLlamaCppStatus.mockResolvedValue(makeStatus());
    apiMocks.fetchSettings.mockResolvedValue({
      llamaCpp: {
        enabled: false,
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080/v1",
        command: "llama-server",
        extraArgs: [],
        modelPath: "",
        alias: "gemma-4-local",
      },
    });
    apiMocks.fetchLlamaCppModels.mockResolvedValue({ items: [] });
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
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      const enabled = renderer.root.findByProps({ id: "llamaCppEnabled", type: "checkbox" });
      const autoStart = renderer.root.findByProps({ id: "llamaCppAutoStart", type: "checkbox" });
      const baseUrl = renderer.root.findByProps({ id: "llamaCppBaseUrl" });

      await act(async () => {
        enabled.props.onChange({ target: { checked: true } });
        autoStart.props.onChange({ target: { checked: true } });
        baseUrl.props.onChange({ target: { value: "http://127.0.0.1:18080/v1" } });
      });

      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
      expect(refreshState.callback).toBeTypeOf("function");

      await act(async () => {
        await refreshState.callback?.({
          topic: "llamaCpp",
          timestamp: Date.now(),
          reason: "test-refresh",
        });
      });
      await flush();

      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
      expect(renderer.root.findByProps({ id: "llamaCppEnabled", type: "checkbox" }).props.checked).toBe(true);
      expect(renderer.root.findByProps({ id: "llamaCppAutoStart", type: "checkbox" }).props.checked).toBe(true);
      expect(renderer.root.findByProps({ id: "llamaCppBaseUrl" }).props.value).toBe("http://127.0.0.1:18080/v1");
    } finally {
      renderer.unmount();
    }
  });

  it("debounces remote risk evaluation while llama.cpp settings are changing", async () => {
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
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      apiMocks.evaluateUiChangeRisk.mockClear();

      const enabled = renderer.root.findByProps({ id: "llamaCppEnabled", type: "checkbox" });
      const modelPath = renderer.root.findByProps({ id: "llamaCppModelPath" });

      await act(async () => {
        enabled.props.onChange({ target: { checked: true } });
        modelPath.props.onChange({ target: { value: "models/gemma-4-q4.gguf" } });
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

  it("applies the recommended single-model profile from Mission Control", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      const buttons = renderer.root.findAllByType("button");
      const recommended = buttons.find((button) => button.props.children === "Apply Recommended Profile");
      expect(recommended).toBeDefined();

      await act(async () => {
        recommended?.props.onClick();
      });

      expect(renderer.root.findByProps({ id: "llamaCppBaseUrl" }).props.value).toBe("http://127.0.0.1:8080/v1");
      expect(renderer.root.findByProps({ id: "llamaCppAlias" }).props.value).toBe("gemma-4-local");
    } finally {
      renderer.unmount();
    }
  });
});
