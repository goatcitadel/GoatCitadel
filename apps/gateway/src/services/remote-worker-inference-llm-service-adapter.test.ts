import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelUsageAccountingService } from "@goatcitadel/gateway-core";
import { Storage } from "@goatcitadel/storage";
import { REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { workerBudgetFixture } from "../../../../packages/storage/src/remote-worker-budget-fixture.js";
import { LlmService } from "./llm-service.js";
import { SecretStoreService } from "./secret-store-service.js";
import {
  RemoteWorkerInferenceLlmServiceAdapter,
  type RemoteWorkerLlmServiceAdapterDependencies,
} from "./remote-worker-inference-llm-service-adapter.js";
import type { RemoteWorkerInferenceDispatchRequest } from "./remote-worker-inference-llm-adapter.js";
import { createGovernedChatCompletion, type GovernedLlmCompletionHost } from "./llm-completion-service.js";
import type { ModelUsageAttributionContext } from "@goatcitadel/contracts";
import { readRemoteWorkerModelToolCalls } from "./remote-worker-model-tool-calls.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0)) close();
});

async function fixture(maxRequests = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-worker-llm-"));
  const storage = new Storage({
    dbPath: path.join(root, "state.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  cleanup.push(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const llm = new LlmService(
    {
      activeProviderId: "openai",
      activeModel: "gpt-5.4",
      providers: [
        {
          providerId: "openai",
          label: "Fixture",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4",
          apiKey: "fixture-not-a-real-key",
        },
      ],
    },
    {},
    {
      secretStore: Object.assign(new SecretStoreService(), { getSecret: () => undefined, isAvailable: () => false }),
      modelUsageAccounting: new ModelUsageAccountingService(
        storage.modelUsageEvents,
        "fixture-dispatch",
        60_000,
        60_000,
      ),
    },
  );
  const resolution = await llm.resolveDispatchRoute("openai", "gpt-5.4");
  const f = workerBudgetFixture(storage.db, "llm-adapter");
  f.budget.createGrant({ ...f.grant, maxRequests, maxCostMicrousd: 50_000_000 }, "fixture-operator");
  const route = {
    schemaVersion: REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
    providerId: resolution.providerId,
    modelId: resolution.modelId,
    apiStyle: resolution.apiStyle,
    configuredContextWindowTokens: resolution.configuredContextWindowTokens,
    ...resolution.credential,
    pricingCatalogVersion: resolution.pricing!.catalogVersion,
    pricingCatalogHash: resolution.pricing!.catalogHash,
    inputRateUsdPerMillion: resolution.pricing!.inputRateUsdPerMillion,
    outputRateUsdPerMillion: resolution.pricing!.outputRateUsdPerMillion,
    cachedInputRateUsdPerMillion: resolution.pricing!.cachedInputRateUsdPerMillion,
  };
  const op = f.admit("one", route);
  const reservation = f.budget.reserve(op)!;
  expect(reservation).toBeDefined();
  f.repo.recordBudgetReservation(op.key, reservation, f.now);
  f.repo.claimDispatch({
    ...op.key,
    dispatchClaimOwner: "fixture-claim",
    effectiveProviderId: route.providerId,
    effectiveModelId: route.modelId,
    effectiveRouteSha256: op.operation.effectiveRouteSha256,
    dispatchLeaseExpiresAt: f.expiresAt,
    now: f.now,
  });
  const authority = vi.fn(async () => {});
  const dependencies: RemoteWorkerLlmServiceAdapterDependencies = {
    llm,
    budgets: {
      getReservationForOperation: async (...args) => f.budget.getReservationForOperation(...args),
      authorizeAttempt: async (...args) => f.budget.authorizeAttempt(...args),
      authorizeRelatedAttempt: async (...args) => f.budget.authorizeRelatedAttempt(...args),
      reconcileRelatedAttempts: async (...args) => f.budget.reconcileRelatedAttempts(...args),
      listRelatedAttempts: async (...args) => f.budget.listRelatedAttempts(...args),
    },
    usage: {
      listOperationAttemptsForUpdate: async (...args) =>
        storage.modelUsageEvents.listOperationAttemptsForUpdate(...args),
    },
    assertAuthorityCurrent: authority,
  };
  const adapter = new RemoteWorkerInferenceLlmServiceAdapter(dependencies);
  const request: RemoteWorkerInferenceDispatchRequest = {
    attribution: {
      operationId: op.operation.operationId,
      dispatchGeneration: op.operation.dispatchGeneration,
      callKind: "delegation_worker",
      workspaceId: "default",
      sessionId: f.sessionId,
      turnId: f.turnId,
      durableRunId: f.durableRunId,
      taskId: f.taskId,
      workerId: f.workerId,
      contextIntentHash: op.operation.routedContextSha256,
    },
    resolution,
    messages: [{ role: "user", text: "Compute 2 + 2." }],
    requestedOutputTokenCap: 100,
    effectiveOutputTokenCap: 100,
    reasoningTokenCeiling: 0,
    temperatureMilli: 0,
  };
  const attempts = () =>
    storage.modelUsageEvents.listOperationAttemptsForUpdate(op.operation.operationId, op.operation.dispatchGeneration);
  return { f, op, adapter, authority, request, attempts, reservation, storage, llm, dependencies };
}

function response(usage = true): Response {
  return new Response(
    JSON.stringify({
      id: "fixture-response",
      model: "gpt-5.4",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "4" }] }],
      ...(usage
        ? {
            usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 11 },
          }
        : {}),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("remote worker existing provider integration", () => {
  it("retains complete provider tool calls under the same dispatch and spending owners", async () => {
    const h = await fixture();
    const argumentsJson = ' {"path":"note.txt"} ';
    const body = await response().json() as Record<string, unknown>;
    body.output = [{ type: "function_call", id: "fc-1", call_id: "call-1", name: "fs_read", arguments: argumentsJson }];
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json(body));
    vi.stubGlobal("fetch", fetch);
    const result = await h.adapter.dispatch({ ...h.request, tools: [{ type: "function", function: { name: "fs_read", parameters: { type: "object", properties: { path: { type: "string" } } } } }] });
    expect(result).toMatchObject({
      terminalState: "completed", chunks: [], transportAttempts: 1,
      toolCalls: [{ callId: "call-1", modelToolName: "fs_read", argumentsJson }],
    });
    expect(h.attempts()).toHaveLength(1);
    expect(result.usageEventIds).toEqual(h.attempts().map((event) => event.eventId));
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { tools: unknown[] };
    expect(sent.tools).toEqual([expect.objectContaining({ type: "function", name: "fs_read" })]);
  });

  it("rejects truncated, malformed and unadmitted tool calls before returning an executable request", () => {
    const tools = [{ type: "function", function: { name: "fs_read" } }];
    const call = { id: "call-1", type: "function", function: { name: "fs_read", arguments: "{}" } };
    const choice = { index: 0, finish_reason: "tool_calls", message: { content: "", tool_calls: [call] } };
    expect(() => readRemoteWorkerModelToolCalls(choice, [])).toThrow(/unadmitted/);
    expect(() => readRemoteWorkerModelToolCalls({ ...choice, finish_reason: "length" }, tools)).toThrow(/incomplete/);
    expect(() => readRemoteWorkerModelToolCalls({ ...choice, message: { tool_calls: [] } }, tools)).toThrow(/missing/);
    expect(() => readRemoteWorkerModelToolCalls({ ...choice, message: { tool_calls: [{ ...call, id: undefined }] } }, tools)).toThrow(/identity/);
    expect(() => readRemoteWorkerModelToolCalls({ ...choice, message: { tool_calls: [{ ...call, function: { ...call.function, arguments: "{" } }] } }, tools)).toThrow(/incomplete JSON/);
  });

  it("prevents multipart image requests from escaping a workflow dispatch guard", async () => {
    const h = await fixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      h.llm.runWithDispatchGuard(
        async () => {
          throw new Error("image authority denied");
        },
        () =>
          h.llm.generateImage(
            {
              providerId: "openai",
              model: "gpt-image-2",
              prompt: "edit goat",
              referenceImages: [{ bytesBase64: "aW1hZ2U=", mimeType: "image/png", fileName: "goat.png" }],
            },
            {
              ...h.request.attribution,
              operationId: "image:separate",
              parentOperationId: h.request.attribution.operationId,
            },
          ),
      ),
    ).rejects.toThrow("image authority denied");
    expect(fetch).not.toHaveBeenCalled();
    expect(h.storage.modelUsageEvents.list({ sessionId: h.f.sessionId }).items).toEqual([
      expect.objectContaining({ operationId: "image:separate", dispatchReconciliation: "confirmed_not_dispatched" }),
    ]);
  });

  it.each([2, 3])(
    "governs canonical memory preparation and the answer under a %i-request shared grant",
    async (maxRequests) => {
      const h = await fixture(maxRequests);
      const fetch = vi.fn(async () => response());
      vi.stubGlobal("fetch", fetch);
      const composeContext = vi.fn(async (_input: unknown, lineage: ModelUsageAttributionContext) => {
        await h.llm.chatCompletions(
          {
            providerId: "openai",
            model: "gpt-5.4",
            max_tokens: 100,
            reasoning: { effort: "none" },
            messages: [{ role: "user", content: "Distill frozen task context." }],
          },
          {
            ...lineage,
            operationId: "memory:independent-operation",
            dispatchGeneration: "memory:independent-generation",
            callKind: "utility",
            utilityKind: "memory_context_distillation",
          },
        );
        return {
          contextId: "memory-proof",
          contextText: "The task answer is four.",
          originalTokenEstimate: 100,
          distilledTokenEstimate: 20,
          citations: [],
          quality: { status: "fresh" },
          sections: [],
        };
      });
      const host = {
        llmService: h.llm,
        config: { assistant: { memory: { enabled: true, qmd: { enabled: true, applyToChat: true } } } },
        memoryLifecycleService: { composeContext },
        hooksService: {
          runInlineHooks: vi.fn(async () => ({ runs: [] })),
          enqueueAfterHooks: vi.fn(),
          hasMutateHook: () => false,
        },
        resolveMemoryWorkspaceRelativeDir: async () => "workspace",
        resolveChatCompletionHookWorkspaceId: async () => "default",
        persistContextManifestForCompletionRequest: vi.fn(),
        resolveFallbackTargets: () => [],
        recordDevDiagnostic: vi.fn(),
        publishRealtime: vi.fn(),
      } as unknown as GovernedLlmCompletionHost;
      const adapter = new RemoteWorkerInferenceLlmServiceAdapter({
        ...h.dependencies,
        complete: (request, attribution, guard) => createGovernedChatCompletion(host, request, attribution, guard),
      });
      const completion = adapter.dispatch({
        ...h.request,
        memory: {
          enabled: true,
          mode: "qmd",
          sessionId: h.f.sessionId,
          turnId: h.f.turnId,
          runId: h.f.durableRunId,
          taskId: h.f.taskId,
        },
      });
      if (maxRequests === 2) {
        await expect(completion).rejects.toThrow("stopped before provider dispatch");
        expect(fetch).not.toHaveBeenCalled();
        expect(h.storage.modelUsageEvents.list({ sessionId: h.f.sessionId }).items).toEqual([
          expect.objectContaining({
            operationId: "memory:independent-operation",
            dispatchReconciliation: "confirmed_not_dispatched",
          }),
        ]);
        return;
      }
      const result = await completion;
      expect(result).toMatchObject({ terminalState: "completed", chunks: ["4"] });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(fetch.mock.calls[1])).toContain("The task answer is four.");
      expect(h.f.budget.listRelatedAttempts(h.reservation)).toEqual([
        expect.objectContaining({
          operationId: "memory:independent-operation",
          parentOperationId: h.request.attribution.operationId,
          dispatchGeneration: "memory:independent-generation",
          workerId: h.f.workerId,
        }),
      ]);
      h.f.repo.finalizeTerminal({
        ...h.op.key,
        dispatchClaimOwner: "fixture-claim",
        terminalState: "completed",
        usageEventIds: [...result.usageEventIds],
        now: h.f.now,
      });
      h.f.budget.settle({ reservation: h.reservation, usageEventIds: result.usageEventIds });
      expect(h.f.budget.listGrants("default", "default")[0]).toMatchObject({ settledRequests: 2, heldRequests: 0 });
    },
  );

  it("keeps embedded model dispatches inside the current authority and retains a denied intent", async () => {
    const h = await fixture();
    const guard = vi.fn(async () => {
      throw new Error("embedding authority denied");
    });
    await expect(
      h.llm.runWithDispatchGuard(guard, () =>
        h.llm.prepareScopedModelUsageDispatch({
          source: "embedding_runtime",
          attribution: {
            ...h.request.attribution,
            operationId: "embedding:separate",
            parentOperationId: h.request.attribution.operationId,
            callKind: "utility",
          },
          effectiveProviderId: "remote",
          effectiveModelId: "embedding-model",
          effectiveApiStyle: "openai_embeddings",
          transportAttemptIndex: 0,
          credential: { credentialType: "api_key", credentialSource: "env", usagePool: "standard" },
        }),
      ),
    ).rejects.toThrow("embedding authority denied");
    expect(guard).toHaveBeenCalledOnce();
    expect(h.storage.modelUsageEvents.list({ sessionId: h.f.sessionId }).items).toEqual([
      expect.objectContaining({ source: "embedding_runtime", dispatchReconciliation: "confirmed_not_dispatched" }),
    ]);
  });

  it("dispatches through LlmService, checks live authority, and settles the sole canonical usage record", async () => {
    const h = await fixture();
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const result = await h.adapter.dispatch(h.request);
    expect(result).toMatchObject({ terminalState: "completed", chunks: ["4"], transportAttempts: 1 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(h.authority).toHaveBeenCalledOnce();
    expect(h.attempts()).toHaveLength(1);
    expect(result.usageEventIds).toEqual(h.attempts().map((a) => a.eventId));
    expect(h.attempts()[0]).toMatchObject({ costUsd: expect.any(Number) });
    h.f.repo.finalizeTerminal({
      ...h.op.key,
      dispatchClaimOwner: "fixture-claim",
      terminalState: "completed",
      usageEventIds: [...result.usageEventIds],
      now: h.f.now,
    });
    h.f.budget.settle({ reservation: h.reservation, usageEventIds: result.usageEventIds });
    expect(h.f.budget.listGrants("default", "default")[0]).toMatchObject({ settledRequests: 1, heldRequests: 0 });
  });

  it.each(["revoked", "authority", "route"] as const)("blocks %s changes before the HTTP boundary", async (reason) => {
    const h = await fixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    if (reason === "revoked") h.f.budget.revokeGrant(h.f.grant.grantId, 1);
    if (reason === "authority") h.authority.mockRejectedValue(new Error("lease lost"));
    const request =
      reason === "route"
        ? { ...h.request, resolution: { ...h.request.resolution, configuredContextWindowTokens: 999 } }
        : h.request;
    const result = await h.adapter.dispatch(request);
    expect(result).toMatchObject({ terminalState: "failed", transportAttempts: 0, chunks: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(h.attempts()).toHaveLength(1);
    expect(h.attempts()[0]).toMatchObject({ dispatchReconciliation: "confirmed_not_dispatched" });
    h.f.repo.finalizeTerminal({
      ...h.op.key,
      dispatchClaimOwner: "fixture-claim",
      terminalState: "failed",
      usageEventIds: [...result.usageEventIds],
      now: h.f.now,
    });
    h.f.budget.settle({ reservation: h.reservation, usageEventIds: result.usageEventIds });
    expect(h.f.budget.listGrants("default", "default")[0]).toMatchObject({
      heldRequests: 0,
      settledRequests: 0,
      settledCostMicrousd: 0,
    });
  });

  it("retains an uncertain charge after a transport error without a provider retry", async () => {
    const h = await fixture();
    const fetch = vi.fn(async () => {
      throw new Error("connection dropped");
    });
    vi.stubGlobal("fetch", fetch);
    const result = await h.adapter.dispatch(h.request);
    expect(result.terminalState).not.toBe("completed");
    expect(fetch).toHaveBeenCalledOnce();
    expect(h.attempts()).toHaveLength(1);
    expect(h.f.budget.listGrants("default", "default")[0]!.heldRequests).toBe(2);
  });

  it("does not refund a completed response with unknown usage", async () => {
    const h = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(false)),
    );
    const result = await h.adapter.dispatch(h.request);
    h.f.repo.finalizeTerminal({
      ...h.op.key,
      dispatchClaimOwner: "fixture-claim",
      terminalState: "completed",
      usageEventIds: [...result.usageEventIds],
      now: h.f.now,
    });
    expect(() => h.f.budget.settle({ reservation: h.reservation, usageEventIds: result.usageEventIds })).toThrow(
      /uncertain/,
    );
    expect(h.f.budget.listGrants("default", "default")[0]!.heldRequests).toBe(2);
  });
});
