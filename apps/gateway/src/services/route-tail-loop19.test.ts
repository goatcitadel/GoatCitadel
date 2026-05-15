import { describe, expect, it, vi } from "vitest";
import type { AgenticCapabilityAvailability, AgenticDiagnosticSignal } from "@goatcitadel/contracts";
import { buildProviderCapabilityRegistry } from "../orchestration/providers/capability-registry.js";
import { buildOrchestrationPlan, resolveModePolicy, shouldUseModeOrchestration } from "../orchestration/router.js";
import { AgenticImprovementBridgeService } from "./agentic-improvement-bridge-service.js";
import { ApprovalsRouteService } from "./approvals-route-service.js";
import {
  createCronJob,
  deleteCronJob,
  getCronJob,
  getCronRunDiff,
  listCronJobs,
  listCronReviewQueue,
  retryCronReviewQueueItem,
  runCronJobNow,
  setCronJobEnabled,
  updateCronJob,
} from "./cron-scheduler-service.js";
import { DevVerificationRouteService } from "./dev-verification-route-service.js";
import { RuntimeLifecycleExportService } from "./runtime-lifecycle-export-service.js";

describe("Loop 19 route service delegate tails", () => {
  it("keeps approval route calls as thin delegates without reshaping arguments", async () => {
    const approvals = {
      createApproval: vi.fn(async (input: unknown) => ({ method: "createApproval", input })),
      listApprovals: vi.fn((status?: string, limit?: number) => ({ method: "listApprovals", status, limit })),
      resolveApprovalsBulk: vi.fn(async (input: unknown) => ({ method: "resolveApprovalsBulk", input })),
      resolveApproval: vi.fn(async (approvalId: string, input: unknown) => ({
        method: "resolveApproval",
        approvalId,
        input,
      })),
      createApprovalRemoteActionToken: vi.fn((approvalId: string, input: unknown) => ({
        method: "createApprovalRemoteActionToken",
        approvalId,
        input,
      })),
      resolveApprovalWithRemoteToken: vi.fn(async (input: unknown) => ({
        method: "resolveApprovalWithRemoteToken",
        input,
      })),
      getApprovalReplay: vi.fn((approvalId: string, replayedBy?: string) => ({
        method: "getApprovalReplay",
        approvalId,
        replayedBy,
      })),
    };
    const service = new ApprovalsRouteService(approvals as never);

    await expect(service.createApproval({ reason: "review" } as never)).resolves.toEqual({
      method: "createApproval",
      input: { reason: "review" },
    });
    expect(service.listApprovals("pending" as never, 7)).toEqual({
      method: "listApprovals",
      status: "pending",
      limit: 7,
    });
    await expect(service.resolveApprovalsBulk({ approvalIds: ["approval-1"] } as never)).resolves.toEqual({
      method: "resolveApprovalsBulk",
      input: { approvalIds: ["approval-1"] },
    });
    await expect(service.resolveApproval("approval-1", { decision: "approved" } as never)).resolves.toEqual({
      method: "resolveApproval",
      approvalId: "approval-1",
      input: { decision: "approved" },
    });
    expect(service.createApprovalRemoteActionToken("approval-1", { ttlSeconds: 60 } as never)).toEqual({
      method: "createApprovalRemoteActionToken",
      approvalId: "approval-1",
      input: { ttlSeconds: 60 },
    });
    await expect(service.resolveApprovalWithRemoteToken({ token: "remote-token" } as never)).resolves.toEqual({
      method: "resolveApprovalWithRemoteToken",
      input: { token: "remote-token" },
    });
    expect(service.getApprovalReplay("approval-1", "operator")).toEqual({
      method: "getApprovalReplay",
      approvalId: "approval-1",
      replayedBy: "operator",
    });
  });

  it("keeps dev verification calls delegated to the runtime host", async () => {
    async function* stream() {
      yield { type: "delta", delta: "ok" };
    }
    const deps = {
      storage: { marker: "storage" },
      createApproval: vi.fn(async (input: unknown) => ({ approvalId: "approval-1", input })),
      createChatCompletion: vi.fn(async (input: unknown) => ({ id: "completion-1", input })),
      createChatCompletionStream: vi.fn(() => stream()),
      createChatSession: vi.fn((input: unknown) => ({ sessionId: "session-1", input })),
      createWorkspace: vi.fn((input: unknown) => ({ workspaceId: "workspace-1", input })),
      getLlmConfig: vi.fn(() => ({ activeProviderId: "openai" })),
      getProviderSecretStatus: vi.fn((providerId: string) => ({ providerId, hasSecret: true, source: "env" })),
      getRealtimeEventSequenceBounds: vi.fn(() => ({ oldestSequence: 1, newestSequence: 9 })),
      isDevDiagnosticsEnabled: vi.fn(() => true),
      listDevDiagnostics: vi.fn((input?: unknown) => ({ items: [], input })),
      publishRealtime: vi.fn(
        (eventType: string, source: string, payload: Record<string, unknown>, options?: unknown) => ({
          eventType,
          source,
          payload,
          options,
        }),
      ),
    };
    const service = new DevVerificationRouteService(deps as never);

    expect(service.storage).toEqual({ marker: "storage" });
    await expect(service.createApproval({ reason: "verify" } as never)).resolves.toMatchObject({
      approvalId: "approval-1",
    });
    await expect(service.createChatCompletion({ messages: [] } as never)).resolves.toMatchObject({
      id: "completion-1",
    });
    await expect(service.createChatCompletionStream({ messages: [] } as never).next()).resolves.toMatchObject({
      value: { type: "delta", delta: "ok" },
    });
    expect(service.createChatSession({ title: "Verify" } as never)).toMatchObject({ sessionId: "session-1" });
    expect(service.createWorkspace({ name: "Workspace" } as never)).toMatchObject({ workspaceId: "workspace-1" });
    expect(service.getLlmConfig()).toEqual({ activeProviderId: "openai" });
    expect(service.getProviderSecretStatus("openai")).toEqual({
      providerId: "openai",
      hasSecret: true,
      source: "env",
    });
    expect(service.getRealtimeEventSequenceBounds()).toEqual({ oldestSequence: 1, newestSequence: 9 });
    expect(service.isDevDiagnosticsEnabled()).toBe(true);
    expect(service.listDevDiagnostics({ limit: 3 } as never)).toEqual({ items: [], input: { limit: 3 } });
    expect(service.publishRealtime("dev.verification", "test", { ok: true }, { correlationId: "corr-1" })).toEqual({
      eventType: "dev.verification",
      source: "test",
      payload: { ok: true },
      options: { correlationId: "corr-1" },
    });
  });

  it("delegates every cron scheduler wrapper and preserves dry-run/runtime posture arguments", async () => {
    const cronAutomationService = {
      listCronJobs: vi.fn(() => [{ jobId: "job-1" }]),
      getCronJob: vi.fn((jobId: string) => ({ jobId })),
      createCronJob: vi.fn((input: unknown) => ({ created: input })),
      updateCronJob: vi.fn((jobId: string, input: unknown) => ({ jobId, updated: input })),
      setCronJobEnabled: vi.fn((jobId: string, enabled: boolean) => ({ jobId, enabled })),
      deleteCronJob: vi.fn((jobId: string) => ({ deleted: true, jobId })),
      runCronJobNow: vi.fn(async (jobId: string) => ({ jobId, status: "ok" as const })),
      listCronReviewQueue: vi.fn((limit: number) => [{ itemId: "review-1", limit }]),
      retryCronReviewQueueItem: vi.fn((itemId: string) => ({ itemId, retried: true })),
      getCronRunDiff: vi.fn((runId: string) => ({ runId, dryRun: true })),
    };
    const host = { cronAutomationService } as never;

    expect(listCronJobs(host)).toEqual([{ jobId: "job-1" }]);
    expect(getCronJob(host, "job-1")).toEqual({ jobId: "job-1" });
    expect(createCronJob(host, { jobId: "job-2", name: "Job", schedule: "0 * * * *" })).toEqual({
      created: { jobId: "job-2", name: "Job", schedule: "0 * * * *" },
    });
    expect(updateCronJob(host, "job-2", { enabled: false, endAt: null })).toEqual({
      jobId: "job-2",
      updated: { enabled: false, endAt: null },
    });
    expect(setCronJobEnabled(host, "job-2", true)).toEqual({ jobId: "job-2", enabled: true });
    expect(deleteCronJob(host, "job-2")).toEqual({ deleted: true, jobId: "job-2" });
    await expect(runCronJobNow(host, "job-2")).resolves.toEqual({ jobId: "job-2", status: "ok" });
    expect(listCronReviewQueue(host)).toEqual([{ itemId: "review-1", limit: 200 }]);
    expect(listCronReviewQueue(host, 5)).toEqual([{ itemId: "review-1", limit: 5 }]);
    expect(retryCronReviewQueueItem(host, "review-1")).toEqual({ itemId: "review-1", retried: true });
    expect(getCronRunDiff(host, "run-1")).toEqual({ runId: "run-1", dryRun: true });
  });
});

describe("Loop 19 runtime lifecycle export tails", () => {
  it("builds trust reports from fallback routing, failures, unresolved approvals, and optional evidence", async () => {
    const host = {
      getRuntimeLifecycle: vi.fn(async () => ({
        canonical: { sessionId: "session-1", turnId: "turn-2" },
        linked: {
          sessionIds: ["session-1"],
          turnIds: ["turn-1", "turn-2"],
          runIds: ["run-1"],
          approvalIds: ["approval-1"],
          taskIds: ["task-1"],
        },
        session: { sessionId: "session-1", displayName: "Coverage Session" },
        sessionSummary: { lastMessagePreview: "fallback title" },
        turns: [
          { turnId: "turn-1", model: "gpt-5-mini" },
          {
            turnId: "turn-2",
            model: "gpt-5.4",
            failure: { message: "tool failed" },
            routing: {
              primaryProviderId: "openai",
              primaryModel: "gpt-5.4",
              effectiveProviderId: "anthropic",
              effectiveModel: "claude-sonnet-4-6",
              fallbackUsed: true,
              fallbackReason: "primary timeout",
            },
          },
        ],
        toolRuns: [{ toolRunId: "tool-1", toolName: "browser.search", status: "failed", approvalId: "approval-1" }],
        executionPlans: [{ planId: "plan-1" }],
        delegationRuns: [{ runId: "delegation-1" }],
        delegationSteps: [{ stepId: "step-1", error: "partial result" }],
        proactiveRuns: [{ runId: "proactive-1" }],
        approvalEffects: [{ effectId: "effect-1" }],
        approval: { approvalId: "approval-1", status: "pending", kind: "tool", riskLevel: "medium" },
      })),
      getTranscript: vi.fn(async () => [{ eventId: "event-1" }]),
      listSessionTimeline: vi.fn(async (_sessionId: string, limit: number) => [{ timelineId: "timeline-1", limit }]),
    };
    const service = new RuntimeLifecycleExportService(host as never);

    const bundle = await service.exportBundle({
      sessionId: "session-1",
      includeTranscript: true,
      includeTimeline: true,
      timelineLimit: 5000,
      format: "trust_report",
    });

    expect(host.getRuntimeLifecycle).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: undefined,
      runId: undefined,
      approvalId: undefined,
      taskId: undefined,
    });
    expect(host.listSessionTimeline).toHaveBeenCalledWith("session-1", 1000);
    expect(bundle.stats).toMatchObject({
      linkedSessionCount: 1,
      linkedTurnCount: 2,
      linkedRunCount: 1,
      linkedApprovalCount: 1,
      linkedTaskCount: 1,
      turnCount: 2,
      toolRunCount: 1,
      executionPlanCount: 1,
      delegationRunCount: 1,
      delegationStepCount: 1,
      proactiveRunCount: 1,
      approvalEffectCount: 1,
      transcriptEventCount: 1,
      timelineEventCount: 1,
    });
    expect(bundle.trustReport).toMatchObject({
      title: "Coverage Session",
      modelProvider: {
        requestedProviderId: "openai",
        requestedModel: "gpt-5.4",
        effectiveProviderId: "anthropic",
        effectiveModel: "claude-sonnet-4-6",
        fallbackUsed: true,
        fallbackReason: "primary timeout",
      },
    });
    expect(bundle.trustReport?.failures).toEqual(["Turn turn-2: tool failed", "Delegation step-1: partial result"]);
    expect(bundle.trustReport?.openRisks).toEqual(
      expect.arrayContaining([
        "A linked approval still needs operator review.",
        "The run contains failures or partial execution evidence.",
      ]),
    );
    expect(bundle.trustReport?.shareableMarkdown).toContain("## Open Risks");
  });

  it("uses title fallbacks and treats approved, rejected, and edited approvals as resolved", async () => {
    const statuses = ["approved", "rejected", "edited"] as const;
    for (const status of statuses) {
      const service = new RuntimeLifecycleExportService({
        getRuntimeLifecycle: vi.fn(async () => ({
          canonical: { sessionId: "session-1" },
          linked: { sessionIds: [], turnIds: [], runIds: [], approvalIds: [], taskIds: [] },
          sessionSummary: { lastMessagePreview: "Summary title" },
          turns: [],
          toolRuns: [],
          approval: { approvalId: "approval-1", status, kind: "tool", riskLevel: "low" },
        })),
        getTranscript: vi.fn(),
        listSessionTimeline: vi.fn(),
      } as never);

      const bundle = await service.exportBundle({ sessionId: "session-1", format: "trust_report", timelineLimit: 0 });

      expect(bundle.trustReport?.title).toBe("Summary title");
      expect(bundle.trustReport?.openRisks).toEqual([
        "Transcript was not included in this export.",
        "Timeline was not included in this export.",
      ]);
    }
  });

  it("falls back to canonical ids and default trust-report copy when no runtime evidence is linked", async () => {
    const service = new RuntimeLifecycleExportService({
      getRuntimeLifecycle: vi.fn(async () => ({
        canonical: { sessionId: "session-fallback" },
        linked: { sessionIds: [], turnIds: [], runIds: [], approvalIds: [], taskIds: [] },
        turns: [{ turnId: "turn-1", model: "fallback-model", routing: {} }],
        toolRuns: [],
      })),
      getTranscript: vi.fn(),
      listSessionTimeline: vi.fn(),
    } as never);

    const bundle = await service.exportBundle({ sessionId: "session-fallback", format: "trust_report" });

    expect(bundle.trustReport?.title).toBe("session-fallback");
    expect(bundle.trustReport?.modelProvider).toMatchObject({
      requestedModel: "fallback-model",
      effectiveModel: "fallback-model",
      fallbackUsed: false,
    });
    expect(bundle.trustReport?.approvals).toEqual([]);
    expect(bundle.trustReport?.shareableMarkdown).toContain("No failures were linked to this export.");
    expect(bundle.trustReport?.shareableMarkdown).toContain("Transcript was not included in this export.");

    const untitledService = new RuntimeLifecycleExportService({
      getRuntimeLifecycle: vi.fn(async () => ({
        canonical: {},
        linked: { sessionIds: [], turnIds: [], runIds: [], approvalIds: [], taskIds: [] },
        turns: [],
        toolRuns: [],
      })),
      getTranscript: vi.fn(),
      listSessionTimeline: vi.fn(),
    } as never);
    const untitled = await untitledService.exportBundle({ format: "trust_report" } as never);
    expect(untitled.trustReport?.title).toBe("Runtime run");
  });
});

describe("Loop 19 orchestration and improvement bridge tails", () => {
  function createRouterInput(overrides: Record<string, unknown> = {}) {
    const runtime = {
      activeProviderId: "openai",
      activeModel: "gpt-5-mini",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          defaultModel: "gpt-5-mini",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          hasApiKey: true,
          apiKeySource: "env",
        },
        {
          providerId: "fast",
          label: "Fast",
          defaultModel: "fast-model",
          baseUrl: "https://fast.example.test",
          apiStyle: "openai-chat-completions",
          hasApiKey: true,
          apiKeySource: "env",
        },
      ],
    };
    const prefs = {
      sessionId: "session-1",
      mode: "chat",
      planningMode: "off",
      providerId: undefined,
      model: undefined,
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      visionFallbackModel: undefined,
      orchestrationEnabled: true,
      orchestrationIntensity: "balanced",
      orchestrationVisibility: "explicit",
      orchestrationProviderPreference: "balanced",
      orchestrationReviewDepth: "standard",
      orchestrationParallelism: "parallel",
      codeAutoApply: "review_required",
      proactiveMode: "off",
      retrievalMode: "standard",
      reflectionMode: "off",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    };
    const task = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "chat",
      objective: "Review the plan.",
      prefs,
      conversation: [],
      historyMessages: [],
      ...overrides,
    };
    return {
      task,
      runtime,
      capabilities: buildProviderCapabilityRegistry(runtime as never),
      policy: resolveModePolicy(task.mode as never),
    };
  }

  it("keeps disabled orchestration off and normalizes route defaults", () => {
    expect(
      shouldUseModeOrchestration(
        createRouterInput({
          prefs: { ...createRouterInput().task.prefs, orchestrationEnabled: false },
        }) as never,
      ),
    ).toBe(false);

    const input = createRouterInput({
      mode: "code",
      objective: "Implement, review, and QA the patch.",
      prefs: {
        ...createRouterInput().task.prefs,
        mode: "code",
        providerId: "missing-provider",
        model: "manual-model",
        orchestrationProviderPreference: "speed",
      },
    });
    input.policy = { ...resolveModePolicy("code"), allowParallelWorkers: false, maxVisibleVisibility: "summarized" };

    const plan = buildOrchestrationPlan(input as never);

    expect(plan.routeDecision.visibility).toBe("summarized");
    expect(plan.routeDecision.parallelism).toBe("sequential");
    expect(plan.routeDecision.triggerReason).toBe("code_specialist_flow");
    expect(plan.steps.map((step) => step.label)).toEqual(["Planner", "Coder", "Reviewer", "QA", "Synthesizer"]);
    expect(plan.steps.every((step) => step.providerId === "missing-provider")).toBe(true);
    expect(plan.steps.every((step) => step.model === "manual-model")).toBe(true);
  });

  it("covers review-only proposal variants without silently widening callable surface", () => {
    const service = new AgenticImprovementBridgeService();
    const repeatedDiagnostic: AgenticDiagnosticSignal = {
      signalId: "diag-loop",
      code: "post_compaction_loop",
      severity: "warning",
      title: "Loop after compaction",
      summary: "The run repeated a completed tool result.",
      createdAt: "2026-05-14T00:00:00.000Z",
    };
    const unavailableCapability: AgenticCapabilityAvailability = {
      capabilityId: "plugin:search",
      label: "Search Plugin",
      family: "plugin",
      status: "unavailable",
      callable: false,
      reasons: [],
      checkedAt: "2026-05-14T00:00:00.000Z",
    };
    const channelCapability: AgenticCapabilityAvailability = {
      capabilityId: "channel:slack",
      label: "Slack",
      family: "channel",
      status: "inspectable",
      callable: false,
      reasons: ["approval required"],
      checkedAt: "2026-05-14T00:00:00.000Z",
    };

    expect(service.fromAgenticDiagnostic({ diagnostic: repeatedDiagnostic }).proposedChange).toContain("loop guard");
    expect(service.fromMissingCapability({ capability: unavailableCapability })).toMatchObject({
      risk: "medium",
      callableImpact: "widens_after_approval",
      evidence: [expect.objectContaining({ source: "plugin" })],
    });
    expect(service.fromMissingCapability({ capability: channelCapability })).toMatchObject({
      risk: "low",
      evidence: [expect.objectContaining({ source: "channel" })],
    });
    expect(
      service.fromPromptLabInvalidRun({
        run: {
          runId: "run-ok-invalid",
          packId: "pack-1",
          testId: "test-1",
          status: "completed",
          integrity: { validationStatus: "invalid", signals: [] },
          startedAt: "2026-05-14T00:00:00.000Z",
        } as never,
      }).risk,
    ).toBe("low");
    expect(
      service.fromAgenticDiagnostic({
        diagnostic: {
          signalId: "diag-generic",
          code: "unexpected_state",
          severity: "info",
          title: "Unexpected state",
          summary: "A generic diagnostic needs review.",
          createdAt: "2026-05-14T00:00:00.000Z",
        } as never,
        runId: "   ",
      }),
    ).toMatchObject({
      risk: "low",
      callableImpact: "none",
      proposedChange: expect.stringContaining("unexpected_state handling path"),
    });
    expect(
      service.fromMissingCapability({
        capability: {
          capabilityId: "skill:research",
          label: "Research skill",
          family: "skill",
          status: "inspectable",
          callable: false,
          reasons: [],
          checkedAt: "2026-05-14T00:00:00.000Z",
        },
      }),
    ).toMatchObject({
      evidence: [expect.objectContaining({ source: "skill_evaluation" })],
      proposedChange: expect.stringContaining("smallest approved exposure change"),
    });
    expect(
      service.fromRepeatedFailure({
        failureId: "failure-two",
        failureClass: "transient",
        observedIssue: "Failed twice.",
        count: 2,
        sampleRefs: ["sample-1", "sample-1", "   "],
        proposedChange: "Use a smaller retry window.",
      }),
    ).toMatchObject({
      risk: "medium",
      proposedChange: "Use a smaller retry window.",
      evidence: [
        expect.objectContaining({ sourceId: "failure-two" }),
        expect.objectContaining({ sourceId: "sample-1" }),
      ],
    });
  });
});
