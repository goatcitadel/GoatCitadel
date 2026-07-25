import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { DatabaseClient, DbStatement } from "./db.js";
import { Storage } from "./index.js";
import { ModelUsageEventRepository } from "./model-usage-event-repo.js";
import type { BeginModelUsageAttemptInput, FinalizeModelUsageAttemptInput } from "./model-usage-event-repo.js";

const storages: Storage[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createStorage(options: { modelUsageRecoverySweepIntervalMs?: number } = {}): Storage {
  const root = path.join(os.tmpdir(), `goatcitadel-model-usage-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  const storage = new Storage({
    dbPath: path.join(root, "storage.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
    ...options,
  });
  storages.push(storage);
  return storage;
}

function seedSession(storage: Storage, sessionId = "session-a", workspaceId = "workspace-a"): void {
  storage.sessions.upsert({
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: "2026-07-13T00:00:00.000Z",
  });
  storage.chatSessionMeta.ensure(sessionId, "2026-07-13T00:00:00.000Z", workspaceId);
}

function beginInput(overrides: Partial<BeginModelUsageAttemptInput> = {}): BeginModelUsageAttemptInput {
  return {
    eventId: "usage-event-1",
    idempotencyKey: "usage-key-1",
    source: "manual_test",
    callKind: "chat_initial",
    requestedProviderId: "openai",
    requestedModelId: "gpt-5",
    effectiveProviderId: "openai",
    effectiveModelId: "gpt-5-2026-07-01",
    effectiveApiStyle: "openai-chat-completions",
    routeDecisionId: "route-1",
    contextSnapshotId: "context-snapshot-1",
    contextIntentHash: "context-intent-hash-1",
    contextEntryRefId: "context-entry-1",
    operationId: "turn-a:call-0",
    dispatchGeneration: "generation-1",
    attemptIndex: 0,
    transportAttemptIndex: 0,
    dispatchOwnerId: "gateway-owner-a",
    dispatchLeaseExpiresAt: "2026-07-13T00:10:00.000Z",
    fallbackIndex: 0,
    repairIndex: 0,
    workspaceId: "workspace-a",
    sessionId: "session-a",
    turnId: "turn-a",
    durableRunId: "durable-a",
    taskId: "task-a",
    agentId: "agent-a",
    credentialType: "api_key",
    usagePool: "standard",
    credentialSource: "env",
    credentialConfigFingerprint: "a".repeat(64),
    pricingCatalogVersion: "2026-07-13",
    pricingCatalogHash: "b".repeat(64),
    inputRateUsdPerMillion: 0,
    outputRateUsdPerMillion: 0,
    cachedInputRateUsdPerMillion: 0,
    startedAt: "2026-07-13T00:00:01.000Z",
    ...overrides,
  };
}

function zeroFinal(overrides: Partial<FinalizeModelUsageAttemptInput> = {}): FinalizeModelUsageAttemptInput {
  return {
    dispatchOwnerId: "gateway-owner-a",
    terminalOutcome: "succeeded",
    availability: "tracked",
    pricingSource: "gateway_estimate",
    costSource: "gateway_estimate",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    reportedEffectiveModelId: "gpt-5-2026-07-02",
    contextResolutionHash: "context-resolution-hash-1",
    finishedAt: "2026-07-13T00:00:02.000Z",
    durationMs: 1_000,
    ...overrides,
  };
}

describe("ModelUsageEventRepository", () => {
  it("round-trips complete requested/effective output-cap recovery lineage", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(
      beginInput({
        requestedOutputTokenCap: 4096,
        effectiveOutputTokenCap: 4096,
        outputCapDisposition: "initial",
      }),
    );
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    storage.modelUsageEvents.finalize("usage-event-1", {
      dispatchOwnerId: "gateway-owner-a",
      terminalOutcome: "failed_before_usage",
      availability: "unknown",
      pricingSource: "not_available",
      costSource: "not_available",
      errorCode: "provideroutputcaperror",
      finishedAt: "2026-07-13T00:00:02.000Z",
      durationMs: 1_000,
    });
    storage.modelUsageEvents.begin(
      beginInput({
        eventId: "usage-event-2",
        idempotencyKey: "usage-key-2",
        transportAttemptIndex: 1,
        requestedOutputTokenCap: 4096,
        effectiveOutputTokenCap: 1984,
        outputCapDisposition: "reduced_retry",
        outputCapRecoverySourceEventId: "usage-event-1",
        outputCapRecoveryReasonCode: "safe_lower_cap",
        outputCapProviderAvailableTokens: 2048,
        outputCapProviderMinimumTokens: 1,
        outputCapRequestInputEstimate: 4000,
        outputCapConfiguredContextWindowTokens: 16_384,
        outputCapSafetyMarginTokens: 64,
        outputCapEvidenceFormat: "bounded_range",
        transportRetryParentEventId: "usage-event-1",
        transportRetryReason: "output_cap_recovery",
      }),
    );

    const retry = storage.modelUsageEvents.findByEventId("usage-event-2");
    assert.ok(retry);
    assert.deepEqual(
      {
        requestedOutputTokenCap: retry.requestedOutputTokenCap,
        effectiveOutputTokenCap: retry.effectiveOutputTokenCap,
        outputCapDisposition: retry.outputCapDisposition,
        outputCapRecoverySourceEventId: retry.outputCapRecoverySourceEventId,
        outputCapRecoveryReasonCode: retry.outputCapRecoveryReasonCode,
        outputCapProviderAvailableTokens: retry.outputCapProviderAvailableTokens,
        outputCapProviderMinimumTokens: retry.outputCapProviderMinimumTokens,
        outputCapRequestInputEstimate: retry.outputCapRequestInputEstimate,
        outputCapConfiguredContextWindowTokens: retry.outputCapConfiguredContextWindowTokens,
        outputCapSafetyMarginTokens: retry.outputCapSafetyMarginTokens,
        outputCapEvidenceFormat: retry.outputCapEvidenceFormat,
        transportRetryParentEventId: retry.transportRetryParentEventId,
        transportRetryReason: retry.transportRetryReason,
      },
      {
        requestedOutputTokenCap: 4096,
        effectiveOutputTokenCap: 1984,
        outputCapDisposition: "reduced_retry",
        outputCapRecoverySourceEventId: "usage-event-1",
        outputCapRecoveryReasonCode: "safe_lower_cap",
        outputCapProviderAvailableTokens: 2048,
        outputCapProviderMinimumTokens: 1,
        outputCapRequestInputEstimate: 4000,
        outputCapConfiguredContextWindowTokens: 16_384,
        outputCapSafetyMarginTokens: 64,
        outputCapEvidenceFormat: "bounded_range",
        transportRetryParentEventId: "usage-event-1",
        transportRetryReason: "output_cap_recovery",
      },
    );
  });

  it("rejects partial, non-decreasing, or source-less reduced output-cap lineage", () => {
    const storage = createStorage();
    assert.throws(
      () => storage.modelUsageEvents.begin(beginInput({ requestedOutputTokenCap: 4096 })),
      /supplied together/u,
    );
    assert.throws(
      () =>
        storage.modelUsageEvents.begin(
          beginInput({
            requestedOutputTokenCap: 4096,
            effectiveOutputTokenCap: 4096,
            outputCapDisposition: "reduced_retry",
          }),
        ),
      /complete prior-attempt/u,
    );
  });

  it("records metadata compatibility as a preserved-cap retry of the immediate failed parent", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(
      beginInput({
        requestedOutputTokenCap: 1984,
        effectiveOutputTokenCap: 1984,
        outputCapDisposition: "initial",
      }),
    );
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    storage.modelUsageEvents.finalize("usage-event-1", {
      dispatchOwnerId: "gateway-owner-a",
      terminalOutcome: "failed_before_usage",
      availability: "unknown",
      pricingSource: "not_available",
      costSource: "not_available",
      errorCode: "providermetadatacompatibilityerror",
      finishedAt: "2026-07-13T00:00:02.000Z",
      durationMs: 1_000,
    });
    storage.modelUsageEvents.begin(
      beginInput({
        eventId: "usage-event-2",
        idempotencyKey: "usage-key-2",
        transportAttemptIndex: 1,
        requestedOutputTokenCap: 1984,
        effectiveOutputTokenCap: 1984,
        outputCapDisposition: "preserved_retry",
        transportRetryParentEventId: "usage-event-1",
        transportRetryReason: "metadata_compatibility",
      }),
    );
    const retry = storage.modelUsageEvents.findByEventId("usage-event-2");
    assert.equal(retry?.outputCapDisposition, "preserved_retry");
    assert.equal(retry?.effectiveOutputTokenCap, 1984);
    assert.equal(retry?.transportRetryParentEventId, "usage-event-1");
    assert.equal(retry?.transportRetryReason, "metadata_compatibility");
  });

  it("rejects retry parents across immutable scope and a second child of the same parent", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(
      beginInput({
        requestedOutputTokenCap: 4096,
        effectiveOutputTokenCap: 4096,
        outputCapDisposition: "initial",
      }),
    );
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    storage.modelUsageEvents.finalize("usage-event-1", {
      dispatchOwnerId: "gateway-owner-a",
      terminalOutcome: "failed_before_usage",
      availability: "unknown",
      pricingSource: "not_available",
      costSource: "not_available",
      errorCode: "provideroutputcaperror",
      finishedAt: "2026-07-13T00:00:02.000Z",
      durationMs: 1_000,
    });
    const retryInput = beginInput({
      eventId: "usage-event-2",
      idempotencyKey: "usage-key-2",
      transportAttemptIndex: 1,
      requestedOutputTokenCap: 4096,
      effectiveOutputTokenCap: 1984,
      outputCapDisposition: "reduced_retry",
      outputCapRecoverySourceEventId: "usage-event-1",
      outputCapRecoveryReasonCode: "safe_lower_cap",
      outputCapProviderAvailableTokens: 2048,
      outputCapProviderMinimumTokens: 1,
      outputCapRequestInputEstimate: 4000,
      outputCapConfiguredContextWindowTokens: 16_384,
      outputCapSafetyMarginTokens: 64,
      outputCapEvidenceFormat: "bounded_range",
      transportRetryParentEventId: "usage-event-1",
      transportRetryReason: "output_cap_recovery",
    });
    assert.throws(
      () => storage.modelUsageEvents.begin({ ...retryInput, workspaceId: "workspace-other" }),
      /immediately prior compatible failed provider attempt/u,
    );
    storage.modelUsageEvents.begin(retryInput);
    assert.throws(
      () => storage.modelUsageEvents.begin({ ...retryInput, eventId: "usage-event-3", idempotencyKey: "usage-key-3" }),
      /UNIQUE constraint failed|duplicate key/iu,
    );
  });

  it("enforces cap combinations in SQL and rejects forged rows in the mapper", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(
      beginInput({
        requestedOutputTokenCap: 4096,
        effectiveOutputTokenCap: 4096,
        outputCapDisposition: "initial",
      }),
    );
    assert.throws(
      () =>
        storage.db
          .prepare(
            `
        UPDATE model_usage_events
        SET output_cap_disposition = 'preserved_retry'
        WHERE event_id = 'usage-event-1'
      `,
          )
          .run(),
      /invalid model usage output-cap retry lineage/u,
    );

    storage.db.exec("DROP TRIGGER trg_model_usage_events_cap_lineage_update");
    storage.db.exec("PRAGMA ignore_check_constraints = ON");
    storage.db
      .prepare(
        `
      UPDATE model_usage_events
      SET effective_output_token_cap = 5000
      WHERE event_id = 'usage-event-1'
    `,
      )
      .run();
    assert.throws(
      () => storage.modelUsageEvents.findByEventId("usage-event-1"),
      /Persisted model usage output-cap values are invalid/u,
    );
  });

  it("uses a PostgreSQL row lock for transactionally fenced canonical evidence reads", () => {
    const preparedSql: string[] = [];
    const emptyStatement: DbStatement = {
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    };
    const db: DatabaseClient = {
      dialect: "postgres",
      prepare(sql) {
        preparedSql.push(sql);
        return emptyStatement;
      },
      exec() {},
      close() {},
      transaction(_mode, callback) {
        return callback();
      },
    };
    const repo = new ModelUsageEventRepository(db);

    assert.equal(repo.findByEventIdForUpdate("usage-event-missing"), undefined);
    assert.ok(
      preparedSql.some(
        (sql) => sql.includes("FROM model_usage_events WHERE event_id = ?") && sql.trimEnd().endsWith("FOR UPDATE"),
      ),
    );
    const recoverySql = preparedSql.filter((sql) => sql.includes("WITH expired AS"));
    assert.equal(recoverySql.length, 2);
    for (const sql of recoverySql) {
      assert.match(sql, /FOR UPDATE SKIP LOCKED/u);
      assert.match(sql, /UPDATE model_usage_events AS target/u);
      assert.match(sql, /target\.terminal_outcome = 'in_flight'/u);
      assert.match(sql, /target\.dispatch_lease_expires_at <= @recoveredAt/u);
    }
    assert.match(
      recoverySql.find((sql) => sql.includes("transport_status = 'intent'")) ?? "",
      /target\.transport_status = 'intent'/u,
    );
    assert.match(
      recoverySql.find((sql) => sql.includes("transport_status = 'accepted'")) ?? "",
      /target\.transport_status = 'accepted'/u,
    );
  });

  it("preserves unknown usage, records terminal failures, and exposes bounded summary", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(beginInput());
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    storage.modelUsageEvents.finalizeAndProject("usage-event-1", {
      dispatchOwnerId: "gateway-owner-a",
      terminalOutcome: "failed_before_usage",
      availability: "unknown",
      pricingSource: "not_available",
      costSource: "not_available",
      errorCode: "provider_timeout",
      finishedAt: "2026-07-13T00:00:02.000Z",
      durationMs: 1_000,
    });

    const result = storage.modelUsageEvents.list({ workspaceId: "workspace-a", limit: 20 });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.terminalOutcome, "failed_before_usage");
    assert.equal(result.items[0]?.inputTokens, undefined);
    assert.equal(result.items[0]?.costUsd, undefined);
    assert.deepEqual(result.summary, {
      attemptCount: 1,
      uncertainDispatchCount: 0,
      trackedAttemptCount: 0,
      unknownAttemptCount: 1,
      metricAvailability: {
        inputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        outputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        cachedInputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        costUsd: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
      },
    });
  });

  it("projects exact-zero tracked usage once and accepts provider-reported model drift", () => {
    const storage = createStorage();
    seedSession(storage);
    storage.modelUsageEvents.begin(beginInput());
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2999-01-01T00:00:00.000Z");

    const first = storage.modelUsageEvents.finalizeAndProject("usage-event-1", zeroFinal());
    const replay = storage.modelUsageEvents.finalizeAndProject("usage-event-1", zeroFinal());

    assert.equal(first.finalized, true);
    assert.equal(first.compatibilityProjected, true);
    assert.equal(replay.finalized, false);
    assert.equal(replay.compatibilityProjected, false);
    assert.equal(first.record.dispatchedModelId, "gpt-5-2026-07-01");
    assert.equal(first.record.effectiveModelId, "gpt-5-2026-07-02");
    assert.equal(first.record.contextSnapshotId, "context-snapshot-1");
    assert.equal(first.record.contextIntentHash, "context-intent-hash-1");
    assert.equal(first.record.contextEntryRefId, "context-entry-1");
    assert.equal(first.record.contextResolutionHash, "context-resolution-hash-1");
    assert.equal(count(storage, "cost_ledger", "canonical_usage_event_id = 'usage-event-1'"), 1);
    assert.equal(storage.sessions.getBySessionId("session-a").tokenTotal, 0);
    assert.deepEqual(storage.costLedger.usageAvailability("2026-07-13T00:00:00Z", "2026-07-13T23:59:59Z"), {
      trackedEvents: 1,
      unknownEvents: 0,
      totalAgentEvents: 1,
      metricAvailability: {
        inputTokens: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
        outputTokens: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
        cachedInputTokens: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
        costUsd: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
      },
    });
  });

  it("includes sessionless chat and image spend while de-duplicating compatibility rows", () => {
    const storage = createStorage();
    const sessionless = {
      sessionId: undefined,
      turnId: undefined,
      durableRunId: undefined,
      taskId: undefined,
      agentId: undefined,
      contextSnapshotId: undefined,
      contextIntentHash: undefined,
      contextEntryRefId: undefined,
    };
    const attempts = [
      {
        eventId: "usage-sessionless-chat",
        callKind: "chat_initial" as const,
        operationId: "raw-chat",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        costUsd: 0.4,
      },
      {
        eventId: "usage-sessionless-image",
        callKind: "image_generation" as const,
        operationId: "raw-image",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0.6,
      },
    ];

    for (const attempt of attempts) {
      storage.modelUsageEvents.begin(
        beginInput({
          ...sessionless,
          eventId: attempt.eventId,
          idempotencyKey: attempt.eventId,
          callKind: attempt.callKind,
          operationId: attempt.operationId,
        }),
      );
      storage.modelUsageEvents.acceptTransport(attempt.eventId, "gateway-owner-a", "2999-01-01T00:00:00.000Z");
      const result = storage.modelUsageEvents.finalizeAndProject(attempt.eventId, {
        ...zeroFinal(),
        pricingSource: "provider_reported",
        costSource: "provider_reported",
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        cachedInputTokens: attempt.cachedInputTokens,
        costUsd: attempt.costUsd,
      });
      assert.equal(result.compatibilityProjected, true);
    }

    seedSession(storage);
    storage.modelUsageEvents.begin(
      beginInput({
        eventId: "usage-session-bound",
        idempotencyKey: "usage-session-bound",
        operationId: "session-bound-chat",
      }),
    );
    storage.modelUsageEvents.acceptTransport("usage-session-bound", "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    storage.modelUsageEvents.finalizeAndProject("usage-session-bound", {
      ...zeroFinal(),
      pricingSource: "provider_reported",
      costSource: "provider_reported",
      inputTokens: 2,
      outputTokens: 1,
      cachedInputTokens: 0,
      costUsd: 0.25,
    });

    assert.equal(count(storage, "cost_ledger", "canonical_usage_event_id IS NOT NULL"), 1);
    assert.deepEqual(storage.costLedger.summary("day", "2026-07-13T00:00:00.000Z", "2026-07-13T23:59:59.999Z"), [
      {
        scope: "day",
        key: "2026-07-13",
        tokenInput: 12,
        tokenOutput: 6,
        tokenCachedInput: 0,
        tokenTotal: 18,
        costUsd: 1.25,
        metricAvailability: {
          inputTokensComplete: true,
          outputTokensComplete: true,
          cachedInputTokensComplete: true,
          costUsdComplete: true,
        },
      },
    ]);
    const series = storage.costLedger.dailySeries("2026-07-13T00:00:00.000Z", "2026-07-13T23:59:59.999Z");
    assert.equal(series[0]?.costUsd, 1.25);
    assert.equal(series[0]?.tokenTotal, 18);
    assert.equal(series[0]?.segments[0]?.providerKey, "openai");
    assert.deepEqual(series[0]?.segments[0]?.models, ["gpt-5-2026-07-02"]);
  });

  it("rejects idempotency aliases across immutable scope and provenance", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(beginInput());
    assert.throws(
      () =>
        storage.modelUsageEvents.begin(
          beginInput({ eventId: "other-event", workspaceId: "foreign", credentialSource: "keychain" }),
        ),
      /idempotency key was reused/u,
    );
  });

  it("projects partial known metrics with an explicit mask and marks canonical sums as lower bounds", () => {
    const storage = createStorage();
    seedSession(storage);
    storage.modelUsageEvents.begin(beginInput());
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    storage.modelUsageEvents.finalizeAndProject("usage-event-1", {
      dispatchOwnerId: "gateway-owner-a",
      terminalOutcome: "succeeded",
      availability: "tracked",
      pricingSource: "not_available",
      costSource: "not_available",
      inputTokens: 12,
      outputTokens: 3,
      finishedAt: "2026-07-13T00:00:02.000Z",
      durationMs: 1_000,
    });

    const costRow = storage.db
      .prepare("SELECT usage_known_mask, token_input, token_output, token_cached_input, cost_usd FROM cost_ledger")
      .get<Record<string, unknown>>();
    assert.equal(costRow?.usage_known_mask, "input,output");
    assert.equal(storage.sessions.getBySessionId("session-a").tokenTotal, 15);
    const canonical = storage.modelUsageEvents.list({ sessionId: "session-a" });
    assert.equal(canonical.summary.inputTokens, 12);
    assert.deepEqual(canonical.summary.metricAvailability.costUsd, {
      knownAttemptCount: 0,
      unknownAttemptCount: 1,
      complete: false,
    });
    const legacy = storage.costLedger.summary("session", "2026-07-13T00:00:00.000Z", "2026-07-13T23:59:59.999Z");
    assert.equal(legacy[0]?.tokenTotal, 15);
    assert.deepEqual(legacy[0]?.metricAvailability, {
      inputTokensComplete: true,
      outputTokensComplete: true,
      cachedInputTokensComplete: false,
      costUsdComplete: false,
    });
  });

  it("rejects contradictory cost provenance", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(beginInput());
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    assert.throws(
      () =>
        storage.modelUsageEvents.finalize("usage-event-1", {
          ...zeroFinal(),
          costSource: "not_available",
          pricingSource: "not_available",
        }),
      /known cost requires/u,
    );
    assert.throws(
      () =>
        storage.modelUsageEvents.finalize("usage-event-1", {
          dispatchOwnerId: "gateway-owner-a",
          terminalOutcome: "succeeded",
          availability: "tracked",
          pricingSource: "provider_reported",
          costSource: "provider_reported",
          inputTokens: 1,
          finishedAt: "2026-07-13T00:00:03.000Z",
          durationMs: 2_000,
        }),
      /absent cost must use/u,
    );
  });

  it("paginates deterministically and binds exact summary parameters", () => {
    const storage = createStorage();
    for (let index = 0; index < 3; index += 1) {
      const eventId = `usage-event-${index}`;
      storage.modelUsageEvents.begin(
        beginInput({
          eventId,
          idempotencyKey: `usage-key-${index}`,
          operationId: `turn-a:call-${index}`,
          startedAt: `2026-07-13T00:00:0${index}.000Z`,
        }),
      );
      storage.modelUsageEvents.acceptTransport(eventId, "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    }
    const first = storage.modelUsageEvents.list({ workspaceId: "workspace-a", limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    assert.equal(first.summary.attemptCount, 3);
    const second = storage.modelUsageEvents.list({ workspaceId: "workspace-a", limit: 2, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0]?.eventId, "usage-event-0");
  });

  it("prunes only terminal retained-window rows and session deletion removes lineage", () => {
    const storage = createStorage();
    seedSession(storage);
    storage.modelUsageEvents.begin(beginInput());
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    storage.modelUsageEvents.finalizeAndProject("usage-event-1", zeroFinal());
    storage.modelUsageEvents.begin(
      beginInput({ eventId: "usage-in-flight", idempotencyKey: "usage-in-flight", operationId: "in-flight" }),
    );
    storage.modelUsageEvents.acceptTransport("usage-in-flight", "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    assert.equal(storage.modelUsageEvents.pruneTerminalBefore("2026-07-14T00:00:00.000Z", 100), 1);
    assert.ok(storage.modelUsageEvents.findByEventId("usage-in-flight"));

    storage.modelUsageEvents.begin(
      beginInput({ eventId: "usage-session-delete", idempotencyKey: "usage-session-delete", operationId: "delete" }),
    );
    storage.deleteChatSessionData("session-a");
    assert.equal(count(storage, "model_usage_events", "session_id = 'session-a'"), 0);
    assert.equal(count(storage, "cost_ledger", "session_id = 'session-a'"), 0);
  });

  it("recovers the accept crash window as non-billable uncertainty and requires reconciliation before prune", () => {
    const first = createStorage();
    const root = roots.at(-1);
    assert.ok(root);
    first.modelUsageEvents.begin(beginInput({ dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z" }));
    first.close();
    storages.splice(storages.indexOf(first), 1);

    const recovered = new Storage({
      dbPath: path.join(root, "storage.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    storages.push(recovered);

    const uncertain = recovered.modelUsageEvents.findByEventId("usage-event-1");
    assert.equal(uncertain?.transportStatus, "dispatch_unknown");
    assert.equal(uncertain?.dispatchUncertaintyReason, "process_restart_before_transport_acceptance");
    assert.ok(uncertain?.dispatchUncertainAt);
    assert.equal(uncertain?.costUsd, 0);
    assert.equal(uncertain?.costSource, "gateway_estimate");
    assert.equal(uncertain?.pricingSource, "gateway_estimate");
    assert.equal(uncertain?.inputTokens, undefined);
    assert.equal(uncertain?.outputTokens, undefined);
    assert.equal(recovered.modelUsageEvents.list({ workspaceId: "workspace-a" }).items[0]?.eventId, "usage-event-1");
    assert.deepEqual(recovered.modelUsageEvents.list({ workspaceId: "workspace-a" }).summary, {
      attemptCount: 0,
      uncertainDispatchCount: 1,
      trackedAttemptCount: 0,
      unknownAttemptCount: 0,
      costUsd: 0,
      metricAvailability: {
        inputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        outputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        cachedInputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        costUsd: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
      },
    });
    assert.deepEqual(recovered.costLedger.usageAvailability("2026-07-13T00:00:00Z", "2026-07-13T23:59:59Z"), {
      trackedEvents: 0,
      unknownEvents: 1,
      totalAgentEvents: 1,
      metricAvailability: {
        inputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        outputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        cachedInputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        costUsd: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
      },
    });
    assert.equal(recovered.modelUsageEvents.pruneTerminalBefore("2026-07-14T00:00:00.000Z", 100), 0);
    const sameGeneration = recovered.modelUsageEvents.begin(beginInput({ eventId: "replayed-same-generation" }));
    assert.equal(sameGeneration.inserted, false);
    assert.equal(sameGeneration.record.eventId, "usage-event-1");

    recovered.modelUsageEvents.reconcileDispatchUnknown("usage-event-1", {
      reconciliation: "confirmed_not_dispatched",
      reconciledAt: "2026-07-13T12:00:00.000Z",
      evidence: "Operator reviewed provider logs; fresh dispatch requires generation-2.",
    });
    const replacement = recovered.modelUsageEvents.begin(
      beginInput({
        eventId: "usage-event-generation-2",
        idempotencyKey: "usage-key-generation-2",
        dispatchGeneration: "generation-2",
      }),
    );
    assert.equal(replacement.inserted, true);
    assert.equal(
      recovered.modelUsageEvents.abandonTransportIntent("usage-event-generation-2", "gateway-owner-a"),
      true,
    );
    assert.equal(recovered.modelUsageEvents.pruneTerminalBefore("2026-07-14T00:00:00.000Z", 100), 1);
  });

  it("rejects exact pricing rates that are not bound to a frozen catalog", () => {
    const storage = createStorage();

    assert.throws(
      () =>
        storage.modelUsageEvents.begin(
          beginInput({
            pricingCatalogVersion: undefined,
            pricingCatalogHash: undefined,
          }),
        ),
      /pricing rates require a frozen pricing catalog version, SHA-256 hash, and all exact rates/u,
    );
  });

  it("keeps immediate dispatch uncertainty unknown when legacy zero rates have no frozen catalog", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(beginInput());
    storage.db
      .prepare(
        "UPDATE model_usage_events SET pricing_catalog_version = NULL, pricing_catalog_hash = NULL WHERE event_id = ?",
      )
      .run("usage-event-1");

    const uncertain = storage.modelUsageEvents.markDispatchUnknown(
      "usage-event-1",
      "gateway-owner-a",
      "2026-07-13T00:00:02.000Z",
      "transport_acceptance_persistence_failed",
    );

    assert.equal(uncertain.transportStatus, "dispatch_unknown");
    assert.equal(uncertain.availability, "unknown");
    assert.equal(uncertain.pricingSource, "not_available");
    assert.equal(uncertain.costSource, "not_available");
    assert.equal(uncertain.costUsd, undefined);
  });

  it("keeps an expired legacy intent unknown when zero rates have no frozen catalog", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(beginInput({ dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z" }));
    storage.db
      .prepare(
        "UPDATE model_usage_events SET pricing_catalog_version = NULL, pricing_catalog_hash = NULL WHERE event_id = ?",
      )
      .run("usage-event-1");

    assert.equal(storage.modelUsageEvents.recoverExpiredIntents("2026-07-13T10:00:00.000Z"), 1);
    const uncertain = storage.modelUsageEvents.findByEventId("usage-event-1");
    assert.equal(uncertain?.transportStatus, "dispatch_unknown");
    assert.equal(uncertain?.availability, "unknown");
    assert.equal(uncertain?.pricingSource, "not_available");
    assert.equal(uncertain?.costSource, "not_available");
    assert.equal(uncertain?.costUsd, undefined);
  });

  it("keeps an expired legacy accepted attempt unknown when zero rates have no frozen catalog", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(beginInput({ dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z" }));
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2000-01-01T00:01:00.000Z");
    storage.db
      .prepare(
        "UPDATE model_usage_events SET pricing_catalog_version = NULL, pricing_catalog_hash = NULL WHERE event_id = ?",
      )
      .run("usage-event-1");

    assert.equal(storage.modelUsageEvents.recoverExpiredAcceptedDispatches("2026-07-13T10:00:00.000Z"), 1);
    const interrupted = storage.modelUsageEvents.findByEventId("usage-event-1");
    assert.equal(interrupted?.terminalOutcome, "interrupted_after_dispatch");
    assert.equal(interrupted?.availability, "unknown");
    assert.equal(interrupted?.pricingSource, "not_available");
    assert.equal(interrupted?.costSource, "not_available");
    assert.equal(interrupted?.costUsd, undefined);
  });

  it("treats an exact reconciliation retry as idempotent even when the server timestamp changes", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(beginInput({ dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z" }));
    assert.equal(storage.modelUsageEvents.recoverExpiredIntents("2026-07-13T10:00:00.000Z"), 1);

    const first = storage.modelUsageEvents.reconcileDispatchUnknown("usage-event-1", {
      reconciliation: "confirmed_not_dispatched",
      reconciledAt: "2026-07-13T11:00:00.000Z",
      reconciledBy: "operator-a",
      evidence: "Provider log confirms transport was never reached.",
    });
    const replay = storage.modelUsageEvents.reconcileDispatchUnknown("usage-event-1", {
      reconciliation: "confirmed_not_dispatched",
      reconciledAt: "2026-07-13T11:01:00.000Z",
      reconciledBy: "operator-a",
      evidence: "Provider log confirms transport was never reached.",
    });

    assert.equal(replay.dispatchReconciledAt, first.dispatchReconciledAt);
    assert.throws(
      () =>
        storage.modelUsageEvents.reconcileDispatchUnknown("usage-event-1", {
          reconciliation: "confirmed_not_dispatched",
          reconciledAt: "2026-07-13T11:02:00.000Z",
          reconciledBy: "operator-b",
          evidence: "Different operator evidence.",
        }),
      /conflicting reconciliation evidence/u,
    );
  });

  it("drains recovery backlogs across repeated bounded batches", () => {
    const storage = createStorage();
    for (let index = 0; index < 7; index += 1) {
      storage.modelUsageEvents.begin(
        beginInput({
          eventId: `intent-${index}`,
          idempotencyKey: `intent-key-${index}`,
          operationId: `intent-operation-${index}`,
          dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z",
        }),
      );
    }
    for (let index = 0; index < 5; index += 1) {
      const eventId = `accepted-${index}`;
      storage.modelUsageEvents.begin(
        beginInput({
          eventId,
          idempotencyKey: `accepted-key-${index}`,
          operationId: `accepted-operation-${index}`,
          dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z",
        }),
      );
      storage.modelUsageEvents.acceptTransport(eventId, "gateway-owner-a", "2000-01-01T00:00:00.000Z");
    }

    const result = storage.modelUsageEvents.recoverExpiredBacklog("2026-07-13T10:00:00.000Z", {
      batchSize: 2,
      maxBatches: 10,
    });

    assert.deepEqual(result, {
      recoveredIntentCount: 7,
      recoveredAcceptedCount: 5,
      batchCount: 4,
      batchLimitReached: false,
    });
    assert.equal(storage.modelUsageEvents.list({ workspaceId: "workspace-a" }).items.length, 12);
  });

  it("periodically recovers rows that become expired after startup", async () => {
    const storage = createStorage({ modelUsageRecoverySweepIntervalMs: 10 });
    storage.modelUsageEvents.begin(beginInput({ dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z" }));

    const deadline = Date.now() + 2_000;
    while (
      storage.modelUsageEvents.findByEventId("usage-event-1")?.transportStatus === "intent" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(storage.modelUsageEvents.findByEventId("usage-event-1")?.transportStatus, "dispatch_unknown");
  });

  it("does not recover a live owner's lease and fences accept and abandon by owner", () => {
    const first = createStorage();
    const root = roots.at(-1);
    assert.ok(root);
    first.modelUsageEvents.begin(
      beginInput({
        dispatchOwnerId: "live-owner",
        dispatchLeaseExpiresAt: "2999-01-01T00:00:00.000Z",
      }),
    );
    first.close();
    storages.splice(storages.indexOf(first), 1);

    const observer = new Storage({
      dbPath: path.join(root, "storage.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    storages.push(observer);
    assert.equal(observer.modelUsageEvents.findByEventId("usage-event-1")?.transportStatus, "intent");
    assert.throws(
      () => observer.modelUsageEvents.acceptTransport("usage-event-1", "foreign-owner", "2999-01-01T00:00:00.000Z"),
      /cannot be accepted/u,
    );
    assert.equal(observer.modelUsageEvents.abandonTransportIntent("usage-event-1", "foreign-owner"), false);
    assert.equal(
      observer.modelUsageEvents.acceptTransport("usage-event-1", "live-owner", "2999-01-01T00:00:00.000Z")
        .transportStatus,
      "accepted",
    );
  });

  it("recovers an expired accepted request as an interrupted unknown attempt and requires a new generation", () => {
    const first = createStorage();
    const root = roots.at(-1);
    assert.ok(root);
    first.modelUsageEvents.begin(
      beginInput({
        dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z",
        inputRateUsdPerMillion: 1,
        outputRateUsdPerMillion: 2,
        cachedInputRateUsdPerMillion: 0.5,
      }),
    );
    first.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2000-01-01T00:01:00.000Z");
    first.close();
    storages.splice(storages.indexOf(first), 1);

    const recovered = new Storage({
      dbPath: path.join(root, "storage.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    storages.push(recovered);
    const interrupted = recovered.modelUsageEvents.findByEventId("usage-event-1");
    assert.equal(interrupted?.transportStatus, "accepted");
    assert.equal(interrupted?.terminalOutcome, "interrupted_after_dispatch");
    assert.equal(interrupted?.availability, "unknown");
    assert.equal(interrupted?.errorCode, "process_restart_after_transport_acceptance");
    assert.equal(recovered.modelUsageEvents.list({ workspaceId: "workspace-a" }).summary.attemptCount, 1);
    assert.equal(recovered.modelUsageEvents.list({ workspaceId: "workspace-a" }).summary.unknownAttemptCount, 1);
    assert.throws(
      () => recovered.modelUsageEvents.finalize("usage-event-1", zeroFinal()),
      /conflicting terminal evidence/u,
    );
    assert.throws(
      () => recovered.modelUsageEvents.finalize("usage-event-1", zeroFinal({ dispatchOwnerId: "foreign-owner" })),
      /different dispatch owner/u,
    );
    const sameGeneration = recovered.modelUsageEvents.begin(
      beginInput({
        eventId: "same-generation-retry",
        inputRateUsdPerMillion: 1,
        outputRateUsdPerMillion: 2,
        cachedInputRateUsdPerMillion: 0.5,
      }),
    );
    assert.equal(sameGeneration.inserted, false);
    assert.equal(sameGeneration.record.eventId, "usage-event-1");
    assert.equal(
      recovered.modelUsageEvents.begin(
        beginInput({
          eventId: "new-generation-retry",
          idempotencyKey: "usage-key-generation-2",
          dispatchGeneration: "generation-2",
          inputRateUsdPerMillion: 1,
          outputRateUsdPerMillion: 2,
          cachedInputRateUsdPerMillion: 0.5,
        }),
      ).inserted,
      true,
    );
  });

  it("preserves provable zero local cost while recovering an expired accepted request", () => {
    const first = createStorage();
    const root = roots.at(-1);
    assert.ok(root);
    first.modelUsageEvents.begin(
      beginInput({
        effectiveProviderId: "llamacpp",
        effectiveModelId: "local-model",
        usagePool: "local",
        credentialType: "unknown",
        credentialSource: "none",
        dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z",
        inputRateUsdPerMillion: 0,
        outputRateUsdPerMillion: 0,
        cachedInputRateUsdPerMillion: 0,
      }),
    );
    first.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2000-01-01T00:01:00.000Z");
    first.close();
    storages.splice(storages.indexOf(first), 1);

    const recovered = new Storage({
      dbPath: path.join(root, "storage.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    storages.push(recovered);
    const interrupted = recovered.modelUsageEvents.findByEventId("usage-event-1");
    assert.equal(interrupted?.terminalOutcome, "interrupted_after_dispatch");
    assert.equal(interrupted?.availability, "tracked");
    assert.equal(interrupted?.pricingSource, "gateway_estimate");
    assert.equal(interrupted?.costSource, "gateway_estimate");
    assert.equal(interrupted?.costUsd, 0);
    assert.equal(interrupted?.inputTokens, undefined);
    assert.equal(interrupted?.outputTokens, undefined);
    assert.equal(interrupted?.cachedInputTokens, undefined);
    assert.deepEqual(recovered.modelUsageEvents.list({ workspaceId: "workspace-a" }).summary, {
      attemptCount: 1,
      uncertainDispatchCount: 0,
      trackedAttemptCount: 1,
      unknownAttemptCount: 0,
      costUsd: 0,
      metricAvailability: {
        inputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        outputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        cachedInputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        costUsd: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
      },
    });
  });

  it("renews a live accepted lease and recovers it only after the renewed expiry", () => {
    const storage = createStorage();
    storage.modelUsageEvents.begin(beginInput());
    storage.modelUsageEvents.acceptTransport("usage-event-1", "gateway-owner-a", "2026-07-14T00:00:00.000Z");
    storage.modelUsageEvents.renewTransportLease("usage-event-1", "gateway-owner-a", "2026-07-16T00:00:00.000Z");
    assert.throws(
      () => storage.modelUsageEvents.renewTransportLease("usage-event-1", "foreign-owner", "2026-07-17T00:00:00.000Z"),
      /cannot be renewed/u,
    );
    assert.equal(storage.modelUsageEvents.recoverExpiredAcceptedDispatches("2026-07-15T00:00:00.000Z"), 0);
    assert.equal(storage.modelUsageEvents.findByEventId("usage-event-1")?.terminalOutcome, "in_flight");
    assert.equal(storage.modelUsageEvents.recoverExpiredAcceptedDispatches("2026-07-17T00:00:00.000Z"), 1);
    assert.equal(
      storage.modelUsageEvents.findByEventId("usage-event-1")?.terminalOutcome,
      "interrupted_after_dispatch",
    );
  });

  it("projects reconciled dispatch uncertainty without inventing or hiding attempts", () => {
    const storage = createStorage();
    const cases = [
      ["not-dispatched", "confirmed_not_dispatched"],
      ["did-dispatch", "confirmed_dispatched_usage_unknown"],
      ["superseded", "superseded_by_new_generation"],
    ] as const;
    for (const [eventId] of cases) {
      storage.modelUsageEvents.begin(
        beginInput({
          eventId,
          idempotencyKey: `key-${eventId}`,
          operationId: `operation-${eventId}`,
          dispatchLeaseExpiresAt: "2000-01-01T00:00:00.000Z",
          inputRateUsdPerMillion: undefined,
          outputRateUsdPerMillion: undefined,
          cachedInputRateUsdPerMillion: undefined,
        }),
      );
    }
    assert.equal(storage.modelUsageEvents.recoverExpiredIntents("2026-07-13T10:00:00.000Z"), 3);
    for (const [eventId, reconciliation] of cases) {
      storage.modelUsageEvents.reconcileDispatchUnknown(eventId, {
        reconciliation,
        reconciledAt: "2026-07-13T11:00:00.000Z",
        evidence: `provider audit for ${eventId}`,
      });
    }

    const result = storage.modelUsageEvents.list({ workspaceId: "workspace-a" });
    assert.equal(result.items.length, 3);
    assert.equal(result.summary.attemptCount, 1);
    assert.equal(result.summary.uncertainDispatchCount, 1);
    assert.equal(result.summary.unknownAttemptCount, 1);
    assert.deepEqual(result.summary.metricAvailability.costUsd, {
      knownAttemptCount: 0,
      unknownAttemptCount: 2,
      complete: false,
    });
    assert.deepEqual(storage.costLedger.usageAvailability("2026-07-13T00:00:00Z", "2026-07-13T23:59:59Z"), {
      trackedEvents: 0,
      unknownEvents: 2,
      totalAgentEvents: 2,
      metricAvailability: {
        inputTokens: { knownAttemptCount: 0, unknownAttemptCount: 2, complete: false },
        outputTokens: { knownAttemptCount: 0, unknownAttemptCount: 2, complete: false },
        cachedInputTokens: { knownAttemptCount: 0, unknownAttemptCount: 2, complete: false },
        costUsd: { knownAttemptCount: 0, unknownAttemptCount: 2, complete: false },
      },
    });
  });

  it("round-trips reserved reasoning and ADC lineage as immutable attempt identity", () => {
    const storage = createStorage();
    const input = beginInput({
      requestedReasoningLevel: "high",
      dispatchedReasoningEffort: "medium",
      reasoningDisposition: "downgraded",
      reasoningReasonCode: "provider_cap",
      credentialType: "service_account",
      credentialSource: "adc",
    });
    const inserted = storage.modelUsageEvents.begin(input);
    assert.equal(inserted.record.requestedReasoningLevel, "high");
    assert.equal(inserted.record.dispatchedReasoningEffort, "medium");
    assert.equal(inserted.record.reasoningDisposition, "downgraded");
    assert.equal(inserted.record.reasoningReasonCode, "provider_cap");
    assert.equal(inserted.record.credentialType, "service_account");
    assert.equal(inserted.record.credentialSource, "adc");

    assert.throws(
      () =>
        storage.modelUsageEvents.begin(
          beginInput({
            eventId: "usage-event-reused",
            requestedReasoningLevel: "high",
            dispatchedReasoningEffort: "low",
            reasoningDisposition: "downgraded",
            reasoningReasonCode: "provider_cap",
            credentialType: "service_account",
            credentialSource: "adc",
          }),
        ),
      /idempotency key was reused/u,
    );
  });
});

function count(storage: Storage, table: string, where: string): number {
  const row = storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get<{ count: number }>();
  return Number(row?.count ?? 0);
}
