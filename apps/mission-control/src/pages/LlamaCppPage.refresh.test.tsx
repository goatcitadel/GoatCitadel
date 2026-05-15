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
  ChangeReviewPanel: ({
    items,
    overall,
    title,
  }: {
    items?: Array<{ field: string; hint?: string; level: string }>;
    overall?: string;
    title?: string;
  }) => (
    <div>
      {title}
      {overall}
      {items?.map((item) => (
        <p key={`${item.field}:${item.level}`}>{item.hint ?? item.field}</p>
      ))}
    </div>
  ),
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

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => button.props.children === label);
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(String(key), String(value));
    },
    removeItem: (key) => {
      map.delete(String(key));
    },
    clear: () => {
      map.clear();
    },
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
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
      localStorage: createMemoryStorage(),
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

  it("persists config changes and drives runtime control actions", async () => {
    apiMocks.startLlamaCppRuntime.mockResolvedValue(makeStatus({ healthy: true, processState: "running" }));
    apiMocks.stopLlamaCppRuntime.mockResolvedValue(makeStatus({ healthy: false, processState: "stopped" }));
    apiMocks.refreshLlamaCppRuntime.mockResolvedValue(makeStatus({ healthy: true, processState: "running" }));
    apiMocks.patchSettings.mockResolvedValue({
      llamaCpp: {
        enabled: true,
        autoStart: true,
        baseUrl: "http://127.0.0.1:18080/v1",
        command: "llama-server",
        extraArgs: ["--reasoning", "off"],
        modelsRootPath: "C:\\models",
        modelPath: "C:\\models\\gemma.gguf",
        alias: "gemma-local",
      },
    });
    apiMocks.fetchLlamaCppStatus.mockResolvedValue(makeStatus({ healthy: true, processState: "running" }));
    apiMocks.fetchLlamaCppModels.mockResolvedValue({ items: ["gemma-local"] });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppEnabled", type: "checkbox" }).props.onChange({
          target: { checked: true },
        });
        renderer.root.findByProps({ id: "llamaCppAutoStart", type: "checkbox" }).props.onChange({
          target: { checked: true },
        });
        renderer.root.findByProps({ id: "llamaCppBaseUrl" }).props.onChange({
          target: { value: "http://127.0.0.1:18080/v1" },
        });
        renderer.root.findByProps({ id: "llamaCppModelsRootPath" }).props.onChange({
          target: { value: "C:\\models" },
        });
        renderer.root.findByProps({ id: "llamaCppModelPath" }).props.onChange({
          target: { value: "C:\\models\\gemma.gguf" },
        });
        renderer.root.findByProps({ id: "llamaCppAlias" }).props.onChange({ target: { value: "gemma-local" } });
      });

      await act(async () => {
        findButton(renderer, "Save llama.cpp Config")?.props.onClick();
      });
      await flush();

      expect(apiMocks.patchSettings).toHaveBeenCalledWith({
        llamaCpp: expect.objectContaining({
          enabled: true,
          autoStart: true,
          baseUrl: "http://127.0.0.1:18080/v1",
          modelsRootPath: "C:\\models",
          modelPath: "C:\\models\\gemma.gguf",
          alias: "gemma-local",
        }),
      });
      expect(apiMocks.fetchLlamaCppModels).toHaveBeenCalled();

      await act(async () => {
        findButton(renderer, "Start")?.props.onClick();
      });
      await flush();
      await act(async () => {
        findButton(renderer, "Stop")?.props.onClick();
      });
      await flush();
      await act(async () => {
        findButton(renderer, "Refresh")?.props.onClick();
      });
      await flush();

      expect(apiMocks.startLlamaCppRuntime).toHaveBeenCalledTimes(1);
      expect(apiMocks.stopLlamaCppRuntime).toHaveBeenCalledTimes(1);
      expect(apiMocks.refreshLlamaCppRuntime).toHaveBeenCalledTimes(1);
    } finally {
      renderer.unmount();
    }
  });

  it("runs install detection, advisor, model download, and smoke-test actions", async () => {
    apiMocks.detectLlamaCppInstall.mockResolvedValue({
      found: true,
      command: "C:\\llama\\llama-server.exe",
      source: "path",
      version: "b5000",
      recommendedBaseUrl: "http://127.0.0.1:19090/v1",
    });
    apiMocks.fetchLlamaCppAdvisor.mockResolvedValue({
      profile: {
        platform: "win32",
        arch: "x64",
        cpuCoresLogical: 16,
        systemRamBytes: 64 * 1024 ** 3,
        gpus: [{ name: "RTX", vramBytes: 12 * 1024 ** 3 }],
      },
      recommended: {
        ctxSize: 8192,
        threads: 8,
        gpuLayers: 32,
        parallel: 2,
        batchSize: 512,
        ubatchSize: 128,
        flashAttention: false,
      },
      observedModelBytes: 6 * 1024 ** 3,
      warnings: ["Use a single slot first."],
    });
    apiMocks.startLlamaCppHuggingFaceDownload.mockResolvedValue({
      jobId: "job-1",
      status: "queued",
      stage: "model",
      repo: "google/gemma",
      filename: "gemma.gguf",
      bytesDownloaded: 0,
      totalBytes: 1024,
    });
    apiMocks.cancelLlamaCppHuggingFaceDownload.mockResolvedValue({
      jobId: "job-1",
      status: "cancelled",
      stage: "model",
      repo: "google/gemma",
      filename: "gemma.gguf",
      bytesDownloaded: 0,
      totalBytes: 1024,
    });
    apiMocks.createLlmChatCompletion.mockResolvedValue({
      choices: [{ message: { content: "hello from llama.cpp" } }],
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppSetupMode" }).props.onChange("advanced");
      });

      await act(async () => {
        findButton(renderer, "Detect Local Install")?.props.onClick();
      });
      await flush();
      expect(renderer.root.findByProps({ id: "llamaCppBaseUrl" }).props.value).toBe("http://127.0.0.1:19090/v1");

      await act(async () => {
        findButton(renderer, "Run Advisor")?.props.onClick();
      });
      await flush();
      await act(async () => {
        findButton(renderer, "Apply Recommendation")?.props.onClick();
      });
      expect(renderer.root.findByProps({ id: "llamaCppCtxSize" }).props.value).toBe("8192");
      expect(renderer.root.findByProps({ id: "llamaCppThreads" }).props.value).toBe("8");
      expect(renderer.root.findByProps({ id: "llamaCppFlashAttention" }).props.value).toBe("off");

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppHfRepo" }).props.onChange({ target: { value: "google/gemma" } });
        renderer.root.findByProps({ id: "llamaCppHfFilename" }).props.onChange({ target: { value: "gemma.gguf" } });
        renderer.root.findByProps({ id: "llamaCppHfMmprojFilename" }).props.onChange({
          target: { value: "mmproj.gguf" },
        });
      });
      await act(async () => {
        findButton(renderer, "Download GGUF")?.props.onClick();
      });
      await flush();
      await act(async () => {
        findButton(renderer, "Cancel Download")?.props.onClick();
      });
      await flush();

      expect(apiMocks.startLlamaCppHuggingFaceDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: "google/gemma",
          filename: "gemma.gguf",
          mmprojFilename: "mmproj.gguf",
        }),
      );
      expect(apiMocks.cancelLlamaCppHuggingFaceDownload).toHaveBeenCalledWith("job-1");

      await act(async () => {
        findButton(renderer, "Run Test Prompt")?.props.onClick();
      });
      await flush();

      expect(apiMocks.createLlmChatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "llamacpp",
          messages: [{ role: "user", content: "Say hello from GoatCitadel's llama.cpp runtime." }],
        }),
      );
      expect(rendererText(renderer)).toContain("hello from llama.cpp");
    } finally {
      renderer.unmount();
    }
  });

  it("renders advisor fallback guidance for CPU-only hosts and auto flash attention", async () => {
    apiMocks.fetchLlamaCppAdvisor.mockResolvedValue({
      profile: {
        platform: "win32",
        arch: "arm64",
        cpuCoresLogical: 8,
        systemRamBytes: 16 * 1024 ** 3,
        gpus: [],
      },
      recommended: {
        ctxSize: null,
        threads: null,
        gpuLayers: null,
        parallel: null,
        batchSize: null,
        ubatchSize: null,
        flashAttention: null,
      },
      observedModelBytes: null,
      warnings: [],
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppSetupMode" }).props.onChange("advanced");
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Run Advisor")?.props.onClick();
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("win32");
      expect(text).toContain("arm64");
      expect(text).toContain("none detected");
      expect(text).toContain("flash attn");
      expect(text).toContain("auto");

      await act(async () => {
        findButton(renderer, "Apply Recommendation")?.props.onClick();
      });

      expect(renderer.root.findByProps({ id: "llamaCppFlashAttention" }).props.value).toBe("auto");
    } finally {
      renderer.unmount();
    }
  });

  it("saves, loads, and applies saved presets back through settings persistence", async () => {
    apiMocks.patchSettings.mockResolvedValue({
      llamaCpp: {
        enabled: true,
        autoStart: false,
        baseUrl: "http://127.0.0.1:28080/v1",
        command: "llama-server",
        extraArgs: ["--ctx-size", "8192", "--reasoning", "off"],
        modelsRootPath: "C:\\models",
        modelPath: "C:\\models\\saved.gguf",
        alias: "saved-model",
        ctxSize: 8192,
        threads: 6,
        gpuLayers: 24,
        parallel: 1,
        batchSize: 512,
        ubatchSize: 128,
        flashAttention: true,
      },
    });
    apiMocks.fetchLlamaCppStatus.mockResolvedValue(makeStatus({ healthy: true, processState: "running" }));
    apiMocks.fetchLlamaCppModels.mockResolvedValue({ items: [] });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppSetupMode" }).props.onChange("advanced");
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppBaseUrl" }).props.onChange({
          target: { value: "http://127.0.0.1:28080/v1" },
        });
        renderer.root.findByProps({ id: "llamaCppModelPath" }).props.onChange({
          target: { value: "C:\\models\\saved.gguf" },
        });
        renderer.root.findByProps({ id: "llamaCppAlias" }).props.onChange({ target: { value: "saved-model" } });
        renderer.root.findByProps({ id: "llamaCppCtxSize" }).props.onChange({ target: { value: "8192" } });
        renderer.root.findByProps({ id: "llamaCppThreads" }).props.onChange({ target: { value: "6" } });
        renderer.root.findByProps({ id: "llamaCppGpuLayers" }).props.onChange({ target: { value: "24" } });
        renderer.root.findByProps({ id: "llamaCppParallel" }).props.onChange({ target: { value: "1" } });
        renderer.root.findByProps({ id: "llamaCppBatchSize" }).props.onChange({ target: { value: "512" } });
        renderer.root.findByProps({ id: "llamaCppUbatchSize" }).props.onChange({ target: { value: "128" } });
        renderer.root.findByProps({ id: "llamaCppFlashAttention" }).props.onChange("on");
        renderer.root.findByProps({ id: "llamaCppExtraArgs" }).props.onChange({
          target: { value: "--ctx-size\n8192\n--reasoning\noff" },
        });
      });

      await act(async () => {
        findButton(renderer, "Save Current to Preset")?.props.onClick();
      });
      await flush();
      expect(String(window.localStorage.getItem("goatcitadel.llamacpp.saved-profiles.v1"))).toContain("saved-model");

      await act(async () => {
        findButton(renderer, "Apply Recommended Profile")?.props.onClick();
      });
      await flush();
      expect(renderer.root.findByProps({ id: "llamaCppAlias" }).props.value).toBe("gemma-4-local");

      await act(async () => {
        findButton(renderer, "Load Saved Preset")?.props.onClick();
      });
      await flush();
      expect(renderer.root.findByProps({ id: "llamaCppAlias" }).props.value).toBe("saved-model");
      expect(renderer.root.findByProps({ id: "llamaCppCtxSize" }).props.value).toBe("8192");

      await act(async () => {
        findButton(renderer, "Apply Preset + Save")?.props.onClick();
      });
      await flush();

      expect(apiMocks.patchSettings).toHaveBeenCalledWith({
        llamaCpp: expect.objectContaining({
          alias: "saved-model",
          ctxSize: 8192,
          threads: 6,
          gpuLayers: 24,
          flashAttention: true,
        }),
      });
    } finally {
      renderer.unmount();
    }
  });

  it("polls managed download completion, records history, and reuses recent model paths", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      localStorage: createMemoryStorage(),
    });
    apiMocks.startLlamaCppHuggingFaceDownload.mockResolvedValue({
      jobId: "job-complete-1",
      status: "running",
      stage: "model",
      repo: "google/gemma",
      filename: "gemma.gguf",
      alias: "gemma-download",
      bytesDownloaded: 512,
      totalBytes: 1024,
    });
    apiMocks.fetchLlamaCppHuggingFaceDownload.mockResolvedValue({
      jobId: "job-complete-1",
      status: "completed",
      stage: "done",
      repo: "google/gemma",
      filename: "gemma.gguf",
      alias: "gemma-download",
      bytesDownloaded: 1024,
      totalBytes: 1024,
      modelPath: "C:\\models\\google\\gemma.gguf",
      modelBytes: 10 * 1024 ** 3,
      mmprojFilename: "mmproj.gguf",
      mmprojPath: "C:\\models\\google\\mmproj.gguf",
      mmprojBytesDownloaded: 256,
      mmprojTotalBytes: 256,
      mmprojBytes: 256,
      completedAt: "2026-05-14T12:00:00.000Z",
      updatedAt: "2026-05-14T12:00:00.000Z",
      expectedSha256: "abc",
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppSetupMode" }).props.onChange("advanced");
        renderer.root.findByProps({ id: "llamaCppHfRepo" }).props.onChange({ target: { value: "google/gemma" } });
        renderer.root.findByProps({ id: "llamaCppHfFilename" }).props.onChange({ target: { value: "gemma.gguf" } });
        renderer.root.findByProps({ id: "llamaCppHfMmprojFilename" }).props.onChange({
          target: { value: "mmproj.gguf" },
        });
      });

      await act(async () => {
        findButton(renderer, "Download GGUF")?.props.onClick();
      });
      await flush();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      await flush();

      expect(apiMocks.fetchLlamaCppHuggingFaceDownload).toHaveBeenCalledWith("job-complete-1");
      expect(renderer.root.findByProps({ id: "llamaCppModelPath" }).props.value).toBe("C:\\models\\google\\gemma.gguf");
      expect(renderer.root.findByProps({ id: "llamaCppAlias" }).props.value).toBe("gemma-download");
      expect(String(window.localStorage.getItem("goatcitadel.llamacpp.download-history.v1"))).toContain(
        "gemma-download",
      );

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppModelPath" }).props.onChange({ target: { value: "other.gguf" } });
        renderer.root.findByProps({ id: "llamaCppExtraArgs" }).props.onChange({ target: { value: "--temp\n0.2" } });
      });
      await act(async () => {
        findButton(renderer, "Use Model")?.props.onClick();
      });
      expect(renderer.root.findByProps({ id: "llamaCppModelPath" }).props.value).toBe("C:\\models\\google\\gemma.gguf");

      await act(async () => {
        findButton(renderer, "Use With mmproj")?.props.onClick();
      });
      expect(renderer.root.findByProps({ id: "llamaCppExtraArgs" }).props.value).toContain("--mmproj");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });

  it("blocks critical saves until confirmed and surfaces runtime action errors", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      localStorage: createMemoryStorage(),
    });
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({
      overall: "critical",
      items: [{ field: "llamaCpp.baseUrl", level: "critical", hint: "Switches runtime target." }],
    });
    apiMocks.startLlamaCppRuntime.mockRejectedValueOnce(new Error("start failed"));
    apiMocks.stopLlamaCppRuntime.mockRejectedValueOnce(new Error("stop failed"));
    apiMocks.refreshLlamaCppRuntime.mockRejectedValueOnce(new Error("refresh failed"));
    apiMocks.fetchLlamaCppModels.mockRejectedValueOnce(new Error("models failed"));
    apiMocks.patchSettings.mockResolvedValue({
      llamaCpp: {
        enabled: true,
        autoStart: false,
        baseUrl: "http://127.0.0.1:19090/v1",
        command: "llama-server",
        extraArgs: [],
        modelPath: "",
        alias: "gemma-4-local",
      },
    });
    apiMocks.fetchLlamaCppStatus.mockResolvedValue(makeStatus({ healthy: true, processState: "running" }));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppBaseUrl" }).props.onChange({
          target: { value: "http://127.0.0.1:19090/v1" },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await flush();
      expect(findButton(renderer, "Save llama.cpp Config")?.props.disabled).toBe(true);

      await act(async () => {
        findButton(renderer, "Save llama.cpp Config")?.props.onClick();
      });
      await flush();
      expect(apiMocks.patchSettings).not.toHaveBeenCalled();
      expect(rendererText(renderer)).toContain("Confirm critical changes before saving llama.cpp configuration.");

      expect(rendererText(renderer)).toContain("models failed");

      await act(async () => {
        findButton(renderer, "Start")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("start failed");

      await act(async () => {
        findButton(renderer, "Stop")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("stop failed");

      await act(async () => {
        findButton(renderer, "Refresh")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("refresh failed");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });

  it("covers alternate llama.cpp presets, unavailable install detection, and failed background downloads", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      localStorage: createMemoryStorage(),
    });
    apiMocks.detectLlamaCppInstall.mockResolvedValue({
      found: false,
      command: null,
      source: "not_found",
      version: null,
      recommendedBaseUrl: "http://127.0.0.1:8080/v1",
    });
    apiMocks.startLlamaCppHuggingFaceDownload.mockResolvedValue({
      jobId: "job-failed-1",
      status: "running",
      stage: "model",
      repo: "google/gemma",
      filename: "gemma.gguf",
      bytesDownloaded: 128,
      totalBytes: 1024,
    });
    apiMocks.fetchLlamaCppHuggingFaceDownload
      .mockResolvedValueOnce({
        jobId: "job-failed-1",
        status: "failed",
        stage: "model",
        repo: "google/gemma",
        filename: "gemma.gguf",
        bytesDownloaded: 128,
        totalBytes: 1024,
        error: "download checksum failed",
      })
      .mockRejectedValueOnce(new Error("poll failed"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      const presetSelect = renderer.root.findByProps({ id: "llamaCppProfilePreset" });
      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppSetupMode" }).props.onChange("advanced");
      });
      await flush();
      await act(async () => {
        presetSelect.props.onChange("multimodal");
      });
      await act(async () => {
        findButton(renderer, "Apply Recommended Profile")?.props.onClick();
      });
      expect(renderer.root.findByProps({ id: "llamaCppCtxSize" }).props.value).toBe("8192");

      await act(async () => {
        presetSelect.props.onChange("text-long");
      });
      await act(async () => {
        findButton(renderer, "Apply Recommended Profile")?.props.onClick();
      });
      expect(renderer.root.findByProps({ id: "llamaCppCtxSize" }).props.value).toBe("49152");

      await act(async () => {
        findButton(renderer, "Detect Local Install")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("No local llama-server install was detected automatically.");

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppHfRepo" }).props.onChange({ target: { value: "google/gemma" } });
        renderer.root.findByProps({ id: "llamaCppHfFilename" }).props.onChange({ target: { value: "gemma.gguf" } });
      });
      await act(async () => {
        findButton(renderer, "Download GGUF")?.props.onClick();
      });
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      await flush();
      expect(rendererText(renderer)).toContain("download checksum failed");

      apiMocks.startLlamaCppHuggingFaceDownload.mockResolvedValueOnce({
        jobId: "job-poll-failed-1",
        status: "running",
        stage: "model",
        repo: "google/gemma",
        filename: "gemma.gguf",
        bytesDownloaded: 128,
        totalBytes: 1024,
      });
      await act(async () => {
        findButton(renderer, "Download GGUF")?.props.onClick();
      });
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      await flush();
      expect(rendererText(renderer)).toContain("poll failed");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });

  it("hydrates explicit off settings and handles no-op or cancelled download actions", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      localStorage: createMemoryStorage(),
    });
    apiMocks.fetchSettings.mockResolvedValueOnce({
      llamaCpp: {
        enabled: true,
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080/v1",
        command: "llama-server",
        extraArgs: [],
        modelPath: "",
        alias: "gemma-4-local",
        flashAttention: false,
      },
    });
    apiMocks.startLlamaCppHuggingFaceDownload.mockResolvedValueOnce({
      jobId: "job-cancelled-1",
      status: "running",
      stage: "model",
      repo: "google/gemma",
      filename: "gemma.gguf",
      bytesDownloaded: 128,
      totalBytes: 1024,
    });
    apiMocks.fetchLlamaCppHuggingFaceDownload.mockResolvedValueOnce({
      jobId: "job-cancelled-1",
      status: "cancelled",
      stage: "model",
      repo: "google/gemma",
      filename: "gemma.gguf",
      bytesDownloaded: 128,
      totalBytes: 1024,
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppSetupMode" }).props.onChange("advanced");
      });
      expect(renderer.root.findByProps({ id: "llamaCppFlashAttention" }).props.value).toBe("off");

      await act(async () => {
        findButton(renderer, "Apply Recommendation")?.props.onClick();
        findButton(renderer, "Cancel Download")?.props.onClick();
      });
      expect(apiMocks.cancelLlamaCppHuggingFaceDownload).not.toHaveBeenCalled();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppHfRepo" }).props.onChange({ target: { value: "google/gemma" } });
        renderer.root.findByProps({ id: "llamaCppHfFilename" }).props.onChange({ target: { value: "gemma.gguf" } });
      });
      await act(async () => {
        findButton(renderer, "Download GGUF")?.props.onClick();
      });
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      await flush();

      expect(apiMocks.fetchLlamaCppHuggingFaceDownload).toHaveBeenCalledWith("job-cancelled-1");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });

  it("surfaces advisor, risk, model refresh, and download error tails from advanced controls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      localStorage: createMemoryStorage(),
    });
    apiMocks.evaluateUiChangeRisk.mockRejectedValue(new Error("risk offline"));
    apiMocks.fetchLlamaCppAdvisor.mockResolvedValue({
      profile: {
        platform: "linux",
        arch: "x64",
        cpuCoresLogical: 12,
        systemRamBytes: 32 * 1024 ** 3,
        gpus: [{ name: "Arc", vramBytes: null }],
      },
      recommended: {
        ctxSize: 2048,
        threads: 4,
        gpuLayers: 8,
        parallel: 1,
        batchSize: 256,
        ubatchSize: 64,
        flashAttention: true,
      },
      observedModelBytes: 5 * 1024 ** 3,
      warnings: [],
    });
    apiMocks.fetchLlamaCppStatus.mockResolvedValue(makeStatus({ healthy: true, processState: "running" }));
    apiMocks.fetchLlamaCppModels.mockResolvedValue({
      items: [{ modelId: "gemma-refreshed", ownedBy: null, created: null }],
    });
    apiMocks.startLlamaCppHuggingFaceDownload.mockRejectedValueOnce(new Error("download rejected")).mockResolvedValue({
      jobId: "job-cancel-error",
      status: "running",
      stage: "model",
      repo: "google/gemma",
      filename: "gemma.gguf",
      bytesDownloaded: 0,
      totalBytes: 1024,
    });
    apiMocks.cancelLlamaCppHuggingFaceDownload.mockRejectedValueOnce(new Error("cancel rejected"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<LlamaCppPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppSetupMode" }).props.onChange("advanced");
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "llamaCppCommand" }).props.onChange({
          target: { value: "C:\\Program Files\\llama\\llama-server.exe" },
        });
        renderer.root.findByProps({ id: "llamaCppModelPath" }).props.onChange({
          target: { value: "models\\tail.gguf" },
        });
        renderer.root.findByProps({ id: "llamaCppHfRepo" }).props.onChange({ target: { value: "google/gemma" } });
        renderer.root.findByProps({ id: "llamaCppHfFilename" }).props.onChange({ target: { value: "gemma.gguf" } });
        renderer.root.findByProps({ id: "llamaCppHfSha256" }).props.onChange({ target: { value: "abc123" } });
        renderer.root.findByProps({ id: "llamaCppHfMmprojSha256" }).props.onChange({ target: { value: "def456" } });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await flush();
      expect(rendererText(renderer)).toContain("Unable to fetch risk hints from gateway.");
      expect(rendererText(renderer)).toContain('"C:\\\\Program Files\\\\llama\\\\llama-server.exe"');

      await act(async () => {
        findButton(renderer, "Run Advisor")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("Observed model size");
      expect(rendererText(renderer)).toContain("5.00");
      expect(rendererText(renderer)).toContain("flash attn");
      expect(rendererText(renderer)).toContain("on");

      await act(async () => {
        findButton(renderer, "Apply Recommendation")?.props.onClick();
      });
      expect(renderer.root.findByProps({ id: "llamaCppFlashAttention" }).props.value).toBe("on");

      await act(async () => {
        findButton(renderer, "Refresh Models")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("gemma-refreshed");

      await act(async () => {
        findButton(renderer, "Download GGUF")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("download rejected");

      await act(async () => {
        findButton(renderer, "Download GGUF")?.props.onClick();
      });
      await flush();
      expect(apiMocks.startLlamaCppHuggingFaceDownload).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sha256: "abc123",
          mmprojSha256: "def456",
        }),
      );

      await act(async () => {
        findButton(renderer, "Cancel Download")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("cancel rejected");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });
});
