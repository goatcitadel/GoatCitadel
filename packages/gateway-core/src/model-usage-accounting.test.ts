import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import {
  ModelUsageAccountingService,
  ModelUsageDispatchPersistenceError,
  ModelUsageDispatchUncertainError,
  ModelUsageSettlementError,
  type BeginModelUsageDispatchInput,
  type ModelUsageDispatchReservation,
} from "./model-usage-accounting.js";

const storages: Storage[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createHarness(): { storage: Storage; accounting: ModelUsageAccountingService } {
  const root = path.join(os.tmpdir(), `goatcitadel-model-accounting-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  const storage = new Storage({
    dbPath: path.join(root, "storage.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  storages.push(storage);
  return {
    storage,
    accounting: new ModelUsageAccountingService(storage.modelUsageEvents, "gateway-owner-test", 60_000, 60_000),
  };
}

function dispatchInput(overrides: Partial<BeginModelUsageDispatchInput> = {}): BeginModelUsageDispatchInput {
  return {
    source: "llm_service",
    attribution: {
      operationId: "turn-1:provider-call-0",
      dispatchGeneration: "generation-1",
      callKind: "chat_initial",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      contextSnapshotId: "snapshot-1",
      contextIntentHash: "intent-hash-1",
      contextEntryRefId: "entry-1",
      contextResolutionHash: "resolution-hash-1",
    },
    requestedProviderId: "openai",
    requestedModelId: "gpt-5",
    effectiveProviderId: "openai",
    effectiveModelId: "gpt-5-2026-07-01",
    effectiveApiStyle: "openai-responses",
    transportAttemptIndex: 0,
    credential: {
      credentialType: "api_key",
      usagePool: "standard",
      credentialSource: "env",
      credentialConfigFingerprint: "a".repeat(64),
    },
    pricing: {
      catalogVersion: "2026-07-13",
      catalogHash: "b".repeat(64),
      inputRateUsdPerMillion: 1,
      outputRateUsdPerMillion: 2,
      cachedInputRateUsdPerMillion: 0.5,
    },
    ...overrides,
  };
}

function invokeFetch<T>(
  reservation: ModelUsageDispatchReservation,
  fetcher: () => Promise<T>,
): { pending: Promise<T>; handle: ReturnType<ModelUsageDispatchReservation["accept"]> } {
  let pending: Promise<T>;
  try {
    pending = fetcher();
  } catch (error) {
    reservation.abandon();
    throw error;
  }
  return { pending, handle: reservation.accept() };
}

describe("ModelUsageAccountingService", () => {
  it("makes successful terminal settlement faults authoritative and never reclassifies them", async () => {
    const { storage, accounting } = createHarness();
    const originalFinalize = storage.modelUsageEvents.finalizeAndProject.bind(storage.modelUsageEvents);
    let finalizeCalls = 0;
    storage.modelUsageEvents.finalizeAndProject = ((...args: Parameters<typeof originalFinalize>) => {
      finalizeCalls += 1;
      if (finalizeCalls === 1) throw new Error("injected settlement persistence fault");
      return originalFinalize(...args);
    }) as typeof storage.modelUsageEvents.finalizeAndProject;
    const call = invokeFetch(accounting.prepareDispatch(dispatchInput()), () => Promise.resolve({ ok: true }));
    await call.pending;

    let settlement: unknown;
    try {
      call.handle.succeed({ prompt_tokens: 3, completion_tokens: 1 });
    } catch (error) {
      settlement = error;
    }

    assert.ok(settlement instanceof ModelUsageSettlementError);
    assert.equal(settlement.intendedOutcome, "succeeded");
    assert.throws(
      () => call.handle.fail(new Error("late reclassification")),
      (error) => error === settlement,
    );
    assert.throws(
      () => call.handle.cancel(),
      (error) => error === settlement,
    );
    assert.equal(finalizeCalls, 1);
    assert.equal(storage.modelUsageEvents.findByEventId(call.handle.eventId)?.terminalOutcome, "in_flight");
  });

  it("makes failed-attempt settlement faults authoritative over the provider error", async () => {
    const { storage, accounting } = createHarness();
    const originalFinalize = storage.modelUsageEvents.finalizeAndProject.bind(storage.modelUsageEvents);
    let finalizeCalls = 0;
    storage.modelUsageEvents.finalizeAndProject = ((...args: Parameters<typeof originalFinalize>) => {
      finalizeCalls += 1;
      if (finalizeCalls === 1) throw new Error("injected failure settlement persistence fault");
      return originalFinalize(...args);
    }) as typeof storage.modelUsageEvents.finalizeAndProject;
    const call = invokeFetch(accounting.prepareDispatch(dispatchInput()), () => Promise.resolve({ ok: false }));
    await call.pending;

    assert.throws(
      () => call.handle.fail(new Error("provider transport rejected")),
      (error: unknown) => error instanceof ModelUsageSettlementError && error.intendedOutcome === "failed_before_usage",
    );
    assert.equal(finalizeCalls, 1);
    assert.equal(storage.modelUsageEvents.findByEventId(call.handle.eventId)?.terminalOutcome, "in_flight");
  });

  it("abandons a synchronous fetch throw without counting a network attempt", () => {
    const { storage, accounting } = createHarness();
    const reservation = accounting.prepareDispatch(dispatchInput());
    assert.throws(
      () =>
        invokeFetch(reservation, () => {
          throw new TypeError("invalid fetch input");
        }),
      /invalid fetch input/u,
    );
    assert.equal(storage.modelUsageEvents.findByEventId(reservation.eventId), undefined);
    assert.equal(storage.modelUsageEvents.list({ workspaceId: "workspace-1" }).summary.attemptCount, 0);
  });

  it("makes an intent-abandon persistence fault authoritative over a synchronous fetch error", () => {
    const { storage, accounting } = createHarness();
    const reservation = accounting.prepareDispatch(dispatchInput());
    let abandonCalls = 0;
    storage.modelUsageEvents.abandonTransportIntent = ((
      ..._args: Parameters<typeof storage.modelUsageEvents.abandonTransportIntent>
    ) => {
      abandonCalls += 1;
      throw new Error("injected abandon persistence fault");
    }) as typeof storage.modelUsageEvents.abandonTransportIntent;

    assert.throws(
      () =>
        invokeFetch(reservation, () => {
          throw new TypeError("invalid fetch input");
        }),
      (error: unknown) =>
        error instanceof ModelUsageDispatchPersistenceError &&
        error.action === "abandon_intent" &&
        error.eventId === reservation.eventId,
    );
    assert.equal(abandonCalls, 1);
    assert.equal(storage.modelUsageEvents.findByEventId(reservation.eventId)?.transportStatus, "intent");
  });

  it("makes a dispatch-unknown persistence fault authoritative and leaves recovery ownership intact", () => {
    const { storage, accounting } = createHarness();
    const reservation = accounting.prepareDispatch(dispatchInput());
    let markCalls = 0;
    storage.modelUsageEvents.markDispatchUnknown = ((
      ..._args: Parameters<typeof storage.modelUsageEvents.markDispatchUnknown>
    ) => {
      markCalls += 1;
      throw new Error("injected dispatch-unknown persistence fault");
    }) as typeof storage.modelUsageEvents.markDispatchUnknown;

    assert.throws(
      () => reservation.markDispatchUnknown(),
      (error: unknown) =>
        error instanceof ModelUsageDispatchPersistenceError &&
        error.action === "mark_dispatch_unknown" &&
        error.eventId === reservation.eventId,
    );
    assert.equal(markCalls, 1);
    assert.equal(storage.modelUsageEvents.findByEventId(reservation.eventId)?.transportStatus, "intent");
  });

  it("makes an accepted lease-renewal persistence fault authoritative and leaves recovery ownership intact", async () => {
    const { storage, accounting } = createHarness();
    const call = invokeFetch(accounting.prepareDispatch(dispatchInput()), () => Promise.resolve({ ok: true }));
    await call.pending;
    let renewCalls = 0;
    storage.modelUsageEvents.renewTransportLease = ((
      ..._args: Parameters<typeof storage.modelUsageEvents.renewTransportLease>
    ) => {
      renewCalls += 1;
      throw new Error("injected accepted lease-renewal persistence fault");
    }) as typeof storage.modelUsageEvents.renewTransportLease;

    assert.throws(
      () => call.handle.renewLease(Date.now() + 60_000),
      (error: unknown) =>
        error instanceof ModelUsageDispatchPersistenceError &&
        error.action === "renew_accepted_lease" &&
        error.eventId === call.handle.eventId,
    );
    assert.equal(renewCalls, 1);
    const accepted = storage.modelUsageEvents.findByEventId(call.handle.eventId);
    assert.equal(accepted?.transportStatus, "accepted");
    assert.equal(accepted?.terminalOutcome, "in_flight");
  });

  it("records promise rejection as failed_before_usage", async () => {
    const { storage, accounting } = createHarness();
    const reservation = accounting.prepareDispatch(dispatchInput());
    const failure = new Error("provider unavailable");
    const { pending, handle } = invokeFetch(reservation, () => Promise.reject(failure));
    await assert.rejects(pending, /provider unavailable/u);
    const record = handle.fail(failure);
    assert.equal(record.terminalOutcome, "failed_before_usage");
    assert.equal(record.availability, "unknown");
    assert.equal(storage.modelUsageEvents.list({ workspaceId: "workspace-1" }).summary.unknownAttemptCount, 1);
  });

  it("preserves provider-reported cost provenance and Responses cached input usage", async () => {
    const { accounting } = createHarness();
    const reservation = accounting.prepareDispatch(dispatchInput());
    const { pending, handle } = invokeFetch(reservation, () => Promise.resolve({ ok: true }));
    await pending;
    const record = handle.succeed({
      input_tokens: 12,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 3 },
      cost_usd: 0.25,
      model: "gpt-5-2026-07-02",
    });
    assert.equal(record.inputTokens, 12);
    assert.equal(record.outputTokens, 4);
    assert.equal(record.cachedInputTokens, 3);
    assert.equal(record.costUsd, 0.25);
    assert.equal(record.costSource, "provider_reported");
    assert.equal(record.pricingSource, "provider_reported");
    assert.equal(record.effectiveModelId, "gpt-5-2026-07-02");
    assert.equal(record.contextResolutionHash, "resolution-hash-1");
  });

  it("keeps partial usage on failure and classifies cancellation once", async () => {
    const { accounting } = createHarness();
    const partialReservation = accounting.prepareDispatch(dispatchInput());
    const partial = invokeFetch(partialReservation, () => Promise.resolve({ ok: true }));
    await partial.pending;
    partial.handle.observe({ input_tokens: 5 });
    const failed = partial.handle.fail(new Error("stream disconnected"));
    assert.equal(failed.terminalOutcome, "failed_after_usage");
    assert.equal(failed.inputTokens, 5);
    assert.equal(failed.outputTokens, undefined);

    const cancelReservation = accounting.prepareDispatch(
      dispatchInput({
        attribution: {
          ...dispatchInput().attribution,
          operationId: "turn-1:provider-call-1",
        },
      }),
    );
    const cancelledCall = invokeFetch(cancelReservation, () => Promise.resolve({ ok: true }));
    await cancelledCall.pending;
    const abort = new Error("operator cancelled stream");
    abort.name = "AbortError";
    const cancelled = cancelledCall.handle.fail(abort);
    assert.equal(cancelled.terminalOutcome, "cancelled");
    assert.equal(cancelledCall.handle.cancel(abort).eventId, cancelled.eventId);
  });

  it("blocks duplicate dispatch identity but permits an explicit new generation", () => {
    const { storage, accounting } = createHarness();
    const first = accounting.prepareDispatch(dispatchInput());
    assert.throws(
      () => accounting.prepareDispatch(dispatchInput()),
      (error: unknown) =>
        error instanceof ModelUsageDispatchUncertainError &&
        error.eventId === first.eventId &&
        /advance dispatchGeneration/u.test(error.message),
    );
    assert.equal(storage.modelUsageEvents.findByEventId(first.eventId)?.transportStatus, "intent");
    const next = accounting.prepareDispatch(
      dispatchInput({ attribution: { ...dispatchInput().attribution, dispatchGeneration: "generation-2" } }),
    );
    assert.notEqual(next.eventId, first.eventId);
    first.abandon();
    next.abandon();
  });

  it("tracks exact numeric zero instead of treating it as unknown", async () => {
    const { storage, accounting } = createHarness();
    const reservation = accounting.prepareDispatch(dispatchInput());
    const call = invokeFetch(reservation, () => Promise.resolve({ ok: true }));
    await call.pending;
    const record = call.handle.succeed({
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_input_tokens: 0,
      cost_usd: 0,
    });
    assert.equal(record.availability, "tracked");
    assert.equal(record.inputTokens, 0);
    assert.equal(record.outputTokens, 0);
    assert.equal(record.cachedInputTokens, 0);
    assert.equal(record.costUsd, 0);
    assert.equal(storage.modelUsageEvents.list({ workspaceId: "workspace-1" }).summary.trackedAttemptCount, 1);
  });

  it("merges split stream usage, drops invalid values, and never detaches cost provenance", async () => {
    const { accounting } = createHarness();
    const reservation = accounting.prepareDispatch(dispatchInput());
    const call = invokeFetch(reservation, () => Promise.resolve({ ok: true }));
    await call.pending;
    call.handle.observe({ input_tokens: 20, cached_input_tokens: -1 });
    call.handle.observeNormalized({ costSource: "gateway_estimate", pricingSource: "gateway_estimate" });
    call.handle.observe({ output_tokens: 6, cached_input_tokens: 4, cost_usd: 0.01 });
    const record = call.handle.succeed();
    assert.equal(record.inputTokens, 20);
    assert.equal(record.outputTokens, 6);
    assert.equal(record.cachedInputTokens, 4);
    assert.equal(record.costUsd, 0.01);
    assert.equal(record.costSource, "provider_reported");
    assert.equal(call.handle.fail(new Error("late failure")).eventId, record.eventId);
  });

  it("persists frozen reasoning, service-account, and ADC attribution at the transport seam", () => {
    const { storage, accounting } = createHarness();
    const reservation = accounting.prepareDispatch(
      dispatchInput({
        attribution: {
          ...dispatchInput().attribution,
          requestedReasoningLevel: "high",
          dispatchedReasoningEffort: "medium",
          reasoningDisposition: "downgraded",
          reasoningReasonCode: "provider_cap",
        },
        credential: {
          credentialType: "service_account",
          usagePool: "standard",
          credentialSource: "adc",
          credentialConfigFingerprint: "c".repeat(64),
        },
      }),
    );
    const record = storage.modelUsageEvents.findByEventId(reservation.eventId);
    assert.equal(record?.requestedReasoningLevel, "high");
    assert.equal(record?.dispatchedReasoningEffort, "medium");
    assert.equal(record?.reasoningDisposition, "downgraded");
    assert.equal(record?.reasoningReasonCode, "provider_cap");
    assert.equal(record?.credentialType, "service_account");
    assert.equal(record?.credentialSource, "adc");
    reservation.abandon();
  });

  it("keeps local dispatch uncertainty unresolved while proving exact zero cost", () => {
    const { storage, accounting } = createHarness();
    const reservation = accounting.prepareDispatch(
      dispatchInput({
        effectiveProviderId: "llamacpp",
        effectiveModelId: "local-model",
        credential: {
          credentialType: "unknown",
          usagePool: "local",
          credentialSource: "none",
        },
        pricing: {
          catalogVersion: "local-zero-v1",
          catalogHash: "d".repeat(64),
          inputRateUsdPerMillion: 0,
          outputRateUsdPerMillion: 0,
          cachedInputRateUsdPerMillion: 0,
        },
      }),
    );
    reservation.markDispatchUnknown("transport_acceptance_persistence_failed");

    const record = storage.modelUsageEvents.findByEventId(reservation.eventId);
    assert.equal(record?.transportStatus, "dispatch_unknown");
    assert.equal(record?.dispatchReconciliation, undefined);
    assert.equal(record?.inputTokens, undefined);
    assert.equal(record?.outputTokens, undefined);
    assert.equal(record?.cachedInputTokens, undefined);
    assert.equal(record?.costUsd, 0);
    assert.equal(record?.costSource, "gateway_estimate");
    assert.equal(record?.pricingSource, "gateway_estimate");
    assert.equal(record?.pricingCatalogVersion, "local-zero-v1");
    assert.equal(record?.inputRateUsdPerMillion, 0);
    const summary = storage.modelUsageEvents.list({ workspaceId: "workspace-1" }).summary;
    assert.equal(summary.attemptCount, 0);
    assert.equal(summary.uncertainDispatchCount, 1);
    assert.deepEqual(summary.metricAvailability.costUsd, {
      knownAttemptCount: 1,
      unknownAttemptCount: 0,
      complete: true,
    });
    assert.equal(summary.metricAvailability.inputTokens.complete, false);
  });
});
