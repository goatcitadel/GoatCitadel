import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ApprovalRequest, ChatCompactionBreakerActionRecord } from "@goatcitadel/contracts";
import type { ChatCompactionBreakerActionService } from "../services/chat-compaction-breaker-action-service.js";
import { registerChatCompactionBreakerActionRoutes } from "./chat.compaction-breaker-actions.js";
import { chatRoutes } from "./chat.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("chat compaction breaker action routes", () => {
  it("rejects a generic auth:none actor before creating a governed action", async () => {
    const createAction = vi.fn();
    const app = await createApp({
      actorId: "auth:none",
      source: "loopback",
      service: { createAction },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/compaction-breaker/actions",
      payload: createBody(),
    });
    expect(response.statusCode).toBe(401);
    expect(createAction).not.toHaveBeenCalled();
  });

  it("uses only the server-stamped operator and requires explicit approval evidence", async () => {
    const action = actionRecord();
    const createAction = vi.fn(async () => action);
    const app = await createApp({
      actorId: "token:operator-1",
      source: "token",
      service: { createAction },
    });
    const missingApproval = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/compaction-breaker/actions",
      payload: { ...createBody(), approvalId: undefined },
    });
    expect(missingApproval.statusCode).toBe(400);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/compaction-breaker/actions",
      payload: createBody(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ action });
    expect(createAction).toHaveBeenCalledWith({
      sessionId: "session-1",
      actorId: "token:operator-1",
      request: createBody(),
    });

    const unreachableForceCallback = await app.inject({
      method: "POST",
      url: `/api/v1/chat/sessions/session-1/compaction-breaker/actions/${action.actionId}/force`,
    });
    expect(unreachableForceCallback.statusCode).toBe(404);
  });

  it("creates the canonical approval request before the separately approved action", async () => {
    const approval = approvalRecord();
    const requestApproval = vi.fn(async () => ({
      approval,
      approvalBindingHash: "sha256:approval-binding",
    }));
    const app = await createApp({
      actorId: "token:operator-1",
      source: "token",
      service: { requestApproval },
    });
    const request = {
      dimensionHash: "dimension-a",
      actionKind: "force" as const,
      expectedBreakerRevision: 4,
      reason: "Reviewed exact compaction receipts",
      expiresInSeconds: 90,
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/compaction-breaker/approval-requests",
      payload: request,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ approval, approvalBindingHash: "sha256:approval-binding" });
    expect(requestApproval).toHaveBeenCalledWith({
      sessionId: "session-1",
      actorId: "token:operator-1",
      request,
    });
  });

  it("registers on the canonical Chat plugin through the decorated production service", async () => {
    const approval = approvalRecord();
    const requestApproval = vi.fn(async () => ({
      approval,
      approvalBindingHash: "sha256:approval-binding",
    }));
    const app = Fastify();
    apps.push(app);
    app.decorate("services", {
      chatCompactionBreakerActions: { requestApproval },
    } as never);
    app.decorate("requireOperatorAuth", async (request: Parameters<FastifyInstance["requireOperatorAuth"]>[0]) => {
      request.authActorId = "token:operator-1";
      request.authActorSource = "token";
    });
    await app.register(chatRoutes);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/compaction-breaker/approval-requests",
      payload: {
        dimensionHash: "dimension-a",
        actionKind: "force",
        expectedBreakerRevision: 4,
        reason: "Reviewed exact compaction receipts",
        expiresInSeconds: 90,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});

async function createApp(input: {
  actorId: string;
  source: "token" | "basic" | "loopback";
  service: Partial<ChatCompactionBreakerActionService>;
}) {
  const app = Fastify();
  apps.push(app);
  app.decorate("requireOperatorAuth", async (request: Parameters<FastifyInstance["requireOperatorAuth"]>[0]) => {
    request.authActorId = input.actorId;
    request.authActorSource = input.source;
  });
  await registerChatCompactionBreakerActionRoutes(app, input.service as ChatCompactionBreakerActionService);
  await app.ready();
  return app;
}

function createBody() {
  return {
    dimensionHash: "dimension-a",
    actionKind: "force" as const,
    expectedBreakerRevision: 4,
    reason: "Reviewed exact compaction receipts",
    expiresInSeconds: 120,
    approvalId: "approval-1",
  };
}

function actionRecord(): ChatCompactionBreakerActionRecord {
  return {
    actionId: "67a3c440-5c09-4abc-89f5-22f1b7f02814",
    sessionId: "session-1",
    dimensionHash: "dimension-a",
    actionKind: "force",
    expectedBreakerRevision: 4,
    actorHash: "sha256:actor",
    requestEvidenceHash: "sha256:request",
    policyDecisionHash: "sha256:policy",
    auditEvidenceHash: "sha256:audit",
    approvalId: "approval-1",
    reason: "Reviewed exact compaction receipts",
    status: "pending",
    createdAt: "2026-07-14T06:00:00.000Z",
    expiresAt: "2026-07-14T06:02:00.000Z",
    updatedAt: "2026-07-14T06:00:00.000Z",
  };
}

function approvalRecord(): ApprovalRequest {
  return {
    approvalId: "approval-1",
    kind: "chat_compaction_breaker_recovery",
    riskLevel: "danger",
    status: "pending",
    payload: {
      schemaVersion: "chat_compaction_breaker_approval.v1",
      sessionId: "session-1",
      dimensionHash: "dimension-a",
      actionKind: "force",
      expectedBreakerRevision: 4,
      actorHash: "sha256:actor",
      reason: "Reviewed exact compaction receipts",
      approvalBindingHash: "sha256:approval-binding",
    },
    preview: {},
    createdAt: "2026-07-14T06:00:00.000Z",
    expiresAt: "2026-07-14T06:01:30.000Z",
    explanationStatus: "not_requested",
  };
}
