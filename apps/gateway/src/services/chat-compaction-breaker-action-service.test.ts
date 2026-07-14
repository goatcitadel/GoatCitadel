import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalCreateInput, ApprovalRequest } from "@goatcitadel/contracts";
import {
  ApprovalRepository,
  buildChatCompactionAttemptId,
  ChatConversationSummaryRepository,
  createDatabase,
} from "@goatcitadel/storage";
import {
  ChatCompactionBreakerActionService,
  CHAT_COMPACTION_BREAKER_APPROVAL_SCHEMA_VERSION,
  hashActorId,
  type ChatCompactionBreakerAuditPort,
  type ChatCompactionBreakerGovernancePort,
} from "./chat-compaction-breaker-action-service.js";

const createdFiles: string[] = [];
const NOW = new Date("2026-07-14T06:00:00.000Z");

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
  }
});

describe("ChatCompactionBreakerActionService", () => {
  it("stores only the actor hash and resolves an approved force action after sealed Chat dimension binding", async () => {
    const fixture = createFixture();
    try {
      const breaker = tripBreaker(fixture.repo, "session-1", "dimension-a");
      const governance = vi.fn<ChatCompactionBreakerGovernancePort["authorize"]>(async (input) => ({
        decision: "allow",
        decisionId: "policy-decision-1",
        approvalId: "approval-1",
        approvalStatus: "approved",
        approvalBindingHash: input.expectedApprovalBindingHash,
      }));
      const audit = vi.fn<ChatCompactionBreakerAuditPort["append"]>(async () => ({
        committed: true,
        receiptId: "audit-receipt-1",
      }));
      const isUseAuthorized = vi.fn(() => true);
      const service = new ChatCompactionBreakerActionService({
        repository: fixture.repo,
        governance: { authorize: governance },
        audit: { append: audit },
        approvals: { create: vi.fn() },
        resolveSessionWorkspaceId: () => "workspace-1",
        isUseAuthorized,
        now: () => NOW,
        createActionId: () => "67a3c440-5c09-4abc-89f5-22f1b7f02814",
      });

      const action = await service.createAction({
        sessionId: "session-1",
        actorId: "token:raw-operator-secret",
        request: {
          dimensionHash: "dimension-a",
          actionKind: "force",
          expectedBreakerRevision: breaker.revision,
          approvalId: "approval-1",
          reason: "Reviewed both exact failed compaction receipts",
        },
      });

      expect(action).toMatchObject({ status: "pending", approvalId: "approval-1" });
      expect(action.actorHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(action.actorHash).not.toContain("raw-operator-secret");
      const stored = fixture.db
        .prepare("SELECT * FROM chat_compaction_breaker_actions WHERE action_id = ?")
        .get(action.actionId);
      expect(JSON.stringify(stored)).not.toContain("raw-operator-secret");
      expect(governance).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          dimensionHash: "dimension-a",
          actionKind: "force",
          expectedBreakerRevision: breaker.revision,
          actorHash: action.actorHash,
        }),
      );
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          requestEvidenceHash: action.requestEvidenceHash,
          policyDecisionHash: action.policyDecisionHash,
          actionStatus: "pending",
        }),
      );

      expect(
        service.resolvePendingForceAction({
          sessionId: "session-1",
          sealedDimensionHash: "dimension-a",
          actorId: "token:raw-operator-secret",
        }),
      ).toEqual({ actionId: action.actionId, actorHash: action.actorHash });
      expect(isUseAuthorized).toHaveBeenCalledWith({
        action: expect.objectContaining({ actionId: action.actionId, status: "pending" }),
        observedAt: NOW.toISOString(),
      });
      isUseAuthorized.mockReturnValue(false);
      expect(
        service.resolvePendingForceAction({
          sessionId: "session-1",
          sealedDimensionHash: "dimension-a",
          actorId: "token:raw-operator-secret",
        }),
      ).toBeUndefined();
      expect(
        service.resolvePendingForceAction({
          sessionId: "session-1",
          sealedDimensionHash: "dimension-a",
          actorId: "token:other-operator",
        }),
      ).toBeUndefined();
    } finally {
      fixture.db.close();
    }
  });

  it("persists mismatched approval evidence as rejected and never exposes it to force execution", async () => {
    const fixture = createFixture();
    try {
      const breaker = tripBreaker(fixture.repo, "session-1", "dimension-a");
      const service = new ChatCompactionBreakerActionService({
        repository: fixture.repo,
        governance: {
          authorize: async () => ({
            decision: "allow",
            decisionId: "policy-decision-2",
            approvalId: "approval-other",
            approvalStatus: "approved",
            approvalBindingHash: "sha256:wrong-boundary",
          }),
        },
        audit: { append: async () => ({ committed: true, receiptId: "audit-receipt-2" }) },
        approvals: { create: vi.fn() },
        resolveSessionWorkspaceId: () => "workspace-1",
        isUseAuthorized: () => true,
        now: () => NOW,
        createActionId: () => "57c92924-c5cc-48ea-ae0e-da73b9ec7317",
      });
      const action = await service.createAction({
        sessionId: "session-1",
        actorId: "token:operator-1",
        request: {
          dimensionHash: "dimension-a",
          actionKind: "force",
          expectedBreakerRevision: breaker.revision,
          approvalId: "approval-1",
          reason: "Reviewed exact receipts",
        },
      });
      expect(action).toMatchObject({
        status: "rejected",
        rejectionReason: "Approval evidence does not match the requested approval",
      });
      expect(
        service.resolvePendingForceAction({
          sessionId: "session-1",
          sealedDimensionHash: "dimension-a",
          actorId: "token:operator-1",
        }),
      ).toBeUndefined();
    } finally {
      fixture.db.close();
    }
  });

  it("fails closed without a committed audit receipt", async () => {
    const fixture = createFixture();
    try {
      const breaker = tripBreaker(fixture.repo, "session-1", "dimension-a");
      const service = new ChatCompactionBreakerActionService({
        repository: fixture.repo,
        governance: {
          authorize: async (input) => ({
            decision: "allow",
            decisionId: "policy-decision-3",
            approvalId: "approval-1",
            approvalStatus: "approved",
            approvalBindingHash: input.expectedApprovalBindingHash,
          }),
        },
        audit: { append: async () => ({ committed: false }) },
        approvals: { create: vi.fn() },
        resolveSessionWorkspaceId: () => "workspace-1",
        isUseAuthorized: () => true,
        now: () => NOW,
        createActionId: () => "1a498cbe-8343-42f0-a6db-f61041759251",
      });
      await expect(
        service.createAction({
          sessionId: "session-1",
          actorId: "token:operator-1",
          request: {
            dimensionHash: "dimension-a",
            actionKind: "force",
            expectedBreakerRevision: breaker.revision,
            approvalId: "approval-1",
            reason: "Reviewed exact receipts",
          },
        }),
      ).rejects.toThrow(/audit receipt did not commit/i);
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM chat_compaction_breaker_actions").get()).toMatchObject({
        count: 0,
      });
    } finally {
      fixture.db.close();
    }
  });

  it("creates a short-lived danger approval bound to the exact actor and breaker revision", async () => {
    const fixture = createFixture();
    try {
      const breaker = tripBreaker(fixture.repo, "session-1", "dimension-a");
      const createApproval = vi.fn(
        async (input: ApprovalCreateInput, authority?: { ttlMs: number }): Promise<ApprovalRequest> => ({
          approvalId: "approval-recovery-1",
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
        }),
      );
      const service = new ChatCompactionBreakerActionService({
        repository: fixture.repo,
        governance: { authorize: vi.fn() },
        audit: { append: vi.fn() },
        approvals: { create: createApproval },
        resolveSessionWorkspaceId: () => "workspace-1",
        isUseAuthorized: () => true,
        now: () => NOW,
      });

      const response = await service.requestApproval({
        sessionId: "session-1",
        actorId: "token:raw-operator-secret",
        request: {
          dimensionHash: "dimension-a",
          actionKind: "force",
          expectedBreakerRevision: breaker.revision,
          reason: "Reviewed both exact failed compaction receipts",
          expiresInSeconds: 90,
        },
      });

      expect(response.approval).toMatchObject({
        approvalId: "approval-recovery-1",
        kind: "chat_compaction_breaker_recovery",
        riskLevel: "danger",
        status: "pending",
        expiresAt: "2026-07-14T06:01:30.000Z",
      });
      expect(response.approvalBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      const approvalInput = createApproval.mock.calls[0]![0];
      expect(createApproval.mock.calls[0]![1]).toEqual({ ttlMs: 90_000 });
      expect(approvalInput).toMatchObject({
        kind: "chat_compaction_breaker_recovery",
        riskLevel: "danger",
        preview: { expiresInSeconds: 90 },
        linkage: {
          sessionId: "session-1",
          workspaceId: "workspace-1",
          actionType: "chat_compaction_breaker_force",
        },
        payload: {
          schemaVersion: CHAT_COMPACTION_BREAKER_APPROVAL_SCHEMA_VERSION,
          sessionId: "session-1",
          dimensionHash: "dimension-a",
          actionKind: "force",
          expectedBreakerRevision: breaker.revision,
          reason: "Reviewed both exact failed compaction receipts",
          approvalBindingHash: response.approvalBindingHash,
        },
      });
      expect(approvalInput).not.toHaveProperty("expiresAt");
      expect(approvalInput.payload.actorHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(JSON.stringify(approvalInput)).not.toContain("raw-operator-secret");
      await expect(
        service.requestApproval({
          sessionId: "session-1",
          actorId: "token:raw-operator-secret",
          request: {
            dimensionHash: "dimension-a",
            actionKind: "force",
            expectedBreakerRevision: breaker.revision + 1,
            reason: "Stale recovery request",
          },
        }),
      ).rejects.toThrow(/revision changed/i);
      expect(createApproval).toHaveBeenCalledTimes(1);
    } finally {
      fixture.db.close();
    }
  });

  it("revalidates current authorization before consuming a pending repair action", () => {
    const fixture = createFixture();
    try {
      const tripped = tripBreaker(fixture.repo, "session-1", "dimension-a");
      fixture.db
        .prepare(
          "UPDATE chat_compaction_breakers SET status = 'blocked_corrupt' WHERE session_id = ? AND dimension_hash = ?",
        )
        .run("session-1", "dimension-a");
      const blocked = fixture.repo.getCompactionBreaker("session-1", "dimension-a");
      expect(blocked).toMatchObject({ status: "blocked_corrupt", revision: tripped.revision });
      const actorId = "token:operator-1";
      const action = fixture.repo.createCompactionBreakerAction({
        actionId: "f8be15f4-4058-4800-8b0b-fac830cb4c37",
        sessionId: "session-1",
        dimensionHash: "dimension-a",
        actionKind: "repair",
        expectedBreakerRevision: blocked!.revision,
        actorHash: hashActorId(actorId),
        requestEvidenceHash: "sha256:request-repair",
        policyDecisionHash: "sha256:policy-repair",
        auditEvidenceHash: "sha256:audit-repair",
        approvalId: "approval-repair",
        reason: "Reviewed quarantined compaction state",
        status: "pending",
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 90_000).toISOString(),
      });
      const isUseAuthorized = vi.fn(() => false);
      const service = new ChatCompactionBreakerActionService({
        repository: fixture.repo,
        governance: { authorize: vi.fn() },
        audit: { append: vi.fn() },
        approvals: { create: vi.fn() },
        resolveSessionWorkspaceId: () => "workspace-1",
        isUseAuthorized,
        now: () => NOW,
      });

      expect(() => service.repair({ sessionId: "session-1", actionId: action.actionId, actorId })).toThrow(
        /no longer authorized/i,
      );
      expect(isUseAuthorized).toHaveBeenCalledWith({
        action: expect.objectContaining({ actionId: action.actionId, status: "pending" }),
        observedAt: NOW.toISOString(),
      });
      expect(fixture.repo.getCompactionBreakerAction(action.actionId, NOW.toISOString()).status).toBe("pending");
    } finally {
      fixture.db.close();
    }
  });

  it("accepts the exact database-owned approval TTL window despite app-clock delay", async () => {
    const fixture = createFixture();
    try {
      const breaker = tripBreaker(fixture.repo, "session-1", "dimension-a");
      const approvals = new ApprovalRepository(fixture.db);
      const service = new ChatCompactionBreakerActionService({
        repository: fixture.repo,
        governance: { authorize: vi.fn() },
        audit: { append: vi.fn() },
        approvals: {
          create: async (input, authority) => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return approvals.createWithTtlDuration(input, authority!.ttlMs);
          },
        },
        resolveSessionWorkspaceId: () => "workspace-1",
        isUseAuthorized: () => true,
        now: () => NOW,
      });

      const response = await service.requestApproval({
        sessionId: "session-1",
        actorId: "token:operator-1",
        request: {
          dimensionHash: "dimension-a",
          actionKind: "force",
          expectedBreakerRevision: breaker.revision,
          reason: "Reviewed database-owned recovery window",
          expiresInSeconds: 90,
        },
      });

      expect(Date.parse(response.approval.expiresAt!) - Date.parse(response.approval.createdAt)).toBe(90_000);
      expect(approvals.get(response.approval.approvalId)).toEqual(response.approval);
    } finally {
      fixture.db.close();
    }
  });
});

function createFixture() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-compaction-action-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatConversationSummaryRepository(db) };
}

function tripBreaker(repo: ChatConversationSummaryRepository, sessionId: string, dimensionHash: string) {
  const identity = {
    sessionId,
    dimensionHash,
    providerId: "openai",
    model: "gpt-4.1",
    profileFingerprint: "profile-a",
  };
  const firstSource = "no-progress-source-1";
  const first = repo.recordCompactionNoProgress({
    ...identity,
    attemptId: buildChatCompactionAttemptId({
      ...identity,
      branchHeadTurnId: "turn-14",
      observedTurnCount: 14,
      boundarySourceHash: firstSource,
      disposition: "no_progress",
    }),
    branchHeadTurnId: "turn-14",
    observedTurnCount: 14,
    attemptedBoundarySourceHash: firstSource,
  });
  const secondSource = "no-progress-source-2";
  return repo.recordCompactionNoProgress({
    ...identity,
    attemptId: buildChatCompactionAttemptId({
      ...identity,
      branchHeadTurnId: "turn-22",
      observedTurnCount: 22,
      boundarySourceHash: secondSource,
      disposition: "no_progress",
    }),
    branchHeadTurnId: "turn-22",
    observedTurnCount: 22,
    attemptedBoundarySourceHash: secondSource,
    expectedBreakerRevision: first.revision,
  });
}
