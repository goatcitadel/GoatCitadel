import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  autoScorePromptPackBatch: vi.fn(),
  autoScorePromptPackTest: vi.fn(),
  cancelPromptPackBenchmark: vi.fn(),
  exportPromptPackReport: vi.fn(),
  fetchPromptPackBenchmark: vi.fn(),
  fetchPromptPackExport: vi.fn(),
  fetchPromptPackReplayRegressionStatus: vi.fn(),
  fetchPromptPackReport: vi.fn(),
  fetchPromptPackTrends: vi.fn(),
  fetchPromptPackTests: vi.fn(),
  fetchPromptPacks: vi.fn(),
  importPromptPack: vi.fn(),
  resetPromptPack: vi.fn(),
  runPromptPackBenchmark: vi.fn(),
  runPromptPackReplayRegression: vi.fn(),
  runPromptPackTest: vi.fn(),
  scorePromptPackTest: vi.fn(),
}));

const providerState = vi.hoisted(() => ({
  loadModelsForProvider: vi.fn(),
  providers: [
    {
      providerId: "openai",
      label: "OpenAI",
      models: ["gpt-5.4", "gpt-5.4-mini"],
    },
  ],
}));

vi.mock("../api/client", () => apiMocks);

vi.mock("../hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    config: { activeProviderId: "openai" },
    loadModelsForProvider: providerState.loadModelsForProvider,
    providers: providerState.providers,
  }),
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: () => undefined,
}));

vi.mock("../components/CardSkeleton", () => ({
  CardSkeleton: () => <div>Loading prompt lab</div>,
}));

vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({ open }: { open?: boolean }) => (open ? <div>Confirm reset</div> : null),
}));

vi.mock("../content/copy", () => ({
  pageCopy: {
    promptLab: {
      title: "Prompt Lab",
      subtitle: "Evaluate prompt packs.",
    },
  },
}));

vi.mock("./prompt-lab/PromptLabSummaryPanel", () => ({
  PromptLabSummaryPanel: ({
    error,
    isRefreshing,
    overviewCards,
    success,
    title,
    onRefreshData,
  }: {
    error?: string | null;
    isRefreshing: boolean;
    overviewCards: Array<{ label: string; value: string; detail: string }>;
    success?: string | null;
    title: string;
    onRefreshData: () => void;
  }) => (
    <section>
      <h1>{title}</h1>
      <p>Refreshing:{String(isRefreshing)}</p>
      {overviewCards.map((card) => (
        <p key={card.label}>
          {card.label}:{card.value}:{card.detail}
        </p>
      ))}
      {error ? <p>Error:{error}</p> : null}
      {success ? <p>Success:{success}</p> : null}
      <button type="button" onClick={onRefreshData}>
        Refresh data
      </button>
    </section>
  ),
}));

vi.mock("./prompt-lab/PromptLabSetupPanel", () => ({
  PromptLabSetupPanel: ({
    benchmarkProvidersInput,
    benchmarkTestCodes,
    selectedModel,
    selectedProviderId,
    onBenchmarkProvidersInputChange,
    onBenchmarkTestCodesChange,
    onRunBenchmark,
  }: {
    benchmarkProvidersInput: string;
    benchmarkTestCodes: string;
    selectedModel: string;
    selectedProviderId: string;
    onBenchmarkProvidersInputChange: (value: string) => void;
    onBenchmarkTestCodesChange: (value: string) => void;
    onRunBenchmark: () => void;
  }) => (
    <aside>
      <p>Setup provider:{selectedProviderId || "none"}</p>
      <p>Setup model:{selectedModel || "none"}</p>
      <p>Setup tests:{benchmarkTestCodes || "none"}</p>
      <p>Setup providers:{benchmarkProvidersInput || "none"}</p>
      <button type="button" onClick={() => onBenchmarkTestCodesChange("TEST-01 TEST-02")}>
        Use focused tests
      </button>
      <button type="button" onClick={() => onBenchmarkProvidersInputChange("openai/gpt-5.4-mini")}>
        Use OpenAI provider
      </button>
      <button type="button" onClick={onRunBenchmark}>
        Run setup benchmark
      </button>
    </aside>
  ),
}));

vi.mock("./prompt-lab/PromptLabReportPanel", () => ({
  PromptLabReportPanel: () => <section>Prompt lab report</section>,
}));

vi.mock("./prompt-lab/PromptLabWorkspace", () => ({
  PromptLabWorkspace: ({
    selectedMissingPlaceholders,
    selectedTest,
  }: {
    selectedMissingPlaceholders: string[];
    selectedTest?: { code: string } | null;
  }) => (
    <main>
      <p>Selected test:{selectedTest?.code ?? "none"}</p>
      <p>Missing placeholders:{selectedMissingPlaceholders.join(",") || "none"}</p>
    </main>
  ),
}));

import { PromptLabPage } from "./PromptLabPage";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(" ");
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function text(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function nodeText(node: { children?: unknown[] }): string {
  return (node.children ?? [])
    .map((child) => (typeof child === "string" ? child : child && typeof child === "object" ? nodeText(child) : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const found = renderer.root.findAll((node) => node.type === "button" && nodeText(node).includes(label)).at(0);
  if (!found) {
    throw new Error(`Button not found: ${label}`);
  }
  return found;
}

async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    findButton(renderer, label).props.onClick();
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

const promptTests = [
  {
    code: "TEST-01",
    expectations: "",
    prompt: "Summarize <TOPIC>",
    testId: "test-1",
    title: "Placeholder prompt",
  },
  {
    code: "TEST-02",
    expectations: "",
    prompt: "Explain the runtime",
    testId: "test-2",
    title: "Plain prompt",
  },
];

function promptReport() {
  return {
    latestAssessments: [],
    runs: [
      {
        finishedAt: "2026-05-14T00:01:00.000Z",
        model: "gpt-5.4",
        output: "ok",
        packId: "pack-core",
        providerId: "openai",
        runId: "run-1",
        startedAt: "2026-05-14T00:00:00.000Z",
        status: "completed",
        testId: "test-2",
      },
    ],
    summary: {
      averageWeightedScore: 91,
      passRate: 1,
      passThreshold: 80,
    },
  };
}

describe("PromptLabPage loop 41 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    apiMocks.fetchPromptPacks.mockResolvedValue({
      items: [{ name: "Core Prompt Pack", packId: "pack-core", testCount: 2 }],
    });
    apiMocks.fetchPromptPackTests.mockResolvedValue({ items: promptTests });
    apiMocks.fetchPromptPackReport.mockResolvedValue(promptReport());
    apiMocks.fetchPromptPackExport.mockResolvedValue({
      exists: true,
      packId: "pack-core",
      path: "artifacts/prompt-lab/core.md",
      sizeBytes: 240,
    });
    apiMocks.fetchPromptPackTrends.mockResolvedValue({ items: [] });
    apiMocks.runPromptPackBenchmark.mockResolvedValue({ benchmarkRunId: "benchmark-loop41" });
    apiMocks.fetchPromptPackBenchmark.mockResolvedValue({
      run: {
        benchmarkRunId: "benchmark-loop41",
        packId: "pack-core",
        status: "completed",
      },
    });
  });

  it("refreshes data from the summary panel and starts a setup-panel benchmark", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<PromptLabPage workspaceId="default" />);
      });
      await flush();

      expect(text(renderer)).toContain("Pack : Core Prompt Pack : 2 tests loaded");
      expect(text(renderer)).toContain("Selected test: TEST-01");
      expect(text(renderer)).toContain("Missing placeholders: <TOPIC>");

      await click(renderer, "Refresh data");
      expect(apiMocks.fetchPromptPacks).toHaveBeenCalledTimes(2);

      await click(renderer, "Use focused tests");
      await click(renderer, "Use OpenAI provider");
      await click(renderer, "Run setup benchmark");

      expect(apiMocks.runPromptPackBenchmark).toHaveBeenCalledWith("pack-core", {
        providers: [{ model: "gpt-5.4-mini", providerId: "openai" }],
        testCodes: ["TEST-01", "TEST-02"],
      });
      expect(apiMocks.fetchPromptPackBenchmark).toHaveBeenCalledWith("benchmark-loop41");
      expect(text(renderer)).toContain("Success: Benchmark started: benchmark-loop41");
    } finally {
      renderer.unmount();
    }
  });
});
