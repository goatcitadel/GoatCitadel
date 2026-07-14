import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetailRoutePage } from "./RunDetailRoutePage";

const runTraceHarness = vi.hoisted(() => ({
  exportObserveRunTrace: vi.fn(),
  fetchEvidenceReceipt: vi.fn(),
  fetchObserveRunTrace: vi.fn(),
  fetchOrchestrationRunTrace: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@goatcitadel/mission-control-shared/api/client")>(
    "@goatcitadel/mission-control-shared/api/client",
  );
  return {
    ...actual,
    exportObserveRunTrace: runTraceHarness.exportObserveRunTrace,
    fetchEvidenceReceipt: runTraceHarness.fetchEvidenceReceipt,
    fetchObserveRunTrace: runTraceHarness.fetchObserveRunTrace,
    fetchOrchestrationRunTrace: runTraceHarness.fetchOrchestrationRunTrace,
  };
});

beforeEach(() => {
  runTraceHarness.exportObserveRunTrace.mockReset();
  runTraceHarness.fetchEvidenceReceipt.mockReset();
  runTraceHarness.fetchObserveRunTrace.mockReset();
  runTraceHarness.fetchOrchestrationRunTrace.mockReset();
  runTraceHarness.fetchOrchestrationRunTrace.mockRejectedValue(new Error("not an orchestration run"));
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe("RunDetailRoutePage", () => {
  it("handles traces with no memory or context evidence", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      runId: "run-no-memory",
      status: "completed",
      mode: "chat",
      request: { summary: "Answer a question.", requestedAt: "2026-05-02T19:00:00.000Z" },
      provider: { effectiveProviderId: "openai", effectiveModel: "gpt-5" },
      timeline: [],
      tools: [],
      approvals: [],
      sideEffects: [],
      artifacts: [{ artifactId: "artifact-1", title: "Answer", kind: "markdown" }],
      errors: [],
    });

    const text = await renderText("run-no-memory");

    expect(runTraceHarness.fetchObserveRunTrace).toHaveBeenCalledWith("run-no-memory");
    expect(text).toContain("Memory and context");
    expect(text).toContain("No memory/context evidence is attached to this trace.");
    expect(text).toContain("Trace and SIEM exports");
    expect(text).toContain("/api/v1/observe/runs/run-no-memory/trace/export");
    expect(text).toContain("/api/v1/runtime/lifecycle/export?runId=run-no-memory");
    expect(text).toContain("format=siem_ndjson");
    expect(text).toContain("Expert raw trace");
  });

  it("handles runs with no artifacts", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      runId: "run-no-artifacts",
      status: "completed",
      mode: "cowork",
      request: { summary: "Plan work.", requestedAt: "2026-05-02T19:00:00.000Z" },
      artifacts: [],
      timeline: [],
      tools: [],
      approvals: [],
      sideEffects: [],
      errors: [],
    });

    const text = await renderText("run-no-artifacts");

    expect(text).toContain("Artifacts");
    expect(text).toContain("No artifacts are attached to this run.");
  });

  it("shows why memory citations were used when trace evidence includes provenance", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      runId: "run-memory-why",
      status: "completed",
      mode: "cowork",
      request: { summary: "Use project memory.", requestedAt: "2026-05-02T19:00:00.000Z" },
      memoryContext: {
        state: "available",
        items: [
          {
            contextId: "ctx-1",
            contextText: "Distilled context.",
            quality: { status: "generated" },
            citations: [
              {
                candidateId: "memory:item-1",
                sourceType: "memory_item",
                sourceRef: "memory://item-1",
                snippet: "The operator prefers small verified changes.",
                score: 0.8764,
                provenance: {
                  relationScope: "project",
                  freshness: "recent",
                  retrievalStrategy: "semantic_hints",
                  selectionReason: "selected by semantic-hint retrieval score 0.956",
                  matchSignals: {
                    lexicalScore: 0.606,
                    semanticHintScore: 0.2,
                    recencyScore: 0.1,
                    diversityScore: 0.05,
                    totalScore: 0.956,
                  },
                },
              },
            ],
          },
        ],
      },
      artifacts: [],
      timeline: [],
      tools: [],
      approvals: [],
      sideEffects: [],
      errors: [],
    });

    const text = await renderText("run-memory-why");

    expect(text).toContain("ctx-1");
    expect(text).toContain("Why used: memory://item-1");
    expect(text).toContain("selected by semantic-hint retrieval score 0.956");
    expect(text).toContain("semantic hints");
    expect(text).toContain("signals lexical 0.606, hint 0.200, recency 0.100, diversity 0.050");
    expect(text).toContain("score 0.876");
    expect(text).toContain("project");
  });

  it("shows failed run errors without claiming an automatic retry path", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      runId: "run-failed",
      status: "failed",
      mode: "code",
      request: { summary: "Run validation.", requestedAt: "2026-05-02T19:00:00.000Z" },
      trace: {
        status: "failed",
        failure: {
          failureClass: "provider_timeout",
          message: "Provider timed out.",
          retryable: true,
          recommendedAction: "retry",
        },
      },
      errors: [{ kind: "provider_timeout", message: "Provider timed out.", retryable: true }],
      artifacts: [],
      sideEffects: [],
    });

    const text = await renderText("run-failed");

    expect(text).toContain("failed");
    expect(text).toContain("Provider timed out.");
    expect(text).toContain("This panel reports available evidence; it does not start replay.");
  });

  it("labels audit-only side effects distinctly", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      runId: "run-audit-side-effect",
      status: "completed",
      mode: "chat",
      request: { summary: "Check connector posture.", requestedAt: "2026-05-02T19:00:00.000Z" },
      sideEffects: [
        {
          effectId: "effect-1",
          effectKind: "connector.delivery",
          targetKind: "connector",
          targetId: "gmail",
          status: "completed",
          auditOnly: true,
          description: "Recorded connector delivery check.",
        },
      ],
      artifacts: [],
      errors: [],
    });

    const text = await renderText("run-audit-side-effect");

    expect(text).toContain("Recorded connector delivery check.");
    expect(text).toContain("Audit-only");
  });

  it("projects tool effect truth with inspect-before-retry guidance and verified receipts only", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      runId: "run-effect-truth",
      status: "failed",
      mode: "chat",
      request: { summary: "Run governed tools.", requestedAt: "2026-07-13T19:00:00.000Z" },
      tools: [
        {
          toolRunId: "tool-uncertain",
          toolName: "http.post",
          status: "failed",
          effectPotential: "unknown",
          effectDisposition: "unknown",
          effectOutcomeKind: "uncertain",
          effectEvidence: {
            outcomeKind: "uncertain",
            reason: "dispatch_may_have_occurred",
            refs: [{ owner: "external_side_effect", refId: "unverified-ref" }],
          },
        },
        {
          toolRunId: "tool-concrete",
          toolName: "code_mode.run",
          status: "executed",
          effectPotential: "unknown",
          effectOutcomeKind: "concrete",
          effectEvidence: {
            outcomeKind: "concrete",
            reason: "canonical_effect_receipt_linked",
            refs: [{ owner: "code_mode", refId: "verified-code-run" }],
          },
        },
      ],
      artifacts: [],
      approvals: [],
      sideEffects: [],
      errors: [],
    });

    const text = await renderText("run-effect-truth");
    const trustedProjectionText = text.split("Expert raw trace")[0] ?? text;

    expect(trustedProjectionText).toContain("effect potential unknown");
    expect(trustedProjectionText).toContain("disposition unknown");
    expect(trustedProjectionText).toContain("outcome uncertain");
    expect(trustedProjectionText).toContain("evidence dispatch_may_have_occurred");
    expect(trustedProjectionText).toContain("Inspect external or runtime state before retry");
    expect(trustedProjectionText).toContain("verify it against the signed canonical owner receipt");
    expect(trustedProjectionText).not.toContain("Verified effect receipt");
    expect(trustedProjectionText).not.toContain("verified-code-run");
    expect(trustedProjectionText).not.toContain("unverified-ref");
    expect(text).toContain("Expert raw trace (diagnostic)");
    expect(text).toContain("Raw IDs and refs are not trusted effect evidence");
  });

  it("surfaces missing and unavailable evidence states outside raw JSON", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      version: "observe.run_trace.v1",
      generatedAt: "2026-05-02T19:00:00.000Z",
      runId: "run-partial-evidence",
      run: { runId: "run-partial-evidence", status: "completed", workflowKey: "cowork" },
      durable: {
        checkpoints: { state: "available", items: [] },
        timeline: { state: "available", items: [] },
      },
      lifecycle: { state: "unknown", error: "Lifecycle trace not retained." },
      session: { state: "not_available" },
      thread: { state: "available", turns: [] },
      approvals: { state: "unknown", items: [], missingIds: ["approval-missing-1"] },
      toolCalls: { state: "available", items: [] },
      memoryContext: { state: "not_available", items: [], error: "Memory context repo offline." },
      providerUsage: { state: "unknown", items: [], totals: {} },
      artifacts: { state: "not_available", items: [], error: "Artifact index unavailable." },
      errors: { state: "available", items: [] },
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        audit: { state: "available", note: "read-only" },
        replay: { state: "not_available", checkpointIds: [], note: "No replay." },
        resume: { eligible: false, note: "No resume." },
      },
    });

    const text = await renderText("run-partial-evidence");

    expect(text).toContain("Evidence availability");
    expect(text).toContain("Approvals unknown");
    expect(text).toContain("Missing approval evidence");
    expect(text).toContain("approval-missing-1");
    expect(text).toContain("Memory context not available");
    expect(text).toContain("Memory context repo offline.");
    expect(text).toContain("Artifacts not available");
    expect(text).toContain("Artifact index unavailable.");
    expect(text).toContain("Lifecycle trace not retained.");
  });

  it("surfaces external side-effect replay audit checkpoints outside raw JSON", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      version: "observe.run_trace.v1",
      generatedAt: "2026-05-02T19:00:00.000Z",
      runId: "run-replay-audit",
      run: { runId: "run-replay-audit", status: "completed", workflowKey: "external_side_effect.replay" },
      request: { summary: "Replay external side effects.", requestedAt: "2026-05-02T19:00:00.000Z" },
      durable: {
        checkpoints: {
          state: "available",
          items: [
            {
              checkpointKind: "run_completed",
              state: {
                workflow: "external_side_effect.replay",
                replayAuditResults: [
                  {
                    runId: "extfx-missing",
                    status: "not_found",
                    reason: "requested_run_missing",
                    message: "Requested external side-effect run was not found.",
                  },
                  {
                    runId: "extfx-blocked",
                    status: "blocked",
                    reason: "idempotency_blocked",
                    message: "Replay claim was blocked by idempotency policy.",
                    replayOutcome: "already_claimed",
                    replayAttempt: "blocked",
                  },
                ],
              },
            },
          ],
        },
      },
      artifacts: [],
      errors: [],
    });

    const text = await renderText("run-replay-audit");

    expect(text).toContain("Replay audit checkpoints");
    expect(text).toContain("Missing run extfx-missing");
    expect(text).toContain("requested_run_missing");
    expect(text).toContain("Blocked replay extfx-blocked");
    expect(text).toContain("idempotency_blocked");
    expect(text).toContain("Replay claim was blocked by idempotency policy.");
  });

  it("surfaces orchestration decision trace evidence outside raw JSON", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      runId: "orch-run-1",
      status: "paused",
      mode: "orchestration.plan.execute",
      request: { summary: "Run a durable Cowork orchestration.", requestedAt: "2026-05-02T19:00:00.000Z" },
      artifacts: [],
      timeline: [],
      tools: [],
      approvals: [],
      sideEffects: [],
      errors: [],
    });
    runTraceHarness.fetchOrchestrationRunTrace.mockResolvedValueOnce({
      run: { runId: "orch-run-1", status: "paused", planId: "plan-1" },
      decisions: [
        {
          decisionId: "event-policy",
          runId: "orch-run-1",
          kind: "policy_checked",
          source: "run_event",
          sourceId: "event-policy",
          eventType: "policy.checked",
          createdAt: "2026-05-02T19:00:01.000Z",
          summary: "policy checked",
          details: {
            gate: "pre_phase",
            trigger: "orchestration.phase.before",
            entityType: "orchestration_phase",
            outcome: "allowed",
            phaseId: "phase-1",
            approvalRequired: true,
          },
        },
        {
          decisionId: "event-phase",
          runId: "orch-run-1",
          kind: "phase_completed",
          source: "run_event",
          sourceId: "event-phase",
          eventType: "phase.executed",
          phaseId: "phase-1",
          createdAt: "2026-05-02T19:00:02.000Z",
          summary: "phase completed phase phase-1 model gpt-test",
          details: {
            phaseId: "phase-1",
            model: "gpt-test",
            costUsd: 0.25,
            inputTokens: 100,
            outputTokens: 40,
            childSessionId: "child-session-1",
            childTurnId: "turn-1",
            childRunId: "child-run-1",
            prompt: {
              promptId: "orchestration.durable.phase.execute",
              promptVersion: "v1",
              promptHash: "sha256:abc123",
            },
          },
        },
        {
          decisionId: "event-wait",
          runId: "orch-run-1",
          kind: "phase_wait_registered",
          source: "run_event",
          sourceId: "event-wait",
          eventType: "phase.waiting",
          phaseId: "phase-2",
          createdAt: "2026-05-02T19:00:03.000Z",
          summary: "phase wait registered phase phase-2",
          details: { phaseId: "phase-2", approvalId: "approval-1", status: "waiting" },
        },
        {
          decisionId: "event-resume",
          runId: "orch-run-1",
          kind: "run_resumed",
          source: "run_event",
          sourceId: "event-resume",
          eventType: "phase.approved",
          phaseId: "phase-2",
          createdAt: "2026-05-02T19:00:04.000Z",
          summary: "run resumed",
          details: { phaseId: "phase-2", resumeRequested: true },
        },
        {
          decisionId: "event-failure",
          runId: "orch-run-1",
          kind: "phase_failed",
          source: "run_event",
          sourceId: "event-failure",
          eventType: "phase.failed",
          phaseId: "phase-3",
          createdAt: "2026-05-02T19:00:05.000Z",
          summary: "phase failed",
          details: { phaseId: "phase-3", status: "failed", error: "Child phase failed." },
        },
      ],
    });

    const text = await renderText("orch-run-1", "workspace-ops");

    expect(runTraceHarness.fetchOrchestrationRunTrace).toHaveBeenCalledWith("orch-run-1", {
      workspaceId: "workspace-ops",
    });
    expect(text).toContain("Orchestration decisions");
    expect(text).toContain("policy_checked");
    expect(text).toContain("pre_phase");
    expect(text).toContain("approval required");
    expect(text).toContain("Prompt orchestration.durable.phase.execute");
    expect(text).toContain("sha256:abc123");
    expect(text).toContain("Model gpt-test");
    expect(text).toContain("cost $0.2500");
    expect(text).toContain("Child lineage for phase-1");
    expect(text).toContain("session child-session-1");
    expect(text).toContain("Wait evidence");
    expect(text).toContain("approval approval-1");
    expect(text).toContain("Resume evidence");
    expect(text).toContain("phase_failed");
    expect(text).toContain("Child phase failed.");
  });

  it("does not treat normal empty trace groups as unavailable evidence", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      version: "observe.run_trace.v1",
      generatedAt: "2026-05-02T19:00:00.000Z",
      runId: "run-empty-optionals",
      run: { runId: "run-empty-optionals", status: "completed", workflowKey: "chat" },
      durable: {
        checkpoints: { state: "not_available", items: [] },
        timeline: { state: "not_available", items: [] },
      },
      lifecycle: { state: "available", response: { turns: [], toolRuns: [] } },
      session: { state: "not_available" },
      thread: { state: "not_available", turns: [] },
      approvals: { state: "not_available", items: [], missingIds: [] },
      toolCalls: { state: "not_available", items: [] },
      memoryContext: { state: "not_available", items: [] },
      providerUsage: { state: "not_available", items: [], totals: {} },
      artifacts: { state: "not_available", items: [] },
      errors: { state: "not_available", items: [] },
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        audit: { state: "available", note: "read-only" },
        replay: { state: "not_available", checkpointIds: [], note: "No replay." },
        resume: { eligible: false, note: "No resume." },
      },
    });

    const text = await renderText("run-empty-optionals");

    expect(text).toContain("Evidence availability");
    expect(text).toContain("No missing, unknown, or error-qualified evidence groups need attention.");
    expect(text).not.toContain("Errors not available");
    expect(text).not.toContain("Artifacts not available");
    expect(text).not.toContain("Approvals not available");
  });

  it("copies a read-only run trace export without replaying the run", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      runId: "run-export",
      status: "completed",
      mode: "chat",
      request: { summary: "Export evidence.", requestedAt: "2026-05-02T19:00:00.000Z" },
      artifacts: [],
      errors: [],
    });
    runTraceHarness.exportObserveRunTrace.mockResolvedValueOnce({
      version: "observe.run_trace_export.v1",
      generatedAt: "2026-05-02T19:01:00.000Z",
      runId: "run-export",
      format: "json",
      contentType: "application/json",
      filename: "goatcitadel-run-trace-run-export.json",
      sourceEndpoint: "/api/v1/observe/runs/run-export/trace",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        note: "read-only",
      },
      trace: {} as never,
      content: '{"runId":"run-export"}',
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <RunDetailRoutePage
          route={{ area: "ops", section: "sessions", view: "run-detail", runId: "run-export", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      findButton(renderer!.root, "Copy trace export").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runTraceHarness.exportObserveRunTrace).toHaveBeenCalledWith("run-export");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('{"runId":"run-export"}');
    expect(collectText(renderer!.root)).toContain("Copied trace export goatcitadel-run-trace-run-export.json.");
    act(() => {
      renderer!.unmount();
    });
  });

  it("downloads a signed evidence receipt as pretty-printed JSON", async () => {
    runTraceHarness.fetchObserveRunTrace.mockResolvedValueOnce({
      runId: "run-receipt",
      status: "completed",
      mode: "chat",
      request: { summary: "Prove the run.", requestedAt: "2026-05-02T19:00:00.000Z" },
      artifacts: [],
      errors: [],
    });
    const receipt = {
      manifest: { schemaVersion: "1.0.0", runId: "run-receipt", generatedAt: "2026-05-02T19:01:00.000Z" },
      contentHash: "abc123",
      hashAlgorithm: "sha256",
      signatureAlgorithm: "ed25519",
      signature: "sig==",
      publicKey: "pub==",
    };
    runTraceHarness.fetchEvidenceReceipt.mockResolvedValueOnce(receipt);

    // This suite runs in the Node test environment (no jsdom), so the component's browser-download
    // path has no DOM. Provide the minimal document/URL surface the handler touches, then restore it.
    const click = vi.fn();
    const anchor = { href: "", download: "", click } as unknown as HTMLAnchorElement;
    const appendChild = vi.fn((node: unknown) => node);
    const removeChild = vi.fn((node: unknown) => node);
    const createElement = vi.fn(() => anchor);
    const createObjectURL = vi.fn().mockReturnValue("blob:receipt");
    const revokeObjectURL = vi.fn();
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const urlDescriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement, body: { appendChild, removeChild } },
    });
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: { createObjectURL, revokeObjectURL },
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <RunDetailRoutePage
          route={{ area: "ops", section: "sessions", view: "run-detail", runId: "run-receipt", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      findButton(renderer!.root, "Download evidence receipt").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runTraceHarness.fetchEvidenceReceipt).toHaveBeenCalledWith("run-receipt");
    expect(createElement).toHaveBeenCalledWith("a");
    expect(anchor.download).toBe("evidence-receipt-run-receipt.json");
    expect(anchor.href).toBe("blob:receipt");
    expect(click).toHaveBeenCalledTimes(1);
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(removeChild).toHaveBeenCalledWith(anchor);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:receipt");
    expect(collectText(renderer!.root)).toContain(
      "Downloaded signed evidence receipt evidence-receipt-run-receipt.json.",
    );

    if (documentDescriptor) {
      Object.defineProperty(globalThis, "document", documentDescriptor);
    } else {
      delete (globalThis as Record<string, unknown>).document;
    }
    if (urlDescriptor) {
      Object.defineProperty(globalThis, "URL", urlDescriptor);
    } else {
      delete (globalThis as Record<string, unknown>).URL;
    }
    act(() => {
      renderer!.unmount();
    });
  });
});

async function renderText(runId: string, workspaceId = "default"): Promise<string> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <RunDetailRoutePage
        route={{ area: "ops", section: "sessions", view: "run-detail", runId, theme: "ops" } as any}
        activeWorkspaceId={workspaceId}
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  const text = collectText(renderer!.root);
  act(() => {
    renderer!.unmount();
  });
  return text;
}

function collectText(node: ReactTestInstance | unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return (node as ReactTestInstance).children.map(collectText).join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0]!;
}
