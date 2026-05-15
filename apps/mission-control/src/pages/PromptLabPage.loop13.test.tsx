import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void> | void),
}));

const providerState = vi.hoisted(() => ({
  providers: [
    {
      providerId: "openai",
      label: "OpenAI",
      models: ["gpt-5.4", "gpt-5.4-mini"],
    },
  ] as Array<{ providerId: string; label: string; models: string[] }>,
  activeProviderId: "openai" as string | undefined,
  loadModelsForProvider: vi.fn(),
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

vi.mock("../api/client", () => apiMocks);

vi.mock("../hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    config: { activeProviderId: providerState.activeProviderId },
    providers: providerState.providers,
    loadModelsForProvider: providerState.loadModelsForProvider,
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
    onCancel,
    onConfirm,
  }: {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    onCancel?: () => void;
    onConfirm?: () => void;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <p>{message}</p>
        <button type="button" onClick={onCancel}>
          Cancel reset
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
    onAutoScoreUnscored,
    onCopyExportPath,
    onExportNow,
    onRefreshData,
    onResetClearRunsChange,
    onResetClearScoresChange,
    onResetPack,
    onRunAll,
    onRunBenchmark,
    onRunNext,
  }: {
    title: string;
    overviewCards: Array<{ label: string; value: string; detail: string }>;
    error?: string | null;
    success?: string | null;
    onAutoScoreUnscored: () => void;
    onCopyExportPath: () => void;
    onExportNow: () => void;
    onRefreshData: () => void;
    onResetClearRunsChange: (value: boolean) => void;
    onResetClearScoresChange: (value: boolean) => void;
    onResetPack: () => void;
    onRunAll: () => void;
    onRunBenchmark: () => void;
    onRunNext: () => void;
  }) => (
    <section>
      <h1>{title}</h1>
      {overviewCards.map((card) => (
        <p key={card.label}>
          {card.label}:{card.value}:{card.detail}
        </p>
      ))}
      {error ? <p>Error:{error}</p> : null}
      {success ? <p>Success:{success}</p> : null}
      <button type="button" onClick={onRunNext}>
        Run next
      </button>
      <button type="button" onClick={onRunAll}>
        Run all
      </button>
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
      <button type="button" onClick={onCopyExportPath}>
        Copy export path
      </button>
      <button type="button" onClick={() => onResetClearRunsChange(false)}>
        Clear runs off
      </button>
      <button type="button" onClick={() => onResetClearScoresChange(false)}>
        Clear scores off
      </button>
      <button type="button" onClick={() => onResetClearRunsChange(true)}>
        Clear runs on
      </button>
      <button type="button" onClick={onResetPack}>
        Reset pack
      </button>
    </section>
  ),
}));

vi.mock("./prompt-lab/PromptLabSetupPanel", () => ({
  PromptLabSetupPanel: ({
    benchmarkProvidersInput,
    importText,
    onBenchmarkProvidersInputChange,
    onBenchmarkTestCodesChange,
    onCancelBenchmark,
    onImport,
    onImportTextChange,
    onRefreshBenchmark,
    onRefreshRegression,
    onRunRegression,
    onSelectedModelChange,
    onSelectedProviderIdChange,
  }: {
    benchmarkProvidersInput: string;
    importText: string;
    onBenchmarkProvidersInputChange: (value: string) => void;
    onBenchmarkTestCodesChange: (value: string) => void;
    onCancelBenchmark: () => void;
    onImport: () => void;
    onImportTextChange: (value: string) => void;
    onRefreshBenchmark: () => void;
    onRefreshRegression: () => void;
    onRunRegression: () => void;
    onSelectedModelChange: (value: string) => void;
    onSelectedProviderIdChange: (value: string) => void;
  }) => (
    <aside>
      <p>Providers:{benchmarkProvidersInput || "none"}</p>
      <textarea value={importText} onChange={(event) => onImportTextChange(event.target.value)} />
      <button type="button" onClick={onImport}>
        Import
      </button>
      <button type="button" onClick={() => onSelectedProviderIdChange("missing-provider")}>
        Select missing provider
      </button>
      <button type="button" onClick={() => onSelectedProviderIdChange("openai")}>
        Select OpenAI
      </button>
      <button type="button" onClick={() => onSelectedModelChange("gpt-5.4-mini")}>
        Select mini
      </button>
      <button type="button" onClick={() => onBenchmarkTestCodesChange("")}>
        Empty benchmark tests
      </button>
      <button type="button" onClick={() => onBenchmarkTestCodesChange("TEST-01 TEST-02 TEST-03")}>
        Set benchmark tests
      </button>
      <button type="button" onClick={() => onBenchmarkProvidersInputChange("")}>
        Empty benchmark providers
      </button>
      <button type="button" onClick={() => onBenchmarkProvidersInputChange("openai/gpt-5.4-mini")}>
        Set benchmark providers
      </button>
      <button type="button" onClick={onRunRegression}>
        Run regression
      </button>
      <button type="button" onClick={onCancelBenchmark}>
        Cancel benchmark
      </button>
      <button type="button" onClick={onRefreshBenchmark}>
        Refresh benchmark
      </button>
      <button type="button" onClick={onRefreshRegression}>
        Refresh regression
      </button>
    </aside>
  ),
}));

vi.mock("./prompt-lab/PromptLabReportPanel", () => ({
  PromptLabReportPanel: ({ passThreshold }: { passThreshold: number }) => <section>Report:{passThreshold}</section>,
}));

vi.mock("./prompt-lab/PromptLabWorkspace", () => ({
  PromptLabWorkspace: ({
    autoScoreSelected,
    onPlaceholderValuesChange,
    onScoreDraftChange,
    onSelectedTestIdChange,
    onTestResultFilterChange,
    runOne,
    scoreDraft,
    selectedMissingPlaceholders,
    selectedTest,
    submitScore,
  }: {
    autoScoreSelected: () => Promise<void>;
    onPlaceholderValuesChange: (value: Record<string, string>) => void;
    onScoreDraftChange: (value: Record<string, unknown>) => void;
    onSelectedTestIdChange: (value: string) => void;
    onTestResultFilterChange: (value: string) => void;
    runOne: (test: { testId: string; code: string; prompt: string }) => Promise<void>;
    scoreDraft: Record<string, unknown>;
    selectedMissingPlaceholders: string[];
    selectedTest?: { testId: string; code: string; prompt: string } | null;
    submitScore: () => Promise<void>;
  }) => (
    <main>
      <p>Selected:{selectedTest?.code ?? "none"}</p>
      <p>Missing:{selectedMissingPlaceholders.join(",") || "none"}</p>
      <p>Notes:{String(scoreDraft.notes ?? "")}</p>
      <button type="button" onClick={() => selectedTest && void runOne(selectedTest)}>
        Run selected
      </button>
      <button type="button" onClick={() => onPlaceholderValuesChange({ name: "Ada" })}>
        Fill placeholders
      </button>
      <button type="button" onClick={() => onSelectedTestIdChange("test-3")}>
        Select completed
      </button>
      <button type="button" onClick={() => onScoreDraftChange({ ...scoreDraft, notes: "Manual note", honesty: 5 })}>
        Draft score
      </button>
      <button type="button" onClick={() => void submitScore()}>
        Submit score
      </button>
      <button type="button" onClick={() => void autoScoreSelected()}>
        Auto-score selected
      </button>
      <button type="button" onClick={() => onTestResultFilterChange("score_failed")}>
        Filter score failed
      </button>
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
    .map((child) =>
      typeof child === "string" ? child : child && typeof child === "object" ? nodeText(child as any) : "",
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function button(renderer: ReactTestRenderer, label: string, occurrence = 0) {
  const found = renderer.root
    .findAll((node) => node.type === "button" && nodeText(node).includes(label))
    .at(occurrence);
  if (!found) {
    throw new Error(`Button not found: ${label}`);
  }
  return found;
}

async function click(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  await act(async () => {
    button(renderer, label, occurrence).props.onClick();
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
  { testId: "test-1", code: "TEST-01", title: "Placeholder", prompt: "Hello <NAME>", expectations: "" },
  { testId: "test-2", code: "TEST-02", title: "Failed", prompt: "Fail", expectations: "" },
  { testId: "test-3", code: "TEST-03", title: "Completed", prompt: "Complete", expectations: "" },
];

const failedRun = {
  runId: "run-failed",
  packId: "pack-core",
  testId: "test-2",
  status: "failed",
  error: "model timeout",
  startedAt: "2026-05-14T00:00:00.000Z",
};

const completedRun = {
  runId: "run-complete",
  packId: "pack-core",
  testId: "test-3",
  status: "completed",
  providerId: "openai",
  model: "gpt-5.4",
  output: "ok",
  startedAt: "2026-05-14T00:00:00.000Z",
  finishedAt: "2026-05-14T00:01:00.000Z",
};

function report() {
  return {
    runs: [failedRun, completedRun],
    latestAssessments: [
      {
        testId: "test-3",
        autoScore: { weightedScore: 42 },
        currentGeneration: true,
        effectiveVerdict: "fail",
        humanReview: {
          scores: { honesty: 3 },
          overrideVerdict: "review",
          notes: "Existing human note",
        },
      },
    ],
    summary: {
      passRate: 0.25,
      averageWeightedScore: 42,
      passThreshold: 80,
    },
  };
}

describe("PromptLabPage loop 13 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    providerState.providers = [{ providerId: "openai", label: "OpenAI", models: ["gpt-5.4", "gpt-5.4-mini"] }];
    providerState.activeProviderId = "openai";
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")),
        },
      },
    });

    apiMocks.fetchPromptPacks.mockResolvedValue({
      items: [{ packId: "pack-core", name: "Core Pack", testCount: 3 }],
    });
    apiMocks.fetchPromptPackTests.mockResolvedValue({ items: promptTests });
    apiMocks.fetchPromptPackReport.mockResolvedValue(report());
    apiMocks.fetchPromptPackExport.mockResolvedValue({
      packId: "pack-core",
      path: "artifacts/core.md",
      exists: true,
      sizeBytes: 200,
    });
    apiMocks.fetchPromptPackTrends.mockResolvedValue({ items: [] });
    apiMocks.runPromptPackTest.mockImplementation(async (_packId: string, testId: string) => {
      if (testId === "test-2") {
        return failedRun;
      }
      return {
        runId: `run-${testId}`,
        packId: "pack-core",
        testId,
        status: "completed",
        providerId: "openai",
        model: "gpt-5.4",
      };
    });
    apiMocks.autoScorePromptPackTest.mockRejectedValue(new Error("judge offline"));
    apiMocks.autoScorePromptPackBatch.mockRejectedValue(new Error("batch judge offline"));
    apiMocks.scorePromptPackTest.mockRejectedValue(new Error("score write failed"));
    apiMocks.exportPromptPackReport.mockRejectedValue(new Error("export failed"));
    apiMocks.resetPromptPack.mockResolvedValue({ deletedRuns: 1, deletedScores: 0 });
    apiMocks.importPromptPack.mockResolvedValue({
      pack: { packId: "pack-imported" },
      tests: [{ testId: "imported" }],
    });
    apiMocks.runPromptPackBenchmark.mockResolvedValue({ benchmarkRunId: "benchmark-1" });
    apiMocks.fetchPromptPackBenchmark.mockResolvedValue({
      run: { benchmarkRunId: "benchmark-1", packId: "pack-core", status: "completed" },
    });
    apiMocks.cancelPromptPackBenchmark.mockResolvedValue({
      run: { benchmarkRunId: "benchmark-1", packId: "pack-core", status: "cancelled" },
    });
    apiMocks.runPromptPackReplayRegression.mockResolvedValue({ regressionRunId: "regression-1" });
    apiMocks.fetchPromptPackReplayRegressionStatus.mockResolvedValue({
      run: { regressionRunId: "regression-1", packId: "pack-core", status: "running" },
    });
  });

  it("handles an empty pack list and no-op actions without selecting a pack", async () => {
    apiMocks.fetchPromptPacks.mockResolvedValueOnce({ items: [] });
    providerState.providers = [];
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<PromptLabPage workspaceId="default" />);
      });
      await flush();

      expect(text(renderer)).toContain("Pack : No pack selected");
      expect(text(renderer)).toContain("Selected: none");

      await click(renderer, "Run next");
      await click(renderer, "Run all");
      await click(renderer, "Export now");
      await click(renderer, "Auto-score unscored");
      await click(renderer, "Import");

      expect(apiMocks.runPromptPackTest).not.toHaveBeenCalled();
      expect(apiMocks.exportPromptPackReport).not.toHaveBeenCalled();
      expect(text(renderer)).toContain("Paste prompt-pack markdown first.");
    } finally {
      renderer.unmount();
    }
  });

  it("covers failed run-all, reset validation, report view, copy/export errors, and benchmark controls", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<PromptLabPage workspaceId="default" />);
      });
      await flush();

      expect(text(renderer)).toContain("Missing: <NAME>");

      await click(renderer, "Fill placeholders");
      await click(renderer, "Run selected");
      expect(text(renderer)).toContain("Ran TEST-01, but auto-score failed: judge offline");

      await click(renderer, "Run all");
      expect(text(renderer)).toContain("Run all finished:");
      expect(text(renderer)).toContain("Some runs need attention:");

      await click(renderer, "Select completed");
      expect(text(renderer)).toContain("Existing human note");
      await click(renderer, "Draft score");
      await click(renderer, "Submit score");
      expect(text(renderer)).toContain("score write failed");
      await click(renderer, "Auto-score selected");
      expect(text(renderer)).toContain("judge offline");

      await click(renderer, "Auto-score unscored");
      expect(text(renderer)).toContain("batch judge offline");
      await click(renderer, "Export now");
      expect(text(renderer)).toContain("export failed");
      await click(renderer, "Copy export path");
      expect(text(renderer)).toContain("Failed to copy export path.");

      await click(renderer, "Clear runs off");
      await click(renderer, "Clear scores off");
      await click(renderer, "Reset pack");
      expect(text(renderer)).toContain("Select at least one reset option");
      await click(renderer, "Clear runs on");
      await click(renderer, "Reset pack");
      expect(text(renderer)).toContain("Reset Prompt Pack");
      await click(renderer, "Reset", 1);
      expect(apiMocks.resetPromptPack).toHaveBeenCalledWith("pack-core", {
        clearRuns: true,
        clearScores: false,
      });

      await click(renderer, "Report");
      expect(text(renderer)).toContain("Report: 80");

      await click(renderer, "Setup");
      await click(renderer, "Empty benchmark tests");
      await click(renderer, "Run benchmark");
      expect(text(renderer)).toContain("Benchmark needs at least one test code.");

      await click(renderer, "Set benchmark tests");
      providerState.providers = [];
      providerState.activeProviderId = undefined;
      await click(renderer, "Select missing provider");
      await click(renderer, "Empty benchmark providers");
      await click(renderer, "Run benchmark");
      expect(text(renderer)).toContain("Benchmark needs at least one provider/model entry");

      await click(renderer, "Set benchmark providers");
      await click(renderer, "Run benchmark");
      expect(apiMocks.runPromptPackBenchmark).toHaveBeenCalledWith("pack-core", {
        testCodes: ["TEST-01", "TEST-02", "TEST-03"],
        providers: [{ providerId: "openai", model: "gpt-5.4-mini" }],
      });

      await click(renderer, "Cancel benchmark");
      expect(apiMocks.cancelPromptPackBenchmark).toHaveBeenCalledWith("benchmark-1");

      await click(renderer, "Run regression");
      expect(apiMocks.runPromptPackReplayRegression).toHaveBeenCalledWith("pack-core", {
        testCodes: ["TEST-01", "TEST-02", "TEST-03"],
        baselineRef: "benchmark-1",
      });
      await click(renderer, "Refresh benchmark");
      await click(renderer, "Refresh regression");
      expect(apiMocks.fetchPromptPackBenchmark).toHaveBeenCalledWith("benchmark-1");
      expect(apiMocks.fetchPromptPackReplayRegressionStatus).toHaveBeenCalledWith("regression-1");

      await act(async () => {
        await refreshState.callback?.();
      });
      await flush();
      expect(apiMocks.fetchPromptPacks).toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces fallback export metadata and keeps failing actions operator-visible", async () => {
    apiMocks.fetchPromptPackExport.mockReset();
    apiMocks.fetchPromptPackExport.mockRejectedValue(new Error("export metadata unavailable"));
    apiMocks.runPromptPackTest.mockRejectedValueOnce(new Error("runner unavailable"));
    apiMocks.resetPromptPack.mockRejectedValueOnce(new Error("reset refused"));
    apiMocks.importPromptPack.mockRejectedValueOnce(new Error("import refused"));
    apiMocks.runPromptPackBenchmark.mockRejectedValueOnce(new Error("benchmark refused"));
    apiMocks.runPromptPackReplayRegression.mockRejectedValueOnce(new Error("regression refused"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<PromptLabPage workspaceId="default" />);
      });
      await flush();

      await click(renderer, "Copy export path");
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

      await click(renderer, "Fill placeholders");
      await click(renderer, "Run selected");
      expect(text(renderer)).toContain("runner unavailable");

      await click(renderer, "Select mini");

      await click(renderer, "Set benchmark tests");
      await click(renderer, "Set benchmark providers");
      await click(renderer, "Run benchmark");
      expect(text(renderer)).toContain("benchmark refused");

      await click(renderer, "Run regression");
      expect(text(renderer)).toContain("regression refused");

      const importBox = renderer.root.findByType("textarea");
      await act(async () => {
        importBox.props.onChange({ target: { value: "# Imported pack" } });
      });
      await click(renderer, "Import");
      expect(text(renderer)).toContain("import refused");

      await click(renderer, "Reset pack");
      expect(text(renderer)).toContain("Reset Prompt Pack");
      await click(renderer, "Cancel reset");
      expect(apiMocks.resetPromptPack).not.toHaveBeenCalled();

      await click(renderer, "Reset pack");
      await click(renderer, "Reset", 1);
      expect(text(renderer)).toContain("reset refused");
    } finally {
      renderer.unmount();
    }
  });
});
