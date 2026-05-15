import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void> | void),
}));

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

const providerMocks = vi.hoisted(() => ({
  loadModelsForProvider: vi.fn(),
}));

vi.mock("../api/client", () => apiMocks);

vi.mock("../hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    config: {
      activeProviderId: "openai",
    },
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        models: ["gpt-5.4", "gpt-5.4-mini"],
      },
    ],
    loadModelsForProvider: providerMocks.loadModelsForProvider,
  }),
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: () => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../components/CardSkeleton", () => ({
  CardSkeleton: () => <div>Loading prompt lab</div>,
}));

vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <p>{message}</p>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel ?? "Confirm"}
        </button>
      </div>
    ) : null,
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
    title,
    overviewCards,
    error,
    success,
    onRunBenchmark,
    onRefreshData,
    onAutoScoreUnscored,
    onExportNow,
    onResetPack,
    onCopyExportPath,
  }: {
    title: string;
    overviewCards: Array<{ label: string; value: string; detail: string }>;
    error?: string | null;
    success?: string | null;
    onRunBenchmark: () => void;
    onRefreshData: () => void;
    onAutoScoreUnscored: () => void;
    onExportNow: () => void;
    onResetPack: () => void;
    onCopyExportPath: () => void;
  }) => (
    <section>
      <h1>{title}</h1>
      {overviewCards.map((card) => (
        <p key={card.label}>
          {card.label}: {card.value} - {card.detail}
        </p>
      ))}
      {error ? <p>Error: {error}</p> : null}
      {success ? <p>Success: {success}</p> : null}
      <button type="button" onClick={onRunBenchmark}>
        Run benchmark
      </button>
      <button type="button" onClick={onRefreshData}>
        Refresh data
      </button>
      <button type="button" onClick={onAutoScoreUnscored}>
        Auto-score unscored
      </button>
      <button type="button" onClick={onExportNow}>
        Export now
      </button>
      <button type="button" onClick={onResetPack}>
        Reset pack
      </button>
      <button type="button" onClick={onCopyExportPath}>
        Copy export path
      </button>
    </section>
  ),
}));

vi.mock("./prompt-lab/PromptLabSetupPanel", () => ({
  PromptLabSetupPanel: ({
    importText,
    packs,
    selectedPackId,
    benchmarkProvidersInput,
    onImportTextChange,
    onImport,
    onSelectedPackIdChange,
    onSelectedProviderIdChange,
    onSelectedModelChange,
    onReuseLastModelChange,
    onAutoScoreOnRunChange,
    onBenchmarkTestCodesChange,
    onBenchmarkProvidersInputChange,
    onRunRegression,
  }: {
    importText: string;
    packs: Array<{ packId: string; name: string }>;
    selectedPackId: string | null;
    benchmarkProvidersInput: string;
    onImportTextChange: (value: string) => void;
    onImport: () => void;
    onSelectedPackIdChange: (value: string) => void;
    onSelectedProviderIdChange: (value: string) => void;
    onSelectedModelChange: (value: string) => void;
    onReuseLastModelChange: (value: boolean) => void;
    onAutoScoreOnRunChange: (value: boolean) => void;
    onBenchmarkTestCodesChange: (value: string) => void;
    onBenchmarkProvidersInputChange: (value: string) => void;
    onRunRegression: () => void;
  }) => (
    <aside>
      <p>Setup {selectedPackId}</p>
      <p>Provider lane {benchmarkProvidersInput}</p>
      <select value={selectedPackId ?? ""} onChange={(event) => onSelectedPackIdChange(event.target.value)}>
        {packs.map((pack) => (
          <option key={pack.packId} value={pack.packId}>
            {pack.name}
          </option>
        ))}
      </select>
      <textarea value={importText} onChange={(event) => onImportTextChange(event.target.value)} />
      <button type="button" onClick={onImport}>
        Import
      </button>
      <button type="button" onClick={() => onSelectedProviderIdChange("openai")}>
        Select OpenAI
      </button>
      <button type="button" onClick={() => onSelectedModelChange("gpt-5.4-mini")}>
        Select mini
      </button>
      <button type="button" onClick={() => onReuseLastModelChange(false)}>
        Disable reuse
      </button>
      <button type="button" onClick={() => onAutoScoreOnRunChange(false)}>
        Disable auto-score
      </button>
      <button type="button" onClick={() => onBenchmarkTestCodesChange("TEST-01, TEST-02")}>
        Set benchmark tests
      </button>
      <button type="button" onClick={() => onBenchmarkProvidersInputChange("openai/gpt-5.4-mini")}>
        Set benchmark providers
      </button>
      <button type="button" onClick={onRunRegression}>
        Run regression
      </button>
    </aside>
  ),
}));

vi.mock("./prompt-lab/PromptLabReportPanel", () => ({
  PromptLabReportPanel: ({ passThreshold }: { passThreshold: number }) => (
    <section>Report threshold {passThreshold}</section>
  ),
}));

vi.mock("./prompt-lab/PromptLabWorkspace", () => ({
  PromptLabWorkspace: ({
    filteredTests,
    selectedTest,
    selectedPlaceholders,
    selectedMissingPlaceholders,
    onPlaceholderValuesChange,
    onSelectedTestIdChange,
    runOne,
    scoreDraft,
    onScoreDraftChange,
    submitScore,
    autoScoreSelected,
    onTestResultFilterChange,
  }: {
    filteredTests: Array<{ testId: string; code: string; prompt: string }>;
    selectedTest?: { testId: string; code: string; prompt: string } | null;
    selectedPlaceholders: string[];
    selectedMissingPlaceholders: string[];
    onPlaceholderValuesChange: (value: Record<string, string>) => void;
    onSelectedTestIdChange: (value: string) => void;
    runOne: (test: { testId: string; code: string; prompt: string }) => Promise<void>;
    scoreDraft: Record<string, unknown>;
    onScoreDraftChange: (value: Record<string, unknown>) => void;
    submitScore: () => Promise<void>;
    autoScoreSelected: () => Promise<void>;
    onTestResultFilterChange: (value: string) => void;
  }) => (
    <main>
      <p>Workspace tests {filteredTests.map((test) => test.code).join(", ")}</p>
      <p>Selected {selectedTest?.code ?? "none"}</p>
      <p>Placeholders {selectedPlaceholders.join(", ") || "none"}</p>
      <p>Missing {selectedMissingPlaceholders.join(", ") || "none"}</p>
      <p>Draft {String(scoreDraft.notes ?? "")}</p>
      <button type="button" onClick={() => selectedTest && void runOne(selectedTest)}>
        Run selected
      </button>
      <button type="button" onClick={() => onPlaceholderValuesChange({ customer_name: "Acme" })}>
        Fill placeholders
      </button>
      <button type="button" onClick={() => onSelectedTestIdChange("test-2")}>
        Select completed
      </button>
      <button type="button" onClick={() => onScoreDraftChange({ ...scoreDraft, notes: "Looks good", taskSuccess: 4 })}>
        Draft score
      </button>
      <button type="button" onClick={() => void submitScore()}>
        Submit score
      </button>
      <button type="button" onClick={() => void autoScoreSelected()}>
        Auto-score selected
      </button>
      <button type="button" onClick={() => onTestResultFilterChange("needs_score")}>
        Filter needs score
      </button>
    </main>
  ),
}));

import { PromptLabPage } from "./PromptLabPage";

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

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return ((node as { children?: unknown[] }).children ?? []).map((child) => instanceText(child)).join(" ");
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

async function click(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[occurrence];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

const tests = [
  {
    testId: "test-1",
    code: "TEST-01",
    title: "Missing placeholder run",
    surface: "chat",
    prompt: "Draft for <CUSTOMER_NAME>",
    expectations: "Be useful",
  },
  {
    testId: "test-2",
    code: "TEST-02",
    title: "Completed run",
    surface: "cowork",
    prompt: "Summarize status",
    expectations: "Be truthful",
  },
];

const completedRun = {
  runId: "run-2",
  packId: "pack-core",
  testId: "test-2",
  status: "completed",
  providerId: "openai",
  model: "gpt-5.4",
  output: "Done",
  startedAt: "2026-04-01T00:00:00.000Z",
  finishedAt: "2026-04-01T00:01:00.000Z",
};

function report() {
  return {
    runs: [completedRun],
    latestAssessments: [],
    summary: {
      passRate: 0.5,
      averageWeightedScore: 75,
      passThreshold: 80,
    },
  };
}

describe("PromptLabPage behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    apiMocks.fetchPromptPacks.mockResolvedValue({
      items: [{ packId: "pack-core", name: "Core Pack", testCount: 2 }],
    });
    apiMocks.fetchPromptPackTests.mockResolvedValue({ items: tests });
    apiMocks.fetchPromptPackReport.mockResolvedValue(report());
    apiMocks.fetchPromptPackExport.mockResolvedValue({
      packId: "pack-core",
      path: "artifacts/prompt-lab/core.md",
      exists: true,
      sizeBytes: 1234,
    });
    apiMocks.fetchPromptPackTrends.mockResolvedValue({ items: [] });
    apiMocks.runPromptPackTest.mockResolvedValue({
      runId: "run-1",
      packId: "pack-core",
      testId: "test-1",
      status: "completed",
      providerId: "openai",
      model: "gpt-5.4",
      startedAt: "2026-04-01T00:00:00.000Z",
      finishedAt: "2026-04-01T00:01:00.000Z",
    });
    apiMocks.autoScorePromptPackTest.mockResolvedValue({
      score: {
        weightedScore: 88,
        autoVerdict: "pass",
      },
    });
    apiMocks.autoScorePromptPackBatch.mockResolvedValue({
      items: [{ runId: "run-2" }],
      skipped: 0,
    });
    apiMocks.scorePromptPackTest.mockResolvedValue({ ok: true });
    apiMocks.exportPromptPackReport.mockResolvedValue({
      packId: "pack-core",
      path: "artifacts/prompt-lab/exported.md",
      exists: true,
      sizeBytes: 5678,
    });
    apiMocks.resetPromptPack.mockResolvedValue({ deletedRuns: 2, deletedScores: 1 });
    apiMocks.importPromptPack.mockResolvedValue({
      pack: { packId: "pack-imported" },
      tests: [{ testId: "imported-1" }],
    });
    apiMocks.runPromptPackBenchmark.mockResolvedValue({ benchmarkRunId: "benchmark-1" });
    apiMocks.fetchPromptPackBenchmark.mockResolvedValue({
      run: {
        benchmarkRunId: "benchmark-1",
        packId: "pack-core",
        status: "running",
      },
    });
    apiMocks.runPromptPackReplayRegression.mockResolvedValue({ regressionRunId: "regression-1" });
    apiMocks.fetchPromptPackReplayRegressionStatus.mockResolvedValue({
      run: {
        regressionRunId: "regression-1",
        packId: "pack-core",
        status: "completed",
      },
    });
  });

  it("loads prompt-pack state and drives run, score, benchmark, import, reset, and export actions", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<PromptLabPage workspaceId="default" />);
      });
      await flush();

      let text = rendererText(renderer);
      expect(text).toContain("Prompt Lab");
      expect(text).toContain("Pack : Core Pack");
      expect(text).toContain("Coverage : 1/2");
      expect(text).toContain("Quality : 50.0% pass");
      expect(text).toContain("Missing <CUSTOMER_NAME>");

      await click(renderer, "Run selected");
      expect(rendererText(renderer)).toContain("Missing placeholder values for TEST-01: <CUSTOMER_NAME>.");
      expect(apiMocks.runPromptPackTest).not.toHaveBeenCalled();

      await click(renderer, "Fill placeholders");
      await click(renderer, "Run selected");
      expect(apiMocks.runPromptPackTest).toHaveBeenCalledWith(
        "pack-core",
        "test-1",
        expect.objectContaining({
          providerId: "openai",
          model: "gpt-5.4",
          placeholderValues: { customer_name: "Acme" },
        }),
      );
      expect(apiMocks.autoScorePromptPackTest).toHaveBeenCalledWith("pack-core", "test-1", { runId: "run-1" });

      await click(renderer, "Select completed");
      await click(renderer, "Draft score");
      await click(renderer, "Submit score");
      expect(apiMocks.scorePromptPackTest).toHaveBeenCalledWith(
        "pack-core",
        "test-2",
        expect.objectContaining({
          runId: "run-2",
          taskSuccess: 4,
          notes: "Looks good",
        }),
      );

      await click(renderer, "Auto-score selected");
      expect(apiMocks.autoScorePromptPackTest).toHaveBeenCalledWith("pack-core", "test-2", {
        runId: "run-2",
        force: true,
      });

      await click(renderer, "Auto-score unscored");
      expect(apiMocks.autoScorePromptPackBatch).toHaveBeenCalledWith("pack-core", { onlyUnscored: true });

      await click(renderer, "Set benchmark tests");
      await click(renderer, "Set benchmark providers");
      await click(renderer, "Run benchmark");
      expect(apiMocks.runPromptPackBenchmark).toHaveBeenCalledWith("pack-core", {
        testCodes: ["TEST-01", "TEST-02"],
        providers: [{ providerId: "openai", model: "gpt-5.4-mini" }],
      });

      await click(renderer, "Run regression");
      expect(apiMocks.runPromptPackReplayRegression).toHaveBeenCalledWith("pack-core", {
        testCodes: ["TEST-01", "TEST-02"],
        baselineRef: "benchmark-1",
      });

      await click(renderer, "Export now");
      expect(apiMocks.exportPromptPackReport).toHaveBeenCalledWith("pack-core");
      await click(renderer, "Copy export path");
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("artifacts/prompt-lab/exported.md");

      const importBox = renderer.root.findByType("textarea");
      await act(async () => {
        importBox.props.onChange({ target: { value: "# Imported pack" } });
      });
      await click(renderer, "Import");
      expect(apiMocks.importPromptPack).toHaveBeenCalledWith({
        content: "# Imported pack",
        sourceLabel: "manual-import",
      });

      await click(renderer, "Reset pack");
      text = rendererText(renderer);
      expect(text).toContain("Reset Prompt Pack");
      await click(renderer, "Reset", 1);
      expect(apiMocks.resetPromptPack).toHaveBeenCalledWith("pack-imported", {
        clearRuns: true,
        clearScores: true,
      });

      await act(async () => {
        await refreshState.callback?.();
      });
      await flush();
      expect(apiMocks.fetchPromptPacks).toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });
});
