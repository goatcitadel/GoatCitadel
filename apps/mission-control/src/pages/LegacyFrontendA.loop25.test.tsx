import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatConnectionTargetSummary, readConnectionString } from "./ChannelSetupPage";
import {
  baseUrlToHost,
  baseUrlToPort,
  createEmptyStatus,
  ensureReasoningDefault,
  formatProgress,
  readRecentLlamaCppDownloads,
  readSavedLlamaCppProfiles,
  upsertFlagValue,
  upsertRecentLlamaCppDownload,
  writeRecentLlamaCppDownloads,
  writeSavedLlamaCppProfiles,
} from "./LlamaCppPage";
import {
  hasUnsavedOnboardingDraft,
  isAbortError,
  matchAllowlistPreset,
  parseMultiline,
  readOnboardingActiveProvider,
} from "./OnboardingPage";

const taskApiMocks = vi.hoisted(() => ({
  addTaskActivity: vi.fn(),
  addTaskDeliverable: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDurableRun: vi.fn(),
  fetchDurableRunTimeline: vi.fn(),
  fetchRuntimeLifecycle: vi.fn(),
  fetchSessions: vi.fn(),
  fetchTaskActivities: vi.fn(),
  fetchTaskDeliverables: vi.fn(),
  fetchTasksByView: vi.fn(),
  fetchTaskSubagents: vi.fn(),
  registerTaskSubagent: vi.fn(),
  restoreTask: vi.fn(),
  resumeDurableRun: vi.fn(),
  updateTask: vi.fn(),
  updateTaskSubagent: vi.fn(),
  wakeDurableRun: vi.fn(),
}));

vi.mock("../api/client", () => taskApiMocks);
vi.mock("../hooks/useAction", () => ({
  useAction: () => ({
    pending: false,
    run: async <T,>(work: () => Promise<T>) => work(),
  }),
}));
vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>
      {primary}
      {secondary}
    </div>
  ),
}));
vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({ primary, inspector }: { primary?: React.ReactNode; inspector?: React.ReactNode }) => (
    <div>
      {primary}
      {inspector}
    </div>
  ),
}));
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ actions, subtitle, title }: { actions?: React.ReactNode; subtitle?: string; title?: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));
vi.mock("../components/Panel", () => ({
  Panel: ({
    actions,
    children,
    subtitle,
    title,
  }: {
    actions?: React.ReactNode;
    children?: React.ReactNode;
    subtitle?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {actions}
      {children}
    </section>
  ),
}));
vi.mock("../components/SelectOrCustom", () => ({
  SelectOrCustom: ({
    customLabel,
    onChange,
    value,
  }: {
    customLabel?: string;
    onChange?: (value: string) => void;
    value?: string;
  }) => (
    <label>
      {customLabel}
      <input aria-label={customLabel} value={value ?? ""} onChange={(event) => onChange?.(event.target.value)} />
    </label>
  ),
}));
vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({ confirmLabel, onConfirm }: { confirmLabel?: string; onConfirm?: () => void; open?: boolean }) => (
    <button type="button" data-testid="loop25-confirm-anyway" onClick={onConfirm}>
      {confirmLabel ?? "Confirm"}
    </button>
  ),
}));
vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/TableSkeleton", () => ({
  TableSkeleton: () => <div>Loading tasks</div>,
}));
vi.mock("../components/ui", () => ({
  GCSelect: ({
    id,
    onChange,
    options,
    value,
  }: {
    id?: string;
    onChange?: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    value?: string;
  }) => (
    <select id={id} value={value} onChange={(event) => onChange?.(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../components/ui/GCEmptyState", () => ({
  GCEmptyState: ({
    description,
    primaryAction,
    title,
  }: {
    description?: React.ReactNode;
    primaryAction?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <section>
      <h3>{title}</h3>
      <p>{description}</p>
      {primaryAction}
    </section>
  ),
}));
vi.mock("../content/copy", () => ({
  pageCopy: {
    tasks: {
      title: "Tasks",
      subtitle: "Track operator work.",
    },
  },
}));

import { TasksPage } from "./TasksPage";

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

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(" ");
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function text(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("Legacy Frontend A loop 25 edge coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      localStorage: createMemoryStorage(),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
  });

  it("summarizes channel connection targets and trimmed fallback fields", () => {
    expect(
      formatConnectionTargetSummary({
        catalogId: "channel.telegram",
        config: {
          targets: ["ignored", { label: "Ops", chatId: "100" }, { label: "Alerts", default: true, chatId: "200" }],
        },
      } as never),
    ).toBe("channel.telegram · 2 targets · default Alerts");
    expect(
      formatConnectionTargetSummary({
        catalogId: "channel.slack",
        config: { defaultChannel: "  #ops  " },
      } as never),
    ).toBe("channel.slack · default #ops");
    expect(readConnectionString({ value: "   " }, "value")).toBeUndefined();
  });

  it("normalizes llama.cpp helper storage, URLs, progress, and launch args", () => {
    window.localStorage.setItem("goatcitadel.llamacpp.saved-profiles.v1", JSON.stringify({ "text-default": {} }));
    expect(readSavedLlamaCppProfiles()["text-default"]?.alias).toBe("gemma-4-local");
    window.localStorage.setItem("goatcitadel.llamacpp.saved-profiles.v1", "{");
    expect(readSavedLlamaCppProfiles()).toEqual({});

    writeSavedLlamaCppProfiles({
      "text-default": {
        savedAt: "2026-05-14T00:00:00.000Z",
        enabled: true,
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080/v1",
        command: "llama-server",
        modelsRootPath: "",
        modelPath: "model.gguf",
        alias: "saved",
        extraArgsText: "",
        ctxSize: "",
        threads: "",
        gpuLayers: "",
        parallel: "",
        batchSize: "",
        ubatchSize: "",
        flashAttentionMode: "auto",
      },
    });
    expect(window.localStorage.getItem("goatcitadel.llamacpp.saved-profiles.v1")).toContain("saved");

    window.localStorage.setItem("goatcitadel.llamacpp.download-history.v1", JSON.stringify({ nope: true }));
    expect(readRecentLlamaCppDownloads()).toEqual([]);
    writeRecentLlamaCppDownloads([]);
    expect(window.localStorage.getItem("goatcitadel.llamacpp.download-history.v1")).toBe("[]");

    expect(
      upsertRecentLlamaCppDownload([], {
        alias: "model-a",
        modelPath: "model-a.gguf",
        repo: "org/model",
        completedAt: "2026-05-14T00:00:00.000Z",
      }),
    ).toHaveLength(1);
    expect(formatProgress(1024 ** 3, 2 * 1024 ** 3)).toBe("50% (1.00 / 2.00 GiB)");
    expect(formatProgress(1024 ** 3)).toBe("1.00 GiB downloaded");
    expect(baseUrlToHost("http://127.0.0.1:8080/v1")).toBe("127.0.0.1");
    expect(baseUrlToHost("not a url")).toBe("127.0.0.1");
    expect(baseUrlToPort("https://llama.local/v1")).toBe("443");
    expect(baseUrlToPort("not a url")).toBe("8080");
    expect(createEmptyStatus("http://127.0.0.1:9090/v1")).toMatchObject({
      baseUrl: "http://127.0.0.1:9090/v1",
      desiredState: "stopped",
      processState: "stopped",
      healthy: false,
    });
    expect(ensureReasoningDefault(["--ctx-size", "4096"])).toEqual(["--ctx-size", "4096", "--reasoning", "off"]);
    expect(upsertFlagValue(["--ctx-size", "4096"], "--ctx-size", "8192")).toEqual(["--ctx-size", "8192"]);
  });

  it("detects onboarding draft changes, allowlist presets, and multiline normalization", () => {
    const state = {
      completed: false,
      settings: {
        auth: { mode: "none", allowLoopbackBypass: false },
        llm: {
          activeProviderId: "openai",
          activeModel: "gpt-5.4",
          providers: [
            {
              providerId: "openai",
              label: "OpenAI",
              baseUrl: "https://api.openai.com/v1",
              apiStyle: "openai-responses",
              defaultModel: "gpt-5.4",
              apiKeySource: "env",
              apiKeyRef: "OPENAI_API_KEY",
            },
          ],
        },
        defaultToolProfile: "standard",
        budgetMode: "balanced",
        networkAllowlist: ["127.0.0.1", "localhost"],
        mesh: {
          enabled: false,
          mode: "lan",
          nodeId: "",
          mdns: true,
          staticPeers: [],
          requireMtls: true,
          tailnetEnabled: false,
        },
      },
    };
    const cleanDraft = {
      state,
      authMode: "none",
      allowLoopbackBypass: false,
      authToken: "",
      basicUsername: "",
      basicPassword: "",
      activeProviderId: "openai",
      activeModel: "gpt-5.4",
      providerLabel: "OpenAI",
      providerBaseUrl: "https://api.openai.com/v1",
      providerApiStyle: "openai-responses",
      providerDefaultModel: "gpt-5.4",
      providerApiKey: "",
      providerApiKeyEnv: "OPENAI_API_KEY",
      currentProviderTransportDraftJson: "{}",
      savedProviderTransportDraftJson: "{}",
      defaultToolProfile: "standard",
      budgetMode: "balanced",
      networkAllowlistText: "127.0.0.1\nlocalhost",
      meshEnabled: false,
      meshMode: "lan",
      meshNodeId: "",
      meshMdns: true,
      meshStaticPeers: "",
      meshRequireMtls: true,
      meshTailnetEnabled: false,
      markComplete: true,
    } as const;

    expect(readOnboardingActiveProvider(state as never, "openai")?.label).toBe("OpenAI");
    expect(hasUnsavedOnboardingDraft(cleanDraft as never)).toBe(false);
    expect(hasUnsavedOnboardingDraft({ ...cleanDraft, providerApiKey: "sk-test" } as never)).toBe(true);
    expect(hasUnsavedOnboardingDraft({ ...cleanDraft, state: null } as never)).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(parseMultiline(" one \n\n two ")).toEqual(["one", "two"]);
    expect(matchAllowlistPreset([])).toBe("strict");
    expect(matchAllowlistPreset(["localhost", "127.0.0.1"])).toBe("local");
    expect(matchAllowlistPreset(["example.com"])).toBe("custom");
  });

  it("keeps task confirmation no-op safe when no delete target is pending", async () => {
    taskApiMocks.fetchTasksByView.mockResolvedValue({ view: "active", items: [] });
    taskApiMocks.fetchSessions.mockResolvedValue({ items: [] });
    taskApiMocks.fetchAgents.mockResolvedValue({ items: [] });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      expect(text(renderer)).toContain("No tasks in this view yet");
      await act(async () => {
        renderer.root.findByProps({ "data-testid": "loop25-confirm-anyway" }).props.onClick();
      });
      expect(taskApiMocks.deleteTask).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });
});
