import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  asRecord,
  buildMemoryGraphProjection,
  buildMemoryModelSummary,
  buildProvenanceCoverage,
  classifyMemoryItemKind,
  classifyTraceMemoryCandidateKind,
  formatDecisionProvenanceSummary,
  formatMemoryEngineeringKind,
  formatRelationProvenanceSummary,
  MemoryRoutePage,
  readMemoryWriteDecision,
  readMetadataString,
  readMetadataStringList,
  resolveMemoryItemWorkspaceLabel,
} from "./MemoryRoutePage";

const memorySnapshot = vi.hoisted(() => ({
  // HX-402 P1: approval-first mutation surface state.
  pendingMutationApprovals: [] as Array<Record<string, unknown>>,
  dismissPendingMutationApproval: vi.fn(),
  loading: false,
  error: null,
  notice: null,
  busyKey: null,
  reload: vi.fn(),
  selectedItemId: "mem-1",
  setSelectedItemId: vi.fn(),
  selectedRunId: "run-1",
  setSelectedRunId: vi.fn(),
  selectedItem: {
    itemId: "mem-1",
    namespace: "workspace.alpha",
    title: "Deployment note",
    content: "Ship after verification.",
    workspaceId: "default",
    metadata: { workspaceId: "workspace-b" },
    pinned: true,
    status: "active",
    lifecycleState: "active",
    updatedAt: "2026-04-22T00:00:00.000Z",
    ttlOverrideSeconds: 3600,
    expiresAt: "2026-04-23T00:00:00.000Z",
  },
  selectedRun: {
    runId: "run-1",
    durableRunId: "durable-1",
    workspaceId: "default",
    triggerSource: "manual",
    status: "completed",
    policySnapshot: {},
    sourceSessionCount: 1,
    changedArtifactCount: 1,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:10:00.000Z",
  },
  policyDraft: {
    enabled: true,
    runMode: "manual",
    timingStrategy: "fixed",
    timeZone: "America/Los_Angeles",
    minHoursSinceLastSuccess: 24,
    minChangedSessions: 1,
    providerId: "openai",
    model: "gpt-5",
    executionTarget: "auto",
    unavailableModelPolicy: "skip",
    scheduleEnabled: false,
    scheduleFrequency: "daily",
    scheduleHour: 3,
    scheduleMinute: 0,
    scheduleWeekday: 1,
  },
  setPolicyDraft: vi.fn(),
  policyDirty: false,
  setPolicyDirty: vi.fn(),
  saveItemPatch: vi.fn(),
  forgetSelectedItem: vi.fn(),
  scanMemoryQuality: vi.fn(),
  patchQualityIssue: vi.fn(),
  runMaintenance: vi.fn(),
  savePolicy: vi.fn(),
  resolveRecommendation: vi.fn(),
  resolveTraceMemoryCandidate: vi.fn(),
  reviewDecision: vi.fn(),
  data: {
    files: [{ relativePath: "memory/workspace/note.md", size: 1024, modifiedAt: "2026-04-22T00:00:00.000Z" }],
    qmdStats: {
      totalRuns: 4,
      generatedRuns: 4,
      cacheHitRuns: 0,
      fallbackRuns: 0,
      failedRuns: 0,
      originalTokenEstimate: 1000,
      distilledTokenEstimate: 700,
      savingsPercent: 30,
      netTokenDelta: -300,
      compressionPercent: 30,
      expansionPercent: 0,
      efficiencyLabel: "reduced",
      recent: [
        {
          contextId: "ctx-1",
          scope: "chat",
          createdAt: "2026-04-22T00:00:00.000Z",
          quality: {
            status: "ok",
            assembly: {
              availableCandidateCount: 3,
              selectedCandidateCount: 1,
              droppedCandidateCount: 2,
              availableTokenEstimate: 300,
              selectedTokenEstimate: 100,
              evidenceTokenBudget: 2000,
            },
          },
          citations: [
            {
              candidateId: "mem-1",
              sourceType: "memory_item",
              sourceRef: "Deployment note",
              snippet: "Ship after verification.",
              score: 0.91,
              provenance: {
                relationScope: "self",
                freshness: "fresh",
                selectionReason: "selected for release checklist and verification cadence hints",
                retrievalStrategy: "semantic_hints",
                matchSignals: {
                  lexicalScore: 0.4,
                  semanticHintScore: 0.8,
                  recencyScore: 0.7,
                  diversityScore: 0.2,
                  totalScore: 0.91,
                },
                sourceTimestamp: "2026-04-22T00:00:00.000Z",
              },
            },
          ],
        },
      ],
    },
    memoryRetrievalStatus: {
      checkedAt: "2026-04-22T00:00:00.000Z",
      enabled: true,
      retrievalMode: "hybrid_rank",
      rerankAvailable: true,
      rerankMode: "hybrid_rank",
      fallbackMode: "available",
      lastRefresh: "2026-04-22T00:00:00.000Z",
      qmd: {
        enabled: true,
        applyToChat: true,
        applyToOrchestration: true,
        minPromptChars: 8,
        cacheTtlSeconds: 300,
        distillerTimeoutMs: 12_000,
      },
      recent: {
        totalRuns: 4,
        generatedRuns: 4,
        cacheHitRuns: 0,
        fallbackRuns: 0,
        failedRuns: 0,
        retrievalStrategies: ["hybrid_rank"],
      },
    },
    memoryItems: [
      {
        itemId: "mem-1",
        namespace: "workspace.alpha",
        title: "Deployment note",
        content: "Ship after verification.",
        pinned: true,
        status: "active",
        lifecycleState: "active",
        updatedAt: "2026-04-22T00:00:00.000Z",
        ttlOverrideSeconds: 3600,
        expiresAt: "2026-04-23T00:00:00.000Z",
        metadata: {
          source: "operator",
          confidence: "high",
          lastUsedAt: "2026-04-22T00:10:00.000Z",
          workspaceId: "default",
          retrievalHints: ["release checklist", "verification cadence"],
        },
      },
    ],
    memoryEntities: [
      {
        id: "entity-1",
        workspaceId: "default",
        scope: "workspace",
        title: "Project Alpha",
        entityType: "project",
        aliases: ["Alpha"],
        status: "active",
        confidence: 0.9,
        sourceRefs: [{ sourceType: "manual", sourceRef: "operator" }],
        metadata: { assumptions: ["Operators review before side effects"], reversibility: "easy to revise" },
        authority: "operator",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    memoryRelations: [
      {
        id: "relation-1",
        workspaceId: "default",
        scope: "workspace",
        title: "Project Alpha uses Automation Designer",
        fromEntityId: "entity-1",
        toEntityId: "entity-2",
        relationType: "uses",
        status: "active",
        confidence: 0.8,
        sourceRefs: [{ sourceType: "manual", sourceRef: "operator" }],
        metadata: {},
        authority: "operator",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    memoryDecisions: [
      {
        id: "decision-1",
        workspaceId: "default",
        scope: "workspace",
        title: "Keep automation advisory",
        decision: "Draft automation recipes before cron creation.",
        alternatives: ["Create cron jobs immediately"],
        rationale: "Operators need preview and proof first.",
        expectedOutcome: "Fewer surprise side effects.",
        reviewAt: "2026-06-22T00:00:00.000Z",
        linkedEntityIds: ["entity-1"],
        linkedRelationIds: ["relation-1"],
        status: "active",
        confidence: 0.75,
        sourceRefs: [{ sourceType: "manual", sourceRef: "operator" }],
        metadata: {},
        authority: "operator",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    memoryFeedback: [
      {
        feedbackId: "fb-1",
        workspaceId: "default",
        kind: "useful",
        status: "open",
        targetKind: "citation",
        targetRef: "mem-1",
        contextId: "ctx-1",
        note: "Release checklist citation helped the operator.",
        metadata: {},
        actorId: "operator:test",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    traceMemoryCandidates: [
      {
        candidateId: "trace-1",
        workspaceId: "default",
        candidateType: "tool_outcome",
        status: "proposed",
        sourceText: "Tool outcome noted docs check is required.",
        proposedInsight: "Docs check should stay attached to release verification memory.",
        confidence: 0.82,
        sourceRefs: [{ sourceType: "run", sourceRef: "run-1" }],
        metadata: { sourceAuthority: "external_channel", sourceSessionId: "shared-session-123456" },
        authority: "external_channel",
        actorId: "external-channel-ingest",
        sourceSessionId: "shared-session-123456",
        sourceMessageId: "external-message-1",
        dedupeKey: "f".repeat(64),
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    memoryQualityIssues: [
      {
        issueId: "quality-1",
        workspaceId: "default",
        kind: "source_drift",
        status: "open",
        severity: "high",
        targetKind: "learning",
        targetRef: "learning-1",
        relatedRefs: [],
        evidenceRefs: [{ sourceType: "artifact", sourceRef: "docs/plan.md", title: "Learning staleness check" }],
        summary: "Referenced file docs/plan.md changed since the learning was recorded.",
        rationale: "Learning staleness checks compare recorded source refs.",
        metadata: {},
        dedupKey: "default|source_drift|learning|learning-1|changed_hash",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    memoryHistory: [
      { changeId: "chg-1", changeType: "updated", createdAt: "2026-04-22T00:00:00.000Z", actorId: "operator:test" },
    ],
    maintenanceStatus: {
      workspaceId: "default",
      policy: {
        workspaceId: "default",
        enabled: true,
        runMode: "manual",
        timingStrategy: "fixed",
        timeZone: "America/Los_Angeles",
        minHoursSinceLastSuccess: 24,
        minChangedSessions: 1,
        executionTarget: "auto",
        unavailableModelPolicy: "skip",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
      state: {
        workspaceId: "default",
        changedSessionCount: 2,
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    },
    maintenanceRuns: [
      {
        runId: "run-1",
        durableRunId: "durable-1",
        workspaceId: "default",
        triggerSource: "manual",
        status: "completed",
        policySnapshot: {},
        sourceSessionCount: 1,
        changedArtifactCount: 1,
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:10:00.000Z",
      },
    ],
    maintenanceRecommendations: [
      {
        recommendationId: "rec-1",
        workspaceId: "default",
        kind: "policy_tuning",
        status: "queued",
        summary: "Tighten cadence for fresh context.",
        proposedPatch: {},
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    selectedRunProvenance: { run: { runId: "run-1" }, sources: [], changes: [] },
    selectedDurableRun: { runId: "durable-1", status: "completed" },
    selectedDurableTimeline: [],
    memoryAdminEnabled: true,
    memoryAdminState: "enabled",
    maintenanceEnabled: true,
    maintenanceDurableReady: true,
    sectionErrors: {
      settings: null,
      files: null,
      qmdStats: null,
      memoryRetrievalStatus: null,
      memoryItems: null,
      memoryEntities: null,
      memoryRelations: null,
      memoryDecisions: null,
      memoryFeedback: null,
      memoryQualityIssues: null,
      traceMemoryCandidates: null,
      memoryHistory: null,
      maintenanceStatus: null,
      maintenanceRuns: null,
      maintenanceRecommendations: null,
      selectedRunProvenance: null,
      selectedDurableRun: null,
      selectedDurableTimeline: null,
    },
  },
}));

const evidenceApiMocks = vi.hoisted(() => ({
  fetchEvidenceEnvelopes: vi.fn(),
  runMemoryRetrievalBenchmark: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchEvidenceEnvelopes: evidenceApiMocks.fetchEvidenceEnvelopes,
  runMemoryRetrievalBenchmark: evidenceApiMocks.runMemoryRetrievalBenchmark,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useMemoryOperatorSnapshot", () => ({
  useMemoryOperatorSnapshot: () => memorySnapshot,
}));

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!button) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return button;
}

function findButtons(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === "button" && collectText(node).includes(label));
}

describe("MemoryRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    evidenceApiMocks.fetchEvidenceEnvelopes.mockResolvedValue({
      items: [
        {
          envelopeId: "env-1",
          eventKind: "memory_write",
          signatureStatus: "signed_hmac",
          contentHash: "hash-123456789",
          createdAt: "2026-04-22T00:00:00.000Z",
          metadata: { decision: { decision: "approved" } },
        },
      ],
    });
    evidenceApiMocks.runMemoryRetrievalBenchmark.mockResolvedValue({
      generatedAt: "2026-04-22T00:00:00.000Z",
      itemCount: 1,
      avgLatencyMs: 12,
      avgOverlapScore: 0.72,
      retrievalStrategies: ["hybrid_rank"],
      semanticCoverageNote: "Hybrid retrieval benchmark.",
      items: [
        {
          prompt: "What recent decisions affect current GoatCitadel memory work?",
          status: "completed",
          latencyMs: 12,
          contextId: "ctx-1",
          citationsCount: 2,
          originalTokenEstimate: 100,
          distilledTokenEstimate: 80,
          overlapScore: 0.72,
          retrievalStrategy: "hybrid_rank",
          semanticCoverageNote: "Hybrid retrieval benchmark.",
          qmdStatus: "generated",
        },
      ],
      warnings: [],
    });
  });

  it("reads memory provenance and evidence metadata defensively", () => {
    expect(asRecord({ source: "operator" })).toEqual({ source: "operator" });
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord(["source"])).toBeUndefined();
    expect(readMetadataString({ reason: "  Useful context " }, "reason")).toBe("Useful context");
    expect(readMetadataString({ reason: "   " }, "reason")).toBeUndefined();
    expect(readMetadataString({ reason: 42 }, "reason")).toBeUndefined();
    expect(readMetadataStringList({ assumptions: [" one ", 42, "two"] }, "assumptions")).toEqual(["one", "two"]);
    expect(readMetadataStringList({ assumptions: "single" }, "assumptions")).toEqual(["single"]);
    expect(readMetadataStringList({ assumptions: [] }, "assumptions")).toEqual([]);
    expect(
      resolveMemoryItemWorkspaceLabel({ workspaceId: "workspace-a", metadata: { workspaceId: "workspace-b" } }),
    ).toBe("workspace-a");
    expect(resolveMemoryItemWorkspaceLabel({ metadata: { workspaceId: " workspace-a " } })).toBe("workspace-a");
    expect(resolveMemoryItemWorkspaceLabel({ metadata: {} })).toBe("global");
    expect(resolveMemoryItemWorkspaceLabel({ workspaceId: " ", metadata: { workspaceId: "workspace-b" } })).toBe(
      "invalid canonical scope",
    );
    expect(
      resolveMemoryItemWorkspaceLabel({ workspaceId: " workspace-a ", metadata: { workspaceId: "workspace-b" } }),
    ).toBe("invalid canonical scope");
    expect(
      readMemoryWriteDecision({ metadata: { decision: { decision: "approved" } }, signatureStatus: "signed" } as any),
    ).toBe("approved");
    expect(readMemoryWriteDecision({ metadata: { decision: ["bad"] }, signatureStatus: "signed" } as any)).toBe(
      "signed",
    );
    expect(readMemoryWriteDecision({ metadata: null, signatureStatus: "unsigned" } as any)).toBe("unsigned");
  });

  it("builds typed provenance coverage without creating a second graph", () => {
    const coverage = buildProvenanceCoverage({
      entities: [
        { entityType: "project", sourceRefs: [{ sourceType: "manual", sourceRef: "operator" }] },
        { entityType: "tool", sourceRefs: [{ sourceType: "artifact", sourceRef: "artifact-1" }] },
      ] as any,
      relations: [{ sourceRefs: [{ sourceType: "manual", sourceRef: "operator" }] }] as any,
      decisions: [{ sourceRefs: [{ sourceType: "run", sourceRef: "run-1" }] }] as any,
      memoryItems: [{ itemId: "mem-1" }] as any,
      evidence: [{ eventKind: "approval.decided" }] as any,
    });

    expect(coverage.find((item) => item.id === "project")).toMatchObject({ records: 1, status: "covered" });
    expect(coverage.find((item) => item.id === "decision")).toMatchObject({ records: 1, status: "covered" });
    expect(coverage.find((item) => item.id === "approval")).toMatchObject({ records: 1, status: "covered" });
    expect(coverage.find((item) => item.id === "source")?.records).toBe(3);
    expect(
      formatRelationProvenanceSummary({
        fromEntityId: "entity-alpha",
        toEntityId: "entity-beta",
        confidence: 0.8,
        sourceRefs: [{ sourceType: "run", sourceRef: "run-1" }],
      } as any),
    ).toContain("run:run-1");
    expect(
      formatDecisionProvenanceSummary({
        linkedEntityIds: ["entity-alpha"],
        linkedRelationIds: ["relation-alpha"],
        sourceRefs: [{ sourceType: "manual", sourceRef: "operator" }],
        runId: "run-1",
      } as any),
    ).toContain("2 linked records");
  });

  it("builds a read-only memory graph projection without adding a graph store", () => {
    const projection = buildMemoryGraphProjection({
      entities: memorySnapshot.data.memoryEntities as any,
      relations: memorySnapshot.data.memoryRelations as any,
      decisions: memorySnapshot.data.memoryDecisions as any,
    });

    expect(projection).toMatchObject({
      readiness: "connected",
      entityCount: 1,
      activeEntityCount: 1,
      relationCount: 1,
      activeRelationCount: 1,
      degradedRelationCount: 1,
      decisionCount: 1,
      connectedEntityCount: 1,
      orphanEntityCount: 0,
      topRelationTypes: [{ relationType: "uses", count: 1 }],
    });
    expect(projection.summary).toContain("entities are linked");
  });

  it("builds presentation-only memory taxonomy counts", () => {
    const summary = buildMemoryModelSummary({
      recentContexts: memorySnapshot.data.qmdStats.recent as any,
      memoryItems: memorySnapshot.data.memoryItems as any,
      entities: memorySnapshot.data.memoryEntities as any,
      relations: memorySnapshot.data.memoryRelations as any,
      decisions: memorySnapshot.data.memoryDecisions as any,
      traceCandidates: memorySnapshot.data.traceMemoryCandidates as any,
      learnings: [{ type: "workflow" }, { type: "operator_preference" }] as any,
    });

    expect(summary.find((item) => item.kind === "working")).toMatchObject({ count: 1, status: "covered" });
    expect(summary.find((item) => item.kind === "episodic")).toMatchObject({ count: 1, status: "covered" });
    expect(summary.find((item) => item.kind === "semantic")).toMatchObject({ count: 5, status: "covered" });
    expect(summary.find((item) => item.kind === "procedural")).toMatchObject({ count: 1, status: "covered" });
    expect(formatMemoryEngineeringKind(classifyMemoryItemKind(memorySnapshot.data.memoryItems[0] as any))).toBe(
      "Semantic",
    );
    expect(
      formatMemoryEngineeringKind(
        classifyTraceMemoryCandidateKind(memorySnapshot.data.traceMemoryCandidates[0] as any),
      ),
    ).toBe("Episodic");
  });

  it("renders lifecycle-aware memory operator truth", () => {
    const markup = renderToStaticMarkup(
      <MemoryRoutePage
        route={{ area: "library", section: "memory", theme: "library" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Memory items");
    const searchControl = markup.match(
      /<label[^>]*for="([^"]+)"[^>]*><span[^>]*>Search memory<\/span><input id="([^"]+)"[^>]*type="search"[^>]*\/><\/label>/u,
    );
    expect(searchControl).not.toBeNull();
    expect(searchControl?.[1]).toBe(searchControl?.[2]);
    expect(searchControl?.[0]).not.toContain("aria-label=");
    expect(markup).toContain("Memory model");
    expect(markup).toContain("Working");
    expect(markup).toContain("Episodic");
    expect(markup).toContain("Semantic");
    expect(markup).toContain("Procedural");
    expect(markup).toContain("selected 1");
    expect(markup).toContain("Retrieval hybrid rank");
    expect(markup).toContain("Fallback available");
    expect(markup).toContain("Retrieval hints");
    expect(markup).toContain("Workspace");
    expect(markup).toContain("default");
    expect(markup).not.toContain("workspace-b");
    expect(markup).toContain('<dl class="mc-next-memory-provenance-list">');
    const provenanceMarkup = markup.match(/<dl class="mc-next-memory-provenance-list">.*?<\/dl>/u)?.[0] ?? "";
    expect(provenanceMarkup).not.toContain('role="presentation"');
    expect(provenanceMarkup).toMatch(/<dt>Namespace<\/dt><dd><span[^>]*aria-hidden="true"[^>]*> · <\/span>/u);
    expect(markup).toContain("release checklist, verification cadence");
    expect(markup).toContain("Lifecycle");
    expect(markup).toContain("Run maintenance now");
    expect(markup).toContain("Tighten cadence for fresh context.");
    expect(markup).toContain("Memory files");
    expect(markup).toContain("Why-used citations");
    expect(markup).toContain("selected for release checklist and verification cadence hints");
    expect(markup).toContain("semantic_hints");
    expect(markup).toContain("Recall quality");
    expect(markup).toContain("Release checklist citation helped the operator.");
    expect(markup).toContain("Trace candidates");
    expect(markup).toContain("Docs check should stay attached to release verification memory.");
    expect(markup).toContain("external channel");
    expect(markup).toContain("session shared-s");
    expect(markup).toContain("Promote");
    expect(markup).toContain("Reject");
    expect(markup).toContain("Graph projection");
    expect(markup).toContain("Provenance map");
    expect(markup).toContain("Memory entities");
    expect(markup).toContain("Relations");
    expect(markup).toContain("Decision journal");
    expect(markup).toContain("Keep automation advisory");
    expect(markup).toContain("Chosen path");
    expect(markup).toContain("Options");
    expect(markup).toContain("Reversibility");
    expect(markup).toContain("Run");
    expect(markup).toContain("Artifact");
    expect(markup).toContain("source refs");
  });

  it("wires operator promote and reject actions for proposed trace candidates", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <MemoryRoutePage
          route={{ area: "library", section: "memory", theme: "library" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    act(() => findButton(renderer!.root, "Promote").props.onClick());
    expect(memorySnapshot.resolveTraceMemoryCandidate).toHaveBeenCalledWith("trace-1", "promote");
    act(() => findButton(renderer!.root, "Reject").props.onClick());
    expect(memorySnapshot.resolveTraceMemoryCandidate).toHaveBeenCalledWith("trace-1", "reject");
  });

  it("keeps quick-jump navigation on route objects", async () => {
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <MemoryRoutePage
          route={{ area: "library", section: "memory", theme: "library" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={navigate}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    const buttons = renderer!.root.findAllByType("button");
    const runtimeButton = buttons.find(
      (button: ReactTestInstance) =>
        button.findAll((node) => typeof node.props?.children === "string" && node.props.children === "Runtime").length >
        0,
    );

    expect(runtimeButton).toBeDefined();

    act(() => {
      runtimeButton!.props.onClick();
    });

    expect(navigate).toHaveBeenCalledWith({
      area: "ops",
      section: "runtime",
      theme: "library",
    });
    expect(navigate.mock.calls[0]?.[0]).not.toHaveProperty("page");
  });

  it("links selected maintenance durable runs to universal run detail", async () => {
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <MemoryRoutePage
          route={{ area: "library", section: "memory", theme: "library" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={navigate}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    const button = findButton(renderer!.root, "Open Run Detail");

    act(() => {
      button.props.onClick();
    });

    expect(navigate).toHaveBeenCalledWith({
      area: "ops",
      section: "sessions",
      view: "run-detail",
      runId: "durable-1",
      theme: "library",
    });
  });

  it("does not link stale durable detail when the selected maintenance run has no durable id", async () => {
    const original = {
      selectedRun: memorySnapshot.selectedRun,
      data: memorySnapshot.data,
    };

    try {
      memorySnapshot.selectedRun = {
        ...original.selectedRun,
        durableRunId: undefined,
      } as any;
      memorySnapshot.data = {
        ...original.data,
        selectedDurableRun: { runId: "previous-durable-run", status: "completed" },
      } as any;

      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = create(
          <MemoryRoutePage
            route={{ area: "library", section: "memory", theme: "library" } as any}
            activeWorkspaceId="default"
            activeWorkspaceName="Default"
            pendingApprovals={0}
            navigate={vi.fn()}
            setActiveWorkspaceId={vi.fn()}
          />,
        );
      });

      expect(findButtons(renderer!.root, "Open Run Detail")).toHaveLength(0);
    } finally {
      Object.assign(memorySnapshot, original);
    }
  });

  it("wires decision retrospective actions through the memory snapshot owner", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <MemoryRoutePage
          route={{ area: "library", section: "memory", theme: "library" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    const button = findButton(renderer!.root, "Record review");
    await act(async () => {
      button.props.onClick();
      await Promise.resolve();
    });

    expect(memorySnapshot.reviewDecision).toHaveBeenCalledWith("decision-1");
  });

  it("wires memory item edits, maintenance policy controls, recommendation actions, and run selection", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <MemoryRoutePage
          route={{ area: "library", section: "memory", theme: "library" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      findButton(renderer!.root, "Deployment note").props.onClick();
    });

    const inputs = renderer!.root.findAllByType("input");
    const selects = renderer!.root.findAllByType("select");
    const policyEnabledLabel = renderer!.root.findAll(
      (node) => node.type === "label" && collectText(node).includes("Enabled"),
    )[0];
    expect(policyEnabledLabel).toBeDefined();
    const policyEnabledSelect = policyEnabledLabel!.findByType("select");
    const textarea = renderer!.root.findByType("textarea");

    await act(async () => {
      inputs
        .find((node) => node.props.placeholder === "Namespace, title, or content")
        ?.props.onChange({
          target: { value: "ship" },
        });
      inputs
        .find((node) => node.props.value === "Deployment note")
        ?.props.onChange({
          target: { value: "Deployment note updated" },
        });
      inputs
        .find((node) => node.props.placeholder === "empty = default")
        ?.props.onChange({
          target: { value: "7200" },
        });
      textarea.props.onChange({ target: { value: "Ship after the coverage lane." } });
      selects.find((node) => node.props.value === "true")?.props.onChange({ target: { value: "false" } });
      policyEnabledSelect.props.onChange({ target: { value: "false" } });
      selects.find((node) => node.props.value === "manual")?.props.onChange({ target: { value: "scheduled" } });
      inputs.find((node) => node.props.value === "openai")?.props.onChange({ target: { value: "anthropic" } });
      inputs.find((node) => node.props.value === "gpt-5")?.props.onChange({ target: { value: "claude-sonnet" } });
    });

    await act(async () => {
      findButton(renderer!.root, "Save item").props.onClick();
      findButton(renderer!.root, "Forget item").props.onClick();
      findButton(renderer!.root, "Run maintenance now").props.onClick();
      findButton(renderer!.root, "Save policy").props.onClick();
      findButtons(renderer!.root, "Refresh").at(-1)!.props.onClick();
      findButton(renderer!.root, "Accept").props.onClick();
      findButtons(renderer!.root, "Reject").at(-1)!.props.onClick();
      findButton(renderer!.root, "completed").props.onClick();
    });

    // Forget is now confirm-gated (5.2): clicking "Forget item" opens the modal;
    // the actual forget only fires after confirming. The GCModal renders through a
    // portal (absent from the react-test-renderer tree), so drive the confirm via the
    // ConfirmModal instance directly (see CuratorRoutePage archive-confirm pattern).
    const forgetModal = renderer!.root.findByType(ConfirmModal);
    expect(forgetModal.props.open).toBe(true);
    await act(async () => {
      await forgetModal.props.onConfirm();
    });

    expect(memorySnapshot.setSelectedItemId).toHaveBeenCalledWith("mem-1");
    expect(memorySnapshot.saveItemPatch).toHaveBeenCalledWith("mem-1", {
      title: "Deployment note updated",
      content: "Ship after the coverage lane.",
      pinned: false,
      ttlOverrideSeconds: 7200,
    });
    expect(memorySnapshot.forgetSelectedItem).toHaveBeenCalledTimes(1);
    expect(memorySnapshot.setPolicyDirty).toHaveBeenCalledWith(true);
    expect(memorySnapshot.setPolicyDraft).toHaveBeenCalledTimes(4);
    const policyUpdaters = memorySnapshot.setPolicyDraft.mock.calls
      .map(([updater]) => updater)
      .filter((updater) => typeof updater === "function") as Array<
      (current: typeof memorySnapshot.policyDraft | null) => typeof memorySnapshot.policyDraft | null
    >;
    expect(policyUpdaters[0]?.(null)).toBeNull();
    const policyResults = policyUpdaters.map((updater) => updater(memorySnapshot.policyDraft));
    expect(policyResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enabled: false }),
        expect.objectContaining({ runMode: "scheduled" }),
        expect.objectContaining({ providerId: "anthropic" }),
        expect.objectContaining({ model: "claude-sonnet" }),
      ]),
    );
    expect(memorySnapshot.runMaintenance).toHaveBeenCalledTimes(1);
    expect(memorySnapshot.savePolicy).toHaveBeenCalledTimes(1);
    expect(memorySnapshot.reload).toHaveBeenCalledTimes(1);
    expect(memorySnapshot.resolveRecommendation).toHaveBeenCalledWith("rec-1", "accept");
    expect(memorySnapshot.resolveRecommendation).toHaveBeenCalledWith("rec-1", "reject");
    expect(memorySnapshot.setSelectedRunId).toHaveBeenCalledWith("run-1");
  });

  it("gates memory forget behind a confirmation modal and never forgets without confirm (5.2)", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <MemoryRoutePage
          route={{ area: "library", section: "memory", theme: "library" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      findButton(renderer!.root, "Deployment note").props.onClick();
    });

    // Clicking the trigger opens the modal but must NOT forget yet.
    await act(async () => {
      findButton(renderer!.root, "Forget item").props.onClick();
    });
    const modal = renderer!.root.findByType(ConfirmModal);
    expect(modal.props.open).toBe(true);
    expect(memorySnapshot.forgetSelectedItem).not.toHaveBeenCalled();

    // Cancelling dismisses the modal without forgetting.
    await act(async () => {
      modal.props.onCancel();
    });
    expect(memorySnapshot.forgetSelectedItem).not.toHaveBeenCalled();
    expect(renderer!.root.findByType(ConfirmModal).props.open).toBe(false);

    // Re-opening and confirming performs the forget exactly once.
    await act(async () => {
      findButton(renderer!.root, "Forget item").props.onClick();
    });
    await act(async () => {
      await renderer!.root.findByType(ConfirmModal).props.onConfirm();
    });
    expect(memorySnapshot.forgetSelectedItem).toHaveBeenCalledTimes(1);
  });

  it("refreshes memory write-gate evidence and surfaces envelope load failures", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <MemoryRoutePage
          route={{ area: "library", section: "memory", theme: "library" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(evidenceApiMocks.fetchEvidenceEnvelopes).toHaveBeenCalledWith({ workspaceId: "default", limit: 12 });
    expect(collectText(renderer!.root)).toContain("approved");

    evidenceApiMocks.fetchEvidenceEnvelopes.mockRejectedValueOnce(new Error("evidence route offline"));
    await act(async () => {
      findButton(renderer!.root, "Refresh evidence").props.onClick();
      await Promise.resolve();
    });

    expect(collectText(renderer!.root)).toContain("Evidence envelopes unavailable: evidence route offline");
    expect(collectText(renderer!.root)).toContain("No memory write-gate envelopes recorded yet.");
  });

  it("renders disabled and unknown memory truth without enabling mutation controls", () => {
    const original = {
      selectedItemId: memorySnapshot.selectedItemId,
      selectedRunId: memorySnapshot.selectedRunId,
      selectedItem: memorySnapshot.selectedItem,
      selectedRun: memorySnapshot.selectedRun,
      policyDraft: memorySnapshot.policyDraft,
      policyDirty: memorySnapshot.policyDirty,
      data: memorySnapshot.data,
      notice: memorySnapshot.notice,
    };

    try {
      memorySnapshot.selectedItemId = "";
      memorySnapshot.selectedRunId = "";
      memorySnapshot.selectedItem = null as any;
      memorySnapshot.selectedRun = null as any;
      memorySnapshot.policyDraft = null as any;
      memorySnapshot.policyDirty = false;
      memorySnapshot.notice = { tone: "warning", message: "Memory settings degraded." } as any;
      memorySnapshot.data = {
        ...original.data,
        files: [],
        qmdStats: null,
        memoryItems: [],
        memoryHistory: [],
        maintenanceStatus: null,
        maintenanceRuns: [],
        maintenanceRecommendations: [],
        selectedRunProvenance: null,
        selectedDurableRun: null,
        selectedDurableTimeline: [],
        memoryAdminEnabled: false,
        memoryAdminState: "unknown",
        maintenanceEnabled: false,
        maintenanceDurableReady: false,
        sectionErrors: {
          settings: "settings failed",
          files: "files failed",
          qmdStats: "qmd failed",
          memoryItems: null,
          memoryHistory: "history failed",
          maintenanceStatus: null,
          maintenanceRuns: null,
          maintenanceRecommendations: null,
          selectedRunProvenance: "provenance failed",
          selectedDurableRun: null,
          selectedDurableTimeline: null,
        },
      } as any;

      const markup = renderToStaticMarkup(
        <MemoryRoutePage
          route={{ area: "library", section: "memory", theme: "library" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );

      expect(markup).toContain("Memory settings degraded.");
      expect(markup).toContain("Memory settings truth is unavailable");
      expect(markup).toContain("Memory item truth is unavailable until backend settings truth reloads.");
      expect(markup).toContain("Select a memory item to inspect lifecycle state");
      expect(markup).toContain("Memory maintenance truth is unavailable until backend settings truth reloads.");
      expect(markup).toContain("No maintenance recommendations.");
      expect(markup).toContain("No maintenance runs yet.");
      expect(markup).toContain("Select a maintenance run to inspect provenance.");
      expect(markup).toContain("No recent context packs.");
      expect(markup).toContain("No memory file subspaces discovered.");
    } finally {
      Object.assign(memorySnapshot, original);
    }
  });

  it("renders disabled memory admin truth with selected item reset through mounted effects", async () => {
    const original = {
      selectedItemId: memorySnapshot.selectedItemId,
      selectedItem: memorySnapshot.selectedItem,
      selectedRun: memorySnapshot.selectedRun,
      data: memorySnapshot.data,
    };

    try {
      memorySnapshot.selectedItemId = "";
      memorySnapshot.selectedItem = null as any;
      memorySnapshot.selectedRun = null as any;
      memorySnapshot.data = {
        ...original.data,
        memoryItems: [],
        memoryHistory: [],
        maintenanceEnabled: false,
        maintenanceDurableReady: false,
        memoryAdminState: "disabled",
        maintenanceRecommendations: [],
        maintenanceRuns: [],
      } as any;

      const navigate = vi.fn();
      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = create(
          <MemoryRoutePage
            route={{ area: "library", section: "memory", theme: "library" } as any}
            activeWorkspaceId="default"
            activeWorkspaceName="Default"
            pendingApprovals={0}
            navigate={navigate}
            setActiveWorkspaceId={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      const text = collectText(renderer!.root);
      expect(text).toContain("Memory lifecycle admin is disabled in settings.");
      expect(text).toContain("Continue without durable memory");
      expect(text).toContain("Memory maintenance is not enabled in this workspace.");
      expect(text).toContain("Select a memory item to inspect lifecycle state");
      await act(async () => {
        findButton(renderer!.root, "Open settings").props.onClick();
        findButton(renderer!.root, "Continue without durable memory").props.onClick();
      });
      expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "trust-policy", theme: "library" });
      expect(navigate).toHaveBeenCalledWith({ area: "chat", theme: "library" });
    } finally {
      Object.assign(memorySnapshot, original);
    }
  });
});
