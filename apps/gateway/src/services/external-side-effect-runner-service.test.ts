import { describe, expect, it, vi } from "vitest";
import {
  claimIdempotentExternalSideEffect,
  markIdempotentExternalSideEffectCompleted,
  recordAuditOnlyExternalSideEffectIntent,
  runIdempotentExternalSideEffect,
} from "./external-side-effect-runner-service.js";

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
});
