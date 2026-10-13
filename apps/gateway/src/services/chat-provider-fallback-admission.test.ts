import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type ChatCompletionRequest,
  type ChatTurnFeatureReferences,
} from "@goatcitadel/contracts";
import {
  authorizeAdmittedChatProviderFallback,
  fingerprintChatProviderFallbackRoute,
  type ChatProviderFallbackAdmissionHost,
} from "./chat-provider-fallback-admission.js";
import {
  attachChatProviderFallbackAuthorization,
  prepareChatProviderFallbackDispatch,
} from "./chat-provider-fallback-authority.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import type { LlmDispatchGuardInput } from "./llm-dispatch-guard.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function fixture() {
  const primary = { providerId: "local", model: "local-model" };
  const fallback = { providerId: "hosted", model: "hosted-model", allowLocalToCloud: true };
  const providers = [
    { ...primary, baseUrl: "http://localhost:8080/v1", hasApiKey: false },
    { ...fallback, baseUrl: "https://api.example.test/v1", hasApiKey: true },
  ];
  const llm = {
    getProviderRouteConfigFingerprint: vi.fn((provider: string, model: string) => `${provider}:${model}:config1`),
    getRuntimeConfig: vi.fn(() => ({ providers })),
    getModelContextWindow: vi.fn(() => 8192),
    getCachedModelAvailability: vi.fn(() => "available"),
    resolveExecutionApiStyle: vi.fn(() => "chat_completions"),
  };
  const references: ChatTurnFeatureReferences = {
    version: "chat.turn.feature-references.v1",
    providerRoute: {
      primary,
      fallback,
      fingerprint: fingerprintChatProviderFallbackRoute(llm as never, primary, fallback)!,
    },
  };
  const featureAdmission = { references, referenceSha256: hash(references) };
  const request = { content: "Hello" };
  const admissionMaterialSha256 = hash({ version: 2, request });
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
    request,
  };
  const run = { workflowKey: "chat.turn.execute", status: "running", payload };
  const admission = { operation: "chat_turn", status: "committed", actorKind: "operator", actorId: "actor" };
  const storage = {
    durableRuns: { getRun: vi.fn(async () => run) },
    sessionMutationAdmissions: {
      findDurableRunBinding: vi.fn(async () => ({ durableRunId: "run" })),
      get: vi.fn(async () => admission),
      findFeatureReferences: vi.fn(async () => featureAdmission),
    },
    chatSessionPrefs: { get: vi.fn(async () => ({ providerFallback: fallback })) },
    chatToolRuns: { listByTurn: vi.fn(async () => [] as unknown[]) },
  };
  const isFeatureEnabled = vi.fn(async () => true);
  const host = { storage, llmService: llm, isFeatureEnabled } as unknown as ChatProviderFallbackAdmissionHost;
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
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 1024,
    timeoutMs: 30000,
    memory: { sessionId: "session", turnId: "turn", runId: "run" },
  };
  const dispatch = {
    attribution: { sessionId: "session", turnId: "turn", durableRunId: "run" },
    route: { providerId: "hosted", modelId: "hosted-model", apiStyle: "chat_completions" },
    effectiveOutputTokenCap: 1024,
  } as LlmDispatchGuardInput;
  return {
    host,
    input,
    completion,
    storage,
    llm,
    payload,
    run,
    admission,
    featureAdmission,
    providers,
    dispatch,
    fence,
    isFeatureEnabled,
  };
}

async function prepare(f: ReturnType<typeof fixture>) {
  const handle = await authorizeAdmittedChatProviderFallback(f.host, f.input, f.completion);
  expect(handle).toBeDefined();
  const bound = attachChatProviderFallbackAuthorization(f.completion, handle!);
  return prepareChatProviderFallbackDispatch(
    bound,
    { ...bound, providerId: "hosted", model: "hosted-model" },
    f.providers,
  );
}

describe("admitted Chat provider fallback", () => {
  it("requires persisted matching evidence at issuance, revalidation and transport dispatch", async () => {
    const f = fixture();
    const guard = await prepare(f);
    expect(f.storage.sessionMutationAdmissions.findFeatureReferences).toHaveBeenCalledTimes(2);
    await guard!(f.dispatch);
    expect(f.storage.sessionMutationAdmissions.findFeatureReferences).toHaveBeenCalledTimes(3);
    expect(f.fence).toHaveBeenCalledTimes(3);
  });

  it("keeps disabled, historical and unbound paths off", async () => {
    const f = fixture();
    f.isFeatureEnabled.mockResolvedValue(false);
    expect(await authorizeAdmittedChatProviderFallback(f.host, f.input, f.completion)).toBeUndefined();
    f.isFeatureEnabled.mockResolvedValue(true);
    expect(
      await authorizeAdmittedChatProviderFallback(f.host, { ...f.input, featureAdmission: undefined }, f.completion),
    ).toBeUndefined();
    expect(
      await authorizeAdmittedChatProviderFallback(f.host, { ...f.input, capabilityProfile: {} as never }, f.completion),
    ).toBeUndefined();
    expect(f.storage.durableRuns.getRun).not.toHaveBeenCalled();
  });

  it.each(["hash", "run", "binding", "actor", "cancelled", "receipt"])("rejects %s authority drift", async (drift) => {
    const f = fixture();
    if (drift === "hash") f.payload.featureReferenceSha256 = "0".repeat(64);
    if (drift === "run") f.run.status = "completed";
    if (drift === "binding")
      f.storage.sessionMutationAdmissions.findDurableRunBinding.mockResolvedValue({ durableRunId: "other" });
    if (drift === "actor") f.payload.requestActor.operatorId = "other";
    if (drift === "cancelled") f.admission.status = "cancelled";
    if (drift === "receipt")
      f.storage.sessionMutationAdmissions.findFeatureReferences.mockResolvedValue({
        ...f.featureAdmission,
        referenceSha256: "0".repeat(64),
      });
    await expect(authorizeAdmittedChatProviderFallback(f.host, f.input, f.completion)).rejects.toThrow();
  });

  it.each(["consent", "configuration", "tool", "context", "unavailable"])(
    "rejects %s drift before transport",
    async (drift) => {
      const f = fixture();
      const guard = await prepare(f);
      if (drift === "consent")
        f.storage.chatSessionPrefs.get.mockResolvedValue({
          providerFallback: {
            providerId: "hosted",
            model: "hosted-model",
            allowLocalToCloud: false,
          },
        });
      if (drift === "configuration") f.llm.getProviderRouteConfigFingerprint.mockReturnValue("changed");
      if (drift === "tool") f.storage.chatToolRuns.listByTurn.mockResolvedValue([{}]);
      if (drift === "context") f.llm.getModelContextWindow.mockReturnValue(100);
      if (drift === "unavailable") f.llm.getCachedModelAvailability.mockReturnValue("unavailable");
      await expect(guard!(f.dispatch)).rejects.toThrow();
    },
  );

  it("rejects invalid output budgets before issuing authority", async () => {
    const f = fixture();
    f.completion.max_tokens = Number.NaN;
    await expect(authorizeAdmittedChatProviderFallback(f.host, f.input, f.completion)).rejects.toThrow();
  });

  it("allows the healthy primary to proceed when its backup cannot fit the request", async () => {
    const f = fixture();
    f.llm.getModelContextWindow.mockReturnValue(100);
    const handle = await authorizeAdmittedChatProviderFallback(f.host, f.input, f.completion);
    expect(handle).toBeDefined();
    const bound = attachChatProviderFallbackAuthorization(f.completion, handle!);
    await expect(
      prepareChatProviderFallbackDispatch(
        bound,
        { ...bound, providerId: "hosted", model: "hosted-model" },
        f.providers,
      ),
    ).rejects.toThrow(/context budget/);
  });

  it("preserves the original deadline and caps the actual transport output budget", async () => {
    const f = fixture();
    f.completion.timeoutMs = Number.NaN;
    await expect(authorizeAdmittedChatProviderFallback(f.host, f.input, f.completion)).rejects.toThrow(
      /bounded completion deadline/,
    );
    const g = fixture();
    const guard = await prepare(g);
    await expect(guard!({ ...g.dispatch, effectiveOutputTokenCap: 4096 })).rejects.toThrow(/output budget/);
    const h = fixture();
    const expired = await prepare(h);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30001);
    try {
      await expect(expired!(h.dispatch)).rejects.toThrow(/original completion deadline/);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects loss of the canonical write lease and wrong transport attribution", async () => {
    const f = fixture();
    const guard = await prepare(f);
    f.fence.mockRejectedValueOnce(new Error("lease lost"));
    await expect(guard!(f.dispatch)).rejects.toThrow(/lease lost/);
    const g = fixture();
    const other = await prepare(g);
    await expect(
      other!({ ...g.dispatch, attribution: { ...g.dispatch.attribution, turnId: "other" } }),
    ).rejects.toThrow(/network dispatch/);
  });

  it("refuses fingerprint issuance when exact provider configuration is unknown", () => {
    const f = fixture();
    f.llm.getProviderRouteConfigFingerprint.mockReturnValue(undefined as never);
    expect(fingerprintChatProviderFallbackRoute(f.llm as never, { providerId: "local", model: "m" })).toBeUndefined();
  });
});
