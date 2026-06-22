import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { OpsQualitySnapshotResponse } from "@goatcitadel/contracts";
import {
  deriveCoworkTaskContinuation,
  formatArtifactProvenance,
  formatKnowledgeCitationAction,
  formatKnowledgeCitationSummary,
  NativeRoutePages,
} from "./NativeRoutePages";

const mocks = vi.hoisted(() => ({
  fetchTasksByView: vi.fn(async (view: "active" | "trash") => ({
    view,
    items:
      view === "active"
        ? [
            {
              taskId: "task-1",
              title: "Review release notes",
              description: "Confirm the current 1.0 evidence.",
              status: "planning",
              priority: "normal",
              createdAt: "2026-05-02T18:00:00.000Z",
              updatedAt: "2026-05-02T18:00:00.000Z",
            },
          ]
        : [],
  })),
  fetchAgenticRuns: vi.fn(async () => ({ items: [] })),
  exportLlmEvalProofRuns: vi.fn(async () => ({
    version: "llm.eval_proof_export.v1",
    generatedAt: "2026-05-02T20:05:00.000Z",
    format: "json",
    contentType: "application/json",
    filename: "goatcitadel-llm-eval-proof-2026-05-02T20-05-00-000Z.json",
    sourceEndpoint: "/api/v1/llm/eval-proof?limit=50",
    posture: {
      readOnly: true,
      sideEffectPosture: "audit_only",
      note: "read-only",
    },
    runs: [],
    content: '{"version":"llm.eval_proof_export.v1"}',
  })),
  fetchLlmEvalProofRuns: vi.fn(async () => ({
    generatedAt: "2026-05-02T20:00:00.000Z",
    items: [
      {
        runId: "eval-proof-1",
        promptHash: "abcdef1234567890",
        status: "completed",
        createdAt: "2026-05-02T19:00:00.000Z",
        candidates: [{ providerId: "openai", model: "gpt-5", qualityScore: 0.91 }],
        results: [
          {
            providerId: "openai",
            model: "gpt-5",
            qualityScore: 0.91,
            measurementSource: "live",
            qualityScoreSource: "operator",
            latencyMs: 1200,
            estimatedCostUsd: 0.04,
            paretoOptimal: true,
            notes: ["strong quality frontier"],
          },
        ],
        warnings: [],
      },
    ],
  })),
  fetchOpsQualitySnapshot: vi.fn(async () => ({
    version: "ops.quality_snapshot.v1",
    generatedAt: "2026-05-02T20:00:00.000Z",
    sourceEndpoint: "/api/v1/ops/quality",
    posture: {
      readOnly: true,
      sideEffectPosture: "audit_only",
      note: "stored evidence",
    },
    metricScope: {
      scope: "bounded_read",
      promptPackLimit: 200,
      evalRunLimit: 25,
      note: "bounded read",
    },
    metrics: {
      promptPackCount: 1,
      promptPackTestCount: 18,
      redTeamPackCount: 1,
      redTeamTestCount: 18,
      evalRunCount: 1,
      paretoModelCount: 1,
      securityGateCount: 1,
      passingSecurityGateCount: 0,
      securityExecutionReadyCount: 0,
      securityExecutionBlockedCount: 1,
      designQualityCheckCount: 4,
      designQualityBlockingCount: 0,
    },
    promptPacks: {
      state: "available",
      items: [
        {
          packId: "pack-1",
          name: "Security Red Team",
          testCount: 18,
          sourceLabel: "goatcitadel_prompt_pack_v6_security_red_team.md",
        },
      ],
    },
    evalProof: {
      state: "available",
      items: [
        {
          runId: "eval-proof-1",
          promptHash: "abcdef1234567890",
          status: "completed",
          createdAt: "2026-05-02T19:00:00.000Z",
          candidates: [{ providerId: "openai", model: "gpt-5", qualityScore: 0.91 }],
          results: [
            {
              providerId: "openai",
              model: "gpt-5",
              qualityScore: 0.91,
              measurementSource: "live",
              qualityScoreSource: "operator",
              latencyMs: 1200,
              estimatedCostUsd: 0.04,
              paretoOptimal: true,
              notes: ["strong quality frontier"],
            },
          ],
          warnings: [],
        },
      ],
    },
    securityEvalPacks: {
      state: "available",
      warnings: [
        "Security eval packs are definitions and stored evidence only; this projection does not call providers or run tests.",
      ],
      items: [
        {
          packKey: "security-red-team-v6",
          title: "Defensive Security Evaluation",
          sourceLabel: "goatcitadel_prompt_pack_v6_security_red_team.md",
          status: "available",
          testCount: 18,
          modeCounts: { chat: 6, cowork: 6, code: 6 },
          toolTierCounts: { "no-tools": 6, "implicit-tools": 6, "explicit-tools": 6 },
          capabilityTargets: ["prompt-injection", "tool-governance"],
          likelyFailureClasses: ["unsafe_tool_use"],
          safetyPosture: {
            definitionOnly: true,
            requiresOperatorRun: true,
            callsProviders: false,
            mutationPerformed: false,
            note: "definition only",
          },
          blockers: ["Import this prompt pack before it can produce run, score, or benchmark evidence."],
        },
      ],
    },
    securityQualityGates: {
      state: "available",
      warnings: ["Security quality gates are read-only projections from stored prompt-pack reports."],
      items: [
        {
          gateId: "prompt-pack:security-red-team-v6:security-quality",
          packKey: "security-red-team-v6",
          title: "Defensive Security Evaluation gate",
          status: "needs_score",
          releaseGate: true,
          readOnly: true,
          packId: "pack-1",
          reportEndpoint: "/api/v1/prompt-packs/pack-1/report",
          generatedAt: "2026-05-02T20:00:00.000Z",
          evidence: {
            definitionStatus: "imported",
            testCount: 18,
            completedRuns: 12,
            failedRuns: 2,
            needsScoreCount: 3,
            passCount: 8,
            failCount: 2,
            reviewCount: 2,
            effectivePassRate: 0.67,
            passThreshold: 75,
            failingCodes: ["SEC-003", "SEC-007"],
          },
          blockers: ["Score all completed defensive security runs before treating this gate as release evidence."],
          nextActions: ["Auto-score or human-review every completed defensive security run."],
          posture: {
            callsProviders: false,
            mutationPerformed: false,
            source: "stored_prompt_pack_report",
            note: "stored evidence",
          },
        },
      ],
    },
    securityExecution: {
      state: "available",
      warnings: [
        "Security execution depth is computed from stored defensive-security prompt-pack reports; it does not run providers or score tests.",
      ],
      items: [
        {
          packKey: "security-red-team-v6",
          title: "Defensive Security Evaluation",
          state: "scoring_required",
          importedPackId: "pack-1",
          testCount: 18,
          completedRuns: 12,
          failedRuns: 2,
          needsScoreCount: 3,
          passCount: 8,
          failCount: 2,
          reviewCount: 2,
          runCoverage: 0.67,
          scoredCoverage: 0.5,
          effectivePassRate: 0.67,
          passThreshold: 75,
          modeCounts: { chat: 6, cowork: 6, code: 6 },
          toolTierCounts: { "no-tools": 6, "implicit-tools": 6, "explicit-tools": 6 },
          capabilityTargets: ["prompt-injection", "tool-governance"],
          likelyFailureClasses: ["unsafe_tool_use"],
          failingCodes: ["SEC-003", "SEC-007"],
          blockers: ["Score all completed defensive security runs before treating this gate as release evidence."],
          nextActions: ["Auto-score or human-review every completed defensive security run."],
          posture: {
            readOnly: true,
            sideEffectPosture: "audit_only",
            source: "stored_prompt_pack_report",
            callsProviders: false,
            mutationPerformed: false,
            note: "stored evidence only",
          },
        },
      ],
    },
    designQuality: {
      state: "available",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        source: "repo_files",
        callsProviders: false,
        mutationPerformed: false,
        note: "Design quality evidence reads repo files only.",
      },
      summary: {
        totalChecks: 4,
        passingCount: 3,
        advisoryCount: 1,
        blockingCount: 0,
        unknownCount: 0,
        p0Count: 0,
        p1Count: 1,
        p2Count: 0,
        p3Count: 3,
      },
      checks: [
        {
          id: "design-intelligence.modules",
          label: "Design-intelligence module integrity",
          severity: "P3",
          status: "passing",
          owner: "skills/bundled/design-intelligence",
          evidence: "skills/bundled/design-intelligence",
        },
        {
          id: "skills.routing-hints.design-quality",
          label: "Design-quality routing hints",
          severity: "P3",
          status: "passing",
          owner: "packages/skills",
          evidence: "packages/skills/src/routing-hints.generated.ts",
        },
        {
          id: "mission-control.anti-slop.scan",
          label: "Calibrated anti-slop scan",
          severity: "P1",
          status: "advisory",
          owner: "mission-control-next",
          evidence: "apps/mission-control-next/src",
          nextAction: "Review token-backed intent for anti-slop hits.",
        },
        {
          id: "design-quality.proof-lanes",
          label: "Design proof lanes are wired",
          severity: "P3",
          status: "passing",
          owner: "scripts",
          evidence: "package.json",
        },
      ],
      warnings: ["Design quality advisories are calibrated signals, not release blockers unless promoted to P0."],
    },
    warnings: ["Security quality gates are read-only projections from stored prompt-pack reports."],
    nextChecks: [
      {
        label: "Prompt gates",
        command: "pnpm prompt:gates",
        reason: "Run targeted prompt-pack gates for behavior changes that affect Chat, Cowork, or Code.",
      },
      {
        label: "Runtime truth",
        command: "pnpm verify:runtime:truth",
        reason: "Use runtime truth for gateway/durable/API changes.",
      },
      {
        label: "Surface regression",
        command: "pnpm verify:surface:regression",
        reason: "Use surface regression for visible operator route changes.",
      },
      {
        label: "Design quality",
        command: "pnpm verify:design:quality",
        reason: "Use the read-only design-quality checker.",
      },
      {
        label: "Visual regression",
        command: "pnpm verify:visual:regression",
        reason: "Use visual regression for visible layout or baseline-sensitive changes.",
      },
    ],
  })),
  fetchOperators: vi.fn(async () => ({ items: [] })),
  fetchPromptPacks: vi.fn(async () => ({
    items: [
      {
        packId: "pack-1",
        name: "Security Red Team",
        testCount: 18,
        sourceLabel: "goatcitadel_prompt_pack_v6_security_red_team.md",
      },
    ],
  })),
  fetchPromptPackReport: vi.fn(async () => ({
    pack: {
      packId: "pack-1",
      name: "Security Red Team",
      testCount: 18,
      sourceLabel: "goatcitadel_prompt_pack_v6_security_red_team.md",
      createdAt: "2026-05-02T18:00:00.000Z",
      updatedAt: "2026-05-02T20:00:00.000Z",
    },
    tests: [],
    runs: [],
    scores: [],
    autoScoresV2: [],
    humanReviewsV2: [],
    latestAssessments: [],
    summary: {
      totalTests: 18,
      completedRuns: 12,
      failedRuns: 2,
      runFailureCount: 2,
      invalidLatestRuns: 1,
      scoreFailureCount: 0,
      needsScoreCount: 3,
      staleLatestAutoScoreCount: 1,
      judgeFallbackCount: 1,
      judgeErrorCount: 0,
      autoScoredRuns: 9,
      humanReviewedRuns: 2,
      degradedScoreCount: 1,
      passCount: 8,
      failCount: 2,
      reviewCount: 2,
      effectivePassRate: 0.67,
      reviewRate: 0.17,
      activeScoringSchemaVersion: "v3",
      passThreshold: 75,
      averageTotalScore: 72,
      averageWeightedScore: 78,
      passRate: 0.67,
      failingCodes: ["SEC-003", "SEC-007"],
    },
  })),
  fetchPromptPackExport: vi.fn(async () => ({
    packId: "pack-1",
    path: "artifacts/prompt-packs/latest/security-red-team.json",
    exists: true,
    sizeBytes: 2048,
    updatedAt: "2026-05-02T20:00:00.000Z",
    latestSnapshotPath: "artifacts/prompt-packs/archive/security-red-team-2026-05-02.json",
    latestSnapshotExists: true,
    latestSnapshotSizeBytes: 4096,
    latestSnapshotUpdatedAt: "2026-05-02T20:05:00.000Z",
    snapshotCount: 4,
  })),
  fetchPromptPackBuiltins: vi.fn(async () => ({
    generatedAt: "2026-05-02T20:00:00.000Z",
    warnings: [
      "Security eval packs are definitions and stored evidence only; this projection does not call providers or run tests.",
    ],
    items: [
      {
        packKey: "security-red-team-v6",
        title: "Defensive Security Evaluation",
        sourceLabel: "goatcitadel_prompt_pack_v6_security_red_team.md",
        status: "available",
        testCount: 18,
        modeCounts: { chat: 6, cowork: 6, code: 6 },
        toolTierCounts: { "no-tools": 6, "implicit-tools": 6, "explicit-tools": 6 },
        capabilityTargets: ["prompt-injection", "tool-governance"],
        likelyFailureClasses: ["unsafe_tool_use"],
        safetyPosture: {
          definitionOnly: true,
          requiresOperatorRun: true,
          callsProviders: false,
          mutationPerformed: false,
          note: "definition only",
        },
        blockers: ["Import this prompt pack before it can produce run, score, or benchmark evidence."],
      },
    ],
  })),
  fetchPromptPackSecurityGates: vi.fn(async () => ({
    generatedAt: "2026-05-02T20:00:00.000Z",
    warnings: ["Security quality gates are read-only projections from stored prompt-pack reports."],
    items: [
      {
        gateId: "prompt-pack:security-red-team-v6:security-quality",
        packKey: "security-red-team-v6",
        title: "Defensive Security Evaluation gate",
        status: "needs_score",
        releaseGate: true,
        readOnly: true,
        packId: "pack-1",
        reportEndpoint: "/api/v1/prompt-packs/pack-1/report",
        generatedAt: "2026-05-02T20:00:00.000Z",
        evidence: {
          definitionStatus: "imported",
          testCount: 18,
          completedRuns: 12,
          failedRuns: 2,
          needsScoreCount: 3,
          passCount: 8,
          failCount: 2,
          reviewCount: 2,
          effectivePassRate: 0.67,
          passThreshold: 75,
          failingCodes: ["SEC-003", "SEC-007"],
        },
        blockers: ["Score all completed defensive security runs before treating this gate as release evidence."],
        nextActions: ["Auto-score or human-review every completed defensive security run."],
        posture: {
          callsProviders: false,
          mutationPerformed: false,
          source: "stored_prompt_pack_report",
          note: "stored evidence",
        },
      },
    ],
  })),
  importBuiltinPromptPack: vi.fn(async () => ({
    pack: {
      packId: "security-red-team-v6",
      name: "Defensive Security Evaluation",
      testCount: 18,
      sourceLabel: "goatcitadel_prompt_pack_v6_security_red_team.md",
    },
    tests: Array.from({ length: 18 }, (_, index) => ({ testId: `test-${index + 1}` })),
  })),
  fetchTaskDeliverables: vi.fn(async () => ({ items: [] })),
  createTask: vi.fn(async () => ({
    taskId: "task-2",
    title: "New task",
    status: "planning",
    priority: "high",
    createdAt: "2026-05-02T18:10:00.000Z",
    updatedAt: "2026-05-02T18:10:00.000Z",
  })),
  updateTask: vi.fn(async () => ({
    taskId: "task-1",
    title: "Review release notes",
    status: "done",
    priority: "high",
    createdAt: "2026-05-02T18:00:00.000Z",
    updatedAt: "2026-05-02T18:15:00.000Z",
  })),
  addTaskDeliverable: vi.fn(async () => ({
    deliverableId: "deliverable-1",
    taskId: "task-1",
    deliverableType: "artifact",
    title: "Release evidence",
    createdAt: "2026-05-02T18:20:00.000Z",
  })),
  deleteTask: vi.fn(async () => ({ deleted: true, taskId: "task-1", mode: "soft" })),
  restoreTask: vi.fn(async () => ({ restored: true, taskId: "task-1" })),
  fetchChatGeneratedArtifacts: vi.fn(async () => ({
    items: [
      {
        artifactId: "artifact-1",
        sessionId: "session-1",
        workspaceId: "default",
        turnId: "turn-1",
        title: "Cowork synthesis",
        kind: "markdown",
        content: "# Result",
        sourceSurface: "cowork",
        version: 2,
        providerId: "openai",
        model: "gpt-5",
        contentHash: "hash-1",
        createdAt: "2026-05-02T19:00:00.000Z",
        updatedAt: "2026-05-02T19:05:00.000Z",
      },
    ],
  })),
  fetchSkillActivationPolicies: vi.fn(async () => ({
    policies: [],
    guardedAutoThreshold: 0.9,
    requireFirstUseConfirmation: true,
  })),
  fetchSkillImportHistory: vi.fn(async () => ({ items: [] })),
  fetchSkillSources: vi.fn(async () => ({ items: [] })),
  fetchSkills: vi.fn(async () => ({
    items: [
      {
        skillId: "skill-safe-improvement",
        name: "Safe improvement",
        state: "enabled",
        callable: true,
        source: "bundled",
        requires: [],
        declaredTools: [],
        instructionBody: "Review evidence before changing skills.",
        dir: "skills/safe-improvement",
      },
    ],
  })),
  fetchSkillEvaluations: vi.fn(async () => ({
    items: [
      {
        runId: "eval-1",
        skillId: "skill-safe-improvement",
        skillName: "Safe improvement",
        status: "proposal_created",
        targetPassRate: 0.8,
        baselineResult: { score: { passRate: 0.5 } },
        candidateResult: { score: { passRate: 0.8 } },
        improvementDelta: 0.3,
        accepted: true,
        scenarios: [],
        criteria: [],
        mutation: { summary: "Tighten evidence review.", patchPreview: "- old\n+ new" },
        operatorTruth: "Review-first.",
        improvementCandidateId: "candidate-review-1",
        proposalId: "proposal-1",
        updatedAt: "2026-05-02T19:00:00.000Z",
      },
    ],
  })),
  fetchCapabilityProposal: vi.fn(async () => ({
    proposal: {
      proposalId: "proposal-1",
      proposalKind: "skill",
      status: "approved",
      title: "Review skill revision",
      summary: "Proposal summary.",
      candidateId: "candidate-review-1",
      activationTargetId: "skill-safe-improvement",
      payload: {
        observedIssue: "Repeated failures need skill maintenance.",
        proposedChange: "Rewrite the skill evidence step.",
        evidenceRefs: [{ refType: "skill_evaluation_run", refId: "eval-1" }],
      },
      createdAt: "2026-05-02T19:00:00.000Z",
      updatedAt: "2026-05-02T19:00:00.000Z",
    },
    events: [],
  })),
  fetchCuratorReviewItem: vi.fn(async () => ({
    candidate: {
      candidateId: "candidate-review-1",
      workspaceId: "default",
      kind: "skill_revision",
      status: "approved",
      targetKey: "skill-safe-improvement",
      fingerprint: "fp",
      summary: "Skill proposal summary.",
      currentRevisionId: "rev-1",
      supportingSignalCount: 2,
      negativeSignalCount: 1,
      createdAt: "2026-05-02T19:00:00.000Z",
      updatedAt: "2026-05-02T19:00:00.000Z",
    },
    currentRevision: {
      revisionId: "rev-1",
      candidateId: "candidate-review-1",
      candidateRef: { refType: "skill", refId: "skill-safe-improvement" },
      changeHash: "hash-1",
      createdAt: "2026-05-02T19:00:00.000Z",
      createdByActorId: "system",
      createdByActorType: "system",
    },
    evidence: [{ refType: "skill_evaluation_run", refId: "eval-1" }],
    risk: "medium",
    rollbackRef: "snapshot-1",
    observedIssue: "Repeated failures need skill maintenance.",
    proposedChange: "Rewrite the skill evidence step.",
    callableImpact: "narrows",
    approvalRequired: true,
    mutationApplied: false,
    runtimeProvenCallable: true,
    corruptionStatus: "clean",
    actionStatuses: {
      validate: "ready",
      approve: "ready",
      reject: "ready",
      snooze: "ready",
      activate: "blocked",
      promote: "blocked",
    },
    disabledReasons: {
      activate: "Skill revisions promote through capability proposals.",
      promote: "Capability proposal promotion is approval-gated and not applied silently.",
    },
  })),
  validateImprovementCandidate: vi.fn(async () => ({
    action: "validate",
    status: "validated",
    review: {
      candidate: {
        candidateId: "candidate-review-1",
        workspaceId: "default",
        kind: "skill_revision",
        status: "approved",
        targetKey: "skill-safe-improvement",
        fingerprint: "fp",
        summary: "Skill proposal summary.",
        currentRevisionId: "rev-1",
        supportingSignalCount: 2,
        negativeSignalCount: 1,
        createdAt: "2026-05-02T19:00:00.000Z",
        updatedAt: "2026-05-02T19:00:00.000Z",
      },
      evidence: [{ refType: "skill_evaluation_run", refId: "eval-1" }],
      risk: "medium",
      rollbackRef: "snapshot-1",
      observedIssue: "Repeated failures need skill maintenance.",
      proposedChange: "Rewrite the skill evidence step.",
      callableImpact: "narrows",
      approvalRequired: true,
      mutationApplied: false,
      runtimeProvenCallable: true,
      corruptionStatus: "clean",
      actionStatuses: {
        validate: "ready",
        approve: "ready",
        reject: "ready",
        snooze: "ready",
        activate: "blocked",
        promote: "blocked",
      },
      disabledReasons: {
        activate: "Skill revisions promote through capability proposals.",
        promote: "Capability proposal promotion is approval-gated and not applied silently.",
      },
    },
    mutationApplied: false,
  })),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@goatcitadel/mission-control-shared/api/client")>(
    "@goatcitadel/mission-control-shared/api/client",
  );
  return {
    ...actual,
    addTaskDeliverable: mocks.addTaskDeliverable,
    createTask: mocks.createTask,
    deleteTask: mocks.deleteTask,
    exportLlmEvalProofRuns: mocks.exportLlmEvalProofRuns,
    fetchOperators: mocks.fetchOperators,
    fetchLlmEvalProofRuns: mocks.fetchLlmEvalProofRuns,
    fetchOpsQualitySnapshot: mocks.fetchOpsQualitySnapshot,
    fetchPromptPacks: mocks.fetchPromptPacks,
    fetchPromptPackExport: mocks.fetchPromptPackExport,
    fetchPromptPackReport: mocks.fetchPromptPackReport,
    fetchPromptPackBuiltins: mocks.fetchPromptPackBuiltins,
    fetchPromptPackSecurityGates: mocks.fetchPromptPackSecurityGates,
    importBuiltinPromptPack: mocks.importBuiltinPromptPack,
    fetchChatGeneratedArtifacts: mocks.fetchChatGeneratedArtifacts,
    fetchAgenticRuns: mocks.fetchAgenticRuns,
    fetchTaskDeliverables: mocks.fetchTaskDeliverables,
    fetchTasksByView: mocks.fetchTasksByView,
    restoreTask: mocks.restoreTask,
    updateTask: mocks.updateTask,
    fetchCapabilityProposal: mocks.fetchCapabilityProposal,
    fetchCuratorReviewItem: mocks.fetchCuratorReviewItem,
    fetchSkillActivationPolicies: mocks.fetchSkillActivationPolicies,
    fetchSkillEvaluations: mocks.fetchSkillEvaluations,
    fetchSkillImportHistory: mocks.fetchSkillImportHistory,
    fetchSkills: mocks.fetchSkills,
    fetchSkillSources: mocks.fetchSkillSources,
    validateImprovementCandidate: mocks.validateImprovementCandidate,
  };
});

describe("NativeRoutePages Cowork task board", () => {
  it("derives a clear continuation cue from blockers, selected tasks, and deliverables", () => {
    const summary = deriveCoworkTaskContinuation({
      tasks: [
        {
          taskId: "task-blocked",
          title: "Validate source freshness",
          status: "blocked",
          priority: "high",
          createdAt: "2026-05-02T18:00:00.000Z",
          updatedAt: "2026-05-02T18:00:00.000Z",
        } as any,
      ],
      deletedTasks: [],
      selectedTask: {
        taskId: "task-blocked",
        title: "Validate source freshness",
        status: "blocked",
        priority: "high",
        createdAt: "2026-05-02T18:00:00.000Z",
        updatedAt: "2026-05-02T18:00:00.000Z",
      } as any,
      deliverables: [{ deliverableId: "deliverable-1", title: "Evidence", deliverableType: "artifact" } as any],
    });

    expect(summary.nextActionLabel).toBe("Clear blocker");
    expect(summary.firstBlockedTaskId).toBe("task-blocked");
    expect(summary.hierarchyDetail).toContain("1 deliverable attached");
    expect(summary.boardTruth).toContain("does not bypass approvals");
  });

  it("renders a Cowork execution glance before task editing controls", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderCoworkTasks();
    });

    const text = collectText(renderer!.root);
    expect(text).toContain("Execution at a glance");
    expect(text).toContain("Phase timeline");
    expect(text).toContain("Current phase");
    expect(text).toContain("Last checkpoint");
    expect(text).toContain("Next checkpoint");
    expect(text).toContain("task-board projection");
    expect(text).toContain("Quiet route jumps");
    expect(JSON.stringify(renderer!.toJSON())).toContain("mc-next-native-work-pair mc-next-cowork-workbench");
  });

  it("renders blocker and review state labels without relying on color alone", async () => {
    const previousFetchTasksByView = mocks.fetchTasksByView.getMockImplementation();
    mocks.fetchTasksByView.mockImplementation(async (view: "active" | "trash") => ({
      view,
      items:
        view === "active"
          ? [
              {
                taskId: "task-blocked",
                title: "Resolve policy blocker",
                description: "Needs operator review before resume.",
                status: "blocked",
                priority: "urgent",
                createdAt: "2026-05-02T18:00:00.000Z",
                updatedAt: "2026-05-02T18:05:00.000Z",
              },
              {
                taskId: "task-review",
                title: "Review synthesis",
                description: "Output is ready for review.",
                status: "review",
                priority: "high",
                createdAt: "2026-05-02T18:00:00.000Z",
                updatedAt: "2026-05-02T18:04:00.000Z",
              },
            ]
          : [],
    }));

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderCoworkTasks();
    });

    const text = collectText(renderer!.root);
    expect(text).toContain("Blocked");
    expect(text).toContain("Open blocker");
    expect(text).toContain("Review");
    expect(JSON.stringify(renderer!.toJSON())).toContain('"data-status":"blocked"');

    if (previousFetchTasksByView) {
      mocks.fetchTasksByView.mockImplementation(previousFetchTasksByView);
    }
  });

  it("creates, updates, adds deliverables, and soft-deletes tasks through task APIs", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderCoworkTasks();
    });

    await act(async () => {
      findInputByPlaceholder(renderer!.root, "Write release notes").props.onChange({ target: { value: "New task" } });
      findFieldControl(renderer!.root, "Priority", "select").props.onChange({ target: { value: "high" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Create task").props.onClick();
    });
    expect(mocks.createTask).toHaveBeenCalledWith({
      citadelId: "company",
      workspaceId: "default",
      title: "New task",
      description: undefined,
      priority: "high",
    });

    await act(async () => {
      findFieldControl(renderer!.root, "Status", "select").props.onChange({ target: { value: "done" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Save task").props.onClick();
    });
    expect(mocks.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ citadelId: "company", status: "done" }),
    );

    await act(async () => {
      findFieldControl(renderer!.root, "Deliverable title", "input").props.onChange({
        target: { value: "Release evidence" },
      });
    });
    await act(async () => {
      findButton(renderer!.root, "Add deliverable").props.onClick();
    });
    expect(mocks.addTaskDeliverable).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ citadelId: "company", title: "Release evidence", deliverableType: "artifact" }),
    );

    await act(async () => {
      findButton(renderer!.root, "Move to trash").props.onClick();
    });
    expect(mocks.deleteTask).toHaveBeenCalledWith("task-1", {
      citadelId: "company",
      mode: "soft",
      deletedBy: "operator",
      workspaceId: "default",
    });
  });

  it("restores deleted tasks when the trash view returns a selected task", async () => {
    mocks.fetchTasksByView.mockImplementation(
      async (view: "active" | "trash") =>
        ({
          view,
          items:
            view === "trash"
              ? [
                  {
                    taskId: "task-1",
                    title: "Review release notes",
                    status: "planning",
                    priority: "normal",
                    deletedAt: "2026-05-02T18:30:00.000Z",
                    createdAt: "2026-05-02T18:00:00.000Z",
                    updatedAt: "2026-05-02T18:00:00.000Z",
                  },
                ]
              : [],
        }) as any,
    );
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderCoworkTasks();
    });
    await act(async () => {
      findButton(renderer!.root, "Restore").props.onClick();
    });

    expect(mocks.restoreTask).toHaveBeenCalledWith("task-1", "default", "company");
  });
});

describe("NativeRoutePages Ops quality dashboard", () => {
  it("renders prompt-pack, eval proof, and export posture without redirecting to Library", async () => {
    let renderer: ReactTestRenderer | null = null;
    const navigate = vi.fn();
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    await act(async () => {
      renderer = renderOpsQuality(navigate);
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = collectText(renderer!.root);
    expect(mocks.fetchOpsQualitySnapshot).toHaveBeenCalledWith({ packLimit: 200, evalLimit: 25 });
    expect(mocks.fetchPromptPackReport).toHaveBeenCalledWith("pack-1");
    expect(mocks.fetchPromptPackExport).toHaveBeenCalledWith("pack-1");
    expect(text).toContain("Quality Dashboard");
    expect(text).toContain("Prompt-pack gate evidence");
    expect(text).toContain("Pass rate");
    expect(text).toContain("67%");
    expect(text).toContain("SEC-003, SEC-007");
    expect(text).toContain("Export snapshot");
    expect(text).toContain("artifacts/prompt-packs/archive/security-red-team-2026-05-02.json");
    expect(text).toContain("Security Red Team");
    expect(text).toContain("Defensive Security Evaluation");
    expect(text).toContain("Security eval packs");
    expect(text).toContain("Security quality gates");
    expect(text).toContain("Defensive Security Evaluation gate");
    expect(text).toContain("Needs score · 12/18 runs · 67% pass");
    expect(text).toContain(
      "Score all completed defensive security runs before treating this gate as release evidence.",
    );
    expect(text).toContain("Red-team packs are visible as governed definitions");
    expect(text).toContain("Available · 18 tests · Chat 6 · Cowork 6 · Code 6");
    expect(text).toContain("Import and open defensive security pack");
    expect(text).toContain("Review security pack scoring");
    expect(text).toContain("Security execution depth");
    expect(text).toContain("Scoring required · 67% run coverage · 50% scored · 67% pass");
    expect(text).toContain("12/18 runs · 3 need score");
    expect(text).toContain("Failing codes: SEC-003, SEC-007");
    expect(text).toContain("Design quality");
    expect(text).toContain("Design-intelligence module integrity");
    expect(text).toContain("Calibrated anti-slop scan");
    expect(text).toContain("P1 · Advisory · mission-control-next");
    expect(text).toContain("No provider calls");
    expect(text).toContain("No source writes");
    expect(text).toContain("design:quality");
    expect(text).toContain("visual:regression");
    expect(text).toContain("Eval proof");
    expect(text).toContain("Eval proof JSON export");
    expect(text).toContain("Run trace JSON");

    await act(async () => {
      findButton(renderer!.root, "Copy eval proof export").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.exportLlmEvalProofRuns).toHaveBeenCalledWith(50);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('{"version":"llm.eval_proof_export.v1"}');
    expect(collectText(renderer!.root)).toContain(
      "Copied eval proof export goatcitadel-llm-eval-proof-2026-05-02T20-05-00-000Z.json.",
    );

    await act(async () => {
      findButton(renderer!.root, "Import and open defensive security pack").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.importBuiltinPromptPack).toHaveBeenCalledWith("security-red-team-v6");
    expect(navigate).toHaveBeenCalledWith({
      area: "library",
      section: "prompt-packs",
      view: "pack:security-red-team-v6",
      theme: "ops",
    });

    await act(async () => {
      findButton(renderer!.root, "Copy prompt-pack export path").props.onClick();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "artifacts/prompt-packs/archive/security-red-team-2026-05-02.json",
    );

    await act(async () => {
      findButton(renderer!.root, "Open prompt packs").props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({
      area: "library",
      section: "prompt-packs",
      view: undefined,
      theme: "ops",
    });
  });

  it("renders partial Ops quality snapshots with section-level source errors", async () => {
    const baseSnapshot = (await mocks.fetchOpsQualitySnapshot()) as unknown as OpsQualitySnapshotResponse;
    mocks.fetchOpsQualitySnapshot.mockClear();
    mocks.fetchPromptPackReport.mockClear();
    mocks.fetchPromptPackExport.mockClear();
    const partialSnapshot = {
      ...baseSnapshot,
      metrics: {
        ...baseSnapshot.metrics,
        promptPackCount: 0,
        promptPackTestCount: 0,
      },
      promptPacks: {
        state: "unknown",
        items: [],
        error: "prompt pack store unavailable",
      },
    } as OpsQualitySnapshotResponse;
    mocks.fetchOpsQualitySnapshot.mockResolvedValueOnce(partialSnapshot as never);
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderOpsQuality();
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = collectText(renderer!.root);
    expect(mocks.fetchOpsQualitySnapshot).toHaveBeenCalledWith({ packLimit: 200, evalLimit: 25 });
    expect(text).toContain("Prompt packs");
    expect(text).toContain("prompt pack store unavailable");
    expect(text).toContain("No prompt packs are available.");
    expect(text).toContain("Eval proof");
    expect(mocks.fetchPromptPackReport).not.toHaveBeenCalled();
    expect(mocks.fetchPromptPackExport).not.toHaveBeenCalled();
  });
});

describe("NativeRoutePages Library provenance helpers", () => {
  it("formats knowledge citation and artifact provenance for operator-facing source visibility", () => {
    expect(formatKnowledgeCitationSummary([{ sourceType: "file" }, { retrievalMode: "memory" }])).toBe(
      "2 citations · file, memory",
    );
    expect(formatKnowledgeCitationAction({ sourceRef: "docs/runbook.md", chunkId: "chunk-1" }, "ctx-1", 0)).toEqual(
      expect.objectContaining({
        label: "docs/runbook.md",
        description: "Context ctx-1 cites chunk chunk-1.",
      }),
    );
    expect(
      formatKnowledgeCitationAction(
        {
          sourceRef: "mem-browser",
          sourceType: "memory_item",
          score: 0.82,
          provenance: {
            relationScope: "self",
            freshness: "recent",
            selectionReason: "selected for lexical/recency score 1.330",
            sourceTimestamp: "2026-05-30T18:05:00.000Z",
          },
        },
        "ctx-2",
        0,
      ),
    ).toEqual(
      expect.objectContaining({
        label: "mem-browser",
        description: "selected for lexical/recency score 1.330",
        meta: expect.stringContaining("memory_item"),
      }),
    );
    expect(
      formatArtifactProvenance({
        artifactId: "artifact-1",
        sessionId: "session-1",
        turnId: "turn-1",
        title: "Cowork synthesis",
        kind: "markdown",
        content: "# Result",
        sourceSurface: "cowork",
        version: 2,
        providerId: "openai",
        model: "gpt-5",
        contentHash: "hash-1",
        createdAt: "2026-05-02T19:00:00.000Z",
        updatedAt: "2026-05-02T19:05:00.000Z",
      } as any),
    ).toContain('"contentHash": "hash-1"');
  });

  it("reopens generated artifacts from the Library artifact route into their source thread", async () => {
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderLibraryArtifacts(navigate);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.fetchChatGeneratedArtifacts).toHaveBeenCalledWith({
      citadelId: "company",
      workspaceId: "default",
      limit: 80,
    });
    expect(collectText(renderer!.root)).toContain("Artifact provenance");

    await act(async () => {
      findButton(renderer!.root, "Open source thread").props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({
      area: "cowork",
      sessionId: "session-1",
      turnId: "turn-1",
      artifactId: "artifact-1",
      theme: "ops",
    });
  });
});

describe("NativeRoutePages proposal trust review", () => {
  it("shows proposal trust details and keeps mutation truth visible", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderLibrarySkills();
    });
    await act(async () => {
      findButton(renderer!.root, "Open proposal").props.onClick();
    });

    expect(mocks.fetchCapabilityProposal).toHaveBeenCalledWith("proposal-1");
    expect(mocks.fetchCuratorReviewItem).toHaveBeenCalledWith("candidate-review-1");
    expect(collectText(renderer!.root)).toContain("Repeated failures need skill maintenance.");
    expect(collectText(renderer!.root)).toContain("Mutation applied");
    expect(collectText(renderer!.root)).toContain("false");
    expect(collectText(renderer!.root)).toContain("Callable impact");
    expect(collectText(renderer!.root)).toContain("narrows");

    const promote = findButton(renderer!.root, "Promote");
    expect(promote.props.disabled).toBe(true);
    expect(String(promote.props.title)).toContain("approval-gated");

    await act(async () => {
      findButton(renderer!.root, "Validate").props.onClick();
    });
    expect(mocks.validateImprovementCandidate).toHaveBeenCalledWith(
      "candidate-review-1",
      expect.objectContaining({ reason: expect.stringContaining("validate") }),
    );
  });
});

describe("NativeRoutePages skill source dispositions", () => {
  it("renders ClawHub source disposition labels without conflating reference-only and conditional imports", async () => {
    mocks.fetchSkillSources.mockResolvedValueOnce({
      items: [
        {
          sourceUrl: "https://clawhub.ai/maximeprades/auto-updater",
          name: "Auto Updater",
          description: "Update scouting reference.",
          sourceProvider: "clawhub",
          installability: "review_only",
          skillFamily: "auto_updates",
          tags: ["clawhub", "updater"],
        },
        {
          sourceUrl: "https://clawhub.ai/lura2/canvas",
          name: "Canvas",
          description: "A2UI host proof required.",
          sourceProvider: "clawhub",
          installability: "review_only",
          skillFamily: "canvas_a2ui",
          tags: ["clawhub", "canvas"],
        },
        {
          sourceUrl: "https://clawhub.ai/matagul/desktop-control",
          name: "Desktop Control",
          description: "Rejected desktop control import.",
          sourceProvider: "clawhub",
          installability: "not_installable",
          skillFamily: "desktop_control_high_risk",
          tags: ["clawhub", "desktop"],
        },
        {
          sourceUrl: "https://clawhub.ai/spclaudehome/skill-vetter",
          name: "Skill Vetter",
          description: "Native skill governance overlap.",
          sourceProvider: "clawhub",
          installability: "review_only",
          skillFamily: "skill_vetting",
          tags: ["clawhub", "vetting"],
        },
      ],
    } as any);
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderLibrarySkills();
    });

    const text = collectText(renderer!.root);
    expect(text).toContain("Auto Updater");
    expect(text).toContain("clawhub · Reference only");
    expect(text).toContain("Canvas");
    expect(text).toContain("clawhub · Conditional install");
    expect(text).toContain("Desktop Control");
    expect(text).toContain("clawhub · Rejected");
    expect(text).toContain("Skill Vetter");
    expect(text).toContain("clawhub · Native overlap");
  });
});

function renderCoworkTasks(): ReactTestRenderer {
  return create(
    <NativeRoutePages
      route={{ area: "cowork", section: "tasks", theme: "ops" } as any}
      activeCitadelId="company"
      activeCitadelName="Company"
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      pendingApprovals={0}
      navigate={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
    />,
  );
}

function renderLibrarySkills(): ReactTestRenderer {
  return create(
    <NativeRoutePages
      route={{ area: "library", section: "skills", theme: "ops" } as any}
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      pendingApprovals={0}
      navigate={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
    />,
  );
}

function renderLibraryArtifacts(navigate = vi.fn()): ReactTestRenderer {
  return create(
    <NativeRoutePages
      route={{ area: "library", section: "artifacts", artifactId: "artifact-1", theme: "ops" } as any}
      activeCitadelId="company"
      activeCitadelName="Company"
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      pendingApprovals={0}
      navigate={navigate}
      setActiveWorkspaceId={vi.fn()}
    />,
  );
}

function renderOpsQuality(navigate = vi.fn()): ReactTestRenderer {
  return create(
    <NativeRoutePages
      route={{ area: "ops", section: "quality", theme: "ops" } as any}
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      pendingApprovals={0}
      navigate={navigate}
      setActiveWorkspaceId={vi.fn()}
    />,
  );
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return match;
}

function findInputByPlaceholder(root: ReactTestInstance, placeholder: string): ReactTestInstance {
  const match = root.findAll(
    (node) =>
      node.type === "input" && typeof node.props?.placeholder === "string" && node.props.placeholder === placeholder,
  )[0];
  if (!match) {
    throw new Error(`Unable to find input: ${placeholder}`);
  }
  return match;
}

function findFieldControl(root: ReactTestInstance, label: string, control: "input" | "select"): ReactTestInstance {
  const field = root.findAll((node) => node.type === "label" && collectText(node).includes(label))[0];
  if (!field) {
    throw new Error(`Unable to find field: ${label}`);
  }
  return field.findByType(control);
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      if (typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
}
