import { describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest, ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

const policyConfig: ToolPolicyConfig = {
  profiles: { danger: ["*"] },
  tools: {
    profile: "danger",
    approvalMode: "approve_risky",
    allow: [],
    deny: [],
  },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: ["./skills"],
    networkAllowlist: ["localhost"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

function createRequest(): ToolInvokeRequest {
  return {
    toolName: "shell.exec",
    args: { command: "echo canonical-approval" },
    agentId: "agent-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    taskId: "task-1",
    runId: "run-1",
    surface: "chat",
    policyContext: {
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "loopback",
      surface: "chat",
    },
  };
}

type TestApprovalCreateExtension =
  | readonly unknown[]
  | { finalize(finalApproval: ApprovalRequest): readonly unknown[] | undefined }
  | undefined;

function finalizeExtension(extension: TestApprovalCreateExtension, approval: ApprovalRequest): readonly unknown[] {
  if (!extension) {
    return [];
  }
  if (Array.isArray(extension)) {
    return extension;
  }
  if (typeof extension === "object" && "finalize" in extension) {
    return extension.finalize(approval) ?? [];
  }
  return [];
}

function createHarness() {
  const create = vi.fn(
    (input: ApprovalCreateInput): ApprovalRequest => ({
      approvalId: "approval-1",
      kind: input.kind,
      riskLevel: input.riskLevel,
      status: "pending",
      payload: input.payload,
      preview: input.preview,
      linkage: input.linkage,
      createdAt: "2026-07-10T00:00:00.000Z",
      expiresAt: input.expiresAt ?? undefined,
      explanationStatus: "not_requested",
    }),
  );
  const appendAudit = vi.fn(async (stream: string) => {
    if (stream === "approvals") {
      throw new Error("legacy approval audit unavailable");
    }
  });
  const upsertPending = vi.fn();
  const appendApprovalEvent = vi.fn();
  const runDb = vi.fn();
  const storage = {
    approvals: {
      create,
      get: vi.fn(),
    },
    approvalEvents: {
      append: appendApprovalEvent,
    },
    audit: {
      append: appendAudit,
    },
    toolAccessDecisions: {
      record: vi.fn(),
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
    },
    toolGrants: {
      list: vi.fn(() => []),
      consumeOne: vi.fn(() => true),
    },
    pendingApprovalActions: {
      upsertPending,
      find: vi.fn(() => undefined),
      markResolved: vi.fn(),
    },
    db: {
      prepare: vi.fn(() => ({ run: runDb })),
    },
  } as unknown as Storage;

  return { storage, create, appendAudit, upsertPending, appendApprovalEvent, runDb };
}

describe("ToolPolicyEngine canonical approval creation", () => {
  it("returns canonical wait/provenance truth even when the legacy approval audit sink is unavailable", async () => {
    const harness = createHarness();
    const createApproval = vi.fn(
      async (
        input: ApprovalCreateInput,
        onCreated?: (approval: ApprovalRequest) => TestApprovalCreateExtension,
      ): Promise<ApprovalRequest> => {
        const created = harness.create(input);
        const canonical = {
          ...created,
          linkage: {
            ...created.linkage,
            durableRunId: "approval-wait-1",
          },
        };
        finalizeExtension(onCreated?.(created), canonical);
        return canonical;
      },
    );
    const engine = new ToolPolicyEngine(policyConfig, harness.storage, undefined, { createApproval });

    await expect(engine.invoke(createRequest())).resolves.toMatchObject({
      outcome: "approval_required",
      approvalId: "approval-1",
    });

    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "shell.exec",
        linkage: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          taskId: "task-1",
          runId: "run-1",
          originSurface: "chat",
          toolName: "shell.exec",
          actionType: "tool.invoke",
          operatorId: "operator-1",
          authActorId: "operator-1",
          authActorSource: "loopback",
        },
      }),
      expect.any(Function),
    );
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        actionType: "tool.invoke",
      }),
    );
    expect(harness.appendApprovalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_registered",
      }),
    );
    expect(harness.appendAudit).not.toHaveBeenCalledWith("approvals", expect.anything());
  });

  it("does not fall back to direct storage when canonical creation fails before commit", async () => {
    const harness = createHarness();
    const createApproval = vi.fn(async () => {
      throw new Error("approval observability transaction failed");
    });
    const engine = new ToolPolicyEngine(policyConfig, harness.storage, undefined, { createApproval });

    await expect(engine.invoke(createRequest())).rejects.toThrow("approval observability transaction failed");

    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.upsertPending).not.toHaveBeenCalled();
    expect(harness.appendApprovalEvent).not.toHaveBeenCalled();
    expect(harness.appendAudit).not.toHaveBeenCalled();
  });

  it("registers the pending action with the canonical post-hook approval expiry", async () => {
    const harness = createHarness();
    const canonicalExpiresAt = "2026-07-11T00:00:00.000Z";
    const createApproval = vi.fn(
      async (
        input: ApprovalCreateInput,
        onCreated?: (approval: ApprovalRequest) => TestApprovalCreateExtension,
      ): Promise<ApprovalRequest> => {
        const canonical = {
          ...harness.create(input),
          expiresAt: canonicalExpiresAt,
        };
        finalizeExtension(onCreated?.(canonical), canonical);
        return canonical;
      },
    );
    const engine = new ToolPolicyEngine(policyConfig, harness.storage, undefined, { createApproval });

    await expect(engine.invoke(createRequest())).resolves.toMatchObject({ outcome: "approval_required" });

    expect(harness.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        expiresAt: canonicalExpiresAt,
      }),
    );
  });

  it("rolls back when an approval hook mutates executable tool arguments", async () => {
    const harness = createHarness();
    let committedApproval: ApprovalRequest | undefined;
    const createApproval = vi.fn(
      async (
        input: ApprovalCreateInput,
        onCreated?: (approval: ApprovalRequest) => TestApprovalCreateExtension,
      ): Promise<ApprovalRequest> => {
        const mutated = {
          ...harness.create(input),
          payload: { command: "rm -rf workspace" },
        };
        const extension = onCreated?.(mutated);
        finalizeExtension(extension, mutated);
        committedApproval = mutated;
        return mutated;
      },
    );
    const engine = new ToolPolicyEngine(policyConfig, harness.storage, undefined, { createApproval });

    await expect(engine.invoke(createRequest())).rejects.toThrow(/cannot mutate executable tool arguments/i);

    expect(committedApproval).toBeUndefined();
    expect(harness.upsertPending).not.toHaveBeenCalled();
    expect(harness.runDb).not.toHaveBeenCalled();
  });

  it.each([
    {
      seam: "pending action registration",
      fail(harness: ReturnType<typeof createHarness>) {
        harness.upsertPending.mockImplementationOnce(() => {
          throw new Error("pending action registration failed");
        });
      },
    },
    {
      seam: "pending action event",
      fail(harness: ReturnType<typeof createHarness>) {
        harness.appendApprovalEvent.mockImplementationOnce(() => {
          throw new Error("pending action event failed");
        });
      },
    },
    {
      seam: "policy invocation row",
      fail(harness: ReturnType<typeof createHarness>) {
        vi.mocked(harness.storage.db.prepare).mockImplementationOnce(
          () =>
            ({
              run: vi.fn(() => {
                throw new Error("policy invocation row failed");
              }),
            }) as never,
        );
      },
    },
  ])("keeps the approval uncommitted when $seam fails", async ({ fail }) => {
    const harness = createHarness();
    fail(harness);
    let committedApproval: ApprovalRequest | undefined;
    const createApproval = vi.fn(
      async (
        input: ApprovalCreateInput,
        onCreated?: (approval: ApprovalRequest) => TestApprovalCreateExtension,
      ): Promise<ApprovalRequest> => {
        const provisional = harness.create(input);
        finalizeExtension(onCreated?.(provisional), provisional);
        committedApproval = provisional;
        return provisional;
      },
    );
    const engine = new ToolPolicyEngine(policyConfig, harness.storage, undefined, { createApproval });

    await expect(engine.invoke(createRequest())).rejects.toThrow(/failed/);

    expect(committedApproval).toBeUndefined();
  });

  it("commits policy audit delivery to the canonical approval outbox instead of failing after commit", async () => {
    const harness = createHarness();
    harness.appendAudit.mockImplementation(async (stream: string) => {
      if (stream === "tool_invocations") {
        throw new Error("live audit sink unavailable");
      }
    });
    let committedApproval: ApprovalRequest | undefined;
    let committedEffects: readonly unknown[] = [];
    const createApproval = vi.fn(
      async (
        input: ApprovalCreateInput,
        onCreated?: (approval: ApprovalRequest) => TestApprovalCreateExtension,
      ): Promise<ApprovalRequest> => {
        const provisional = harness.create(input);
        committedEffects = finalizeExtension(onCreated?.(provisional), provisional);
        committedApproval = provisional;
        return provisional;
      },
    );
    const engine = new ToolPolicyEngine(policyConfig, harness.storage, undefined, { createApproval });

    await expect(engine.invoke(createRequest())).resolves.toMatchObject({
      outcome: "approval_required",
      approvalId: "approval-1",
    });

    expect(committedApproval).toBeDefined();
    expect(committedEffects).toEqual([
      expect.objectContaining({
        operationId: expect.stringContaining("tool.invoke.approval_required.audit"),
        delivery: expect.objectContaining({
          kind: "audit",
          stream: "tool_invocations",
        }),
      }),
    ]);
    expect(harness.appendAudit).not.toHaveBeenCalledWith("tool_invocations", expect.anything());
  });

  it("returns a truthful blocked result when canonical creation auto-rejects the approval", async () => {
    const harness = createHarness();
    let committedEffects: readonly unknown[] = [];
    const createApproval = vi.fn(
      async (
        input: ApprovalCreateInput,
        onCreated?: (approval: ApprovalRequest) => TestApprovalCreateExtension,
      ): Promise<ApprovalRequest> => {
        const provisional = harness.create(input);
        const extension = onCreated?.(provisional);
        const rejected: ApprovalRequest = {
          ...provisional,
          status: "rejected",
          resolvedAt: "2026-07-10T00:00:01.000Z",
          resolvedBy: "system",
          resolutionNote: "Auto-rejected by shell danger policy.",
        };
        committedEffects = finalizeExtension(extension, rejected);
        return rejected;
      },
    );
    const engine = new ToolPolicyEngine(policyConfig, harness.storage, undefined, { createApproval });

    await expect(engine.invoke(createRequest())).resolves.toMatchObject({
      outcome: "blocked",
      approvalId: "approval-1",
      policyReason: expect.stringContaining("auto-rejected"),
    });

    expect(harness.upsertPending).toHaveBeenCalledTimes(1);
    expect(committedEffects).toEqual([
      expect.objectContaining({
        delivery: expect.objectContaining({
          kind: "audit",
          stream: "tool_invocations",
          payload: expect.objectContaining({ outcome: "blocked" }),
        }),
      }),
    ]);
    expect(harness.runDb).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "agent-1",
      "session-1",
      "task-1",
      "run-1",
      "shell.exec",
      "blocked",
      expect.stringContaining("auto-rejected"),
      expect.any(String),
      null,
      "approval-1",
      null,
      null,
      null,
      "approve_risky",
      '["allowed","approval_mode_risky"]',
    );
  });
});
