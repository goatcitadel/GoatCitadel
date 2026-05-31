import { describe, expect, it, vi } from "vitest";
import {
  claimIdempotentExternalSideEffect,
  type ExternalSideEffectRunStore,
  markIdempotentExternalSideEffectCompleted,
  recordAuditOnlyExternalSideEffectIntent,
  runIdempotentExternalSideEffect,
} from "./external-side-effect-runner-service.js";

function createSideEffectRunStore(): ExternalSideEffectRunStore & {
  createOrGet: ReturnType<typeof vi.fn>;
  markExternalCallStarted: ReturnType<typeof vi.fn>;
  markCompleted: ReturnType<typeof vi.fn>;
  markFailure: ReturnType<typeof vi.fn>;
} {
  return {
    createOrGet: vi.fn((input, now) => ({
      runId: "extfx-1",
      workspaceId: input.workspaceId ?? "default",
      boundary: input.boundary,
      routePath: input.routePath,
      catalogId: input.catalogId,
      connectionId: input.connectionId,
      actionId: input.actionId,
      actorScope: input.actorScope ?? "",
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      status: input.status ?? "claimed_not_sent",
      replayPolicy: "idempotent_external",
      replayOutcome: input.replayOutcome,
      replayAttempt: input.replayAttempt,
      resumeState: "not_resumable",
      requestPayload: input.requestPayload,
      attemptCount: 0,
      createdAt: now ?? "2026-05-31T00:00:00.000Z",
      updatedAt: now ?? "2026-05-31T00:00:00.000Z",
    })),
    markExternalCallStarted: vi.fn((runId, _input, now) => ({
      runId,
      workspaceId: "default",
      boundary: "integration_operator_action",
      routePath: "external",
      actorScope: "conn-1",
      idempotencyKey: "operator-key",
      payloadHash: "hash",
      status: "external_call_started",
      replayPolicy: "idempotent_external",
      resumeState: "in_progress",
      attemptCount: 1,
      externalCallStartedAt: now,
      createdAt: now ?? "2026-05-31T00:00:00.000Z",
      updatedAt: now ?? "2026-05-31T00:00:00.000Z",
    })),
    markCompleted: vi.fn((runId, input, now) => ({
      runId,
      workspaceId: "default",
      boundary: "integration_operator_action",
      routePath: "external",
      actorScope: "conn-1",
      idempotencyKey: "operator-key",
      payloadHash: "hash",
      status: "completed",
      replayPolicy: "idempotent_external",
      replayOutcome: input?.replayOutcome,
      resumeState: "completed",
      responsePayload: input?.responsePayload,
      externalReferenceId: input?.externalReferenceId,
      attemptCount: 1,
      completedAt: now,
      createdAt: now ?? "2026-05-31T00:00:00.000Z",
      updatedAt: now ?? "2026-05-31T00:00:00.000Z",
    })),
    markFailure: vi.fn((runId, input, now) => ({
      runId,
      workspaceId: "default",
      boundary: "integration_operator_action",
      routePath: "external",
      actorScope: "conn-1",
      idempotencyKey: "operator-key",
      payloadHash: "hash",
      status: input.status,
      replayPolicy: "idempotent_external",
      resumeState: "not_resumable",
      errorText: input.errorText,
      attemptCount: 1,
      completedAt: now,
      createdAt: now ?? "2026-05-31T00:00:00.000Z",
      updatedAt: now ?? "2026-05-31T00:00:00.000Z",
    })),
  };
}

describe("external-side-effect-runner-service", () => {
  it("records audit-only external side-effect intents with replay posture", () => {
    const createEnvelope = vi.fn(() => ({
      envelopeId: "envelope-1",
      eventKind: "external_writeback",
      contentHash: "hash-1",
      payloadHash: "payload-hash",
      toolCallHashes: [],
      memoryLineage: [],
      signatureStatus: "unsigned_local" as const,
      metadata: {},
      createdAt: "2026-05-31T00:00:00.000Z",
    }));

    const result = recordAuditOnlyExternalSideEffectIntent({
      evidenceEnvelopeService: { createEnvelope } as never,
      boundary: "integration_operator_action",
      connectionId: "conn-1",
      catalogId: "automation.activepieces",
      integrationKey: "activepieces",
      actionId: "run_flow",
      actionCapability: "write",
      status: "blocked",
      message: "Preview only.",
      inputKeys: ["flowId"],
      outputKeys: [],
      checkedAt: "2026-05-31T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "recorded",
      replayPolicy: "audit_only",
      resumable: false,
      envelopeId: "envelope-1",
      intentId: expect.stringMatching(/^external-side-effect-/),
      idempotencyKey: expect.any(String),
    });
    expect(createEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "external_writeback",
        metadata: expect.objectContaining({
          boundary: "integration_operator_action",
          externalSideEffect: true,
          externalSideEffectIntentId: result.intentId,
          externalSideEffectIdempotencyKey: result.idempotencyKey,
          replayPolicy: "audit_only",
          resumable: false,
          catalogId: "automation.activepieces",
          actionId: "run_flow",
        }),
      }),
    );
  });

  it("keeps intent posture explicit when evidence envelopes are unavailable", () => {
    const result = recordAuditOnlyExternalSideEffectIntent({
      boundary: "mcp_server_mode_preview",
      status: "blocked",
      message: "Server mode is preview only.",
      checkedAt: "2026-05-31T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "unavailable",
      replayPolicy: "audit_only",
      resumable: false,
      reason: "evidence_service_unavailable",
      intentId: expect.stringMatching(/^external-side-effect-/),
      idempotencyKey: expect.any(String),
    });
  });

  it("claims idempotent external side effects before the webhook boundary", () => {
    const claim = vi.fn(() => ({
      outcome: "claimed" as const,
      record: {
        method: "POST",
        routePath: "external",
        idempotencyKey: "operator-key",
        actorScope: "conn-1",
        payloadHash: "hash",
        status: "pending" as const,
        createdAt: "2026-05-31T00:00:00.000Z",
        updatedAt: "2026-05-31T00:00:00.000Z",
      },
    }));
    const markCompleted = vi.fn();
    const mutationStore = {
      claim,
      markCompleted,
      markFailed: vi.fn(),
    };

    const result = claimIdempotentExternalSideEffect({
      mutationStore,
      boundary: "integration_operator_action",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { flowId: "flow-1", payload: { message: "send" } },
    });

    expect(result).toMatchObject({
      replayPolicy: "idempotent_external",
      replayOutcome: "claimed",
      replayAttempt: "new",
      resumable: false,
      resumeState: "not_resumable",
      idempotencyKey: "operator-key",
      payloadHash: expect.any(String),
      actorScope: "conn-1",
    });
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        idempotencyKey: "operator-key",
        actorScope: "conn-1",
        payloadHash: result.payloadHash,
      }),
    );

    markIdempotentExternalSideEffectCompleted(mutationStore, result, "2026-05-31T00:00:01.000Z");
    expect(markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "operator-key",
        actorScope: "conn-1",
        updatedAt: "2026-05-31T00:00:01.000Z",
      }),
    );
  });

  it("records a durable side-effect run without persisting raw request payload values", () => {
    const sideEffectRunStore = createSideEffectRunStore();
    const result = claimIdempotentExternalSideEffect({
      mutationStore: {
        claim: vi.fn(() => ({
          outcome: "claimed" as const,
          claimKind: "new" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "hash",
            status: "pending" as const,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed: vi.fn(),
      },
      sideEffectRunStore,
      workspaceId: "workspace-1",
      boundary: "integration_operator_action",
      catalogId: "automation.gmail",
      connectionId: "conn-1",
      actionId: "write",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { provider: "gmail", to: "private@example.test", bodyText: "secret body" },
    });

    expect(result).toMatchObject({
      sideEffectRunId: "extfx-1",
      replayOutcome: "claimed",
    });
    expect(sideEffectRunStore.createOrGet).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        status: "claimed_not_sent",
        requestPayload: {
          valueKind: "object",
          keys: ["bodyText", "provider", "to"],
        },
      }),
      "2026-05-31T00:00:00.000Z",
    );
    expect(JSON.stringify(sideEffectRunStore.createOrGet.mock.calls[0]?.[0])).not.toContain("secret body");
  });

  it("reports unavailable idempotency without claiming replay safety", () => {
    const result = claimIdempotentExternalSideEffect({
      boundary: "integration_operator_action",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { message: "send" },
    });

    expect(result).toMatchObject({
      replayPolicy: "idempotent_external",
      replayOutcome: "idempotency_unavailable",
      idempotencyKey: expect.any(String),
      payloadHash: expect.any(String),
    });
  });

  it("does not execute external work when an idempotent side-effect claim is not new", async () => {
    const execute = vi.fn();
    const result = await runIdempotentExternalSideEffect({
      mutationStore: {
        claim: vi.fn(() => ({
          outcome: "duplicate" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "hash",
            status: "completed" as const,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:01.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed: vi.fn(),
      },
      boundary: "integration_operator_action",
      catalogId: "productivity.trello",
      connectionId: "conn-1",
      actionId: "write",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { name: "Durable card" },
      label: "Trello card create",
      output: { provider: "trello" },
      execute,
    });

    expect(result).toMatchObject({
      status: "blocked",
      blockedReason: "external_side_effect_duplicate",
      output: {
        provider: "trello",
        replayPolicy: "idempotent_external",
        replayOutcome: "duplicate",
        replayAttempt: "blocked",
        resumable: false,
        resumeState: "completed",
        idempotencyKey: "operator-key",
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("marks claimed idempotent side effects failed when execution throws", async () => {
    const markFailed = vi.fn();
    const result = await runIdempotentExternalSideEffect({
      mutationStore: {
        claim: vi.fn(() => ({
          outcome: "claimed" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "hash",
            status: "pending" as const,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed,
      },
      boundary: "integration_operator_action",
      catalogId: "productivity.trello",
      connectionId: "conn-1",
      actionId: "write",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { name: "Durable card" },
      label: "Trello card create",
      execute: async () => {
        throw new Error("provider failed");
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ message: "provider failed" }),
      output: {
        replayPolicy: "idempotent_external",
        replayOutcome: "claimed",
        replayAttempt: "new",
        resumable: false,
        resumeState: "manual_retry_after_recorded_failure",
        idempotencyKey: "operator-key",
      },
    });
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "operator-key",
        actorScope: "conn-1",
      }),
    );
  });

  it("marks durable side-effect runs started, completed, or unknown after the boundary", async () => {
    const sideEffectRunStore = createSideEffectRunStore();
    const mutationStore = {
      claim: vi.fn(() => ({
        outcome: "claimed" as const,
        claimKind: "new" as const,
        record: {
          method: "POST",
          routePath: "external",
          idempotencyKey: "operator-key",
          actorScope: "conn-1",
          payloadHash: "hash",
          status: "pending" as const,
          createdAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:00:00.000Z",
        },
      })),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };

    const executed = await runIdempotentExternalSideEffect({
      mutationStore,
      sideEffectRunStore,
      boundary: "integration_operator_action",
      catalogId: "productivity.trello",
      connectionId: "conn-1",
      actionId: "write",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { name: "Durable card" },
      label: "Trello card create",
      execute: async (claim) => {
        expect(claim.externalCallStarted).toBe(false);
        claim.markExternalCallStarted();
        expect(claim.externalCallStarted).toBe(true);
        return { output: { id: "card-1", name: "Durable card" } };
      },
    });

    expect(executed.status).toBe("executed");
    expect(sideEffectRunStore.markExternalCallStarted).toHaveBeenCalledWith(
      "extfx-1",
      undefined,
      "2026-05-31T00:00:00.000Z",
    );
    expect(sideEffectRunStore.markCompleted).toHaveBeenCalledWith(
      "extfx-1",
      expect.objectContaining({
        responsePayload: {
          valueKind: "object",
          keys: ["output"],
        },
        externalReferenceId: "id:card-1",
      }),
      "2026-05-31T00:00:00.000Z",
    );

    const failingStore = createSideEffectRunStore();
    const failed = await runIdempotentExternalSideEffect({
      mutationStore: {
        ...mutationStore,
        claim: vi.fn(() => ({
          outcome: "claimed" as const,
          claimKind: "new" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key-2",
            actorScope: "conn-1",
            payloadHash: "hash",
            status: "pending" as const,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        })),
      },
      sideEffectRunStore: failingStore,
      boundary: "integration_operator_action",
      catalogId: "productivity.trello",
      connectionId: "conn-1",
      actionId: "write",
      idempotencyKey: "operator-key-2",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { name: "Durable card" },
      label: "Trello card create",
      execute: async (claim) => {
        claim.markExternalCallStarted();
        throw new Error("provider failed");
      },
    });

    expect(failed.status).toBe("failed");
    expect(failingStore.markFailure).toHaveBeenCalledWith(
      "extfx-1",
      {
        status: "unknown_external_outcome",
        errorText: "provider failed",
      },
      "2026-05-31T00:00:00.000Z",
    );
  });

  it("marks claimed side-effect runs failed before the boundary when execution never starts the external call", async () => {
    const sideEffectRunStore = createSideEffectRunStore();

    const result = await runIdempotentExternalSideEffect({
      mutationStore: {
        claim: vi.fn(() => ({
          outcome: "claimed" as const,
          claimKind: "new" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "hash",
            status: "pending" as const,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed: vi.fn(),
      },
      sideEffectRunStore,
      boundary: "integration_operator_action",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { message: "preflight failed" },
      label: "Activepieces webhook trigger",
      execute: async () => {
        throw new Error("request build failed");
      },
    });

    expect(result.status).toBe("failed");
    expect(sideEffectRunStore.markExternalCallStarted).not.toHaveBeenCalled();
    expect(sideEffectRunStore.markFailure).toHaveBeenCalledWith(
      "extfx-1",
      {
        status: "failed_before_boundary",
        errorText: "request build failed",
      },
      "2026-05-31T00:00:00.000Z",
    );
  });

  it("marks retries from failed idempotency claims as retry attempts", () => {
    const result = claimIdempotentExternalSideEffect({
      mutationStore: {
        claim: vi.fn(() => ({
          outcome: "claimed" as const,
          claimKind: "retry_after_failure" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "hash",
            status: "pending" as const,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:05.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed: vi.fn(),
      },
      boundary: "integration_operator_action",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:10.000Z",
      payload: { message: "retry" },
    });

    expect(result).toMatchObject({
      replayPolicy: "idempotent_external",
      replayOutcome: "claimed",
      replayAttempt: "retry_after_failure",
      resumable: false,
      resumeState: "not_resumable",
      idempotencyKey: "operator-key",
    });
  });
});
