import { describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest, ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import type { ApprovalCreateCommitPort, ApprovalCreateCommitResult } from "./approval-gate.js";
import { ToolPolicyEngine } from "./engine.js";

const policyConfig: ToolPolicyConfig = {
  tools: {
    approvalMode: "approve_risky",
    allow: ["*"],
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

async function finalizeExtension(
  extension: ApprovalCreateCommitResult | Promise<ApprovalCreateCommitResult> | undefined,
  approval: ApprovalRequest,
): Promise<readonly unknown[]> {
  const resolvedExtension = await extension;
  if (!resolvedExtension) {
    return [];
  }
  if (Array.isArray(resolvedExtension)) {
    return resolvedExtension;
  }
  if (typeof resolvedExtension === "object" && "finalize" in resolvedExtension) {
    return (await resolvedExtension.finalize(approval)) ?? [];
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
      expiresAt: input.expiresAt ?? "2026-07-10T00:15:00.000Z",
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
    runImmediateTransaction: vi.fn(async <T>(work: () => T | Promise<T>): Promise<T> => await work()),
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
      listActive: vi.fn(() => []),
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
  } as unknown as Storage & AsyncStorage;

  return { storage, create, appendAudit, upsertPending, appendApprovalEvent, runDb };
}

describe("ToolPolicyEngine canonical approval creation", () => {
  it.each([
    { toolName: "memory.search", args: { query: "launch decisions" }, preview: { query: "launch decisions" } },
    { toolName: "git.commit", args: { message: "Record changes" }, preview: { input: "Record changes" } },
    { toolName: "git.branch.switch", args: { branch: "review" }, preview: { branchTarget: "review" } },
    { toolName: "git.add", args: { paths: ["workspace/notes.md"] }, preview: { paths: ["workspace/notes.md"] } },
    { toolName: "browser.search", args: { query: "launch decisions" }, preview: { input: "launch decisions" } },
    {
      toolName: "session.history",
      args: { messageId: "anchor-1", sequence: 42 },
      preview: { target: "This conversation", input: "Message anchor-1, sequence 42" },
    },
    {
      toolName: "schedule.manage",
      args: { op: "cancel", jobId: "morning-briefing" },
      preview: { target: "Schedule morning-briefing" },
    },
    {
      toolName: "schedule.manage",
      args: { op: "create", schedule: "0 9 * * 1", prompt: "Summarize the week" },
      preview: { scheduleSummary: "0 9 * * 1", input: "Summarize the week" },
    },
    {
      toolName: "notify.request",
      args: { eventType: "turn.completed", title: "Report ready", message: "The report is ready to review." },
      preview: { title: "Report ready", input: "The report is ready to review." },
    },
  ])("saves review evidence when policy requires approval for $toolName", async ({ toolName, args, preview }) => {
    const harness = createHarness();
    const createApproval = vi.fn(async (input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitPort) => {
      const created = harness.create(input);
      await finalizeExtension(onCreated?.(created), created);
      return created;
    });
    const engine = new ToolPolicyEngine(
      { ...policyConfig, tools: { ...policyConfig.tools, approvalMode: "approve_all" } },
      harness.storage,
      undefined,
      { createApproval },
    );
    await expect(engine.invoke({ ...createRequest(), toolName, args })).resolves.toMatchObject({
      outcome: "approval_required",
    });
    expect(harness.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: toolName, payload: args, preview: expect.objectContaining(preview) }),
    );
  });

  it("returns canonical wait/provenance truth even when the legacy approval audit sink is unavailable", async () => {
    const harness = createHarness();
    const createApproval = vi.fn(
      async (input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitPort): Promise<ApprovalRequest> => {
        const created = harness.create(input);
        const canonical = {
          ...created,
          linkage: {
            ...created.linkage,
            durableRunId: "approval-wait-1",
          },
        };
        await finalizeExtension(onCreated?.(created), canonical);
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
      { ttlMs: 15 * 60_000 },
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
      async (input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitPort): Promise<ApprovalRequest> => {
        const canonical = {
          ...harness.create(input),
          expiresAt: canonicalExpiresAt,
        };
        await finalizeExtension(onCreated?.(canonical), canonical);
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
      async (input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitPort): Promise<ApprovalRequest> => {
        const mutated = {
          ...harness.create(input),
          payload: { command: "rm -rf workspace" },
        };
        const extension = onCreated?.(mutated);
        await finalizeExtension(extension, mutated);
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
      async (input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitPort): Promise<ApprovalRequest> => {
        const provisional = harness.create(input);
        await finalizeExtension(onCreated?.(provisional), provisional);
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
      async (input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitPort): Promise<ApprovalRequest> => {
        const provisional = harness.create(input);
        committedEffects = await finalizeExtension(onCreated?.(provisional), provisional);
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
      async (input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitPort): Promise<ApprovalRequest> => {
        const provisional = harness.create(input);
        const extension = onCreated?.(provisional);
        const rejected: ApprovalRequest = {
          ...provisional,
          status: "rejected",
          resolvedAt: "2026-07-10T00:00:01.000Z",
          resolvedBy: "system",
          resolutionNote: "Auto-rejected by shell danger policy.",
        };
        committedEffects = await finalizeExtension(extension, rejected);
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
