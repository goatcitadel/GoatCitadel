import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetailRoutePage } from "./RunDetailRoutePage";

const runTraceHarness = vi.hoisted(() => ({
  exportObserveRunTrace: vi.fn(),
  fetchObserveRunTrace: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@goatcitadel/mission-control-shared/api/client")>(
    "@goatcitadel/mission-control-shared/api/client",
  );
  return {
    ...actual,
    exportObserveRunTrace: runTraceHarness.exportObserveRunTrace,
    fetchObserveRunTrace: runTraceHarness.fetchObserveRunTrace,
  };
});

beforeEach(() => {
  runTraceHarness.exportObserveRunTrace.mockReset();
  runTraceHarness.fetchObserveRunTrace.mockReset();
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
});

async function renderText(runId: string): Promise<string> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <RunDetailRoutePage
        route={{ area: "ops", section: "sessions", view: "run-detail", runId, theme: "ops" } as any}
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
