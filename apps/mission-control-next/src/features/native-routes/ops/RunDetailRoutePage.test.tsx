import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetailRoutePage } from "./RunDetailRoutePage";

const runTraceHarness = vi.hoisted(() => ({
  fetchObserveRunTrace: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@goatcitadel/mission-control-shared/api/client")>(
    "@goatcitadel/mission-control-shared/api/client",
  );
  return {
    ...actual,
    fetchObserveRunTrace: runTraceHarness.fetchObserveRunTrace,
  };
});

beforeEach(() => {
  runTraceHarness.fetchObserveRunTrace.mockReset();
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
