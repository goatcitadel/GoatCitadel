import { expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest, ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine, type ApprovalCreateCommitPort, type ApprovalCreateCommitResult } from "@goatcitadel/policy-engine";
import { buildApprovalReviewEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { KnowledgeFacadeService } from "./memory-facade-service.js";
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


it.each(["Use the local store for project decisions", "  First line\nSecond line\n", "Decision: use the local store. password=private-content-value"])("projects exact redacted content through canonical approval evidence: %s", async content => {
  const harness = createHarness();
  let persisted: ApprovalRequest | undefined;
  const createApproval = vi.fn(async (input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitPort) => {
    persisted = JSON.parse(JSON.stringify(harness.create(input))) as ApprovalRequest;
    await finalizeExtension(onCreated?.(persisted), persisted);
    return persisted;
  });
  const engine = new ToolPolicyEngine(policyConfig, harness.storage, undefined, { createApproval });
  const invokeAndUnwrap = vi.fn((request: ToolInvokeRequest) => engine.invoke({ ...request, workspaceId: "workspace-1", policyContext: createRequest().policyContext }));
  const facade = new KnowledgeFacadeService({ invokeAndUnwrap });
  const input = { namespace: "project-memory", title: "Reviewed decision", content, metadata: { password: "private-metadata-value" } };
  await expect(facade.knowledgeMemoryWrite(input)).resolves.toMatchObject({ outcome: "approval_required", approvalId: "approval-1" });
  expect(persisted?.payload).toEqual(input);
  expect(persisted?.linkage).toMatchObject({ workspaceId: "workspace-1", sessionId: "session:operator:knowledge", toolName: "memory.write" });
  expect(buildApprovalReviewEvidenceModel(persisted?.preview)?.changes).toContainEqual({ label: "Memory content", content: content.replace("private-content-value", "[REDACTED]") });
  expect(persisted?.preview).toMatchObject({ target: "Memory namespace: project-memory", title: "Reviewed decision" });
  expect(JSON.stringify(persisted?.preview)).not.toContain("private-content-value");
  expect(JSON.stringify(persisted?.preview)).not.toContain(input.metadata.password);
  expect(JSON.stringify(persisted?.preview)).toContain("persist");
  expect(JSON.stringify(persisted?.preview)).toContain("workspace-1");
});
it("preserves rejection of a canonical memory approval hook that mutates executable content", async () => {
  const harness = createHarness();
  const engine = new ToolPolicyEngine(policyConfig, harness.storage, undefined, {
    createApproval: async (input, onCreated) => {
      const changed = JSON.parse(JSON.stringify(harness.create(input))) as ApprovalRequest;
      changed.payload = { ...changed.payload, content: "unreviewed replacement" };
      await finalizeExtension(onCreated?.(changed), changed);
      return changed;
    },
  });
  const facade = new KnowledgeFacadeService({ invokeAndUnwrap: request => engine.invoke(request) });
  await expect(facade.knowledgeMemoryWrite({ namespace: "project-memory", title: "Decision", content: "Reviewed content" })).rejects.toThrow("cannot mutate executable tool arguments");
  expect(harness.upsertPending).not.toHaveBeenCalled();
});

it.each(["docs.ingest", "embeddings.index", "embeddings.query"])("projects exact supported Knowledge review under ask-always: %s", async toolName => {
  const harness = createHarness();
  let persisted: ApprovalRequest | undefined;
  const engine = new ToolPolicyEngine({ ...policyConfig, tools: { ...policyConfig.tools, approvalMode: "approve_all" } }, harness.storage, undefined, {
    createApproval: async (input, onCreated) => {
      persisted = JSON.parse(JSON.stringify(harness.create(input))) as ApprovalRequest;
      await finalizeExtension(onCreated?.(persisted), persisted);
      return persisted;
    },
  });
  const value = "  Exact first line\npassword=private-query-value\n";
  await expect(engine.invoke({ ...createRequest(), toolName, args: { namespace: "exact-namespace", query: value, sourceType: "text", source: value, metadata: { password: "private-metadata" } } })).resolves.toMatchObject({ outcome: "approval_required" });
  const evidence = buildApprovalReviewEvidenceModel(persisted?.preview);
  expect(evidence?.changes).toContainEqual({ label: "Knowledge query", content: value.replace("private-query-value", "[REDACTED]") });
  expect(evidence?.changes).toContainEqual({ label: "Knowledge source", content: value.replace("private-query-value", "[REDACTED]") });
  expect(JSON.stringify(evidence)).not.toContain("private-metadata");
  expect(JSON.stringify(evidence)).toContain("session-1");
});
