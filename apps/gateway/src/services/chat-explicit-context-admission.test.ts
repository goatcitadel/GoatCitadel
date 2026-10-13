import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type ChatCompletionRequest,
  type ChatTurnFeatureReferences,
} from "@goatcitadel/contracts";
import {
  assertAdmittedExplicitContextCurrent,
  prepareAdmittedExplicitContextRequest,
  type ChatExplicitContextAdmissionHost,
} from "./chat-explicit-context-admission.js";
import { runWithChatExplicitContext, streamWithChatExplicitContext } from "./chat-explicit-context-authority.js";
import {
  buildChatRoutedContextSnapshot,
  revalidateChatRoutedContextSnapshotAccess,
  resolveChatRoutedContextSources,
  type ChatRoutedContextSourceDeps,
} from "./chat-routed-context-service.js";
import { fingerprintChatProviderFallbackRoute } from "./chat-provider-fallback-admission.js";
import {
  loadAndVerifyDurableChatRoutedContextSnapshot,
  parseDurableChatTurnPayload,
} from "./durable-execution-service.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import type { LlmDispatchGuard, LlmDispatchGuardInput } from "./llm-dispatch-guard.js";
import { inspectAdmittedChatRoutedContext } from "./chat-routed-context-inspection.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
async function fixture() {
  const primary = { providerId: "local", model: "local-model" };
  const fallback = { providerId: "hosted", model: "hosted-model", allowLocalToCloud: true };
  const llm = {
    getProviderRouteConfigFingerprint: vi.fn((provider: string, model: string) => `${provider}:${model}:config1`),
    getModelContextWindow: vi.fn(() => 32768),
  };
  const request = { content: "Use admitted context" };
  const admissionMaterialSha256 = hash({ version: 2, request });
  const memory = {
    itemId: "memory",
    workspaceId: "workspace",
    content: "Original admitted memory bytes.",
    metadata: {},
    status: "active",
    lifecycleState: "active",
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
  const sourceDeps = {
    getSessionKind: vi.fn(async () => "dm"),
    getActiveMemoryItem: vi.fn(async () => memory),
  } as unknown as ChatRoutedContextSourceDeps;
  const resolveSources = vi.fn((input: Parameters<typeof resolveChatRoutedContextSources>[1]) =>
    resolveChatRoutedContextSources(sourceDeps, input),
  );
  const resolved = await resolveSources({
    refs: [{ kind: "memory_item", ref: "memory" }],
    workspaceId: "workspace",
    sessionId: "session",
    memoryMode: "on",
    allowGlobalMemory: false,
  });
  const snapshot = buildChatRoutedContextSnapshot({
    resolved,
    turnId: "turn",
    sessionId: "session",
    workspaceId: "workspace",
    admission: {
      binding: {
        admissionId: "admission",
        sessionIncarnationId: "incarnation",
        materialSha256: admissionMaterialSha256,
        aggregateRevision: 1,
        controllerGeneration: 1,
      },
      ...primary,
      memoryMode: "on",
      tools: [],
    },
    routeContextWindowTokens: 32768,
    baseHistoryMessages: [{ role: "user", content: request.content }],
  });
  const references: ChatTurnFeatureReferences = {
    version: "chat.turn.feature-references.v1",
    providerRoute: {
      primary,
      fallback,
      fingerprint: fingerprintChatProviderFallbackRoute(llm as never, primary, fallback)!,
    },
    explicitContext: { snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash },
  };
  const featureAdmission = { references, referenceSha256: hash(references) };
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: "admission",
    sessionIncarnationId: "incarnation",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    admissionMaterialSha256,
    effectiveRequestMaterialSha256: hash({ version: 1, admissionMaterialSha256, request }),
    requestActor: {
      actorKind: "operator",
      actorId: "actor",
      operatorId: "operator",
      authActorId: "auth",
      authActorSource: "token",
    },
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run" },
    userMessageId: "user",
    assistantMessageId: "assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    featureReferenceSha256: featureAdmission.referenceSha256,
    routedContextSnapshotId: snapshot.snapshotId,
    routedContextSnapshotHash: snapshot.snapshotHash,
    request,
  };
  const run = { runId: "run", workflowKey: "chat.turn.execute", status: "running", payload };
  const storage = {
    durableRuns: { getRun: vi.fn(async () => run) },
    sessionMutationAdmissions: {
      findDurableRunBinding: vi.fn(async () => ({ durableRunId: "run" })),
      findFeatureReferences: vi.fn(async () => featureAdmission),
    },
    routedContextSnapshots: { get: vi.fn(async () => snapshot) },
    chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "workspace" })) },
    chatSessionPrefs: { get: vi.fn(async () => ({ memoryMode: "on" })) },
    chatTurnTraces: {
      get: vi.fn(async () => ({
        turnId: "turn",
        sessionId: "session",
        durable: { runId: "run" },
        routing: {
          routedContext: {
            snapshotId: snapshot.snapshotId,
            snapshotHash: snapshot.snapshotHash,
            contentHash: snapshot.contentHash,
            sourceRequestHash: snapshot.sourceRequestHash,
          },
        },
      })),
    },
  };
  const isFeatureEnabled = vi.fn(async () => true);
  const revalidate = vi.fn((value: typeof snapshot) =>
    revalidateChatRoutedContextSnapshotAccess(
      { storage, isFeatureEnabled, resolveChatRoutedContextSources: resolveSources } as never,
      value,
    ),
  );
  const host = {
    storage,
    llmService: llm,
    revalidateChatRoutedContextSnapshot: revalidate,
  } as unknown as ChatExplicitContextAdmissionHost;
  const fence = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const input = {
    ...primary,
    policyRunId: "run",
    sessionId: "session",
    turnId: "turn",
    workspaceId: "workspace",
    operatorId: "operator",
    authActorId: "auth",
    authActorSource: "token",
    canonicalWriteFence: fence,
    featureAdmission,
  } as unknown as ChatTurnAgentRunnerInput;
  const completion: ChatCompletionRequest = {
    ...primary,
    messages: [{ role: "user", content: request.content }],
    max_tokens: 1024,
    timeoutMs: 30000,
    memory: { sessionId: "session", turnId: "turn", runId: "run" },
  };
  const dispatch = {
    attribution: { sessionId: "session", turnId: "turn", durableRunId: "run" },
    route: { providerId: "local", modelId: "local-model", apiStyle: "chat_completions" },
    effectiveOutputTokenCap: 1024,
  } as LlmDispatchGuardInput;
  const port = {
    runWithDispatchGuard: vi.fn(async <T>(guard: LlmDispatchGuard, operation: () => Promise<T>) => {
      await guard(dispatch);
      return operation();
    }),
    streamWithDispatchGuard: vi.fn(async function* <T>(guard: LlmDispatchGuard, operation: () => AsyncGenerator<T>) {
      await guard(dispatch);
      yield* operation();
    }),
  };
  return {
    host,
    input,
    completion,
    storage,
    llm,
    payload,
    run,
    featureAdmission,
    dispatch,
    fence,
    snapshot,
    memory,
    sourceDeps,
    resolveSources,
    isFeatureEnabled,
    revalidate,
    port,
  };
}

describe("admitted explicit Chat context", () => {
  it("inspects completed admission-bound source provenance without a fabricated profile or source bytes", async () => {
    const f = await fixture();
    f.run.status = "completed";
    const result = await inspectAdmittedChatRoutedContext(
      { ...f.host, normalizeWorkspaceId: (id) => id ?? "default", storage: f.storage as never },
      "session",
      "turn",
      { workspaceId: "workspace", operatorId: "auth" },
    );
    expect(result).toMatchObject({
      state: "admission_bound",
      sessionId: "session",
      turnId: "turn",
      workspaceId: "workspace",
      routedContext: {
        snapshotHash: f.snapshot.snapshotHash,
        entries: [{ sourceHash: f.snapshot.entries[0]!.sourceHash }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("Original admitted memory bytes");
    expect(result).not.toHaveProperty("profile");
    expect(f.revalidate).toHaveBeenCalledOnce();
  });

  it.each(["actor", "workspace", "trace", "receipt", "binding", "source-access"])(
    "hides admitted source inspection when %s is inconsistent",
    async (drift) => {
      const f = await fixture();
      if (drift === "trace")
        f.storage.chatTurnTraces.get.mockResolvedValue({
          ...(await f.storage.chatTurnTraces.get()),
          sessionId: "other",
        });
      if (drift === "receipt") f.payload.featureReferenceSha256 = "0".repeat(64);
      if (drift === "binding")
        f.storage.sessionMutationAdmissions.findDurableRunBinding.mockResolvedValue({ durableRunId: "other" });
      if (drift === "source-access") vi.mocked(f.sourceDeps.getActiveMemoryItem).mockResolvedValue(undefined);
      await expect(
        inspectAdmittedChatRoutedContext(
          { ...f.host, storage: f.storage as never, normalizeWorkspaceId: (id) => id ?? "default" },
          "session",
          "turn",
          {
            workspaceId: drift === "workspace" ? "other" : "workspace",
            operatorId: drift === "actor" ? "other" : "auth",
          },
        ),
      ).rejects.toThrow();
      if (["actor", "workspace", "trace", "receipt", "binding"].includes(drift))
        expect(f.storage.routedContextSnapshots.get).not.toHaveBeenCalled();
    },
  );

  it("creates a profile-free snapshot and revalidates exact stored admission at preparation and transport", async () => {
    const f = await fixture();
    expect(f.snapshot.schemaVersion).toBe("chat.routed-context-snapshot.v3");
    expect(f.snapshot).not.toHaveProperty("capabilityProfileId");
    const request = await prepareAdmittedExplicitContextRequest(f.host, f.input, f.completion);
    const operation = vi.fn(async () => "result");
    await expect(runWithChatExplicitContext(f.port as never, { ...request }, operation)).resolves.toBe("result");
    expect(f.fence).toHaveBeenCalledTimes(3);
    expect(f.revalidate).toHaveBeenCalledTimes(3);
    expect(request.messages[0]?.content).toBe(f.snapshot.contextText);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("preserves admitted bytes after current text changes without substituting live content", async () => {
    const f = await fixture();
    const request = await prepareAdmittedExplicitContextRequest(f.host, f.input, f.completion);
    f.memory.content = "Changed current memory text.";
    await expect(runWithChatExplicitContext(f.port as never, request, async () => "ok")).resolves.toBe("ok");
    expect(JSON.stringify(request.messages)).toContain("Original admitted memory bytes.");
    expect(JSON.stringify(request.messages)).not.toContain(f.memory.content);
  });

  it.each(["disabled", "memory-off", "shared", "deleted", "workspace", "lease", "run", "receipt", "binding", "actor"])(
    "refuses %s authority drift before dispatch",
    async (drift) => {
      const f = await fixture();
      const request = await prepareAdmittedExplicitContextRequest(f.host, f.input, f.completion);
      if (drift === "disabled") f.isFeatureEnabled.mockResolvedValue(false);
      if (drift === "memory-off") f.storage.chatSessionPrefs.get.mockResolvedValue({ memoryMode: "off" });
      if (drift === "shared") vi.mocked(f.sourceDeps.getSessionKind).mockResolvedValue("group");
      if (drift === "deleted") vi.mocked(f.sourceDeps.getActiveMemoryItem).mockResolvedValue(undefined);
      if (drift === "workspace") f.storage.chatSessionMeta.get.mockResolvedValue({ workspaceId: "other" });
      if (drift === "lease") f.fence.mockRejectedValue(new Error("lease lost"));
      if (drift === "run") f.run.status = "completed";
      if (drift === "receipt") f.payload.featureReferenceSha256 = "0".repeat(64);
      if (drift === "binding")
        f.storage.sessionMutationAdmissions.findDurableRunBinding.mockResolvedValue({ durableRunId: "other" });
      if (drift === "actor") f.payload.requestActor.operatorId = "other";
      const operation = vi.fn(async () => "must not dispatch");
      await expect(runWithChatExplicitContext(f.port as never, request, operation)).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each(["bytes", "tools", "output", "route", "attribution", "transport-cap", "configuration"])(
    "refuses %s drift through hooks or actual transport",
    async (drift) => {
      const f = await fixture();
      let request = await prepareAdmittedExplicitContextRequest(f.host, f.input, f.completion);
      if (drift === "bytes") request = { ...request, messages: request.messages.slice(1) };
      if (drift === "tools")
        request = {
          ...request,
          tools: [
            {
              type: "function",
              function: { name: "giant", description: "large schema ".repeat(20000), parameters: {} },
            },
          ],
        };
      if (drift === "output") request = { ...request, max_tokens: 32768 };
      if (drift === "route") f.dispatch = { ...f.dispatch, route: { ...f.dispatch.route, providerId: "other" } };
      if (drift === "attribution") f.dispatch.attribution.turnId = "other";
      if (drift === "transport-cap") Object.assign(f.dispatch, { effectiveOutputTokenCap: 4096 });
      if (drift === "configuration") f.llm.getProviderRouteConfigFingerprint.mockReturnValue("changed");
      if (drift === "route")
        f.port.runWithDispatchGuard.mockImplementation(async (guard, operation) => {
          await guard(f.dispatch);
          return operation();
        });
      const operation = vi.fn(async () => "must not dispatch");
      await expect(runWithChatExplicitContext(f.port as never, request, operation)).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it("validates lazily consumed streams and fails closed without actual transport guard support", async () => {
    const f = await fixture();
    const request = await prepareAdmittedExplicitContextRequest(f.host, f.input, f.completion);
    const stream = streamWithChatExplicitContext(f.port as never, request, async function* () {
      yield "secret";
    });
    f.isFeatureEnabled.mockResolvedValue(false);
    await expect(stream.next()).rejects.toThrow(/disabled/);
    f.isFeatureEnabled.mockResolvedValue(true);
    await expect(runWithChatExplicitContext({} as never, request, async () => "secret")).rejects.toThrow(
      /guard is unavailable/,
    );
  });

  it("rehydrates only the exact v3 snapshot on durable replay and rechecks current access", async () => {
    const f = await fixture();
    const payload = parseDurableChatTurnPayload(f.run as never);
    expect(payload).toBeDefined();
    expect(await loadAndVerifyDurableChatRoutedContextSnapshot(f.host as never, f.run as never, payload!)).toBe(
      f.snapshot,
    );
    expect(f.revalidate).toHaveBeenCalledOnce();
    f.isFeatureEnabled.mockResolvedValue(false);
    await expect(
      loadAndVerifyDurableChatRoutedContextSnapshot(f.host as never, f.run as never, payload!),
    ).rejects.toThrow(/disabled/);
    f.isFeatureEnabled.mockResolvedValue(true);
    f.storage.chatTurnTraces.get.mockResolvedValue({
      turnId: "turn",
      sessionId: "session",
      durable: { runId: "other" },
      routing: {
        routedContext: {
          snapshotId: f.snapshot.snapshotId,
          snapshotHash: f.snapshot.snapshotHash,
          contentHash: f.snapshot.contentHash,
          sourceRequestHash: f.snapshot.sourceRequestHash,
        },
      },
    });
    await expect(
      loadAndVerifyDurableChatRoutedContextSnapshot(f.host as never, f.run as never, payload!),
    ).rejects.toThrow();
  });

  it("rechecks source access and exact persisted receipt before context tools may read snapshot bytes", async () => {
    const f = await fixture();
    await expect(assertAdmittedExplicitContextCurrent(f.host, f.input)).resolves.toBeUndefined();
    f.storage.chatSessionPrefs.get.mockResolvedValue({ memoryMode: "off" });
    await expect(assertAdmittedExplicitContextCurrent(f.host, f.input)).rejects.toThrow(/memory mode is off/);
    f.storage.chatSessionPrefs.get.mockResolvedValue({ memoryMode: "on" });
    f.payload.featureReferenceSha256 = "0".repeat(64);
    await expect(assertAdmittedExplicitContextCurrent(f.host, f.input)).rejects.toThrow(/scope changed/);
  });
});
