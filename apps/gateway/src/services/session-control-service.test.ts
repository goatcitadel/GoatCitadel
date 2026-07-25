import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  NotFoundError,
  SESSION_CONTROL_MAX_LIST_ITEMS,
  type ChatSendMessageRequest,
} from "@goatcitadel/contracts";
import type {
  HeartbeatOccurrenceAdmissionRequest,
  HeartbeatOccurrenceRecord,
  SessionMutationAdmissionRecord,
  Storage,
} from "@goatcitadel/storage";
import {
  DecisionCommittedHeartbeatAdmissionError,
  SessionControlService,
  computeChatTurnAdmissionMaterialSha256,
  createAuthenticatedOperatorAdmissionContext,
  freezeChatTurnRequestActor,
  type AuthenticatedOperatorAdmissionContext,
} from "./session-control-service.js";
import { buildHeartbeatOccurrencePlan } from "./heartbeat-occurrence-service.js";

const BASE_REQUEST = {
  content: "Ship the exact turn",
  parts: [{ type: "text", text: "Ship the exact turn" }],
  attachments: ["attachment-1"],
  contextRefs: [{ kind: "attachment", attachmentId: "attachment-1" }],
  providerId: "openai",
  model: "gpt-5",
  autoRoute: true,
  webMode: "off",
  memoryMode: "session",
  thinkingLevel: "medium",
  speedMode: "balanced",
  subagentPolicy: "off",
  normalizationProfile: "default",
  commandText: "/ship",
  permissionProfileId: "permission-1",
  policyRunId: "policy-run-1",
  policyTaskId: "policy-task-1",
  fullWebAccess: false,
  parentDelegationStepId: "step-1",
} as unknown as ChatSendMessageRequest;

describe("SessionControlService", () => {
  // HX-408 M1-review mandate: `freezeChatTurnRequestActor` treats any
  // non-`none` authActorSource as authenticated operator authority. An
  // admitted mesh node is machine identity, never operator authority — pin
  // that a `mesh_node` source can never reach Chat turn admission with trust.
  it("rejects a mesh_node actor source at the trusted Chat request-actor freeze", () => {
    expect(() =>
      freezeChatTurnRequestActor({
        content: "publish something",
        operatorId: "node-1",
        authActorId: "node-1",
        authActorSource: "mesh_node",
      }),
    ).toThrow(/mesh node identity/iu);
    // The operator admission context factory keeps rejecting it as well.
    expect(() =>
      createAuthenticatedOperatorAdmissionContext({
        actorId: "node-1",
        authActorSource: "mesh_node",
      }),
    ).toThrow(/operator control-plane authority/u);
    // Operator sources keep working exactly as before.
    expect(
      freezeChatTurnRequestActor({
        content: "hello",
        operatorId: "operator-1",
        authActorId: "operator-1",
        authActorSource: "token",
      }),
    ).toMatchObject({ actorKind: "operator", actorId: "operator-1" });
  });

  it("keeps the authenticated-operator context factory scoped to a single route-layer mint site", () => {
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    const productionSources = listProductionTypeScriptSources(sourceRoot);
    const factoryIdentifier = "createAuthenticatedOperatorAdmissionContext";
    const callToken = "createAuthenticatedOperatorAdmissionContext(";
    // The security-sensitive operator context is minted only in the route-layer
    // helper reachable from the authenticated Chat routes (chat.messages.ts sits
    // at its module-size ceiling); the service file only *defines* the factory.
    const mintSite = "routes/session-control-request-context.ts";
    const definitionSite = "services/session-control-service.ts";

    const inventory = productionSources
      .filter((filePath) => readFileSync(filePath, "utf8").includes(factoryIdentifier))
      .map((filePath) => relative(sourceRoot, filePath).replaceAll("\\", "/"))
      .sort();
    expect(inventory).toEqual([mintSite, definitionSite]);

    // Exactly one construction call, and it lives at the single route-layer mint site.
    const mintSource = readFileSync(resolve(sourceRoot, mintSite), "utf8");
    expect(mintSource.match(/createAuthenticatedOperatorAdmissionContext\s*\(/gu)).toHaveLength(1);

    // No production file other than the mint site (its one call) and the service
    // (its definition) references the factory constructor.
    expect(
      productionSources
        .filter((filePath) => {
          const relativePath = relative(sourceRoot, filePath).replaceAll("\\", "/");
          return relativePath !== mintSite && relativePath !== definitionSite;
        })
        .some((filePath) => readFileSync(filePath, "utf8").includes(callToken)),
    ).toBe(false);
  });

  it("admits against the observed immutable meta/control evidence and returns the frozen identity", () => {
    const materialSha256 = computeChatTurnAdmissionMaterialSha256(BASE_REQUEST);
    const admission = record({ materialSha256 });
    const storage = {
      chatSessionMeta: { get: vi.fn(() => ({ sessionId: "session-1", workspaceId: "workspace-1", revision: 7 })) },
      sessionControls: {
        getControl: vi.fn(() => ({ generation: 3 })),
        resolveMutationAuthority: vi.fn(() => ({ generation: 3 })),
      },
      sessionMutationAdmissions: {
        admit: vi.fn(() => ({ disposition: "created", admission })),
      },
    };
    const service = new SessionControlService(storage as unknown as Storage);

    const active = service.admitOperatorChatTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      request: BASE_REQUEST,
      runtimeOwnerId: "runtime-1",
      actorId: "operator-1",
      idempotencyKey: "admit-turn-1",
      correlationId: "correlation-1",
    });

    expect(storage.sessionMutationAdmissions.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        runtimeOwnerId: "runtime-1",
        aggregateRevision: 7,
        controllerGeneration: 3,
        materialSha256,
      }),
    );
    // The frozen admitted request excludes routed-context refs: raw refs never
    // enter durable-executable identity (they freeze into the routed-context
    // snapshot chain instead).
    const { contextRefs: _contextRefs, ...frozenBaseRequest } = BASE_REQUEST;
    expect(active).toEqual({
      identity: {
        admissionId: "admission-1",
        sessionIncarnationId: "incarnation-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        aggregateRevision: 7,
        controllerGeneration: 3,
        materialSha256,
      },
      admittedRequest: frozenBaseRequest,
      requestActor: { actorKind: "operator", actorId: "operator-1" },
      requestClaim: { runtimeOwnerId: "runtime-1", leaseRevision: 1 },
    });
  });

  it("uses the atomic heartbeat-preemption admission only for an exact server-authenticated operator context", () => {
    const request = {
      ...BASE_REQUEST,
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "loopback" as const,
    };
    const materialSha256 = computeChatTurnAdmissionMaterialSha256(request);
    const admission = record({ materialSha256 });
    const storage = {
      chatSessionMeta: { get: vi.fn(() => ({ sessionId: "session-1", workspaceId: "workspace-1", revision: 7 })) },
      sessionControls: {
        getControl: vi.fn(() => ({ generation: 3 })),
        resolveMutationAuthority: vi.fn(() => ({ generation: 3 })),
      },
      sessionMutationAdmissions: {
        admit: vi.fn(),
        preemptHeartbeatAndAdmitOperatorTurn: vi.fn(() => ({
          disposition: "created",
          preemptionDisposition: "not_required",
          controllerGeneration: 3,
          admission,
        })),
      },
    };
    const service = new SessionControlService(storage as unknown as Storage);

    const active = service.admitOperatorChatTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      request,
      runtimeOwnerId: "runtime-1",
      actorId: "operator-1",
      idempotencyKey: "admit-turn-1",
      correlationId: "correlation-1",
      authenticatedOperator: createAuthenticatedOperatorAdmissionContext({
        actorId: "operator-1",
        authActorSource: "loopback",
      }),
    });

    expect(storage.sessionMutationAdmissions.preemptHeartbeatAndAdmitOperatorTurn).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runtimeOwnerId: "runtime-1",
      aggregateRevision: 7,
      expectedControllerGeneration: 3,
      operatorActorId: "operator-1",
      operation: "chat_turn",
      materialSha256,
      idempotencyKey: "admit-turn-1",
      correlationId: "correlation-1",
    });
    expect(storage.sessionMutationAdmissions.admit).not.toHaveBeenCalled();
    expect(active.requestActor).toEqual({
      actorKind: "operator",
      actorId: "operator-1",
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "loopback",
    });
  });

  it("rejects a forged authenticated-operator option before either admission path can mutate storage", () => {
    const storage = {
      chatSessionMeta: { get: vi.fn() },
      sessionControls: { getControl: vi.fn(), resolveMutationAuthority: vi.fn() },
      sessionMutationAdmissions: {
        admit: vi.fn(),
        preemptHeartbeatAndAdmitOperatorTurn: vi.fn(),
      },
    };
    const service = new SessionControlService(storage as unknown as Storage);

    expect(() =>
      service.admitOperatorChatTurn({
        sessionId: "session-1",
        turnId: "turn-1",
        request: {
          ...BASE_REQUEST,
          operatorId: "operator-1",
          authActorId: "operator-1",
          authActorSource: "loopback",
        },
        runtimeOwnerId: "runtime-1",
        actorId: "operator-1",
        idempotencyKey: "admit-turn-1",
        correlationId: "correlation-1",
        authenticatedOperator: {
          kind: "authenticated_operator_http",
          actorId: "operator-1",
          authActorSource: "loopback",
        } as unknown as AuthenticatedOperatorAdmissionContext,
      }),
    ).toThrow(/does not match the server-stamped Chat request/u);
    expect(storage.chatSessionMeta.get).not.toHaveBeenCalled();
    expect(storage.sessionMutationAdmissions.preemptHeartbeatAndAdmitOperatorTurn).not.toHaveBeenCalled();
    expect(storage.sessionMutationAdmissions.admit).not.toHaveBeenCalled();
  });

  it("surfaces an exact no-admission recovery signal for a decision-committed heartbeat", () => {
    const request = {
      ...BASE_REQUEST,
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "loopback" as const,
    };
    const storage = {
      chatSessionMeta: { get: vi.fn(() => ({ sessionId: "session-1", workspaceId: "workspace-1", revision: 7 })) },
      sessionControls: {
        getControl: vi.fn(() => ({ generation: 3 })),
        resolveMutationAuthority: vi.fn(() => ({ generation: 3 })),
      },
      sessionMutationAdmissions: {
        admit: vi.fn(),
        preemptHeartbeatAndAdmitOperatorTurn: vi.fn(() => ({
          disposition: "decision_committed" as const,
          preemptionDisposition: "decision_committed" as const,
          controllerGeneration: 3,
          workspaceId: "workspace-1",
          sessionId: "session-1",
          sessionIncarnationId: "incarnation-1",
          turnId: "heartbeat-turn-1",
          occurrenceId: "occurrence-1",
          heartbeatAdmissionId: "heartbeat-admission-1",
          durableRunId: "heartbeat-run-1",
        })),
      },
    };
    const service = new SessionControlService(storage as unknown as Storage);

    let observed: unknown;
    try {
      service.admitOperatorChatTurn({
        sessionId: "session-1",
        turnId: "operator-turn-1",
        request,
        runtimeOwnerId: "runtime-1",
        actorId: "operator-1",
        idempotencyKey: "admit-operator-turn-1",
        correlationId: "operator-turn-1",
        authenticatedOperator: createAuthenticatedOperatorAdmissionContext({
          actorId: "operator-1",
          authActorSource: "loopback",
        }),
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(DecisionCommittedHeartbeatAdmissionError);
    expect((observed as DecisionCommittedHeartbeatAdmissionError).recovery).toEqual({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sessionIncarnationId: "incarnation-1",
      turnId: "heartbeat-turn-1",
      occurrenceId: "occurrence-1",
      heartbeatAdmissionId: "heartbeat-admission-1",
      durableRunId: "heartbeat-run-1",
    });
    expect(storage.sessionMutationAdmissions.admit).not.toHaveBeenCalled();
  });

  it("replays the same authenticated admission after committed heartbeat preemption advances control to N+1", () => {
    const request = {
      ...BASE_REQUEST,
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "loopback" as const,
    };
    const materialSha256 = computeChatTurnAdmissionMaterialSha256(request);
    const admission = record({ materialSha256, controllerGeneration: 4 });
    let currentGeneration = 3;
    let committedMaterial: string | undefined;
    const preemptHeartbeatAndAdmitOperatorTurn = vi.fn((input: { materialSha256: string }) => {
      if (committedMaterial && input.materialSha256 !== committedMaterial) {
        throw new ConflictError({ message: "Operator admission replay conflicts." });
      }
      committedMaterial = input.materialSha256;
      const disposition = currentGeneration === 3 ? "created" : "replayed";
      const preemptionDisposition = currentGeneration === 3 ? "preempted" : "replayed";
      currentGeneration = 4;
      return {
        disposition,
        preemptionDisposition,
        controllerGeneration: 4,
        admission,
        controlEventId: "event-preempt-1",
        occurrenceId: "occurrence-1",
        heartbeatAdmissionId: "heartbeat-admission-1",
        durableRunId: "heartbeat-run-1",
      };
    });
    const storage = {
      chatSessionMeta: { get: vi.fn(() => ({ sessionId: "session-1", workspaceId: "workspace-1", revision: 7 })) },
      sessionControls: {
        getControl: vi.fn(() => ({ generation: currentGeneration })),
        resolveMutationAuthority: vi.fn(() => ({ generation: currentGeneration })),
      },
      sessionMutationAdmissions: {
        admit: vi.fn(),
        preemptHeartbeatAndAdmitOperatorTurn,
      },
    };
    const service = new SessionControlService(storage as unknown as Storage);
    const input = {
      sessionId: "session-1",
      turnId: "turn-1",
      request,
      runtimeOwnerId: "runtime-1",
      actorId: "operator-1",
      idempotencyKey: "admit-turn-1",
      correlationId: "correlation-1",
      authenticatedOperator: createAuthenticatedOperatorAdmissionContext({
        actorId: "operator-1",
        authActorSource: "loopback",
      }),
    };

    const created = service.admitOperatorChatTurn(input);
    const replayed = service.admitOperatorChatTurn(input);

    expect(created).toEqual(replayed);
    expect(created.identity.controllerGeneration).toBe(4);
    expect(preemptHeartbeatAndAdmitOperatorTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedControllerGeneration: 3, materialSha256 }),
    );
    expect(preemptHeartbeatAndAdmitOperatorTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedControllerGeneration: 4, materialSha256 }),
    );
    expect(() =>
      service.admitOperatorChatTurn({
        ...input,
        request: { ...request, content: "drifted replay" },
      }),
    ).toThrow(/replay conflicts/u);
  });

  it("freezes a system producer independently from spoofable request actor fields", () => {
    const materialSha256 = computeChatTurnAdmissionMaterialSha256(BASE_REQUEST);
    const admission = record({ materialSha256, actorKind: "system", actorId: "system:integration:webhook-1" });
    const storage = {
      chatSessionMeta: { get: vi.fn(() => ({ sessionId: "session-1", workspaceId: "workspace-1", revision: 7 })) },
      sessionControls: {
        getControl: vi.fn(() => ({ generation: 3 })),
        resolveMutationAuthority: vi.fn(() => ({ generation: 3 })),
      },
      sessionMutationAdmissions: {
        admit: vi.fn(() => ({ disposition: "created", admission })),
      },
    };
    const service = new SessionControlService(storage as unknown as Storage);

    const active = service.admitChatTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      request: {
        ...BASE_REQUEST,
        operatorId: "spoofed-operator",
        authActorId: "companion:spoofed",
        authActorSource: "token",
      },
      runtimeOwnerId: "runtime-1",
      actor: { actorKind: "system", actorId: "system:integration:webhook-1" },
      idempotencyKey: "admit-turn-1",
      correlationId: "correlation-1",
    });

    expect(storage.sessionControls.resolveMutationAuthority).toHaveBeenCalledWith({
      actorKind: "operator",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      expectedGeneration: 3,
    });
    expect(storage.sessionMutationAdmissions.admit).toHaveBeenCalledWith(
      expect.objectContaining({ actorKind: "system", actorId: "system:integration:webhook-1" }),
    );
    expect(active.requestActor).toEqual({
      actorKind: "system",
      actorId: "system:integration:webhook-1",
    });
  });

  it("uses the raw authenticated companion session id and rejects projected auth actor ids", () => {
    const materialSha256 = computeChatTurnAdmissionMaterialSha256(BASE_REQUEST);
    const admission = record({ materialSha256, actorKind: "external_companion", actorId: "companion-session-1" });
    const storage = {
      chatSessionMeta: { get: vi.fn(() => ({ sessionId: "session-1", workspaceId: "workspace-1", revision: 7 })) },
      sessionControls: {
        getControl: vi.fn(() => ({ generation: 3 })),
        resolveMutationAuthority: vi.fn(() => ({ generation: 3 })),
      },
      sessionMutationAdmissions: {
        admit: vi.fn(() => ({ disposition: "created", admission })),
      },
    };
    const service = new SessionControlService(storage as unknown as Storage);
    const externalActor = {
      actorKind: "external_companion" as const,
      actorId: "companion-session-1",
      companionSessionId: "companion-session-1",
      deviceGrantId: "device-grant-1",
      clientInstanceId: "client-1",
      principalPurpose: "session_control_client" as const,
      tokenHashSha256: "a".repeat(64),
      requiredCapability: "send_message" as const,
      expectedGeneration: 3,
    };

    const active = service.admitChatTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      request: {
        ...BASE_REQUEST,
        authActorId: "companion:companion-session-1",
        authActorSource: "companion_session",
      },
      runtimeOwnerId: "runtime-1",
      actor: externalActor,
      idempotencyKey: "admit-turn-1",
      correlationId: "correlation-1",
    });

    expect(storage.sessionControls.resolveMutationAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        actorKind: "external_companion",
        companionSessionId: "companion-session-1",
        requiredCapability: "send_message",
      }),
    );
    expect(active.requestActor).toEqual({
      actorKind: "external_companion",
      actorId: "companion-session-1",
    });

    expect(() =>
      service.admitChatTurn({
        sessionId: "session-1",
        turnId: "turn-2",
        request: BASE_REQUEST,
        runtimeOwnerId: "runtime-2",
        actor: { ...externalActor, actorId: "companion:companion-session-1" },
        idempotencyKey: "admit-turn-2",
        correlationId: "correlation-2",
      }),
    ).toThrow("raw authenticated companion session id");
  });

  it("changes the digest for every execution-relevant field while excluding transport signal, actor projection, and routed-context refs", () => {
    const baseline = computeChatTurnAdmissionMaterialSha256(BASE_REQUEST);
    const variants: ChatSendMessageRequest[] = [
      { ...BASE_REQUEST, content: "different" },
      { ...BASE_REQUEST, parts: [{ type: "text", text: "different" }] },
      { ...BASE_REQUEST, attachments: ["attachment-2"] },
      { ...BASE_REQUEST, providerId: "anthropic" },
      { ...BASE_REQUEST, model: "claude-opus" },
      { ...BASE_REQUEST, routeDecision: { action: "send", issuedAt: "2026-07-15T00:00:00.000Z" } as never },
      { ...BASE_REQUEST, useMemory: true },
      { ...BASE_REQUEST, mode: "chat" },
      { ...BASE_REQUEST, autoRoute: false },
      { ...BASE_REQUEST, webMode: "deep" },
      { ...BASE_REQUEST, memoryMode: "off" },
      { ...BASE_REQUEST, thinkingLevel: "high" },
      { ...BASE_REQUEST, speedMode: "fast" },
      { ...BASE_REQUEST, subagentPolicy: "auto" },
      { ...BASE_REQUEST, modelCouncil: { enabled: true } as never },
      { ...BASE_REQUEST, normalizationProfile: "quick_web" },
      { ...BASE_REQUEST, commandText: "/different" },
      { ...BASE_REQUEST, prefsOverride: { webMode: "deep" } },
      { ...BASE_REQUEST, permissionProfileId: "permission-2" },
      { ...BASE_REQUEST, localOperatorOverrideId: "override-1" },
      { ...BASE_REQUEST, policyRunId: "policy-run-2" },
      { ...BASE_REQUEST, policyTaskId: "policy-task-2" },
      { ...BASE_REQUEST, fullWebAccess: true },
      { ...BASE_REQUEST, parentDelegationStepId: "step-2" },
      { ...BASE_REQUEST, sideChatContext: { parentSessionId: "parent-1" } as never },
    ];
    for (const variant of variants) {
      expect(computeChatTurnAdmissionMaterialSha256(variant)).not.toBe(baseline);
    }
    expect(
      computeChatTurnAdmissionMaterialSha256({
        ...BASE_REQUEST,
        signal: AbortSignal.abort(),
        operatorId: "operator-other",
        authActorId: "auth-other",
        authActorSource: "token",
      }),
    ).toBe(baseline);
    // Routed-context refs are excluded BY DESIGN: the C1 durable ward strips
    // raw refs from every durable payload (their identity freezes into the
    // routed-context snapshot chain: sourceRequestHash + snapshotHash +
    // capability-profile/trace bindings), so the admission material must hash
    // the refs-less request the durable identity re-verifications reconstruct.
    expect(computeChatTurnAdmissionMaterialSha256({ ...BASE_REQUEST, contextRefs: [] })).toBe(baseline);
    expect(
      computeChatTurnAdmissionMaterialSha256({
        ...BASE_REQUEST,
        contextRefs: [{ kind: "external_attachment", ref: "esa_att-1" }] as never,
      }),
    ).toBe(baseline);
  });

  it("admits the exact synchronous storage-owned heartbeat callback without a second authority derivation", () => {
    const plan = buildHeartbeatOccurrencePlan({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      expectedPriorCadence: {},
      idleFloorSeconds: 300,
    });
    const occurrenceRequest = heartbeatAdmissionRequest(plan.frozenRequestSha256);
    const admission = record({
      admissionId: "heartbeat-admission-1",
      actorKind: "system",
      actorId: "system-heartbeat",
      operation: "chat_system_heartbeat",
      materialSha256: plan.frozenRequestSha256,
      idempotencyKey: occurrenceRequest.admissionInput.idempotencyKey,
      correlationId: occurrenceRequest.occurrenceId,
    });
    const storage = {
      chatSessionMeta: { get: vi.fn(() => ({ workspaceId: "workspace-1" })) },
      sessionControls: {
        getControl: vi.fn(),
        resolveMutationAuthority: vi.fn(),
      },
      sessionMutationAdmissions: {
        admit: vi.fn(() => ({ disposition: "created", admission })),
      },
    };
    const service = new SessionControlService(storage as unknown as Storage);

    const admitted = service.admitSystemHeartbeatOccurrence({
      occurrenceRequest,
      request: plan.request,
    });

    expect(storage.sessionMutationAdmissions.admit).toHaveBeenCalledWith(occurrenceRequest.admissionInput);
    expect(storage.sessionControls.getControl).not.toHaveBeenCalled();
    expect(storage.sessionControls.resolveMutationAuthority).not.toHaveBeenCalled();
    expect(admitted.admission.requestActor).toEqual({ actorKind: "system", actorId: "system-heartbeat" });
    expect(admitted.admission.systemHeartbeatOccurrence).toEqual({
      kind: "system_heartbeat_occurrence",
      operation: "chat_system_heartbeat",
      occurrenceId: occurrenceRequest.occurrenceId,
      correlationId: occurrenceRequest.occurrenceId,
      claimSha256: occurrenceRequest.claimSha256,
      durableRunId: occurrenceRequest.child.durableRunId,
    });
    expect(Object.isFrozen(admitted.admission.systemHeartbeatOccurrence)).toBe(true);
    expect(admitted.record).toBe(admission);
  });

  it("fails closed before heartbeat admission when callback actor, child, or request bytes drift", () => {
    const plan = buildHeartbeatOccurrencePlan({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      expectedPriorCadence: {},
      idleFloorSeconds: 300,
    });
    const occurrenceRequest = heartbeatAdmissionRequest(plan.frozenRequestSha256);
    occurrenceRequest.admissionInput.turnId = "foreign-turn";
    const admit = vi.fn();
    const service = new SessionControlService({
      chatSessionMeta: { get: vi.fn(() => ({ workspaceId: "workspace-1" })) },
      sessionMutationAdmissions: { admit },
    } as unknown as Storage);

    expect(() => service.admitSystemHeartbeatOccurrence({ occurrenceRequest, request: plan.request })).toThrow(
      /canonical request/u,
    );
    expect(admit).not.toHaveBeenCalled();
  });

  it("reclaims only the complete occurrence-linked heartbeat lease identity", () => {
    const plan = buildHeartbeatOccurrencePlan({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      expectedPriorCadence: {},
      idleFloorSeconds: 300,
    });
    const occurrence = heartbeatOccurrence(
      plan.frozenRequestSha256,
      plan.frozenObjectiveSha256,
      plan.evaluatedPolicySha256,
    );
    const admission = record({
      admissionId: occurrence.admissionId,
      actorKind: "system",
      actorId: "system-heartbeat",
      operation: "chat_system_heartbeat",
      materialSha256: plan.frozenRequestSha256,
      idempotencyKey: occurrence.admissionIdempotencyKey,
      correlationId: occurrence.admissionCorrelationId,
      requestSha256: occurrence.admissionRequestSha256,
      runtimeOwnerId: occurrence.runtimeOwnerId,
    });
    const reclaim = vi.fn(() => ({ disposition: "reclaimed", admission }));
    const service = new SessionControlService({
      sessionMutationAdmissions: {
        require: vi.fn(() => admission),
        reclaimExpiredSystemTurnWriteRequestLease: reclaim,
      },
    } as unknown as Storage);

    const recovered = service.recoverSystemHeartbeatOccurrence({ occurrence, request: plan.request });

    expect(recovered.disposition).toBe("reclaimed");
    if (recovered.disposition === "reclaimed") {
      expect(recovered.admission.systemHeartbeatOccurrence).toEqual({
        kind: "system_heartbeat_occurrence",
        operation: "chat_system_heartbeat",
        occurrenceId: occurrence.occurrenceId,
        correlationId: occurrence.occurrenceId,
        claimSha256: occurrence.claimSha256,
        durableRunId: occurrence.durableRunId,
      });
    }
    expect(reclaim).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrenceId: occurrence.occurrenceId,
        expectedLeaseRevision: 1,
        expectedDurableRunId: occurrence.durableRunId,
        frozenRequestSha256: plan.frozenRequestSha256,
        frozenObjectiveSha256: plan.frozenObjectiveSha256,
        evaluatedPolicySha256: plan.evaluatedPolicySha256,
      }),
    );
  });

  // Request-lease renewal is reached only from the runtime owner's heartbeat
  // interval, which no route may arm, so nothing else drives these branches.
  it("renews the request lease in place against the presented claim and advances the stored revision", () => {
    const materialSha256 = computeChatTurnAdmissionMaterialSha256(BASE_REQUEST);
    // The presented claim is the live admission's own claim object, which the
    // renewal then mutates in place — snapshot it at call time or the recorded
    // argument reads back with the post-renewal revision.
    let presentedClaim: unknown;
    const renewTurnWriteRequestLease = vi.fn((input: { requestRuntimeClaim: unknown }) => {
      presentedClaim = { ...(input.requestRuntimeClaim as Record<string, unknown>) };
      return record({ materialSha256, runtimeLeaseRevision: 2 });
    });
    const storage = {
      chatSessionMeta: { get: vi.fn(() => ({ sessionId: "session-1", workspaceId: "workspace-1", revision: 7 })) },
      sessionControls: {
        getControl: vi.fn(() => ({ generation: 3 })),
        resolveMutationAuthority: vi.fn(() => ({ generation: 3 })),
      },
      sessionMutationAdmissions: {
        admit: vi.fn(() => ({ disposition: "created", admission: record({ materialSha256 }) })),
        renewTurnWriteRequestLease,
      },
    };
    const service = new SessionControlService(storage as unknown as Storage);
    const active = service.admitOperatorChatTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      request: BASE_REQUEST,
      runtimeOwnerId: "runtime-1",
      actorId: "operator-1",
      idempotencyKey: "admit-turn-1",
      correlationId: "correlation-1",
    });
    const claim = active.requestClaim;

    const renewed = service.renewRequestLease(active);

    expect(renewTurnWriteRequestLease).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionId: "admission-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        sessionIncarnationId: "incarnation-1",
        turnId: "turn-1",
      }),
    );
    expect(presentedClaim).toEqual({ runtimeOwnerId: "runtime-1", leaseRevision: 1 });
    // The live admission object is renewed in place: a heartbeat must not hand
    // back a detached copy the caller's later writes would ignore.
    expect(renewed).toBe(active);
    expect(active.requestClaim).toBe(claim);
    expect(active.requestClaim).toEqual({ runtimeOwnerId: "runtime-1", leaseRevision: 2 });
  });

  it("fails closed when a lease renewal or turn write is attempted without an exclusive request claim", () => {
    const renewTurnWriteRequestLease = vi.fn();
    const assertActiveTurnWrite = vi.fn();
    const service = new SessionControlService({
      sessionMutationAdmissions: { renewTurnWriteRequestLease, assertActiveTurnWrite },
    } as unknown as Storage);
    const identity = {
      admissionId: "admission-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sessionIncarnationId: "incarnation-1",
      turnId: "turn-1",
      aggregateRevision: 7,
      controllerGeneration: 3,
      materialSha256: "a".repeat(64),
    } as never;
    const durableOnly = {
      identity,
      admittedRequest: BASE_REQUEST,
      requestActor: { actorKind: "operator", actorId: "operator-1" },
      requestClaim: { runtimeOwnerId: "runtime-1", leaseRevision: 1 },
      durableClaim: { durableRunId: "run-1", claimToken: "claim-1", leaseRevision: 1 },
    } as never;
    const claimless = { identity, admittedRequest: BASE_REQUEST, requestActor: durableOnly.requestActor } as never;

    // A durable claim has superseded the request lease — renewing it would
    // resurrect a second writer for the same turn.
    expect(() => service.renewRequestLease(durableOnly)).toThrow(ConflictError);
    expect(() => service.renewRequestLease(claimless)).toThrow(ConflictError);
    expect(() => service.assertActiveTurnWrite(claimless)).toThrow(ConflictError);
    expect(renewTurnWriteRequestLease).not.toHaveBeenCalled();
    expect(assertActiveTurnWrite).not.toHaveBeenCalled();
  });

  it("denies the session event read to a send-only external controller but allows it once read is delegated", () => {
    const companion = {
      actorKind: "external_companion" as const,
      companionSessionId: "companion-session-1",
      deviceGrantId: "device-grant-1",
      clientInstanceId: "client-instance-1",
      principalPurpose: "session_control_client" as const,
    };
    const control = (capabilities: string[]) => ({
      ownerKind: "external_companion",
      generation: 4,
      capabilities,
      boundExternalController: { companionSessionId: "companion-session-1", clientInstanceId: "client-instance-1" },
    });
    const buildService = (capabilities: string[]) =>
      new SessionControlService({
        chatSessionMeta: { get: vi.fn(() => ({ workspaceId: "workspace-1" })) },
        sessionControls: {
          getControl: vi.fn(() => control(capabilities)),
          listEvents: vi.fn(() => []),
        },
      } as unknown as Storage);

    const sendOnly = buildService(["send"]);
    let denied: unknown;
    try {
      sendOnly.listEvents({ actor: companion, sessionId: "session-1" });
    } catch (error) {
      denied = (error as ConflictError & { details?: { sessionControlCode?: string } }).details?.sessionControlCode;
    }
    expect(denied).toBe("SESSION_CONTROL_CAPABILITY_DENIED");

    const withRead = buildService(["send", "read"]);
    expect(withRead.listEvents({ actor: companion, sessionId: "session-1" })).toEqual([]);
  });

  it("authorizeExternalSessionRead is the single gate: admits bound+read, bypasses operators, and fails closed", () => {
    const companion = {
      actorKind: "external_companion" as const,
      companionSessionId: "companion-session-1",
      deviceGrantId: "device-grant-1",
      clientInstanceId: "client-instance-1",
      principalPurpose: "session_control_client" as const,
    };
    const buildService = (
      controlFactory: () => unknown,
    ): { service: SessionControlService; getControl: ReturnType<typeof vi.fn> } => {
      const getControl = vi.fn(controlFactory);
      const service = new SessionControlService({
        chatSessionMeta: { get: vi.fn(() => ({ workspaceId: "workspace-1" })) },
        sessionControls: { getControl },
      } as unknown as Storage);
      return { service, getControl };
    };
    const boundControl = (capabilities: string[], overrides: Record<string, unknown> = {}) => ({
      ownerKind: "external_companion",
      generation: 4,
      capabilities,
      boundExternalController: { companionSessionId: "companion-session-1", clientInstanceId: "client-instance-1" },
      ...overrides,
    });
    const deniedCode = (fn: () => void): string | undefined => {
      try {
        fn();
      } catch (error) {
        return (error as ConflictError & { details?: { sessionControlCode?: string } }).details?.sessionControlCode;
      }
      return undefined;
    };

    // ALLOW: bound controller with delegated read.
    const allow = buildService(() => boundControl(["send", "read"]));
    expect(() =>
      allow.service.authorizeExternalSessionRead({ actor: companion, sessionId: "session-1" }),
    ).not.toThrow();

    // OPERATOR bypass: no storage read, no throw.
    const operator = buildService(() => boundControl(["send", "read"]));
    operator.service.authorizeExternalSessionRead({
      actor: { actorKind: "operator", actorId: "op-1" },
      sessionId: "s",
    });
    expect(operator.getControl).not.toHaveBeenCalled();

    // DENY 1 — send-only capability.
    expect(
      deniedCode(() =>
        buildService(() => boundControl(["send"])).service.authorizeExternalSessionRead({
          actor: companion,
          sessionId: "session-1",
        }),
      ),
    ).toBe("SESSION_CONTROL_CAPABILITY_DENIED");

    // DENY 2 — non-controller (operator owns the session).
    expect(
      deniedCode(() =>
        buildService(() => ({ ownerKind: "operator", generation: 1 })).service.authorizeExternalSessionRead({
          actor: companion,
          sessionId: "session-1",
        }),
      ),
    ).toBe("SESSION_CONTROL_CAPABILITY_DENIED");

    // DENY 3 — wrong companion session bound.
    expect(
      deniedCode(() =>
        buildService(() =>
          boundControl(["send", "read"], {
            boundExternalController: { companionSessionId: "other-companion", clientInstanceId: "client-instance-1" },
          }),
        ).service.authorizeExternalSessionRead({ actor: companion, sessionId: "session-1" }),
      ),
    ).toBe("SESSION_CONTROL_CAPABILITY_DENIED");

    // DENY 4 — cross-session / different bound client instance.
    expect(
      deniedCode(() =>
        buildService(() =>
          boundControl(["send", "read"], {
            boundExternalController: { companionSessionId: "companion-session-1", clientInstanceId: "other-instance" },
          }),
        ).service.authorizeExternalSessionRead({ actor: companion, sessionId: "session-1" }),
      ),
    ).toBe("SESSION_CONTROL_CAPABILITY_DENIED");

    // DENY 5 — unknown session fails closed (NotFound before any control read).
    const unknownGetControl = vi.fn(() => boundControl(["send", "read"]));
    const unknownService = new SessionControlService({
      chatSessionMeta: { get: vi.fn(() => undefined) },
      sessionControls: { getControl: unknownGetControl },
    } as unknown as Storage);
    expect(() => unknownService.authorizeExternalSessionRead({ actor: companion, sessionId: "missing" })).toThrow(
      NotFoundError,
    );
    expect(unknownGetControl).not.toHaveBeenCalled();
  });
});

describe("SessionControlService.pageControlEventStream", () => {
  const companion = {
    actorKind: "external_companion" as const,
    companionSessionId: "companion-session-1",
    deviceGrantId: "device-grant-1",
    clientInstanceId: "client-instance-1",
    principalPurpose: "session_control_client" as const,
  };
  const controlEvent = (overrides: Record<string, unknown> = {}) => ({
    eventId: "sce-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    nextGeneration: 2,
    nextLeaseState: "external_live",
    reasonCode: "handoff",
    actorKind: "operator",
    actorId: "operator:1",
    correlationId: "corr-1",
    createdAt: "2026-07-14T10:00:00.000Z",
    ...overrides,
  });
  const boundControl = (capabilities: string[], overrides: Record<string, unknown> = {}) => ({
    ownerKind: "external_companion",
    leaseState: "external_live",
    generation: 4,
    capabilities,
    boundExternalController: { companionSessionId: "companion-session-1", clientInstanceId: "client-instance-1" },
    ...overrides,
  });
  const streamRow = (sequence: number, overrides: Record<string, unknown> = {}) => ({
    sequence,
    event: controlEvent({ eventId: `sce-${sequence}`, ...overrides }),
  });
  const buildService = (options: {
    control: () => unknown;
    rows?: Array<{ sequence: number; event: unknown }>;
    bounds?: { oldestSequence: number; newestSequence: number };
  }) => {
    const rows = options.rows ?? [];
    const listEventsAfterSequence = vi.fn((_ws: string, _sid: string, after: number, limit: number) =>
      rows.filter((row) => row.sequence > after).slice(0, limit),
    );
    const getEventSequenceBounds = vi.fn(
      () =>
        options.bounds ?? {
          oldestSequence: rows.length > 0 ? rows[0]!.sequence : 0,
          newestSequence: rows.length > 0 ? rows[rows.length - 1]!.sequence : 0,
        },
    );
    const getControl = vi.fn(options.control);
    const service = new SessionControlService({
      chatSessionMeta: { get: vi.fn(() => ({ workspaceId: "workspace-1" })) },
      sessionControls: { getControl, getEventSequenceBounds, listEventsAfterSequence },
    } as unknown as Storage);
    return { service, listEventsAfterSequence, getEventSequenceBounds, getControl };
  };

  it("uses event_sequence as the cursor, exposes honest bounds, and carries the current generation for a bound reader with read", () => {
    const { service, listEventsAfterSequence } = buildService({
      control: () => boundControl(["send", "read"], { generation: 5 }),
      rows: [
        streamRow(1, { reasonCode: "session_initialized", nextGeneration: 1 }),
        streamRow(2, { reasonCode: "handoff", nextGeneration: 2 }),
        streamRow(3, { reasonCode: "heartbeat", nextGeneration: 2 }),
      ],
      bounds: { oldestSequence: 1, newestSequence: 3 },
    });
    const page = service.pageControlEventStream({ actor: companion, sessionId: "session-1" });
    expect(page.events.map((envelope) => envelope.cursor)).toEqual([1, 2, 3]);
    expect(page.events.map((envelope) => envelope.event.eventId)).toEqual(["sce-1", "sce-2", "sce-3"]);
    expect(page.oldestSequence).toBe(1);
    expect(page.newestSequence).toBe(3);
    expect(page.truncated).toBe(false);
    expect(page.generation).toBe(5);
    expect(page.ownerKind).toBe("external_companion");
    expect(page.leaseState).toBe("external_live");
    expect(listEventsAfterSequence).toHaveBeenCalledWith("workspace-1", "session-1", 0, SESSION_CONTROL_MAX_LIST_ITEMS);
  });

  it("pages FORWARD past 200 from the client cursor and sets truncated when more remain (H1)", () => {
    const { service } = buildService({
      control: () => boundControl(["send", "read"]),
      rows: [streamRow(199), streamRow(200), streamRow(201), streamRow(202)],
      bounds: { oldestSequence: 1, newestSequence: 260 },
    });
    const page = service.pageControlEventStream({
      actor: companion,
      sessionId: "session-1",
      afterCursor: 200,
      limit: 2,
    });
    // Events beyond 200 ARE returned — they are not permanently unreachable.
    expect(page.events.map((envelope) => envelope.cursor)).toEqual([201, 202]);
    expect(page.newestSequence).toBe(260);
    // limit filled AND last (202) < newest (260) ⇒ keep paging forward.
    expect(page.truncated).toBe(true);
  });

  it("clears truncated once the page reaches the newest sequence even at the limit", () => {
    const { service } = buildService({
      control: () => boundControl(["send", "read"]),
      rows: [streamRow(259), streamRow(260)],
      bounds: { oldestSequence: 1, newestSequence: 260 },
    });
    const page = service.pageControlEventStream({
      actor: companion,
      sessionId: "session-1",
      afterCursor: 258,
      limit: 2,
    });
    expect(page.events.map((envelope) => envelope.cursor)).toEqual([259, 260]);
    expect(page.truncated).toBe(false);
  });

  it("fails closed for a send-only controller before any event is read (revoked/unbound readers cannot page)", () => {
    const { service, listEventsAfterSequence, getEventSequenceBounds } = buildService({
      control: () => boundControl(["send"]),
      rows: [streamRow(1)],
    });
    let code: string | undefined;
    try {
      service.pageControlEventStream({ actor: companion, sessionId: "session-1" });
    } catch (error) {
      code = (error as ConflictError & { details?: { sessionControlCode?: string } }).details?.sessionControlCode;
    }
    expect(code).toBe("SESSION_CONTROL_CAPABILITY_DENIED");
    expect(listEventsAfterSequence).not.toHaveBeenCalled();
    expect(getEventSequenceBounds).not.toHaveBeenCalled();
  });

  it("admits an operator without a control-binding check and surfaces the current owner/generation, content-free", () => {
    const { service } = buildService({
      control: () => ({ ownerKind: "operator", leaseState: "operator_active", generation: 7 }),
      rows: [
        streamRow(5, { reasonCode: "operator_revoke", nextOwnerKind: "operator", nextLeaseState: "operator_active" }),
      ],
      bounds: { oldestSequence: 1, newestSequence: 5 },
    });
    const page = service.pageControlEventStream({
      actor: { actorKind: "operator", actorId: "op-1" },
      sessionId: "session-1",
    });
    expect(page.ownerKind).toBe("operator");
    expect(page.generation).toBe(7);
    expect(page.events).toHaveLength(1);
    // Content-free: no approval action token or message text can ride the stream.
    expect(JSON.stringify(page)).not.toMatch(/grat_|"token"|approvalActionToken/);
  });
});

function listProductionTypeScriptSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return listProductionTypeScriptSources(fullPath);
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".vitest.ts") ||
      entry.name.endsWith(".d.ts")
    ) {
      return [];
    }
    return [fullPath];
  });
}

function heartbeatAdmissionRequest(materialSha256: string): HeartbeatOccurrenceAdmissionRequest {
  return {
    occurrenceId: "heartbeat-occurrence-1",
    claimSha256: "c".repeat(64),
    claimedAt: "2026-07-15T19:00:00.000Z",
    child: {
      userMessageId: "heartbeat-user-1",
      assistantMessageId: "heartbeat-assistant-1",
      turnId: "turn-1",
      durableRunId: "heartbeat-run-1",
    },
    admissionInput: {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      expectedSessionIncarnationId: "incarnation-1",
      turnId: "turn-1",
      runtimeOwnerId: "runtime-1",
      admissionKind: "turn_write",
      aggregateRevision: 7,
      controllerGeneration: 3,
      actorKind: "system",
      actorId: "system-heartbeat",
      operation: "chat_system_heartbeat",
      materialSha256,
      idempotencyKey: "heartbeat-admission:heartbeat-occurrence-1",
      correlationId: "heartbeat-occurrence-1",
    },
  };
}

function heartbeatOccurrence(
  frozenRequestSha256: string,
  frozenObjectiveSha256: string,
  evaluatedPolicySha256: string,
): HeartbeatOccurrenceRecord {
  return {
    occurrenceId: "heartbeat-occurrence-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sessionIncarnationId: "incarnation-1",
    admissionId: "admission-1",
    admissionRequestSha256: "b".repeat(64),
    admissionIdempotencyKey: "heartbeat-admission:heartbeat-occurrence-1",
    admissionCorrelationId: "heartbeat-occurrence-1",
    runtimeOwnerId: "runtime-1",
    systemActorId: "system-heartbeat",
    admissionMaterialSha256: frozenRequestSha256,
    evaluatedPolicySha256,
    frozenRequestSha256,
    frozenObjectiveSha256,
    claimSha256: "c".repeat(64),
    aggregateRevision: 7,
    controllerGeneration: 3,
    priorCadence: {},
    heartbeatIntervalSeconds: 3600,
    cooldownSeconds: 0,
    idleFloorSeconds: 300,
    observedSessionActivityAt: "2026-07-15T18:00:00.000Z",
    userMessageId: "heartbeat-user-1",
    assistantMessageId: "heartbeat-assistant-1",
    turnId: "turn-1",
    durableRunId: "heartbeat-run-1",
    state: "admitted",
    revision: 1,
    claimedAt: "2026-07-15T19:00:00.000Z",
    updatedAt: "2026-07-15T19:00:00.000Z",
  };
}

function record(patch: Partial<SessionMutationAdmissionRecord> = {}): SessionMutationAdmissionRecord {
  return {
    admissionId: "admission-1",
    sessionIncarnationId: "incarnation-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    runtimeOwnerId: "runtime-1",
    runtimeLeaseRevision: 1,
    admissionKind: "turn_write",
    aggregateRevision: 7,
    controllerGeneration: 3,
    actorKind: "operator",
    actorId: "operator-1",
    operation: "chat_turn",
    materialSha256: "a".repeat(64),
    status: "active",
    idempotencyKey: "admit-turn-1",
    requestSha256: "b".repeat(64),
    correlationId: "correlation-1",
    createdAt: "2026-07-15T00:00:00.000Z",
    ...patch,
  };
}
