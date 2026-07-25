import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalCreateInput, ApprovalRequest, CitadelWard } from "@goatcitadel/contracts";
import { buildChatCompactionAttemptId, ChatConversationSummaryRepository, createDatabase } from "@goatcitadel/storage";
import {
  createChatCompactionBreakerActionServiceForGateway,
  type ChatCompactionBreakerRuntimeHost,
} from "./chat-compaction-breaker-runtime-service.js";

const NOW = new Date("2026-07-14T08:00:00.000Z");
const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
  }
});

describe("Gateway chat compaction breaker runtime adapter", () => {
  it("accepts only an exact, unexpired, workspace-bound approved decision and commits sanitized audit", async () => {
    const fixture = createFixture();
    try {
      const breaker = tripBreaker(fixture.repo);
      const approvalResponse = await fixture.service.requestApproval({
        sessionId: "session-1",
        actorId: "token:raw-operator-secret",
        request: requestFor(breaker.revision),
      });
      expect(fixture.createApproval.mock.calls[0]![1]).toEqual({ ttlMs: 90_000 });
      fixture.approval = {
        ...approvalResponse.approval,
        status: "approved",
        resolvedAt: NOW.toISOString(),
        resolvedBy: "operator:reviewer",
      };

      const action = await fixture.service.createAction({
        sessionId: "session-1",
        actorId: "token:raw-operator-secret",
        request: {
          ...requestFor(breaker.revision),
          approvalId: fixture.approval.approvalId,
        },
      });

      expect(action).toMatchObject({ status: "pending", approvalId: fixture.approval.approvalId });
      expect(fixture.auditAppend).toHaveBeenCalledTimes(1);
      const auditCall = fixture.auditAppend.mock.calls[0]!;
      expect(auditCall[0]).toBe("approvals");
      expect(auditCall[1]).toMatchObject({
        schemaVersion: "chat_compaction_breaker_action_audit.v1",
        actionId: action.actionId,
        actorHash: action.actorHash,
        actionStatus: "pending",
      });
      expect(auditCall[2]).toEqual({ deliveryId: `chat-compaction-breaker-action:${action.actionId}` });
      expect(JSON.stringify(auditCall)).not.toContain("raw-operator-secret");
    } finally {
      fixture.db.close();
    }
  });

  it("lets a deny Ward win over an otherwise exact approved recovery", async () => {
    const fixture = createFixture([
      { name: "block breaker recovery", actionPattern: "chat.compaction_breaker.*", effect: "deny" },
    ]);
    try {
      const breaker = tripBreaker(fixture.repo);
      const approvalResponse = await fixture.service.requestApproval({
        sessionId: "session-1",
        actorId: "token:operator-1",
        request: requestFor(breaker.revision),
      });
      fixture.approval = {
        ...approvalResponse.approval,
        status: "approved",
        resolvedAt: NOW.toISOString(),
        resolvedBy: "operator:reviewer",
      };
      const action = await fixture.service.createAction({
        sessionId: "session-1",
        actorId: "token:operator-1",
        request: {
          ...requestFor(breaker.revision),
          approvalId: fixture.approval.approvalId,
        },
      });

      expect(action).toMatchObject({ status: "rejected", rejectionReason: "Denied by deny-wins policy" });
      expect(fixture.auditAppend).toHaveBeenCalledWith(
        "approvals",
        expect.objectContaining({ actionStatus: "rejected" }),
        expect.any(Object),
      );
    } finally {
      fixture.db.close();
    }
  });

  it("revalidates current deny-wins policy and approval state before a pending force action executes", async () => {
    const wards: CitadelWard[] = [];
    const fixture = createFixture(wards);
    try {
      const breaker = tripBreaker(fixture.repo);
      const approvalResponse = await fixture.service.requestApproval({
        sessionId: "session-1",
        actorId: "token:operator-1",
        request: requestFor(breaker.revision),
      });
      fixture.approval = {
        ...approvalResponse.approval,
        status: "approved",
        resolvedAt: NOW.toISOString(),
        resolvedBy: "operator:reviewer",
      };
      const action = await fixture.service.createAction({
        sessionId: "session-1",
        actorId: "token:operator-1",
        request: {
          ...requestFor(breaker.revision),
          approvalId: fixture.approval.approvalId,
        },
      });

      expect(
        fixture.service.resolvePendingForceAction({
          sessionId: "session-1",
          sealedDimensionHash: "dimension-a",
          actorId: "token:operator-1",
        }),
      ).toEqual({ actionId: action.actionId, actorHash: action.actorHash });

      wards.push({ name: "late deny", actionPattern: "chat.compaction_breaker.*", effect: "deny" });
      expect(
        fixture.service.resolvePendingForceAction({
          sessionId: "session-1",
          sealedDimensionHash: "dimension-a",
          actorId: "token:operator-1",
        }),
      ).toBeUndefined();

      wards.splice(0);
      fixture.approval = { ...fixture.approval, status: "edited" };
      expect(
        fixture.service.resolvePendingForceAction({
          sessionId: "session-1",
          sealedDimensionHash: "dimension-a",
          actorId: "token:operator-1",
        }),
      ).toBeUndefined();
    } finally {
      fixture.db.close();
    }
  });

  it.each([
    ["expired", (approval: ApprovalRequest) => ({ ...approval, expiresAt: NOW.toISOString() })],
    [
      "too-short",
      (approval: ApprovalRequest) => ({ ...approval, expiresAt: new Date(NOW.getTime() + 29_000).toISOString() }),
    ],
    [
      "too-long",
      (approval: ApprovalRequest) => ({ ...approval, expiresAt: new Date(NOW.getTime() + 301_000).toISOString() }),
    ],
    [
      "future-created",
      (approval: ApprovalRequest) => ({ ...approval, createdAt: new Date(NOW.getTime() + 1_000).toISOString() }),
    ],
    [
      "resolution-before-creation",
      (approval: ApprovalRequest) => ({ ...approval, resolvedAt: new Date(NOW.getTime() - 1).toISOString() }),
    ],
    [
      "future-resolution",
      (approval: ApprovalRequest) => ({ ...approval, resolvedAt: new Date(NOW.getTime() + 1_000).toISOString() }),
    ],
    [
      "resolution-after-expiry",
      (approval: ApprovalRequest) => ({
        ...approval,
        createdAt: new Date(NOW.getTime() - 120_000).toISOString(),
        expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
        resolvedAt: new Date(NOW.getTime() + 31_000).toISOString(),
      }),
    ],
    [
      "payload-mismatched",
      (approval: ApprovalRequest) => ({ ...approval, payload: { ...approval.payload, actorHash: "sha256:tampered" } }),
    ],
    [
      "workspace-mismatched",
      (approval: ApprovalRequest) => ({
        ...approval,
        linkage: { ...approval.linkage, workspaceId: "workspace-other" },
      }),
    ],
  ])("rejects %s approval evidence", async (_label, mutateApproval) => {
    const fixture = createFixture();
    try {
      const breaker = tripBreaker(fixture.repo);
      const approvalResponse = await fixture.service.requestApproval({
        sessionId: "session-1",
        actorId: "token:operator-1",
        request: requestFor(breaker.revision),
      });
      fixture.approval = mutateApproval({
        ...approvalResponse.approval,
        status: "approved",
        resolvedAt: NOW.toISOString(),
        resolvedBy: "operator:reviewer",
      });
      const action = await fixture.service.createAction({
        sessionId: "session-1",
        actorId: "token:operator-1",
        request: {
          ...requestFor(breaker.revision),
          approvalId: fixture.approval.approvalId,
        },
      });
      expect(action.status).toBe("rejected");
      expect(
        fixture.service.resolvePendingForceAction({
          sessionId: "session-1",
          sealedDimensionHash: "dimension-a",
          actorId: "token:operator-1",
        }),
      ).toBeUndefined();
    } finally {
      fixture.db.close();
    }
  });

  it("does not persist an action when the production audit owner fails", async () => {
    const fixture = createFixture();
    try {
      const breaker = tripBreaker(fixture.repo);
      const approvalResponse = await fixture.service.requestApproval({
        sessionId: "session-1",
        actorId: "token:operator-1",
        request: requestFor(breaker.revision),
      });
      fixture.approval = {
        ...approvalResponse.approval,
        status: "approved",
        resolvedAt: NOW.toISOString(),
        resolvedBy: "operator:reviewer",
      };
      fixture.auditAppend.mockRejectedValueOnce(new Error("audit unavailable"));
      await expect(
        fixture.service.createAction({
          sessionId: "session-1",
          actorId: "token:operator-1",
          request: {
            ...requestFor(breaker.revision),
            approvalId: fixture.approval.approvalId,
          },
        }),
      ).rejects.toThrow("audit unavailable");
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM chat_compaction_breaker_actions").get()).toMatchObject({
        count: 0,
      });
    } finally {
      fixture.db.close();
    }
  });
});

function createFixture(wards: CitadelWard[] = []) {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-compaction-runtime-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  const repo = new ChatConversationSummaryRepository(db);
  const auditAppend = vi.fn(async () => undefined);
  const fixture: {
    approval?: ApprovalRequest;
  } = {};
  const storage = {
    approvals: {
      get: (approvalId: string) => {
        if (!fixture.approval || fixture.approval.approvalId !== approvalId) {
          throw new Error(`unexpected approval ${approvalId}`);
        }
        return fixture.approval;
      },
    },
    audit: { append: auditAppend },
    chatConversationSummaries: repo,
    chatSessionMeta: { get: () => ({ workspaceId: "workspace-1" }) },
    citadels: { listWards: () => wards },
    sessions: { getBySessionId: () => ({ sessionId: "session-1" }) },
    workspaces: { find: () => ({ citadelId: "personal" }) },
  } as unknown as ChatCompactionBreakerRuntimeHost["storage"];
  const createApproval = vi.fn(
    async (input: ApprovalCreateInput, authority?: { ttlMs: number }): Promise<ApprovalRequest> => {
      const approval: ApprovalRequest = {
        approvalId: randomUUID(),
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        ...(input.rollbackNote ? { rollbackNote: input.rollbackNote } : {}),
        ...(input.linkage ? { linkage: input.linkage } : {}),
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + authority!.ttlMs).toISOString(),
        explanationStatus: "not_requested",
      };
      fixture.approval = approval;
      return approval;
    },
  );
  const service = createChatCompactionBreakerActionServiceForGateway({
    storage,
    normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
    createApproval,
    now: () => NOW,
  });
  return {
    db,
    repo,
    service,
    auditAppend,
    createApproval,
    get approval() {
      return fixture.approval!;
    },
    set approval(value: ApprovalRequest) {
      fixture.approval = value;
    },
  };
}

function requestFor(expectedBreakerRevision: number) {
  return {
    dimensionHash: "dimension-a",
    actionKind: "force" as const,
    expectedBreakerRevision,
    reason: "Reviewed exact compaction receipts",
    expiresInSeconds: 90,
  };
}

function tripBreaker(repo: ChatConversationSummaryRepository) {
  const identity = {
    sessionId: "session-1",
    dimensionHash: "dimension-a",
    providerId: "openai",
    model: "gpt-4.1",
    profileFingerprint: "profile-a",
  };
  const first = repo.recordCompactionNoProgress({
    ...identity,
    attemptId: buildChatCompactionAttemptId({
      ...identity,
      branchHeadTurnId: "turn-14",
      observedTurnCount: 14,
      boundarySourceHash: "source-1",
      disposition: "no_progress",
    }),
    branchHeadTurnId: "turn-14",
    observedTurnCount: 14,
    attemptedBoundarySourceHash: "source-1",
  });
  return repo.recordCompactionNoProgress({
    ...identity,
    attemptId: buildChatCompactionAttemptId({
      ...identity,
      branchHeadTurnId: "turn-22",
      observedTurnCount: 22,
      boundarySourceHash: "source-2",
      disposition: "no_progress",
    }),
    branchHeadTurnId: "turn-22",
    observedTurnCount: 22,
    attemptedBoundarySourceHash: "source-2",
    expectedBreakerRevision: first.revision,
  });
}
