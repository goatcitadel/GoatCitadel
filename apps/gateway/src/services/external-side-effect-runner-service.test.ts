import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalSideEffectBoundaryClaimLostError, Storage } from "@goatcitadel/storage";
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

const realStorageTempRoots: string[] = [];

afterEach(() => {
  for (const root of realStorageTempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createSideEffectRunStore(
  replayRunId = "extfx-1",
  statusStale = true,
): ExternalSideEffectRunStore & {
  createOrGet: ReturnType<typeof vi.fn>;
  markExternalCallStarted: ReturnType<typeof vi.fn>;
  markCompleted: ReturnType<typeof vi.fn>;
  markFailure: ReturnType<typeof vi.fn>;
  markFailureIfStatus: ReturnType<typeof vi.fn>;
  isStatusStale: ReturnType<typeof vi.fn>;
} {
  return {
    createOrGet: vi.fn((input, now) => ({
      runId: replayRunId,
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
    markFailureIfStatus: vi.fn((runId, _expectedStatus, input, now) => ({
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
    isStatusStale: vi.fn(() => statusStale),
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
    expect(sideEffectRunStore.markFailureIfStatus).toHaveBeenCalledWith(
      "extfx-1",
      "external_call_started",
      {
        status: "unknown_external_outcome",
        errorText: "run mirror unavailable",
      },
      "2026-05-31T00:00:00.000Z",
    );
  });

  it("does not let non-strict completion readback failure downgrade a completed real SQLite run", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-legacy-completed-"));
    realStorageTempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const sideEffectRunStore: ExternalSideEffectRunStore = {
      createOrGet: (input, now) => storage.externalSideEffectRuns.createOrGet(input, now),
      markExternalCallStarted: (runId, input, now) =>
        storage.externalSideEffectRuns.markExternalCallStarted(runId, input, now),
      markCompleted: (runId, input, now) => {
        storage.externalSideEffectRuns.markCompleted(runId, input, now);
        throw new Error("completion readback failed after the row committed");
      },
      markFailure: (runId, input, now) => storage.externalSideEffectRuns.markFailure(runId, input, now),
      markFailureIfStatus: (runId, expectedStatus, input, now) =>
        storage.externalSideEffectRuns.markFailureIfStatus(runId, expectedStatus, input, now),
    };

    try {
      const result = await runIdempotentExternalSideEffect({
        mutationStore: storage.mutationIdempotency,
        sideEffectRunStore,
        boundary: "legacy_connector_delivery",
        connectionId: "conn-legacy-completion",
        actionId: "send-legacy-completion",
        idempotencyKey: "legacy-completion-key",
        checkedAt: "2026-05-31T00:00:00.000Z",
        payload: { message: "sent once" },
        label: "Legacy completion readback proof",
        execute: async (claim) => {
          claim.markExternalCallStarted();
          return { id: "provider-sent-once" };
        },
      });

      expect(result.status).toBe("executed");
      expect(storage.externalSideEffectRuns.listByConnection("conn-legacy-completion")[0]).toMatchObject({
        status: "completed",
        resumeState: "completed",
        externalReferenceId: "id:provider-sent-once",
      });
    } finally {
      storage.close();
    }
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

  it("rejects strict durable execution before claiming when no transaction owner is supplied", async () => {
    const mutationStore = createStatefulMutationIdempotencyStore();
    const sideEffectRunStore = createSideEffectRunStore();
    const provider = vi.fn(async () => ({ ok: true }));

    await expect(
      runIdempotentExternalSideEffect({
        mutationStore,
        sideEffectRunStore,
        boundary: "durable_connector_delivery",
        connectionId: "conn-1",
        actionId: "run-transaction-required",
        idempotencyKey: "strict-transaction-required",
        checkedAt: "2026-05-31T00:00:00.000Z",
        payload: { message: "sent" },
        label: "Durable connector delivery",
        requireDurableBoundaryRecord: true,
        execute: async (claim) => {
          claim.markExternalCallStarted();
          return provider();
        },
      }),
    ).rejects.toThrow(/transaction owner/i);
    expect(mutationStore.claim).not.toHaveBeenCalled();
    expect(sideEffectRunStore.createOrGet).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects raw destination values before claiming or invoking a provider", async () => {
    const mutationStore = createStatefulMutationIdempotencyStore();
    const provider = vi.fn();

    await expect(
      runIdempotentExternalSideEffect({
        mutationStore,
        boundary: "integration_operator_action",
        connectionId: "conn-raw-target",
        actionId: "trigger_webhook",
        checkedAt: "2026-05-31T00:00:00.000Z",
        externalDestinationFingerprint: "https://provider.example.test/hook?token=must-not-persist",
        payload: { provider: "activepieces" },
        label: "Raw target refusal",
        execute: provider,
      }),
    ).rejects.toThrow(/fingerprint must be a SHA-256 hex digest/i);
    expect(mutationStore.claim).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("commits both strict completion records through the transaction owner", async () => {
    const mutationStore = createStatefulMutationIdempotencyStore();
    const sideEffectRunStore = createSideEffectRunStore();
    const runClaimTransaction = vi.fn(<T>(work: () => T): T => work());

    const result = await runIdempotentExternalSideEffect({
      mutationStore,
      sideEffectRunStore,
      runClaimTransaction,
      boundary: "durable_connector_delivery",
      connectionId: "conn-1",
      actionId: "run-atomic-completion",
      idempotencyKey: "strict-atomic-completion",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { message: "sent" },
      label: "Durable connector delivery",
      requireDurableBoundaryRecord: true,
      execute: async (claim) => {
        claim.markExternalCallStarted();
        return { ok: true };
      },
    });

    expect(result.status).toBe("executed");
    expect(runClaimTransaction).toHaveBeenCalledTimes(3);
    expect(mutationStore.markCompleted).toHaveBeenCalledTimes(1);
    expect(sideEffectRunStore.markCompleted).toHaveBeenCalledTimes(1);
  });

  it("fails strict durable callers before provider invocation when the boundary marker cannot persist", async () => {
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
          idempotencyKey: "strict-key",
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
    const provider = vi.fn(async () => ({ ok: true }));

    const result = await runIdempotentExternalSideEffect({
      mutationStore,
      sideEffectRunStore,
      runClaimTransaction: (work) => work(),
      boundary: "durable_connector_delivery",
      connectionId: "conn-1",
      actionId: "run-1",
      idempotencyKey: "strict-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { message: "sent" },
      label: "Durable connector delivery",
      requireDurableBoundaryRecord: true,
      execute: async (claim) => {
        claim.markExternalCallStarted();
        return provider();
      },
    });

    expect(result.status).toBe("failed");
    expect(provider).not.toHaveBeenCalled();
    expect(mutationStore.markFailed).toHaveBeenCalled();
    expect(sideEffectRunStore.markFailureIfStatus).toHaveBeenCalledWith(
      "extfx-1",
      "claimed_not_sent",
      expect.objectContaining({ status: "failed_before_boundary" }),
      "2026-05-31T00:00:00.000Z",
    );
  });

  it("keeps a real rolled-back boundary marker failure safely retryable before provider invocation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-boundary-rollback-"));
    realStorageTempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const sideEffectRunStore = new Proxy(storage.externalSideEffectRuns, {
      get(target, property, receiver) {
        if (property === "markExternalCallStarted") {
          return () => {
            throw new Error("started mirror unavailable");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ExternalSideEffectRunStore;
    const provider = vi.fn(async () => ({ ok: true }));

    try {
      const result = await runIdempotentExternalSideEffect({
        mutationStore: storage.mutationIdempotency,
        sideEffectRunStore,
        runClaimTransaction: <T>(work: () => T): T => storage.runImmediateTransaction(work),
        boundary: "durable_connector_delivery",
        connectionId: "conn-boundary-rollback",
        actionId: "send-boundary-rollback",
        idempotencyKey: "boundary-rollback-key",
        checkedAt: "2026-05-31T00:00:00.000Z",
        payload: { message: "must not be sent" },
        label: "Boundary rollback proof",
        requireMutationClaimOwnership: true,
        requireDurableBoundaryRecord: true,
        execute: async (claim) => {
          claim.markExternalCallStarted();
          return provider();
        },
      });

      expect(result).toMatchObject({
        status: "failed",
        claim: { resumeState: "manual_retry_after_recorded_failure" },
      });
      expect(provider).not.toHaveBeenCalled();
      expect(storage.externalSideEffectRuns.listByConnection("conn-boundary-rollback")[0]).toMatchObject({
        status: "failed_before_boundary",
        resumeState: "manual_retry_after_recorded_failure",
      });
    } finally {
      storage.close();
    }
  });

  it("does not reopen idempotency when a strict caller loses its durable boundary claim", async () => {
    const sideEffectRunStore = createSideEffectRunStore();
    sideEffectRunStore.markExternalCallStarted.mockImplementation(() => {
      throw new ExternalSideEffectBoundaryClaimLostError("extfx-1", "unknown_external_outcome");
    });
    const mutationStore = {
      claim: vi.fn(() => ({
        outcome: "claimed" as const,
        claimKind: "new" as const,
        record: {
          method: "POST",
          routePath: "external",
          idempotencyKey: "strict-key",
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
    const provider = vi.fn(async () => ({ ok: true }));

    const result = await runIdempotentExternalSideEffect({
      mutationStore,
      sideEffectRunStore,
      runClaimTransaction: (work) => work(),
      boundary: "approved_external_runtime",
      connectionId: "conn-1",
      actionId: "approval-1",
      idempotencyKey: "strict-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { message: "sent" },
      label: "Approved external runtime action",
      requireDurableBoundaryRecord: true,
      execute: async (claim) => {
        claim.markExternalCallStarted();
        return provider();
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      claim: { resumeState: "manual_review_unknown_external_outcome" },
    });
    expect(provider).not.toHaveBeenCalled();
    expect(mutationStore.markFailed).not.toHaveBeenCalled();
    expect(sideEffectRunStore.markFailure).not.toHaveBeenCalled();
    expect(sideEffectRunStore.markFailureIfStatus).not.toHaveBeenCalled();
  });

  it("does not report false completion after a strict claimant's mutation generation is stolen", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-completed-winner-"));
    realStorageTempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const base = {
      mutationStore: storage.mutationIdempotency,
      sideEffectRunStore: storage.externalSideEffectRuns,
      runClaimTransaction: <T>(work: () => T): T => storage.runImmediateTransaction(work),
      boundary: "durable_connector_delivery",
      connectionId: "conn-completed-winner",
      actionId: "send-completed-winner",
      idempotencyKey: "completed-winner-key",
      checkedAt: "2026-05-31T00:00:00.000Z",
      payload: { message: "send once" },
      label: "Completed winner proof",
      requireDurableBoundaryRecord: true,
    } as const;
    let releaseOriginal!: () => void;
    const originalGate = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    let originalStarted!: () => void;
    const originalStartedGate = new Promise<void>((resolve) => {
      originalStarted = resolve;
    });

    try {
      const original = runIdempotentExternalSideEffect({
        ...base,
        execute: async (claim) => {
          claim.markExternalCallStarted();
          originalStarted();
          await originalGate;
          return { id: "provider-sent-once" };
        },
      });
      await originalStartedGate;
      const run = storage.externalSideEffectRuns.listByConnection(base.connectionId)[0]!;
      storage.mutationIdempotency.markFailed({
        method: "POST",
        routePath: run.routePath,
        idempotencyKey: run.idempotencyKey,
        actorScope: run.actorScope,
        updatedAt: "2026-05-31T00:10:00.000Z",
      });

      let releaseRetry!: () => void;
      const retryGate = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      let retryEntered!: () => void;
      const retryEnteredGate = new Promise<void>((resolve) => {
        retryEntered = resolve;
      });
      const retry = runIdempotentExternalSideEffect({
        ...base,
        checkedAt: "2026-05-31T00:10:00.000Z",
        execute: async (claim) => {
          retryEntered();
          await retryGate;
          claim.markExternalCallStarted();
          return { id: "must-not-send" };
        },
      });
      await retryEnteredGate;

      releaseOriginal();
      await expect(original).resolves.toMatchObject({
        status: "failed",
        claim: { resumeState: "manual_review_unknown_external_outcome" },
        error: { code: "EXTERNAL_SIDE_EFFECT_BOUNDARY_CLAIM_LOST" },
      });
      expect(storage.externalSideEffectRuns.get(run.runId).status).toBe("unknown_external_outcome");

      releaseRetry();
      await expect(retry).resolves.toMatchObject({
        status: "failed",
        claim: { resumeState: "manual_review_unknown_external_outcome" },
      });
      expect(storage.externalSideEffectRuns.get(run.runId)).toMatchObject({
        status: "unknown_external_outcome",
        resumeState: "manual_review_unknown_external_outcome",
      });
    } finally {
      storage.close();
    }
  });

  it("records a genuine active strict-boundary failure with real SQLite CAS", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-active-failure-"));
    realStorageTempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });

    try {
      const result = await runIdempotentExternalSideEffect({
        mutationStore: storage.mutationIdempotency,
        sideEffectRunStore: storage.externalSideEffectRuns,
        runClaimTransaction: <T>(work: () => T): T => storage.runImmediateTransaction(work),
        boundary: "durable_connector_delivery",
        connectionId: "conn-active-failure",
        actionId: "send-active-failure",
        idempotencyKey: "active-failure-key",
        checkedAt: "2026-05-31T00:00:00.000Z",
        payload: { message: "outcome unknown" },
        label: "Active failure proof",
        requireDurableBoundaryRecord: true,
        execute: async (claim) => {
          claim.markExternalCallStarted();
          throw new Error("connection reset after provider dispatch");
        },
      });

      expect(result).toMatchObject({
        status: "failed",
        claim: { resumeState: "manual_review_unknown_external_outcome" },
      });
      expect(storage.externalSideEffectRuns.listByConnection("conn-active-failure")[0]).toMatchObject({
        status: "unknown_external_outcome",
        resumeState: "manual_review_unknown_external_outcome",
      });
    } finally {
      storage.close();
    }
  });

  it("lets only one restarted SQLite replay worker own a stale claimed-not-sent mutation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-replay-workers-"));
    realStorageTempRoots.push(root);
    const dbPath = path.join(root, "runtime.sqlite");
    const payload = { provider: "activepieces", message: "send once after restart" };
    const seedStorage = new Storage({
      dbPath,
      transcriptsDir: path.join(root, "seed-transcripts"),
      auditDir: path.join(root, "seed-audit"),
    });
    const seeded = claimIdempotentExternalSideEffect({
      mutationStore: seedStorage.mutationIdempotency,
      sideEffectRunStore: seedStorage.externalSideEffectRuns,
      runClaimTransaction: <T>(work: () => T): T => seedStorage.runImmediateTransaction(work),
      workspaceId: "workspace-replay",
      boundary: "integration_operator_action",
      catalogId: "automation.activepieces",
      connectionId: "conn-replay-workers",
      actionId: "trigger_webhook",
      actorScope: "conn-replay-workers",
      idempotencyKey: "restart-replay-key",
      checkedAt: "2026-01-01T00:00:00.000Z",
      payload,
    });
    expect(seeded.claimToken).toEqual(expect.any(String));
    expect(
      seedStorage.mutationIdempotency.markFailed({
        method: "POST",
        routePath: seeded.routePath,
        idempotencyKey: seeded.idempotencyKey,
        actorScope: seeded.actorScope,
        claimToken: seeded.claimToken,
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    ).toBe(true);
    expect(
      seedStorage.mutationIdempotency.claim({
        method: "POST",
        routePath: seeded.routePath,
        idempotencyKey: seeded.idempotencyKey,
        actorScope: seeded.actorScope,
        payloadHash: seeded.payloadHash,
        now: "2026-01-01T00:00:02.000Z",
        leaseDurationMs: 1_000,
      }),
    ).toMatchObject({ outcome: "claimed" });
    seedStorage.gatewaySql
      .prepare("UPDATE external_side_effect_runs SET updated_at = ? WHERE run_id = ?")
      .run("2020-01-01T00:00:00.000Z", seeded.sideEffectRunId!);
    const staleRun = seedStorage.externalSideEffectRuns.get(seeded.sideEffectRunId!);
    seedStorage.close();

    const workerA = new Storage({
      dbPath,
      transcriptsDir: path.join(root, "worker-a-transcripts"),
      auditDir: path.join(root, "worker-a-audit"),
    });
    const workerB = new Storage({
      dbPath,
      transcriptsDir: path.join(root, "worker-b-transcripts"),
      auditDir: path.join(root, "worker-b-audit"),
    });
    const provider = vi.fn(async () => ({ output: { id: "provider-once" } }));
    const buildWorker = (storage: Storage) =>
      runReplaySafeExternalSideEffectWorker({
        runs: [staleRun],
        checkedAt: "2099-01-01T00:00:00.000Z",
        staleClaimedNotSentAfterMs: 60_000,
        buildJob: (run) => ({
          mutationStore: storage.mutationIdempotency,
          sideEffectRunStore: storage.externalSideEffectRuns,
          runClaimTransaction: <T>(work: () => T): T => storage.runImmediateTransaction(work),
          workspaceId: run.workspaceId,
          boundary: run.boundary,
          catalogId: run.catalogId,
          connectionId: run.connectionId,
          actionId: run.actionId,
          actorScope: run.actorScope,
          idempotencyKey: run.idempotencyKey,
          checkedAt: "2099-01-01T00:00:00.000Z",
          payload,
          label: "Restarted Activepieces replay",
          execute: async (claim) => {
            claim.markExternalCallStarted();
            return provider();
          },
        }),
      });

    try {
      const results = (await Promise.all([buildWorker(workerA), buildWorker(workerB)])).flat();

      expect(results.map((result) => result.status).sort()).toEqual(["executed", "skipped"]);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(workerA.externalSideEffectRuns.get(staleRun.runId)).toMatchObject({
        status: "completed",
        resumeState: "completed",
        attemptCount: 1,
      });
      expect(
        workerA.mutationIdempotency.get({
          method: "POST",
          routePath: seeded.routePath,
          idempotencyKey: seeded.idempotencyKey,
          actorScope: seeded.actorScope,
        }),
      ).toMatchObject({ status: "completed" });
    } finally {
      workerA.close();
      workerB.close();
    }
  });

  it("does not let a stale replay snapshot duplicate a provider call after the winner's lease expires", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-replay-long-provider-"));
    realStorageTempRoots.push(root);
    const dbPath = path.join(root, "runtime.sqlite");
    const payload = { provider: "activepieces", message: "one provider call across an expired lease" };
    const seedStorage = new Storage({
      dbPath,
      transcriptsDir: path.join(root, "seed-transcripts"),
      auditDir: path.join(root, "seed-audit"),
    });
    const seeded = claimIdempotentExternalSideEffect({
      mutationStore: seedStorage.mutationIdempotency,
      sideEffectRunStore: seedStorage.externalSideEffectRuns,
      runClaimTransaction: <T>(work: () => T): T => seedStorage.runImmediateTransaction(work),
      workspaceId: "workspace-long-provider",
      boundary: "integration_operator_action",
      catalogId: "automation.activepieces",
      connectionId: "conn-long-provider",
      actionId: "trigger_webhook",
      actorScope: "conn-long-provider",
      idempotencyKey: "long-provider-replay-key",
      checkedAt: "2026-01-01T00:00:00.000Z",
      payload,
    });
    expect(
      seedStorage.mutationIdempotency.markFailed({
        method: "POST",
        routePath: seeded.routePath,
        idempotencyKey: seeded.idempotencyKey,
        actorScope: seeded.actorScope,
        claimToken: seeded.claimToken,
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    ).toBe(true);
    seedStorage.gatewaySql
      .prepare("UPDATE external_side_effect_runs SET updated_at = ? WHERE run_id = ?")
      .run("2020-01-01T00:00:00.000Z", seeded.sideEffectRunId!);
    const staleRun = seedStorage.externalSideEffectRuns.get(seeded.sideEffectRunId!);
    seedStorage.close();

    const workerA = new Storage({
      dbPath,
      transcriptsDir: path.join(root, "worker-a-transcripts"),
      auditDir: path.join(root, "worker-a-audit"),
    });
    const workerB = new Storage({
      dbPath,
      transcriptsDir: path.join(root, "worker-b-transcripts"),
      auditDir: path.join(root, "worker-b-audit"),
    });
    let releaseProviderA!: () => void;
    const providerAGate = new Promise<void>((resolve) => {
      releaseProviderA = resolve;
    });
    let providerAStarted!: () => void;
    const providerAStartedGate = new Promise<void>((resolve) => {
      providerAStarted = resolve;
    });
    const providerA = vi.fn(async () => {
      providerAStarted();
      await providerAGate;
      return { output: { id: "provider-a" } };
    });
    const providerB = vi.fn(async () => ({ output: { id: "provider-b-must-not-run" } }));
    const buildWorker = (storage: Storage, provider: typeof providerA) =>
      runReplaySafeExternalSideEffectWorker({
        runs: [staleRun],
        checkedAt: "2099-01-01T00:00:00.000Z",
        staleClaimedNotSentAfterMs: 10,
        buildJob: (run) => ({
          mutationStore: storage.mutationIdempotency,
          sideEffectRunStore: storage.externalSideEffectRuns,
          runClaimTransaction: <T>(work: () => T): T => storage.runImmediateTransaction(work),
          workspaceId: run.workspaceId,
          boundary: run.boundary,
          catalogId: run.catalogId,
          connectionId: run.connectionId,
          actionId: run.actionId,
          actorScope: run.actorScope,
          idempotencyKey: run.idempotencyKey,
          checkedAt: "2099-01-01T00:00:00.000Z",
          payload,
          label: "Long-running Activepieces replay",
          execute: async (claim) => {
            claim.markExternalCallStarted();
            return provider();
          },
        }),
      });

    let first: ReturnType<typeof buildWorker> | undefined;
    try {
      first = buildWorker(workerA, providerA);
      await providerAStartedGate;
      await new Promise((resolve) => setTimeout(resolve, 30));

      const second = await buildWorker(workerB, providerB);
      releaseProviderA();
      const firstResult = await first;

      expect([...firstResult, ...second].map((result) => result.status).sort()).toEqual(["executed", "skipped"]);
      expect(providerA).toHaveBeenCalledTimes(1);
      expect(providerB).not.toHaveBeenCalled();
      expect(workerA.externalSideEffectRuns.get(staleRun.runId)).toMatchObject({
        status: "completed",
        resumeState: "completed",
        externalReferenceId: "id:provider-a",
        attemptCount: 1,
      });
    } finally {
      releaseProviderA();
      await first?.catch(() => undefined);
      workerA.close();
      workerB.close();
    }
  });

  it("stops an expired losing worker before the provider after a restarted worker completes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-losing-worker-"));
    realStorageTempRoots.push(root);
    const dbPath = path.join(root, "runtime.sqlite");
    const originalStorage = new Storage({
      dbPath,
      transcriptsDir: path.join(root, "original-transcripts"),
      auditDir: path.join(root, "original-audit"),
    });
    const replayStorage = new Storage({
      dbPath,
      transcriptsDir: path.join(root, "replay-transcripts"),
      auditDir: path.join(root, "replay-audit"),
    });
    const payload = { provider: "activepieces", message: "single owner" };
    const originalProvider = vi.fn(async () => ({ output: { id: "loser-must-not-send" } }));
    const replayProvider = vi.fn(async () => ({ output: { id: "replay-winner" } }));
    let releaseOriginal!: () => void;
    const originalGate = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    let originalEntered!: () => void;
    const originalEnteredGate = new Promise<void>((resolve) => {
      originalEntered = resolve;
    });
    let original: Promise<unknown> | undefined;

    try {
      original = runIdempotentExternalSideEffect({
        mutationStore: originalStorage.mutationIdempotency,
        sideEffectRunStore: originalStorage.externalSideEffectRuns,
        workspaceId: "workspace-replay",
        boundary: "integration_operator_action",
        catalogId: "automation.activepieces",
        connectionId: "conn-losing-worker",
        actionId: "trigger_webhook",
        actorScope: "conn-losing-worker",
        idempotencyKey: "losing-worker-key",
        checkedAt: "2026-01-01T00:00:00.000Z",
        claimLeaseDurationMs: 5,
        payload,
        label: "Original Activepieces request",
        execute: async (claim) => {
          originalEntered();
          await originalGate;
          claim.markExternalCallStarted();
          return originalProvider();
        },
      });
      await originalEnteredGate;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const staleRun = originalStorage.externalSideEffectRuns.listByConnection("conn-losing-worker", {
        workspaceId: "workspace-replay",
      })[0]!;

      const replay = await runReplaySafeExternalSideEffectWorker({
        runs: [staleRun],
        checkedAt: "2099-01-01T00:00:00.000Z",
        staleClaimedNotSentAfterMs: 5,
        buildJob: (run) => ({
          mutationStore: replayStorage.mutationIdempotency,
          sideEffectRunStore: replayStorage.externalSideEffectRuns,
          runClaimTransaction: <T>(work: () => T): T => replayStorage.runImmediateTransaction(work),
          workspaceId: run.workspaceId,
          boundary: run.boundary,
          catalogId: run.catalogId,
          connectionId: run.connectionId,
          actionId: run.actionId,
          actorScope: run.actorScope,
          idempotencyKey: run.idempotencyKey,
          checkedAt: "2099-01-01T00:00:00.000Z",
          payload,
          label: "Restarted Activepieces replay",
          execute: async (claim) => {
            claim.markExternalCallStarted();
            return replayProvider();
          },
        }),
      });
      expect(replay).toMatchObject([{ status: "executed" }]);

      releaseOriginal();
      await expect(original).resolves.toMatchObject({
        status: "failed",
        claim: { resumeState: "manual_review_unknown_external_outcome" },
        error: { code: "EXTERNAL_SIDE_EFFECT_BOUNDARY_CLAIM_LOST" },
      });
      expect(originalProvider).not.toHaveBeenCalled();
      expect(replayProvider).toHaveBeenCalledTimes(1);
      expect(replayStorage.externalSideEffectRuns.get(staleRun.runId)).toMatchObject({
        status: "completed",
        resumeState: "completed",
        externalReferenceId: "id:replay-winner",
      });
    } finally {
      releaseOriginal();
      await original?.catch(() => undefined);
      originalStorage.close();
      replayStorage.close();
    }
  });

  it("uses the database clock for replay leases when the app eligibility clock is skewed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-clock-skew-"));
    realStorageTempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const payload = { provider: "activepieces", message: "live owner" };

    try {
      const liveClaim = claimIdempotentExternalSideEffect({
        mutationStore: storage.mutationIdempotency,
        sideEffectRunStore: storage.externalSideEffectRuns,
        workspaceId: "workspace-clock",
        boundary: "integration_operator_action",
        catalogId: "automation.activepieces",
        connectionId: "conn-clock",
        actionId: "trigger_webhook",
        actorScope: "conn-clock",
        idempotencyKey: "clock-skew-key",
        checkedAt: "2000-01-01T00:00:00.000Z",
        claimLeaseDurationMs: 60_000,
        payload,
      });
      const provider = vi.fn();
      const run = storage.externalSideEffectRuns.get(liveClaim.sideEffectRunId!);

      const replay = await runReplaySafeExternalSideEffectWorker({
        runs: [run],
        checkedAt: "2999-01-01T00:00:00.000Z",
        staleClaimedNotSentAfterMs: 60_000,
        buildJob: (candidate) => ({
          mutationStore: storage.mutationIdempotency,
          sideEffectRunStore: storage.externalSideEffectRuns,
          runClaimTransaction: <T>(work: () => T): T => storage.runImmediateTransaction(work),
          workspaceId: candidate.workspaceId,
          boundary: candidate.boundary,
          catalogId: candidate.catalogId,
          connectionId: candidate.connectionId,
          actionId: candidate.actionId,
          actorScope: candidate.actorScope,
          idempotencyKey: candidate.idempotencyKey,
          checkedAt: "2999-01-01T00:00:00.000Z",
          payload,
          label: "Clock-skew replay",
          execute: provider,
        }),
      });

      expect(replay).toMatchObject([
        { status: "skipped", run: { runId: run.runId }, reason: "claimed_not_sent_not_stale" },
      ]);
      expect(provider).not.toHaveBeenCalled();
      expect(
        storage.mutationIdempotency.get({
          method: "POST",
          routePath: liveClaim.routePath,
          idempotencyKey: liveClaim.idempotencyKey,
          actorScope: liveClaim.actorScope,
        }),
      ).toMatchObject({ status: "pending", claimToken: liveClaim.claimToken });
    } finally {
      storage.close();
    }
  });

  it("uses database age before taking over a lease-less production claim under app clock skew", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-lease-less-clock-skew-"));
    realStorageTempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const payload = { provider: "activepieces", flowId: "flow-1", payload: {} };

    try {
      const liveClaim = claimIdempotentExternalSideEffect({
        mutationStore: storage.mutationIdempotency,
        sideEffectRunStore: storage.externalSideEffectRuns,
        workspaceId: "workspace-clock",
        boundary: "integration_operator_action",
        catalogId: "automation.activepieces",
        connectionId: "conn-clock-lease-less",
        actionId: "trigger_webhook",
        actorScope: "conn-clock-lease-less",
        idempotencyKey: "clock-skew-lease-less-key",
        checkedAt: new Date().toISOString(),
        payload,
      });
      const provider = vi.fn();
      const run = storage.externalSideEffectRuns.get(liveClaim.sideEffectRunId!);

      const replay = await runReplaySafeExternalSideEffectWorker({
        runs: [run],
        checkedAt: "2999-01-01T00:00:00.000Z",
        staleClaimedNotSentAfterMs: 60_000,
        buildJob: (candidate) => ({
          mutationStore: storage.mutationIdempotency,
          sideEffectRunStore: storage.externalSideEffectRuns,
          runClaimTransaction: <T>(work: () => T): T => storage.runImmediateTransaction(work),
          workspaceId: candidate.workspaceId,
          boundary: candidate.boundary,
          catalogId: candidate.catalogId,
          connectionId: candidate.connectionId,
          actionId: candidate.actionId,
          actorScope: candidate.actorScope,
          idempotencyKey: candidate.idempotencyKey,
          checkedAt: "2999-01-01T00:00:00.000Z",
          payload,
          label: "Lease-less clock-skew replay",
          execute: provider,
        }),
      });

      expect(replay).toMatchObject([
        { status: "skipped", run: { runId: run.runId }, reason: "claimed_not_sent_not_stale" },
      ]);
      expect(provider).not.toHaveBeenCalled();
      expect(
        storage.mutationIdempotency.get({
          method: "POST",
          routePath: liveClaim.routePath,
          idempotencyKey: liveClaim.idempotencyKey,
          actorScope: liveClaim.actorScope,
        }),
      ).toMatchObject({ status: "pending", claimToken: liveClaim.claimToken });
    } finally {
      storage.close();
    }
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
    const markFailed = vi.fn(() => true);
    const markCompleted = vi.fn(() => true);
    const execute = vi.fn(async (claim) => {
      claim.markExternalCallStarted();
      return { output: { id: "flow-run-1" } };
    });
    const sideEffectRunStore = createSideEffectRunStore();
    const mutationStore = {
      claim: vi
        .fn()
        .mockReturnValueOnce({
          outcome: "claimed" as const,
          claimKind: "retry_after_failure" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "payload-hash",
            status: "pending" as const,
            claimToken: "replay-claim-1",
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:02:00.000Z",
          },
        })
        .mockReturnValueOnce({
          outcome: "claimed" as const,
          claimKind: "retry_after_failure" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "payload-hash",
            status: "pending" as const,
            claimToken: "replay-boundary-claim-2",
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:02:00.000Z",
          },
        }),
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
              runClaimTransaction: (work) => work(),
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
        claimToken: "replay-claim-1",
      }),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "operator-key", claimToken: "replay-boundary-claim-2" }),
    );
  });

  it("retries stale claimed-not-sent runs but leaves fresh claims alone", async () => {
    const execute = vi.fn(async (claim) => {
      claim.markExternalCallStarted();
      return { output: { id: "retry-1" } };
    });
    const mutationStore = {
      claim: vi
        .fn()
        .mockReturnValueOnce({
          outcome: "claimed" as const,
          claimKind: "retry_after_stale_claim" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "payload-hash",
            status: "pending" as const,
            claimToken: "stale-claim-1",
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:10:00.000Z",
          },
        })
        .mockReturnValueOnce({
          outcome: "claimed" as const,
          claimKind: "retry_after_failure" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "payload-hash",
            status: "pending" as const,
            claimToken: "stale-boundary-claim-2",
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:10:00.000Z",
          },
        }),
      markCompleted: vi.fn(() => true),
      markFailed: vi.fn(() => true),
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
        sideEffectRunStore: createSideEffectRunStore(run.runId, run.runId === "extfx-stale"),
        runClaimTransaction: (work) => work(),
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
    expect(mutationStore.markFailed).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "stale-claim-1" }));
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

  it("refuses replay jobs without a transaction owner before claiming or invoking the provider", async () => {
    const execute = vi.fn();
    const mutationStore = {
      claim: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };
    const run = sideEffectRun();

    const results = await runReplaySafeExternalSideEffectWorker({
      runs: [run],
      checkedAt: "2026-05-31T00:10:00.000Z",
      buildJob: () => ({
        mutationStore,
        sideEffectRunStore: createSideEffectRunStore(run.runId),
        boundary: run.boundary,
        catalogId: run.catalogId,
        connectionId: run.connectionId,
        actionId: run.actionId,
        actorScope: run.actorScope,
        checkedAt: "2026-05-31T00:10:00.000Z",
        idempotencyKey: run.idempotencyKey,
        payload: { provider: "activepieces", message: "must not execute" },
        label: "Activepieces webhook trigger",
        execute,
      }),
    });

    expect(results).toMatchObject([{ status: "skipped", reason: "job_unavailable" }]);
    expect(mutationStore.claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses replay jobs that would claim a different actor scope or mutation route", async () => {
    const execute = vi.fn();
    const mutationStore = {
      claim: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };
    const cases = [
      {
        run: sideEffectRun({ runId: "extfx-actor-mismatch" }),
        actorScope: "different-actor",
      },
      {
        run: sideEffectRun({ runId: "extfx-route-mismatch", routePath: "/legacy/external-side-effect/route" }),
        actorScope: "conn-1",
      },
    ];

    for (const replayCase of cases) {
      const results = await runReplaySafeExternalSideEffectWorker({
        runs: [replayCase.run],
        checkedAt: "2026-05-31T00:10:00.000Z",
        buildJob: (run) => ({
          mutationStore,
          sideEffectRunStore: createSideEffectRunStore(),
          boundary: run.boundary,
          catalogId: run.catalogId,
          connectionId: run.connectionId,
          actionId: run.actionId,
          actorScope: replayCase.actorScope,
          checkedAt: "2026-05-31T00:10:00.000Z",
          idempotencyKey: run.idempotencyKey,
          payload: { provider: "activepieces", message: "wrong identity" },
          label: "Activepieces webhook trigger",
          execute,
        }),
      });

      expect(results).toMatchObject([{ status: "skipped", reason: "job_identity_mismatch" }]);
    }
    expect(mutationStore.markFailed).not.toHaveBeenCalled();
    expect(mutationStore.claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
