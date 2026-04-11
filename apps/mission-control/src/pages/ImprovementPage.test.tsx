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
  useRefreshSubscription: () => undefined,
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

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const textOf = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (!value || typeof value !== "object" || !("children" in value)) {
      return "";
    }
    return ((value as { children?: unknown[] }).children ?? []).map((child) => textOf(child)).join(" ");
  };

  const button = renderer.root.findAll(
    (node) => node.type === "button" && textOf(node).replace(/\s+/g, " ").includes(label),
  )[0];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
}

describe("ImprovementPage", () => {
  let currentCandidateDetail: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentCandidateDetail = {
      candidate: {
        candidateId: "cand-1",
        workspaceId: "default",
        kind: "routing_policy",
        status: "ready_for_approval",
        targetKey: "pack-routing:provider-balance",
        fingerprint: "fp-1",
        summary: "Routing candidate summary",
        currentRevisionId: "rev-1",
        supportingSignalCount: 3,
        negativeSignalCount: 1,
        latestSignalAt: "2026-04-11T10:00:00.000Z",
        createdAt: "2026-04-11T09:00:00.000Z",
        updatedAt: "2026-04-11T10:00:00.000Z",
        suppressionUntil: "2026-04-18T10:00:00.000Z",
      },
      currentRevision: {
        revisionId: "rev-1",
        candidateId: "cand-1",
        candidateRef: { refType: "artifact_manifest", refId: "routing_policy:pack-routing:provider-balance" },
        changeHash: "hash-1",
        createdAt: "2026-04-11T09:05:00.000Z",
        createdByActorId: "system",
        createdByActorType: "system",
      },
      supportingSignals: [
        {
          signalId: "sig-1",
          evidenceRefs: [{ refType: "approval", refId: "apr-1" }],
        },
      ],
      latestEvaluation: {
        evaluationId: "eval-1",
        candidateId: "cand-1",
        revisionId: "rev-1",
        status: "passed",
        baselineRef: { refType: "baseline", refId: "base-1" },
        candidateRef: { refType: "artifact_manifest", refId: "routing_policy:pack-routing:provider-balance" },
        evaluatorKind: "prompt_lab_regression",
        evaluatorVersion: "v1",
        changeHash: "hash-1",
        metrics: {},
        resultSummary: "passed in lab",
        createdAt: "2026-04-11T09:10:00.000Z",
        createdByActorId: "system",
        createdByActorType: "service",
      },
      latestActivation: {
        activationId: "act-1",
        candidateId: "cand-1",
        revisionId: "rev-1",
        approvalId: "apr-1",
        status: "active",
        scope: "workspace",
        activationTarget: { refType: "routing_policy_config", refId: "pack-routing:provider-balance" },
        preActivationSnapshot: { refType: "routing_policy_snapshot", refId: "pack-routing:provider-balance" },
        appliedChangeHash: "hash-1",
        watchStatus: "watching",
        watchSignalTarget: 20,
        watchSignalCount: 7,
        regressionCount: 1,
        createdAt: "2026-04-11T09:20:00.000Z",
        updatedAt: "2026-04-11T09:25:00.000Z",
        requestedByActorId: "operator",
        requestedByActorType: "operator",
      },
      attemptManifestSummary: [
        {
          signalId: "sig-1",
          providerId: "openai",
          model: "gpt-5.4",
          outputSummary: "Replay summary",
        },
      ],
    };

    apiMocks.fetchImprovementReports.mockResolvedValue({
      items: [
        {
          reportId: "report-1",
          runId: "run-1",
          summary: {
            sampledDecisions: 1,
            likelyWrongCount: 0,
            wrongnessRate: 0,
            topCauseClasses: [],
            duplicateSuppressedCount: 0,
            improvedCount: 0,
            regressedCount: 0,
          },
          topFindings: [],
          appliedAutoTunes: [],
          queuedRecommendations: [],
          weekOverWeek: { improved: [], regressed: [], unchanged: [] },
          weekStart: "2026-04-07T00:00:00.000Z",
          weekEnd: "2026-04-11T00:00:00.000Z",
          createdAt: "2026-04-11T10:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchImprovementReplayRuns.mockResolvedValue({
      items: [
        {
          runId: "run-1",
          triggerMode: "manual",
          sampleSize: 1,
          windowStart: "2026-04-10T00:00:00.000Z",
          windowEnd: "2026-04-11T00:00:00.000Z",
          status: "completed",
          totalCandidates: 1,
          totalScored: 1,
          likelyWrongCount: 0,
          modelJudgedCount: 0,
          startedAt: "2026-04-11T09:00:00.000Z",
          finishedAt: "2026-04-11T09:10:00.000Z",
        },
      ],
    });
    apiMocks.fetchImprovementReplayRun.mockResolvedValue({
      run: {
        runId: "run-1",
        triggerMode: "manual",
        sampleSize: 1,
        windowStart: "2026-04-10T00:00:00.000Z",
        windowEnd: "2026-04-11T00:00:00.000Z",
        status: "completed",
        totalCandidates: 1,
        totalScored: 1,
        likelyWrongCount: 0,
        modelJudgedCount: 0,
        startedAt: "2026-04-11T09:00:00.000Z",
        finishedAt: "2026-04-11T09:10:00.000Z",
      },
      items: [],
      findings: [],
      autoTunes: [],
    });
    apiMocks.fetchImprovementSignals.mockResolvedValue({
      items: [
        {
          signalId: "sig-1",
          signalKind: "prompt_lab_regression_completed",
          outcome: "negative",
          sourceService: "prompt-pack-service",
          workspaceId: "default",
        },
      ],
    });
    apiMocks.fetchImprovementCandidates.mockResolvedValue({
      items: [
        {
          candidateId: "cand-1",
          kind: "routing_policy",
          status: "ready_for_approval",
          supportingSignalCount: 3,
          targetKey: "pack-routing:provider-balance",
          summary: "Routing candidate summary",
        },
      ],
    });
    apiMocks.fetchImprovementCandidate.mockImplementation(async () => currentCandidateDetail);
    apiMocks.requestImprovementActivation.mockImplementation(async () => {
      currentCandidateDetail = {
        ...currentCandidateDetail,
        candidate: {
          ...(currentCandidateDetail.candidate as Record<string, unknown>),
          status: "approved",
        },
      };
      return currentCandidateDetail.latestActivation as never;
    });
    apiMocks.pauseImprovementActivation.mockImplementation(async () => {
      currentCandidateDetail = {
        ...currentCandidateDetail,
        latestActivation: {
          ...(currentCandidateDetail.latestActivation as Record<string, unknown>),
          status: "paused",
          watchStatus: "paused",
        },
      };
      return currentCandidateDetail.latestActivation as never;
    });
    apiMocks.rollbackImprovementActivation.mockImplementation(async () => {
      currentCandidateDetail = {
        ...currentCandidateDetail,
        latestActivation: {
          ...(currentCandidateDetail.latestActivation as Record<string, unknown>),
          status: "rolled_back",
          watchStatus: "failed",
        },
      };
      return currentCandidateDetail.latestActivation as never;
    });
    apiMocks.runImprovementReplay.mockResolvedValue({
      run: {
        runId: "run-2",
        triggerMode: "manual",
        sampleSize: 1,
        windowStart: "2026-04-10T00:00:00.000Z",
        windowEnd: "2026-04-11T00:00:00.000Z",
        status: "completed",
        totalCandidates: 0,
        totalScored: 0,
        likelyWrongCount: 0,
        modelJudgedCount: 0,
        startedAt: "2026-04-11T10:30:00.000Z",
      },
    });
    apiMocks.draftReplayOverride.mockResolvedValue({ replayRunId: "draft-1", overrides: [] });
    apiMocks.executeReplayOverride.mockResolvedValue({ replayRunId: "draft-2", overrides: [] });
    apiMocks.fetchReplayDiff.mockResolvedValue(null);
    apiMocks.approveImprovementAutoTune.mockResolvedValue({});
    apiMocks.revertImprovementAutoTune.mockResolvedValue({});
  });

  it("renders the candidate drawer with revision, watch, suppression, and Gatehouse link fields", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ImprovementPage workspaceId="default" />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Status ready_for_approval");
      expect(text).toContain("Revision rev-1");
      expect(text).toContain("Activation: active");
      expect(text).toContain("Watch watching");
      expect(text).toContain("Signals 7/20");
      expect(text).toContain("Regressions 1");
      expect(text).toContain("Suppressed until 2026-04-18T10:00:00.000Z");

      const approvalLink = renderer.root.findAll(
        (node) => node.type === "a" && node.props.href === "?space=operate&page=approvals&approvalId=apr-1",
      )[0];
      expect(approvalLink).toBeTruthy();
    } finally {
      renderer.unmount();
    }
  });

  it("requests activation, pauses, and rolls back through the candidate drawer actions", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ImprovementPage workspaceId="default" />);
      });
      await flush();

      await clickButton(renderer, "Request Activation");
      await flush();
      expect(apiMocks.requestImprovementActivation).toHaveBeenCalledWith("cand-1");
      expect(apiMocks.fetchImprovementCandidate).toHaveBeenCalled();

      await clickButton(renderer, "Pause");
      await flush();
      expect(apiMocks.pauseImprovementActivation).toHaveBeenCalledWith("act-1");

      currentCandidateDetail = {
        ...currentCandidateDetail,
        latestActivation: {
          ...(currentCandidateDetail.latestActivation as Record<string, unknown>),
          status: "active",
          watchStatus: "watching",
        },
      };
      await clickButton(renderer, "Rollback");
      await flush();
      expect(apiMocks.rollbackImprovementActivation).toHaveBeenCalledWith("act-1");
    } finally {
      renderer.unmount();
    }
  });
});
