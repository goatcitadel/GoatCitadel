import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type { HeartbeatOccurrenceRecord } from "@goatcitadel/storage";
import {
  assertHeartbeatChatDispatchCurrent,
  assertHeartbeatOccurrenceCurrent,
  buildHeartbeatOccurrenceReference,
  type HeartbeatChatAuthorityHost,
} from "./heartbeat-chat-authority.js";
import { buildHeartbeatOccurrencePlan } from "./heartbeat-occurrence-service.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import { freezeChatTurnExecutionRequest } from "./session-control-service.js";
import { resolveChatFeatureAdmission, type ChatFeatureAdmissionHost } from "./chat-feature-admission-service.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function fixture() {
  const plan = buildHeartbeatOccurrencePlan({
    workspaceId: "workspace",
    sessionId: "session",
    expectedPriorCadence: {},
    idleFloorSeconds: 300,
  });
  const occurrence = {
    occurrenceId: "occurrence",
    workspaceId: "workspace",
    sessionId: "session",
    sessionIncarnationId: "incarnation",
    admissionId: "admission",
    admissionCorrelationId: "occurrence",
    systemActorId: "system-heartbeat",
    admissionMaterialSha256: plan.frozenRequestSha256,
    frozenRequestSha256: plan.frozenRequestSha256,
    evaluatedPolicySha256: plan.evaluatedPolicySha256,
    frozenObjectiveSha256: plan.frozenObjectiveSha256,
    claimSha256: "a".repeat(64),
    aggregateRevision: 1,
    controllerGeneration: 1,
    priorCadence: {},
    idleFloorSeconds: 300,
    turnId: "turn",
    durableRunId: "run",
    userMessageId: "user",
    assistantMessageId: "assistant",
    state: "admitted",
  } as HeartbeatOccurrenceRecord;
  const admission = {
    identity: {
      admissionId: "admission",
      workspaceId: "workspace",
      sessionId: "session",
      sessionIncarnationId: "incarnation",
      turnId: "turn",
      aggregateRevision: 1,
      controllerGeneration: 1,
      materialSha256: plan.frozenRequestSha256,
    },
    admittedRequest: plan.request,
    requestActor: { actorKind: "system", actorId: "system-heartbeat" },
    systemHeartbeatOccurrence: {
      kind: "system_heartbeat_occurrence",
      operation: "chat_system_heartbeat",
      occurrenceId: "occurrence",
      correlationId: "occurrence",
      claimSha256: occurrence.claimSha256,
      durableRunId: "run",
    },
  } as ActiveTurnAdmission;
  const isFeatureEnabled = vi.fn(async (flag: string) => flag === "proactiveHeartbeatTurnsV1Enabled");
  const references = {
    version: "chat.turn.feature-references.v1" as const,
    heartbeatOccurrence: buildHeartbeatOccurrenceReference(occurrence),
  };
  const features = { references, referenceSha256: hash(references) };
  const frozenRequest = freezeChatTurnExecutionRequest(plan.request);
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: "admission",
    workspaceId: "workspace",
    sessionId: "session",
    sessionIncarnationId: "incarnation",
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    admissionMaterialSha256: plan.frozenRequestSha256,
    effectiveRequestMaterialSha256: hash({
      version: 1,
      admissionMaterialSha256: plan.frozenRequestSha256,
      request: frozenRequest,
    }),
    requestActor: admission.requestActor,
    turnId: "turn",
    userMessageId: "user",
    assistantMessageId: "assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request: frozenRequest,
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run" },
    featureReferenceSha256: features.referenceSha256,
    heartbeatOccurrenceId: "occurrence",
    heartbeatClaimSha256: occurrence.claimSha256,
    heartbeatEvaluatedPolicySha256: occurrence.evaluatedPolicySha256,
    heartbeatFrozenObjectiveSha256: occurrence.frozenObjectiveSha256,
  };
  const persistedAdmission = {
    status: "active",
    actorKind: "system",
    actorId: "system-heartbeat",
    operation: "chat_system_heartbeat",
    correlationId: "occurrence",
  };
  const storage = {
    heartbeatOccurrences: { find: vi.fn(async () => occurrence) },
    durableRuns: { getRun: vi.fn(async () => ({ workflowKey: "chat.turn.execute", status: "running", payload })) },
    sessionMutationAdmissions: {
      findDurableRunBinding: vi.fn(async () => ({ durableRunId: "run" })),
      get: vi.fn(async () => persistedAdmission),
      findFeatureReferences: vi.fn(async () => features),
      bindFeatureReferences: vi.fn(async () => features),
    },
  };
  const host = { storage, isFeatureEnabled } as unknown as HeartbeatChatAuthorityHost;
  return {
    plan,
    occurrence,
    admission,
    reference: references.heartbeatOccurrence,
    features,
    payload,
    persistedAdmission,
    storage,
    host,
    isFeatureEnabled,
  };
}

describe("heartbeat occurrence feature authority", () => {
  it("accepts only the exact storage-claimed system posture and fixed policy", async () => {
    const f = fixture();
    await expect(assertHeartbeatOccurrenceCurrent(f.host, f)).resolves.toEqual(f.occurrence);
  });
  it.each([
    "disabled",
    "master-off",
    "terminal",
    "generation",
    "hash",
    "actor",
    "workspace",
    "request",
    "policy",
    "posture",
    "child",
  ])("rejects %s drift before preparation", async (change) => {
    const f = fixture();
    if (change === "disabled") f.isFeatureEnabled.mockResolvedValue(false);
    if (change === "master-off") f.isFeatureEnabled.mockResolvedValue(true);
    if (change === "terminal") f.occurrence.state = "terminal";
    if (change === "generation") f.occurrence.controllerGeneration++;
    if (change === "hash") f.reference.sha256 = "0".repeat(64);
    if (change === "actor") f.admission.requestActor.actorKind = "operator";
    if (change === "workspace") f.admission.identity.workspaceId = "foreign";
    if (change === "request") f.admission.admittedRequest.content = "Different work";
    if (change === "policy") f.occurrence.evaluatedPolicySha256 = "0".repeat(64);
    if (change === "posture") f.admission.systemHeartbeatOccurrence = undefined;
    if (change === "child") f.occurrence.durableRunId = "other";
    await expect(assertHeartbeatOccurrenceCurrent(f.host, f)).rejects.toThrow();
  });
  it("binds the complete feature record once and refuses changed client or resume evidence", async () => {
    const f = fixture();
    const findFeatureReferences = vi.fn(async () => undefined as typeof f.features | undefined);
    const host = {
      ...f.host,
      storage: {
        ...f.storage,
        sessionMutationAdmissions: { ...f.storage.sessionMutationAdmissions, findFeatureReferences },
      },
      assertTurnAdmissionWrite: vi.fn(async () => undefined),
      routeFingerprint: () => "b".repeat(64),
    } as unknown as ChatFeatureAdmissionHost;
    const input = {
      admission: f.admission,
      heartbeatOccurrence: f.reference,
      content: f.plan.request.content,
      route: { effectiveProviderId: "fixture", effectiveModel: "fixture" } as never,
    };
    await expect(resolveChatFeatureAdmission(host, input)).resolves.toEqual(f.features);
    expect(f.storage.sessionMutationAdmissions.bindFeatureReferences).toHaveBeenCalledTimes(1);
    findFeatureReferences.mockResolvedValue(f.features);
    await resolveChatFeatureAdmission(host, input);
    expect(f.storage.sessionMutationAdmissions.bindFeatureReferences).toHaveBeenCalledTimes(1);
    await expect(
      resolveChatFeatureAdmission(host, { ...input, heartbeatOccurrence: { ...f.reference, ownerId: "foreign" } }),
    ).rejects.toThrow();
    await expect(
      resolveChatFeatureAdmission(host, { ...input, expectedReferenceSha256: "b".repeat(64) }),
    ).rejects.toThrow();
    f.admission.requestActor.actorKind = "operator";
    await expect(resolveChatFeatureAdmission(host, input)).rejects.toThrow();
  });
  it("revalidates canonical occurrence and persisted durable authority under the dispatch fence", async () => {
    const f = fixture();
    f.occurrence.state = "durable_bound";
    f.occurrence.boundDurableRunId = "run";
    f.occurrence.featureReferenceSha256 = f.features.referenceSha256;
    const canonicalWriteFence = vi.fn(async <T>(operation: () => T | Promise<T>) => await operation());
    const input = {
      featureAdmission: f.features,
      sessionId: "session",
      workspaceId: "workspace",
      turnId: "turn",
      policyRunId: "run",
      canonicalWriteFence,
    };
    await assertHeartbeatChatDispatchCurrent(f.host, input);
    f.persistedAdmission.operation = "chat.turn.execute";
    await expect(assertHeartbeatChatDispatchCurrent(f.host, input)).rejects.toThrow("stale");
    f.persistedAdmission.operation = "chat_system_heartbeat";
    f.occurrence.state = "abandoned";
    await expect(assertHeartbeatChatDispatchCurrent(f.host, input)).rejects.toThrow("current");
    await expect(
      assertHeartbeatChatDispatchCurrent(f.host, { ...input, canonicalWriteFence: undefined }),
    ).rejects.toThrow("fence");
    expect(canonicalWriteFence).toHaveBeenCalledTimes(3);
  });
});
