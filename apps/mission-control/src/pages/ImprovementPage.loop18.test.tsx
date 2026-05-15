import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  approveImprovementAutoTune: vi.fn(),
  draftReplayOverride: vi.fn(),
  executeReplayOverride: vi.fn(),
  fetchImprovementCandidate: vi.fn(),
  fetchImprovementCandidates: vi.fn(),
  fetchImprovementReplayRun: vi.fn(),
  fetchImprovementReplayRuns: vi.fn(),
  fetchImprovementReports: vi.fn(),
  fetchImprovementSignals: vi.fn(),
  fetchReplayDiff: vi.fn(),
  pauseImprovementActivation: vi.fn(),
  requestImprovementActivation: vi.fn(),
  revertImprovementAutoTune: vi.fn(),
  rollbackImprovementActivation: vi.fn(),
  runImprovementReplay: vi.fn(),
}));

const refreshMock = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void>),
  lastOptions: null as null | {
    onFallbackStateChange?: (value: boolean) => void;
  },
}));

vi.mock("../api/client", () => ({
  approveImprovementAutoTune: apiMocks.approveImprovementAutoTune,
  draftReplayOverride: apiMocks.draftReplayOverride,
  executeReplayOverride: apiMocks.executeReplayOverride,
  fetchImprovementCandidate: apiMocks.fetchImprovementCandidate,
  fetchImprovementCandidates: apiMocks.fetchImprovementCandidates,
  fetchImprovementReplayRun: apiMocks.fetchImprovementReplayRun,
  fetchImprovementReplayRuns: apiMocks.fetchImprovementReplayRuns,
  fetchImprovementReports: apiMocks.fetchImprovementReports,
  fetchImprovementSignals: apiMocks.fetchImprovementSignals,
  fetchReplayDiff: apiMocks.fetchReplayDiff,
  pauseImprovementActivation: apiMocks.pauseImprovementActivation,
  requestImprovementActivation: apiMocks.requestImprovementActivation,
  revertImprovementAutoTune: apiMocks.revertImprovementAutoTune,
  rollbackImprovementActivation: apiMocks.rollbackImprovementActivation,
  runImprovementReplay: apiMocks.runImprovementReplay,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_key: string, callback: () => Promise<void>, options: typeof refreshMock.lastOptions) => {
    refreshMock.callback = callback;
    refreshMock.lastOptions = options;
  },
}));

import { ImprovementPage } from "./ImprovementPage";

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

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

function findButtons(renderer: ReactTestRenderer, label: string) {
  const textOf = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
    if (!value || typeof value !== "object" || !("children" in value)) {
      return "";
    }
    return ((value as { children?: unknown[] }).children ?? []).map((child) => textOf(child)).join(" ");
  };

  return renderer.root.findAll((node) => node.type === "button" && textOf(node).replace(/\s+/g, " ").includes(label));
}

function buttonLabels(renderer: ReactTestRenderer): string[] {
  const textOf = (value: unknown): string => {
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    if (!value || typeof value !== "object" || !("children" in value)) {
      return "";
    }
    return ((value as { children?: unknown[] }).children ?? []).map((child) => textOf(child)).join(" ");
  };

  return renderer.root
    .findAll((node) => node.type === "button")
    .map((node) => textOf(node).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

async function clickButton(renderer: ReactTestRenderer, label: string, index = 0): Promise<void> {
  const button = findButtons(renderer, label)[index];
  if (!button) {
    throw new Error(`Button not found: ${label}. Available buttons: ${buttonLabels(renderer).join(" | ")}`);
  }
  await act(async () => {
    button.props.onClick();
  });
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    triggerMode: "manual",
    sampleSize: 9,
    windowStart: "2026-04-10T00:00:00.000Z",
    windowEnd: "2026-04-11T00:00:00.000Z",
    status: "completed",
    totalCandidates: 9,
    totalScored: 9,
    likelyWrongCount: 8,
    modelJudgedCount: 3,
    startedAt: "2026-04-11T09:00:00.000Z",
    finishedAt: "2026-04-11T09:10:00.000Z",
    ...overrides,
  };
}

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    reportId: "report-1",
    runId: "run-1",
    summary: {
      sampledDecisions: 9,
      likelyWrongCount: 8,
      wrongnessRate: 0.88,
      topCauseClasses: [{ causeClass: "tool_mismatch", count: 4 }],
      duplicateSuppressedCount: 1,
      improvedCount: 2,
      regressedCount: 1,
    },
    topFindings: [],
    appliedAutoTunes: [],
    queuedRecommendations: [],
    strategyTags: [],
    weekOverWeek: { improved: ["routing improved"], regressed: ["browser tool drift"], unchanged: [] },
    weekStart: "2026-04-07T00:00:00.000Z",
    weekEnd: "2026-04-11T00:00:00.000Z",
    createdAt: "2026-04-11T10:00:00.000Z",
    ...overrides,
  };
}

function setupDefaultApi(overrides?: { report?: Record<string, unknown> | null; run?: Record<string, unknown> }) {
  const run = makeRun(overrides?.run);
  const report = overrides?.report === null ? null : makeReport(overrides?.report);

  apiMocks.fetchImprovementReports.mockResolvedValue({ items: report ? [report] : [] });
  apiMocks.fetchImprovementReplayRuns.mockResolvedValue({ items: [run] });
  apiMocks.fetchImprovementReplayRun.mockResolvedValue({
    run,
    items: Array.from({ length: 9 }, (_, index) => ({
      itemId: `item-${index + 1}`,
      causeClass: `cause-${index + 1}`,
      wrongnessProbability: 0.91 - index * 0.01,
      summary: `Wrong decision ${index + 1}`,
      decisionType: "tool",
    })),
    findings: [],
    autoTunes: [],
  });
  apiMocks.fetchImprovementSignals.mockResolvedValue({ items: [] });
  apiMocks.fetchImprovementCandidates.mockResolvedValue({ items: [] });
  apiMocks.fetchImprovementCandidate.mockResolvedValue(null);
  apiMocks.runImprovementReplay.mockResolvedValue({ run });
  apiMocks.draftReplayOverride.mockResolvedValue({ replayRunId: "draft-1", status: "completed", overrides: [] });
  apiMocks.executeReplayOverride.mockResolvedValue({ replayRunId: "draft-2", status: "completed", overrides: [] });
  apiMocks.fetchReplayDiff.mockResolvedValue(null);
  apiMocks.approveImprovementAutoTune.mockResolvedValue({});
  apiMocks.revertImprovementAutoTune.mockResolvedValue({});
}

describe("ImprovementPage loop 18 behavior coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.callback = null;
    refreshMock.lastOptions = null;
    setupDefaultApi();
  });

  it("renders top wrong decisions, run errors, and limits the visible item list to the first eight findings", async () => {
    setupDefaultApi({ run: { error: "judge timeout after partial scoring" } });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ImprovementPage workspaceId="default" />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("judge timeout after partial scoring");
      expect(text).toContain("Wrong decision 1");
      expect(text).toContain("Wrong decision 8");
      expect(text).not.toContain("Wrong decision 9");
      expect(text).toContain("tool_mismatch");
      expect(text).toContain("browser tool drift");
    } finally {
      renderer.unmount();
    }
  });

  it("approves low-risk queued auto-tunes, blocks high-risk queued auto-tunes, and reverts applied auto-tunes", async () => {
    setupDefaultApi({
      report: {
        appliedAutoTunes: [
          {
            tuneId: "tune-applied",
            tuneClass: "routing_threshold",
            description: "Lower threshold for direct browser work",
            status: "applied",
            riskLevel: "low",
          },
        ],
        queuedRecommendations: [
          {
            tuneId: "tune-low",
            tuneClass: "prompt_patch",
            description: "Tighten retry wording",
            status: "queued",
            riskLevel: "low",
          },
          {
            tuneId: "tune-high",
            tuneClass: "policy_change",
            description: "Allow automatic filesystem writes",
            status: "queued",
            riskLevel: "high",
          },
        ],
      },
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ImprovementPage workspaceId="default" />);
      });
      await flush();

      const approveButtons = findButtons(renderer, "Approve");
      expect(approveButtons).toHaveLength(2);
      expect(approveButtons[0]?.props.disabled).toBe(false);
      expect(approveButtons[1]?.props.disabled).toBe(true);

      await clickButton(renderer, "Approve");
      await flush();
      expect(apiMocks.approveImprovementAutoTune).toHaveBeenCalledWith("tune-low");
      expect(rendererText(renderer)).toContain("Auto-tune approved and applied.");

      await clickButton(renderer, "Revert");
      await flush();
      expect(apiMocks.revertImprovementAutoTune).toHaveBeenCalledWith("tune-applied");
      expect(rendererText(renderer)).toContain("Auto-tune reverted.");
    } finally {
      renderer.unmount();
    }
  });

  it("shows the running replay empty-report copy and the degraded live-refresh banner", async () => {
    setupDefaultApi({
      report: null,
      run: {
        status: "running",
        finishedAt: undefined,
        totalCandidates: 0,
        totalScored: 0,
        likelyWrongCount: 0,
      },
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ImprovementPage workspaceId="default" />);
      });
      await flush();

      expect(rendererText(renderer)).toContain(
        "Replay is still running. A weekly report appears after scoring and clustering complete.",
      );

      await act(async () => {
        refreshMock.lastOptions?.onFallbackStateChange?.(true);
      });
      expect(rendererText(renderer)).toContain("Live updates degraded, checking periodically.");
    } finally {
      renderer.unmount();
    }
  });

  it("selects candidates, replay runs, reports, and refreshes the active run detail", async () => {
    setupDefaultApi({
      report: {
        reportId: "report-initial",
        runId: "run-initial",
        summary: {
          sampledDecisions: 4,
          likelyWrongCount: 1,
          wrongnessRate: 0.25,
          topCauseClasses: [],
          duplicateSuppressedCount: 0,
          improvedCount: 0,
          regressedCount: 0,
        },
      },
      run: {
        runId: "run-initial",
        status: "completed",
        totalCandidates: 4,
        totalScored: 4,
        likelyWrongCount: 1,
      },
    });
    const selectedRun = makeRun({
      runId: "run-selected",
      reportId: "report-selected",
      status: "running",
      totalCandidates: 7,
      totalScored: 3,
      likelyWrongCount: 2,
      startedAt: "2026-04-12T09:00:00.000Z",
      finishedAt: undefined,
    });
    apiMocks.fetchImprovementReports.mockResolvedValue({
      items: [
        makeReport({
          reportId: "report-initial",
          runId: "run-initial",
          summary: {
            sampledDecisions: 4,
            likelyWrongCount: 1,
            wrongnessRate: 0.25,
            topCauseClasses: [],
            duplicateSuppressedCount: 0,
            improvedCount: 0,
            regressedCount: 0,
          },
          weekEnd: "2026-04-11T00:00:00.000Z",
          createdAt: "2026-04-11T10:00:00.000Z",
        }),
        makeReport({
          reportId: "report-selected",
          runId: "run-selected",
          summary: {
            sampledDecisions: 7,
            likelyWrongCount: 2,
            wrongnessRate: 0.29,
            topCauseClasses: [{ causeClass: "selected_report", count: 2 }],
            duplicateSuppressedCount: 0,
            improvedCount: 1,
            regressedCount: 0,
          },
          weekEnd: "2026-04-12T00:00:00.000Z",
          createdAt: "2026-04-12T10:00:00.000Z",
        }),
      ],
    });
    apiMocks.fetchImprovementReplayRuns.mockResolvedValue({
      items: [
        makeRun({
          runId: "run-initial",
          reportId: "report-initial",
          status: "completed",
          totalCandidates: 4,
          totalScored: 4,
          likelyWrongCount: 1,
          startedAt: "2026-04-11T09:00:00.000Z",
        }),
        selectedRun,
      ],
    });
    apiMocks.fetchImprovementCandidates.mockResolvedValue({
      items: [
        {
          candidateId: "cand-initial",
          kind: "prompt_patch",
          status: "ready_for_approval",
          supportingSignalCount: 1,
          targetKey: "prompt:initial",
          summary: "Initial candidate",
        },
        {
          candidateId: "cand-selected",
          kind: "routing_policy",
          status: "approved",
          supportingSignalCount: 3,
          targetKey: "route:selected",
          summary: "Selected routing candidate",
        },
      ],
    });
    apiMocks.fetchImprovementCandidate.mockImplementation(async (candidateId: string) => ({
      candidate: {
        candidateId,
        kind: candidateId === "cand-selected" ? "routing_policy" : "prompt_patch",
        status: candidateId === "cand-selected" ? "approved" : "ready_for_approval",
        supportingSignalCount: candidateId === "cand-selected" ? 3 : 1,
        targetKey: candidateId === "cand-selected" ? "route:selected" : "prompt:initial",
        summary: candidateId === "cand-selected" ? "Selected routing candidate" : "Initial candidate",
      },
      currentRevision: null,
      supportingSignals: [],
      latestEvaluation: null,
      latestActivation: null,
      attemptManifestSummary: [],
    }));
    apiMocks.fetchImprovementReplayRun.mockImplementation(async (runId: string) => ({
      run: runId === "run-selected" ? selectedRun : makeRun({ runId, reportId: "report-initial" }),
      items: [
        {
          itemId: `${runId}-item`,
          causeClass: runId === "run-selected" ? "selected_run" : "initial_run",
          wrongnessProbability: 0.82,
          summary: runId === "run-selected" ? "Selected run finding" : "Initial run finding",
          decisionType: "tool",
        },
      ],
      findings: [],
      autoTunes: [],
    }));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ImprovementPage workspaceId="default" />);
      });
      await flush();

      await clickButton(renderer, "routing_policy");
      await flush();
      expect(apiMocks.fetchImprovementCandidate).toHaveBeenCalledWith("cand-selected");
      expect(rendererText(renderer)).toContain("Selected routing candidate");

      await clickButton(renderer, new Date("2026-04-12T09:00:00.000Z").toLocaleString());
      await flush();
      expect(apiMocks.fetchImprovementReplayRun).toHaveBeenCalledWith("run-selected");
      expect(rendererText(renderer)).toContain("Selected run finding");

      await clickButton(renderer, "7 sampled");
      await flush();
      expect(rendererText(renderer)).toContain("selected_report");

      const callCountBeforeRefresh = apiMocks.fetchImprovementReplayRun.mock.calls.length;
      await act(async () => {
        await refreshMock.callback?.();
      });
      await flush();

      expect(apiMocks.fetchImprovementReplayRun.mock.calls.length).toBeGreaterThan(callCountBeforeRefresh);
      expect(apiMocks.fetchImprovementReplayRun).toHaveBeenLastCalledWith("run-selected");
    } finally {
      renderer.unmount();
    }
  });
});
