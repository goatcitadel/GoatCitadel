import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  claimIdempotentExternalSideEffect,
  deriveExternalSideEffectReversibility,
  type ExternalSideEffectExecutionContext,
  type ExternalSideEffectRunStore,
  markIdempotentExternalSideEffectCompleted,
  recordAuditOnlyExternalSideEffectIntent,
  runIdempotentExternalSideEffect,
  runReplaySafeExternalSideEffectWorker,
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

function sideEffectRun(overrides: Partial<ReturnType<ExternalSideEffectRunStore["createOrGet"]>> = {}) {
  return {
    runId: "extfx-1",
    workspaceId: "default",
    boundary: "integration_operator_action",
    routePath: "external_side_effect:integration_operator_action:automation.activepieces:conn-1:trigger_webhook",
    catalogId: "automation.activepieces",
    connectionId: "conn-1",
    actionId: "trigger_webhook",
    actorScope: "conn-1",
    idempotencyKey: "operator-key",
    payloadHash: "payload-hash",
    status: "failed_before_boundary" as const,
    replayPolicy: "idempotent_external" as const,
    replayOutcome: "claimed" as const,
    replayAttempt: "new" as const,
    resumeState: "manual_retry_after_recorded_failure" as const,
    requestPayload: { valueKind: "object", keys: ["message"] },
    attemptCount: 1,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:01:00.000Z",
    ...overrides,
  };
}

type FakeMutationClaimStatus = "pending" | "completed" | "failed";

interface FakeMutationClaimInput {
  method: string;
  routePath: string;
  idempotencyKey: string;
  actorScope?: string;
  payloadHash: string;
  now?: string;
}

/**
 * Mirrors packages/storage/src/mutation-idempotency-repo.ts claim() exactly: the
 * payload-hash mismatch check runs BEFORE the failed-record revive, and a still-
 * "pending" existing row yields "in_progress" rather than "duplicate". Using this
 * stateful fake (instead of a one-shot vi.fn() outcome) lets the payload_mismatch
 * and in_progress tests prove the runner's blocking behavior against genuine
 * claim() state transitions across two real invocations, not a canned mock.
 */
function createStatefulMutationIdempotencyStore(): {
  claim: ReturnType<typeof vi.fn>;
  markCompleted: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
} {
  const rows = new Map<string, { payloadHash: string; status: FakeMutationClaimStatus }>();

  const toKey = (input: FakeMutationClaimInput) =>
    [input.method, input.routePath, input.idempotencyKey, input.actorScope ?? ""].join("|");

  const toRecord = (input: FakeMutationClaimInput, row: { payloadHash: string; status: FakeMutationClaimStatus }) => ({
    method: input.method,
    routePath: input.routePath,
    idempotencyKey: input.idempotencyKey,
    actorScope: input.actorScope ?? "",
    payloadHash: row.payloadHash,
    status: row.status,
    createdAt: input.now ?? "",
    updatedAt: input.now ?? "",
  });

  return {
    claim: vi.fn((input: FakeMutationClaimInput) => {
      const key = toKey(input);
      const existing = rows.get(key);
      if (!existing) {
        const row = { payloadHash: input.payloadHash, status: "pending" as const };
        rows.set(key, row);
        return { outcome: "claimed" as const, claimKind: "new" as const, record: toRecord(input, row) };
      }
      if (existing.payloadHash !== input.payloadHash) {
        return { outcome: "payload_mismatch" as const, record: toRecord(input, existing) };
      }
      if (existing.status === "failed") {
        const row = { payloadHash: input.payloadHash, status: "pending" as const };
        rows.set(key, row);
        return { outcome: "claimed" as const, claimKind: "retry_after_failure" as const, record: toRecord(input, row) };
      }
      return {
        outcome: existing.status === "pending" ? ("in_progress" as const) : ("duplicate" as const),
        record: toRecord(input, existing),
      };
    }),
    markCompleted: vi.fn((input: FakeMutationClaimInput) => {
      const key = toKey(input);
      const existing = rows.get(key);
      if (existing) {
        rows.set(key, { ...existing, status: "completed" });
      }
    }),
    markFailed: vi.fn((input: FakeMutationClaimInput) => {
      const key = toKey(input);
      const existing = rows.get(key);
      if (existing) {
        rows.set(key, { ...existing, status: "failed" });
      }
    }),
  };
}

describe("external-side-effect-runner-service", () => {
  it("keeps deterministic external side-effect digests fast and off constant-key HMAC helpers", () => {
    const source = readFileSync(new URL("./external-side-effect-runner-service.ts", import.meta.url), "utf8");

    expect(source).toMatch(/createHash\("sha256"\)[\s\S]*EXTERNAL_SIDE_EFFECT_DIGEST_DOMAIN_KEY/);
    expect(source).not.toMatch(/pbkdf2Sync\(\s*canonicalPayload,\s*EXTERNAL_SIDE_EFFECT_DIGEST_DOMAIN_KEY,/);
    expect(source).not.toMatch(/createHmac\("sha256",\s*EXTERNAL_SIDE_EFFECT_DIGEST_DOMAIN_KEY\)/);
  });

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
      reversibility: expect.objectContaining({
        status: "irreversible",
        label: "Cannot undo",
      }),
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
          reversibilityStatus: "irreversible",
          catalogId: "automation.activepieces",
          actionId: "run_flow",
        }),
      }),
    );
  });

  it("separates replay-audit, manual-reconciliation, and cannot-undo external action posture", () => {
    expect(
      deriveExternalSideEffectReversibility({
        replayPolicy: "idempotent_external",
        resumable: true,
        resumeState: "manual_retry_after_recorded_failure",
        status: "failed_before_boundary",
        intentId: "intent-1",
      }),
    ).toMatchObject({
      status: "replay_audit_only",
      label: "Replay audit only",
      evidenceRef: "intent-1",
    });
    expect(
      deriveExternalSideEffectReversibility({
        replayPolicy: "idempotent_external",
        resumable: false,
        resumeState: "manual_review_unknown_external_outcome",
        status: "unknown_external_outcome",
      }),
    ).toMatchObject({
      status: "manual_reconciliation",
      label: "Manual reconciliation",
    });
    expect(
      deriveExternalSideEffectReversibility({
        replayPolicy: "audit_only",
        resumable: false,
        resumeState: "completed",
        status: "completed",
      }),
    ).toMatchObject({
      status: "irreversible",
      label: "Cannot undo",
    });
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

  it("blocks execution and records payload_mismatch when the same identity is claimed with a different payload hash", async () => {
    const mutationStore = createStatefulMutationIdempotencyStore();
    const sideEffectRunStore = createSideEffectRunStore();
    const firstExecute = vi.fn(async (claim: ExternalSideEffectExecutionContext) => {
      claim.markExternalCallStarted();
      return { output: { id: "card-1" } };
    });

    const first = await runIdempotentExternalSideEffect({
      mutationStore,
      sideEffectRunStore,
      boundary: "integration_operator_action",
      catalogId: "productivity.trello",
      connectionId: "conn-1",
      actionId: "write",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { name: "Payload A" },
      label: "Trello card create",
      execute: firstExecute,
    });
    expect(first.status).toBe("executed");

    const secondExecute = vi.fn();
    const second = await runIdempotentExternalSideEffect({
      mutationStore,
      sideEffectRunStore,
      boundary: "integration_operator_action",
      catalogId: "productivity.trello",
      connectionId: "conn-1",
      actionId: "write",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:01.000Z",
      payload: { name: "Payload B" },
      label: "Trello card create",
      execute: secondExecute,
    });

    expect(second).toMatchObject({
      status: "blocked",
      blockedReason: "external_side_effect_payload_mismatch",
      claim: expect.objectContaining({ replayOutcome: "payload_mismatch", resumeState: "payload_mismatch" }),
    });
    expect(secondExecute).not.toHaveBeenCalled();
    expect(sideEffectRunStore.createOrGet).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "payload_mismatch" }),
      "2026-05-31T00:00:01.000Z",
    );
  });

  it("blocks without sending when an idempotent claim is already in progress", async () => {
    const mutationStore = createStatefulMutationIdempotencyStore();
    const sideEffectRunStore = createSideEffectRunStore();
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstExecute = vi.fn(async (claim: ExternalSideEffectExecutionContext) => {
      claim.markExternalCallStarted();
      await firstCanFinish;
      return { output: { id: "card-1" } };
    });
    const secondExecute = vi.fn();

    const firstPromise = runIdempotentExternalSideEffect({
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
      execute: firstExecute,
    });

    // The first invocation runs synchronously up to `await firstCanFinish` before
    // control returns here, so the mutation-store row is already "pending" (claimed,
    // not yet completed) by the time this second, identical invocation claims again.
    const second = await runIdempotentExternalSideEffect({
      mutationStore,
      sideEffectRunStore,
      boundary: "integration_operator_action",
      catalogId: "productivity.trello",
      connectionId: "conn-1",
      actionId: "write",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:01.000Z",
      payload: { name: "Durable card" },
      label: "Trello card create",
      execute: secondExecute,
    });

    expect(second).toMatchObject({
      status: "blocked",
      blockedReason: "external_side_effect_in_progress",
      claim: expect.objectContaining({ replayOutcome: "in_progress", resumeState: "in_progress" }),
    });
    expect(secondExecute).not.toHaveBeenCalled();

    releaseFirst();
    const first = await firstPromise;
    expect(first.status).toBe("executed");
    expect(firstExecute).toHaveBeenCalledOnce();
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

    const workflowEvidenceStore = createSideEffectRunStore();
    await runIdempotentExternalSideEffect({
      mutationStore: {
        ...mutationStore,
        claim: vi.fn(() => ({
          outcome: "claimed" as const,
          claimKind: "new" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "activepieces-key",
            actorScope: "conn-1",
            payloadHash: "hash",
            status: "pending" as const,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        })),
      },
      sideEffectRunStore: workflowEvidenceStore,
      boundary: "integration_operator_action",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      idempotencyKey: "activepieces-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { message: "hello" },
      label: "Activepieces webhook trigger",
      execute: async (claim) => {
        claim.markExternalCallStarted();
        return {
          output: {
            workflowRunId: "run-123",
            workflowRunStatus: "RUNNING",
            workflowRunUrl: "https://activepieces.example.test/runs/run-123?token=secret#debug",
          },
        };
      },
    });

    expect(workflowEvidenceStore.markCompleted).toHaveBeenCalledWith(
      "extfx-1",
      expect.objectContaining({
        responsePayload: {
          valueKind: "object",
          keys: ["output"],
          workflowRunId: "run-123",
          workflowRunStatus: "RUNNING",
          workflowRunStatusSource: "webhook_response",
          workflowRunUrl: "https://activepieces.example.test/runs/run-123",
        },
        externalReferenceId: "workflowRunId:run-123",
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

  it("does not reopen idempotency for retry when post-boundary bookkeeping fails", async () => {
    const sideEffectRunStore = createSideEffectRunStore();
    sideEffectRunStore.markCompleted.mockImplementation(() => {
      throw new Error("run mirror unavailable");
    });
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

    const result = await runIdempotentExternalSideEffect({
      mutationStore,
      sideEffectRunStore,
      boundary: "integration_operator_action",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { message: "sent" },
      label: "Activepieces webhook trigger",
      execute: async (claim) => {
        claim.markExternalCallStarted();
        return { output: { workflowRunId: "run-1" } };
      },
    });

    expect(result.status).toBe("executed");
    expect(mutationStore.markCompleted).toHaveBeenCalled();
    expect(mutationStore.markFailed).not.toHaveBeenCalled();
    expect(sideEffectRunStore.markFailure).toHaveBeenCalledWith(
      "extfx-1",
      {
        status: "unknown_external_outcome",
        errorText: "run mirror unavailable",
      },
      "2026-05-31T00:00:00.000Z",
    );
  });

  it("keeps post-boundary execution failures non-retryable when local started-state persistence fails", async () => {
    const sideEffectRunStore = createSideEffectRunStore();
    sideEffectRunStore.markExternalCallStarted.mockImplementation(() => {
      throw new Error("started mirror unavailable");
    });
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

    const result = await runIdempotentExternalSideEffect({
      mutationStore,
      sideEffectRunStore,
      boundary: "integration_operator_action",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      idempotencyKey: "operator-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { message: "sent" },
      label: "Activepieces webhook trigger",
      execute: async (claim) => {
        claim.markExternalCallStarted();
        throw new Error("external system returned 502 after send");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.output).toMatchObject({
      resumable: false,
      resumeState: "manual_review_unknown_external_outcome",
    });
    expect(mutationStore.markFailed).not.toHaveBeenCalled();
    expect(sideEffectRunStore.markFailure).toHaveBeenCalledWith(
      "extfx-1",
      {
        status: "unknown_external_outcome",
        errorText: "external system returned 502 after send",
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

  it("replays only pre-boundary side-effect failures through caller-supplied jobs", async () => {
    const markFailed = vi.fn();
    const markCompleted = vi.fn();
    const execute = vi.fn(async (claim) => {
      claim.markExternalCallStarted();
      return { output: { id: "flow-run-1" } };
    });
    const sideEffectRunStore = createSideEffectRunStore();
    const mutationStore = {
      claim: vi.fn(() => ({
        outcome: "claimed" as const,
        claimKind: "retry_after_failure" as const,
        record: {
          method: "POST",
          routePath: "external",
          idempotencyKey: "operator-key",
          actorScope: "conn-1",
          payloadHash: "payload-hash",
          status: "pending" as const,
          createdAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:02:00.000Z",
        },
      })),
      markCompleted,
      markFailed,
    };
    const runs = [
      sideEffectRun(),
      sideEffectRun({
        runId: "extfx-unknown",
        status: "unknown_external_outcome",
        resumeState: "not_resumable",
      }),
    ];

    const results = await runReplaySafeExternalSideEffectWorker({
      runs,
      checkedAt: "2026-05-31T00:02:00.000Z",
      buildJob: (run) =>
        run.runId === "extfx-1"
          ? {
              mutationStore,
              sideEffectRunStore,
              boundary: run.boundary,
              catalogId: run.catalogId,
              connectionId: run.connectionId,
              actionId: run.actionId,
              checkedAt: "2026-05-31T00:02:00.000Z",
              idempotencyKey: run.idempotencyKey,
              payload: { provider: "activepieces", message: "safe retry" },
              label: "Activepieces webhook trigger",
              execute,
            }
          : undefined,
    });

    expect(results).toMatchObject([
      {
        status: "executed",
        run: { runId: "extfx-1" },
        result: { status: "executed", claim: { replayAttempt: "retry_after_failure" } },
      },
      {
        status: "skipped",
        run: { runId: "extfx-unknown" },
        reason: "external_boundary_already_crossed",
      },
    ]);
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        routePath: runs[0].routePath,
        idempotencyKey: "operator-key",
        actorScope: "conn-1",
        updatedAt: "2026-05-31T00:02:00.000Z",
      }),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(markCompleted).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "operator-key" }));
  });

  it("retries stale claimed-not-sent runs but leaves fresh claims alone", async () => {
    const execute = vi.fn(async (claim) => {
      claim.markExternalCallStarted();
      return { output: { id: "retry-1" } };
    });
    const mutationStore = {
      claim: vi.fn(() => ({
        outcome: "claimed" as const,
        claimKind: "retry_after_failure" as const,
        record: {
          method: "POST",
          routePath: "external",
          idempotencyKey: "operator-key",
          actorScope: "conn-1",
          payloadHash: "payload-hash",
          status: "pending" as const,
          createdAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:10:00.000Z",
        },
      })),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };

    const results = await runReplaySafeExternalSideEffectWorker({
      runs: [
        sideEffectRun({
          runId: "extfx-stale",
          status: "claimed_not_sent",
          resumeState: "not_resumable",
          updatedAt: "2026-05-31T00:00:00.000Z",
        }),
        sideEffectRun({
          runId: "extfx-fresh",
          status: "claimed_not_sent",
          resumeState: "not_resumable",
          updatedAt: "2026-05-31T00:09:30.000Z",
        }),
      ],
      checkedAt: "2026-05-31T00:10:00.000Z",
      staleClaimedNotSentAfterMs: 60_000,
      buildJob: (run) => ({
        mutationStore,
        sideEffectRunStore: createSideEffectRunStore(),
        boundary: run.boundary,
        catalogId: run.catalogId,
        connectionId: run.connectionId,
        actionId: run.actionId,
        checkedAt: "2026-05-31T00:10:00.000Z",
        idempotencyKey: run.idempotencyKey,
        payload: { provider: "activepieces", message: "safe retry" },
        label: "Activepieces webhook trigger",
        execute,
      }),
    });

    expect(results).toMatchObject([
      { status: "executed", run: { runId: "extfx-stale" } },
      { status: "skipped", run: { runId: "extfx-fresh" }, reason: "claimed_not_sent_not_stale" },
    ]);
    expect(mutationStore.markFailed).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("refuses replay jobs that do not preserve the recorded side-effect identity", async () => {
    const execute = vi.fn();
    const mutationStore = {
      claim: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };

    const results = await runReplaySafeExternalSideEffectWorker({
      runs: [sideEffectRun()],
      checkedAt: "2026-05-31T00:10:00.000Z",
      buildJob: (run) => ({
        mutationStore,
        sideEffectRunStore: createSideEffectRunStore(),
        boundary: run.boundary,
        catalogId: run.catalogId,
        connectionId: "different-connection",
        actionId: run.actionId,
        checkedAt: "2026-05-31T00:10:00.000Z",
        idempotencyKey: run.idempotencyKey,
        payload: { provider: "activepieces", message: "wrong target" },
        label: "Activepieces webhook trigger",
        execute,
      }),
    });

    expect(results).toMatchObject([
      {
        status: "skipped",
        reason: "job_identity_mismatch",
      },
    ]);
    expect(mutationStore.markFailed).not.toHaveBeenCalled();
    expect(mutationStore.claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
