import { describe, expect, it, vi } from "vitest";
import {
  remoteWorkerInferenceCanonicalSha256 as hash,
  sealRemoteWorkerChatContextForTurn,
  type ChatTurnFeatureReferences,
  type RemoteWorkerAdmissionReference,
} from "@goatcitadel/contracts";
import {
  resolveRemoteWorkerAdmissionAuthority,
  readRetainedRemoteWorkerChatEvidence,
  selectRemoteWorkerChatAdmission,
  type RemoteWorkerChatAdmissionSelectionHost,
  type RemoteWorkerChatAdmissionAuthorityHost,
} from "./remote-worker-chat-admission-authority.js";
import { buildWorkerInferenceSubmission } from "../../../remote-worker/src/worker-inference-execution.js";
import { resolveChatFeatureAdmission, type ChatFeatureAdmissionHost } from "./chat-feature-admission-service.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import { RemoteWorkerChatOfferService } from "./remote-worker-chat-offer-service.js";

function fixture(providerId = "local") {
  const request = { content: "Read the admitted note", subagentPolicy: "off" },
    materialSha256 = hash({ version: 2, request });
  const scope = {
    admissionId: "admission",
    sessionIncarnationId: "incarnation",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    aggregateRevision: 1,
    controllerGeneration: 2,
    materialSha256,
    actorId: "operator",
    actorSource: "token" as const,
  };
  const permission = { profileId: "safe", approvalMode: "approve_risky" as const };
  const tool = {
    canonicalName: "fs.read",
    modelName: "fs_read",
    providerDefinition: { type: "function", function: { name: "fs_read", parameters: { type: "object" } } },
    definitionHash: "",
    runtimeOwner: { kind: "builtin" as const, bindingHash: hash("builtin") },
    effectPotential: {
      version: "goatcitadel.tool-effect.v1" as const,
      potential: "none" as const,
      sourceKind: "builtin" as const,
      reason: "trusted_builtin_safe_read" as const,
    },
  };
  tool.definitionHash = hash(tool.providerDefinition);
  const references: ChatTurnFeatureReferences = {
    version: "chat.turn.feature-references.v1",
    providerRoute: { primary: { providerId, model: "model" }, fingerprint: hash("route") },
    remotePlacement: {
      version: "chat.remote-placement.admission.v1",
      scope,
      citadelId: "citadel",
      operatorId: "operator",
      contentSha256: hash(request.content),
      memoryMode: "off",
      runtimeInterposition: { hash: hash("hooks"), count: 0 },
      permission: { ...permission, profileHash: hash(permission) },
      selectedTools: [tool],
    },
  };
  const reference: RemoteWorkerAdmissionReference = {
    version: "goatcitadel.remote-worker-admission-reference.v1",
    scope,
    featureReferenceSha256: hash(references),
  };
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: scope.admissionId,
    sessionIncarnationId: scope.sessionIncarnationId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    admissionAggregateRevision: scope.aggregateRevision,
    admissionControllerGeneration: scope.controllerGeneration,
    admissionMaterialSha256: materialSha256,
    effectiveRequestMaterialSha256: hash({ version: 1, admissionMaterialSha256: materialSha256, request }),
    requestActor: {
      actorKind: "operator",
      actorId: "operator",
      operatorId: "operator",
      authActorId: "operator",
      authActorSource: "token",
    },
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run" },
    userMessageId: "user",
    assistantMessageId: "assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    featureReferenceSha256: reference.featureReferenceSha256,
    request,
  };
  const binding = { references, referenceSha256: reference.featureReferenceSha256 };
  const policy = {
    permissionProfileId: permission.profileId,
    permissionProfile: permission,
    authActorId: scope.actorId,
    authActorSource: scope.actorSource,
  };
  const state = { enabled: true, current: true, tools: [structuredClone(tool)] };
  const assertCurrent = vi.fn(async () => {
    if (!state.current) throw new Error("lease lost");
  });
  const storage = {
    durableRuns: {
      getRun: vi.fn(async () => ({ runId: "run", workflowKey: "chat.turn.execute", status: "running", payload })),
    },
    sessionMutationAdmissions: { findFeatureReferences: vi.fn(async () => binding) },
    chatTurnCapabilityProfiles: { get: vi.fn(), findByRun: vi.fn() },
  };
  const host: RemoteWorkerChatAdmissionAuthorityHost = {
    storage: storage as never,
    enabled: async () => state.enabled,
    resolvePolicy: vi.fn(async () => policy as never),
    assertFeaturesCurrent: vi.fn(async () => undefined),
    readCurrentSelectedTools: vi.fn(async () => state.tools),
  };
  return {
    host,
    state,
    reference,
    references,
    binding,
    payload,
    policy,
    assertCurrent,
    storage,
    input: { reference, durableRunId: "run", assertCurrent },
  };
}

describe("remote Chat admission-reference authority", () => {
  it("selects current remote evidence under both admission fences and rejects revocation before return", async () => {
    const f = fixture(),
      tool = f.state.tools[0];
    const host = {
      enabled: () => true,
      storage: { workspaces: { find: async () => ({ citadelId: "citadel" }) } },
      assertTurnAdmissionWrite: f.assertCurrent,
      getChatSessionPrefs: async () => ({ subagentPolicy: "off", memoryMode: "off" }),
      resolveToolPolicyContext: async () => ({ ...f.policy, operatorId: "operator" }),
      resolveCapabilityToolSchema: vi.fn(async () => ({
        tools: [tool.providerDefinition],
        modelToCanonical: new Map([[tool.modelName, tool.canonicalName]]),
      })),
      listCallable: async () => [
        { callable: true, toolName: tool.canonicalName, effectPotential: tool.effectPotential },
      ],
      resolveMeshToolSchemas: async () => [],
      getToolCallBeforeInterposition: vi.fn(async () => ({ hash: hash("hooks"), count: 0 })),
      resolveRuntimeOwnerBinding: () => tool.runtimeOwner,
    } as unknown as RemoteWorkerChatAdmissionSelectionHost;
    const input = {
      admission: {
        identity: f.reference.scope,
        admittedRequest: f.payload.request,
        requestActor: f.payload.requestActor,
      } as ActiveTurnAdmission,
      content: f.payload.request.content,
      route: { effectiveProviderId: "local", effectiveModel: "model" },
      references: f.references,
    } as Parameters<typeof selectRemoteWorkerChatAdmission>[1];
    expect(await selectRemoteWorkerChatAdmission(host, input)).toEqual(f.references.remotePlacement);
    expect(f.assertCurrent).toHaveBeenCalledTimes(2);
    expect(host.resolveCapabilityToolSchema).toHaveBeenCalledWith(
      expect.objectContaining({ subagentPolicy: "off", historyMessages: [] }),
    );
    vi.mocked(host.getToolCallBeforeInterposition).mockImplementationOnce(async () => {
      f.state.current = false;
      return { hash: hash("hooks"), count: 0 };
    });
    await expect(selectRemoteWorkerChatAdmission(host, input)).rejects.toThrow("lease lost");
  });
  it("does not select remote placement for scheduled work or while remote execution is disabled", async () => {
    const f = fixture(),
      assertCurrent = vi.fn();
    const host = {
      enabled: () => true,
      assertTurnAdmissionWrite: assertCurrent,
    } as unknown as RemoteWorkerChatAdmissionSelectionHost;
    const input = {
      admission: { admittedRequest: f.payload.request } as ActiveTurnAdmission,
      references: { ...f.references, scheduledOccurrence: {} },
    } as Parameters<typeof selectRemoteWorkerChatAdmission>[1];
    expect(await selectRemoteWorkerChatAdmission(host, input)).toBeUndefined();
    expect(
      await selectRemoteWorkerChatAdmission({ ...host, enabled: () => false }, { ...input, references: f.references }),
    ).toBeUndefined();
    expect(assertCurrent).not.toHaveBeenCalled();
  });
  it("selects once behind the remote flag and keeps durable replay on its immutable reference", async () => {
    const f = fixture(),
      selected = vi.fn(async () => f.references.remotePlacement),
      enabled = { value: false };
    let retained: { references: ChatTurnFeatureReferences; referenceSha256: string } | undefined;
    const bind = vi.fn(
      async (input: { references: ChatTurnFeatureReferences }) =>
        (retained = { references: input.references, referenceSha256: hash(input.references) }),
    );
    const host = {
      assertTurnAdmissionWrite: f.assertCurrent,
      storage: {
        sessionMutationAdmissions: { findFeatureReferences: async () => retained, bindFeatureReferences: bind },
      },
      isFeatureEnabled: async (flag: string) => flag === "chatRemotePlacementV1Enabled" && enabled.value,
      resolveRemotePlacement: selected,
      routeFingerprint: () => hash("route"),
    } as unknown as ChatFeatureAdmissionHost;
    const admission = {
      identity: f.reference.scope,
      admittedRequest: f.payload.request,
      requestActor: f.payload.requestActor,
      requestClaim: { runtimeOwnerId: "owner", leaseRevision: 1 },
    } as ActiveTurnAdmission;
    const input = {
      admission,
      content: f.payload.request.content,
      route: { effectiveProviderId: "local", effectiveModel: "model" },
    } as Parameters<typeof resolveChatFeatureAdmission>[1];
    expect(await resolveChatFeatureAdmission(host, input)).toBeUndefined();
    expect(selected).not.toHaveBeenCalled();
    enabled.value = true;
    const bound = await resolveChatFeatureAdmission(host, input);
    expect(bound?.references.remotePlacement).toEqual(f.references.remotePlacement);
    expect(bound?.references.providerRoute).toEqual(f.references.providerRoute);
    enabled.value = false;
    expect(
      await resolveChatFeatureAdmission(host, { ...input, expectedReferenceSha256: bound!.referenceSha256 }),
    ).toEqual(bound);
    expect(selected).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenCalledOnce();
    await expect(
      resolveChatFeatureAdmission(host, { ...input, expectedReferenceSha256: hash("other") }),
    ).rejects.toThrow("admitted hash");
    retained = undefined;
    enabled.value = true;
    expect(
      await resolveChatFeatureAdmission(host, {
        ...input,
        admission: { ...admission, durableClaim: { durableRunId: "run", leaseOwnerId: "owner", attemptCount: 1 } },
      }),
    ).toBeUndefined();
    expect(selected).toHaveBeenCalledOnce();
  });

  it("offers a canonical admission variant only while the captured durable claim remains current", async () => {
    const f = fixture();
    const run = {
      runId: "run",
      workflowKey: "chat.turn.execute",
      status: "running",
      payload: f.payload,
      leaseOwnerId: "worker",
      attemptCount: 1,
      version: 3,
      createdAt: new Date().toISOString(),
    };
    const fence = vi.fn(async () => {
      if (!f.state.current) throw new Error("claim lost");
    });
    const schedule = vi.fn(async () => ({ assignmentId: "assignment" }));
    const resolver = vi.fn(async (input: typeof f.input) => resolveRemoteWorkerAdmissionAuthority(f.host, input));
    const service = new RemoteWorkerChatOfferService({
      enabled: true,
      registryWorkspaceId: "registry",
      pathJailSha256: hash("jail"),
      storage: {
        durableRuns: { getRun: async () => run },
        sessionMutationAdmissions: { assertActiveTurnWrite: fence },
        remoteWorkerAssignments: { scheduleTaskBoundChatOffer: schedule },
      },
      resolveAdmissionAuthority: resolver,
    } as never);
    await service.schedule(run);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ reference: f.reference, durableRunId: "run" }));
    expect(fence).toHaveBeenCalledWith(
      expect.objectContaining({
        ...f.reference.scope,
        durableClaim: { durableRunId: "run", leaseOwnerId: "worker", attemptCount: 1 },
        requireExactDurablePayloadIdentity: true,
      }),
    );
    expect(schedule).toHaveBeenCalledOnce();
    f.state.current = false;
    await expect(service.schedule(run)).rejects.toThrow("claim lost");
    expect(schedule).toHaveBeenCalledOnce();
    await expect(service.schedule({ ...run, version: 2 })).rejects.toThrow("current durable Chat claim");
  });
  it.each(["local", "hosted"])("restores selected %s evidence without fabricating a profile", async (providerId) => {
    const f = fixture(providerId),
      result = await resolveRemoteWorkerAdmissionAuthority(f.host, f.input);
    expect(result.evidence.route).toEqual({ providerId, model: "model" });
    expect(result.evidence.tools).toHaveLength(1);
    expect(result.evidence).not.toHaveProperty("profile");
    expect(result.evidence.binding).not.toHaveProperty("capabilityProfileSha256");
    expect(f.storage.chatTurnCapabilityProfiles.get).not.toHaveBeenCalled();
    expect(f.assertCurrent).toHaveBeenCalledTimes(2);
  });
  it.each([
    "flag",
    "claim",
    "actor",
    "permission",
    "missing_permission",
    "schema",
    "owner",
    "hash",
    "material",
    "controller",
  ])("refuses %s drift before use", async (drift) => {
    const f = fixture();
    if (drift === "flag") f.state.enabled = false;
    if (drift === "claim") f.state.current = false;
    if (drift === "actor") f.policy.authActorId = "other";
    if (drift === "permission") f.policy.permissionProfileId = "different";
    if (drift === "missing_permission") delete (f.policy as Partial<typeof f.policy>).permissionProfile;
    if (drift === "schema") f.state.tools[0]!.providerDefinition.function.name = "changed";
    if (drift === "owner") f.state.tools[0]!.runtimeOwner.bindingHash = hash("new owner");
    if (drift === "hash") f.binding.referenceSha256 = hash("changed");
    if (drift === "material") f.payload.admissionMaterialSha256 = hash("changed");
    if (drift === "controller") f.payload.admissionControllerGeneration++;
    await expect(resolveRemoteWorkerAdmissionAuthority(f.host, f.input)).rejects.toThrow();
  });
  it("retained history has no live claim and worker decodes exact context/authority variant", async () => {
    const f = fixture(),
      evidence = await readRetainedRemoteWorkerChatEvidence(f.storage as never, {
        admissionReference: f.reference,
        durableRunId: "run",
      });
    expect(evidence.assertCurrent).toBeUndefined();
    expect(f.assertCurrent).not.toHaveBeenCalled();
    const context = sealRemoteWorkerChatContextForTurn("run", f.payload, [
      { role: "system", content: "Retained guidance" },
      { role: "user", content: f.payload.request.content },
    ]);
    const identity = {
      schemaVersion: "goatcitadel.remote-worker-assignment-workload.v1",
      registryWorkspaceId: "registry",
      assignmentId: "assignment",
      assignmentManifestSha256: hash("manifest"),
      durableRunId: "run",
      durableRunVersion: 1,
      durableRunPayloadSha256: hash(f.payload),
      admissionReference: f.reference,
      contextSnapshotSha256: context.contextSha256,
    };
    const workload = { ...identity, workloadSha256: hash(identity), payload: f.payload, chatContext: context };
    const lease = {
      registryWorkspaceId: "registry",
      assignmentId: "assignment",
      assignmentGeneration: 1,
      leaseRevision: 1,
      leaseToken: "a".repeat(64),
    };
    expect(buildWorkerInferenceSubmission(workload, lease).messages[0]?.text).toBe("Retained guidance");
    expect(() =>
      buildWorkerInferenceSubmission({ ...workload, capabilityProfileSha256: hash("fake profile") }, lease),
    ).toThrow();
    const tampered = structuredClone(workload);
    tampered.admissionReference.scope.controllerGeneration++;
    expect(() => buildWorkerInferenceSubmission(tampered, lease)).toThrow();
  });
});
