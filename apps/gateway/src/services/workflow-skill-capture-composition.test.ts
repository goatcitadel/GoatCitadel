import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalChatAdmissionReleaseOutcome } from "./durable-run-service.js";
import { createWorkflowSkillCaptureForGateway } from "./workflow-skill-capture-composition.js";

const { captureDependencies } = vi.hoisted(() => ({ captureDependencies: vi.fn() }));
vi.mock("./workflow-skill-capture-service.js", () => ({
  WorkflowSkillCaptureService: class {
    public constructor(dependencies: unknown) {
      captureDependencies(dependencies);
    }
  },
}));

const identity = { runId: "source-run", workspaceId: "workspace", sessionId: "session", turnId: "source-turn" };
type Reconcile = (request: typeof identity & { timeoutMs: number }) => Promise<TerminalChatAdmissionReleaseOutcome>;

function result(
  recoveryOutcome: TerminalChatAdmissionReleaseOutcome["recoveryOutcome"],
  durableRunStatus: TerminalChatAdmissionReleaseOutcome["durableRunStatus"],
): TerminalChatAdmissionReleaseOutcome {
  return { recoveryOutcome, durableRunStatus, elapsedMs: 30_000, remainingBudgetMs: 0 };
}

function composeWait(reconcile: Reconcile) {
  createWorkflowSkillCaptureForGateway({
    storage: {},
    config: { rootDir: ".", assistant: { capabilities: { candidateRoot: "candidates" } } },
    chatMessageRouteRuntimeHost: { durableRunService: { awaitTerminalChatAdmissionRelease: reconcile } },
  } as Parameters<typeof createWorkflowSkillCaptureForGateway>[0]);
  return (
    captureDependencies.mock.lastCall?.[0] as {
      waitForTerminalAdmission: (source: typeof identity) => Promise<boolean>;
    }
  ).waitForTerminalAdmission;
}

beforeEach(() => captureDependencies.mockClear());

describe("workflow capture terminal admission wait", () => {
  it("keeps the source identity across windows when finalizers outlive the first wait", async () => {
    const reconcile = vi
      .fn<Reconcile>()
      .mockResolvedValueOnce(result("not_terminal", "running"))
      .mockResolvedValueOnce(result("reconciliation_pending", "completed"))
      .mockResolvedValueOnce(result("released", "completed"));

    await expect(composeWait(reconcile)(identity)).resolves.toBe(true);
    expect(reconcile.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ ...identity, timeoutMs: 30_000 }]));
  });

  it("stops on a lineage mismatch", async () => {
    const reconcile = vi.fn<Reconcile>().mockResolvedValue(result("lineage_mismatch", "completed"));

    await expect(composeWait(reconcile)(identity)).resolves.toBe(false);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("bounds the total wait if the source never releases", async () => {
    const reconcile = vi.fn<Reconcile>().mockResolvedValue(result("reconciliation_pending", "completed"));

    await expect(composeWait(reconcile)(identity)).resolves.toBe(false);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });
});
