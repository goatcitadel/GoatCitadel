import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { agentSendChatMessage, agentSendChatMessageStream, type ChatTurnEntryHost } from "./chat-turn-entry-service.js";
import {
  computeChatTurnAdmissionMaterialSha256,
  createAuthenticatedOperatorAdmissionContext,
  createExternalCompanionAdmissionContext,
} from "./session-control-service.js";

/**
 * HX-411: canonical Chat send must admit a bound external `session_control_client`
 * controller through the *same* pipeline as an operator, carrying its generation,
 * capability, token binding, and live lease, and must be fenced identically at
 * every late recheck. These tests pin the branch point, the generation CAS input,
 * the operator regression, and the late-generation fence wiring at the entry seam.
 */

const COMPANION = {
  companionSessionId: "companion-session-1",
  deviceGrantId: "device-grant-1",
  clientInstanceId: "client-instance-1",
  tokenHashSha256: "a".repeat(64),
  expectedGeneration: 4,
};

const REQUEST = {
  content: "external controller work",
  operatorId: "operator-owner",
  authActorId: "operator-owner",
  authActorSource: "none" as const,
};

function externalCompanionContext(overrides: Partial<typeof COMPANION> = {}) {
  return createExternalCompanionAdmissionContext({ ...COMPANION, ...overrides });
}

function externalAdmission(input: {
  sessionId: string;
  turnId: string;
  request: Parameters<typeof computeChatTurnAdmissionMaterialSha256>[0];
  actor: { expectedGeneration: number; companionSessionId: string };
}) {
  return {
    identity: {
      admissionId: `admission-${input.turnId}`,
      sessionIncarnationId: "incarnation-1",
      workspaceId: "workspace-1",
      sessionId: input.sessionId,
      turnId: input.turnId,
      aggregateRevision: 1,
      controllerGeneration: input.actor.expectedGeneration,
      materialSha256: computeChatTurnAdmissionMaterialSha256(input.request),
    },
    admittedRequest: input.request,
    requestActor: { actorKind: "external_companion" as const, actorId: input.actor.companionSessionId },
    requestClaim: { runtimeOwnerId: `runtime-${input.turnId}`, leaseRevision: 1 },
  };
}

interface HarnessOverrides {
  admitChatTurn?: ReturnType<typeof vi.fn>;
  admitOperatorChatTurn?: ReturnType<typeof vi.fn>;
  assertActiveTurnWrite?: ReturnType<typeof vi.fn>;
}

function buildHarness(overrides: HarnessOverrides = {}) {
  const admitChatTurn =
    overrides.admitChatTurn ?? vi.fn((input: Parameters<typeof externalAdmission>[0]) => externalAdmission(input));
  const admitOperatorChatTurn =
    overrides.admitOperatorChatTurn ??
    vi.fn((input: { sessionId: string; turnId: string; request: typeof REQUEST; actorId: string }) => ({
      identity: {
        admissionId: `admission-${input.turnId}`,
        sessionIncarnationId: "incarnation-1",
        workspaceId: "workspace-1",
        sessionId: input.sessionId,
        turnId: input.turnId,
        aggregateRevision: 1,
        controllerGeneration: 1,
        materialSha256: computeChatTurnAdmissionMaterialSha256(input.request),
      },
      admittedRequest: input.request,
      requestActor: { actorKind: "operator" as const, actorId: input.actorId },
      requestClaim: { runtimeOwnerId: `runtime-${input.turnId}`, leaseRevision: 1 },
    }));
  const admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery = vi.fn(async (input: { turnId: string }) =>
    admitOperatorChatTurn(input),
  );
  const assertActiveTurnWrite = overrides.assertActiveTurnWrite ?? vi.fn();
  const closeTurnWrite = vi.fn();
  const startRequestLeaseHeartbeat = vi.fn(() => ({ stop: vi.fn(), assertHealthy: vi.fn() }));
  const host = {
    withChatTurnWriteLease: async (_sessionId: string, _owner: string, operation: () => Promise<unknown>) =>
      operation(),
    withChatTurnWriteLeaseStream: (_sessionId: string, _owner: string, operation: () => AsyncGenerator<unknown>) =>
      operation(),
    recoverDecisionCommittedHeartbeat: vi.fn(async () => undefined),
    recordDevDiagnostic: vi.fn(),
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId ?? "workspace-1",
    storage: {
      runImmediateTransaction: (work: () => unknown) => work(),
      chatSessionMeta: { ensure: () => ({ workspaceId: "workspace-1" }) },
    },
    sessionControlRuntimeOwner: {
      admitChatTurn,
      admitOperatorChatTurn,
      admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery,
      startRequestLeaseHeartbeat,
      assertActiveTurnWrite,
      closeTurnWrite,
    },
  } as unknown as ChatTurnEntryHost;
  return {
    host,
    admitChatTurn,
    admitOperatorChatTurn,
    admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery,
    assertActiveTurnWrite,
    closeTurnWrite,
    startRequestLeaseHeartbeat,
  };
}

async function consume(stream: AsyncGenerator<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Drives generator execution; admission/fence throws before any chunk.
  }
}

describe("external companion canonical send admission (HX-411)", () => {
  it("admits a bound external controller through admitChatTurn with its generation, send capability, and token binding", async () => {
    // The first late fence throws to stop after admission is captured.
    const sentinel = new Error("stop after admission");
    const { host, admitChatTurn, admitOperatorChatTurn, closeTurnWrite } = buildHarness({
      assertActiveTurnWrite: vi.fn(() => {
        throw sentinel;
      }),
    });
    const externalCompanion = externalCompanionContext();

    await expect(agentSendChatMessage(host, "session-1", REQUEST, { externalCompanion })).rejects.toBe(sentinel);

    expect(admitOperatorChatTurn).not.toHaveBeenCalled();
    expect(admitChatTurn).toHaveBeenCalledTimes(1);
    const [admissionInput] = admitChatTurn.mock.calls[0];
    expect(admissionInput).toMatchObject({
      sessionId: "session-1",
      request: REQUEST,
      idempotencyKey: expect.stringMatching(/^chat-turn-admit:/),
      actor: {
        actorKind: "external_companion",
        actorId: COMPANION.companionSessionId,
        companionSessionId: COMPANION.companionSessionId,
        deviceGrantId: COMPANION.deviceGrantId,
        clientInstanceId: COMPANION.clientInstanceId,
        principalPurpose: "session_control_client",
        tokenHashSha256: COMPANION.tokenHashSha256,
        requiredCapability: "send",
        expectedGeneration: COMPANION.expectedGeneration,
      },
    });
    // No operator-derived actorId leaks into the external admission input.
    expect(admissionInput).not.toHaveProperty("actorId");
    // The identical admission-material digest helper is reused; assertEntryTurnAdmission
    // passed (we reached the fence), proving the frozen digest matches the request.
    expect(closeTurnWrite).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", actorId: COMPANION.companionSessionId }),
    );
  });

  it("keeps the operator send path on admitOperatorChatTurn and never touches admitChatTurn", async () => {
    const sentinel = new Error("stop after admission");
    const { host, admitChatTurn, admitOperatorChatTurn } = buildHarness({
      assertActiveTurnWrite: vi.fn(() => {
        throw sentinel;
      }),
    });

    await expect(agentSendChatMessage(host, "session-1", REQUEST)).rejects.toBe(sentinel);

    expect(admitOperatorChatTurn).toHaveBeenCalledTimes(1);
    expect(admitChatTurn).not.toHaveBeenCalled();
    const [operatorInput] = admitOperatorChatTurn.mock.calls[0];
    expect(operatorInput).toMatchObject({ sessionId: "session-1", request: REQUEST, actorId: "operator-owner" });
    expect(operatorInput).not.toHaveProperty("actor");
  });

  it("routes an authenticated operator send through the heartbeat-recovery admission, not the external path", async () => {
    const sentinel = new Error("stop after admission");
    const { host, admitChatTurn, admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery } = buildHarness({
      assertActiveTurnWrite: vi.fn(() => {
        throw sentinel;
      }),
    });
    const authenticatedOperator = createAuthenticatedOperatorAdmissionContext({
      actorId: "operator-owner",
      authActorSource: "none",
    });

    await expect(agentSendChatMessage(host, "session-1", REQUEST, { authenticatedOperator })).rejects.toBe(sentinel);

    expect(admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery).toHaveBeenCalledTimes(1);
    expect(admitChatTurn).not.toHaveBeenCalled();
  });

  it("refuses a send attributed to both an operator and an external controller before any admission", async () => {
    const { host, admitChatTurn, admitOperatorChatTurn, startRequestLeaseHeartbeat } = buildHarness();
    const authenticatedOperator = createAuthenticatedOperatorAdmissionContext({
      actorId: "operator-owner",
      authActorSource: "none",
    });
    const externalCompanion = externalCompanionContext();

    await expect(
      agentSendChatMessage(host, "session-1", REQUEST, { authenticatedOperator, externalCompanion }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(admitChatTurn).not.toHaveBeenCalled();
    expect(admitOperatorChatTurn).not.toHaveBeenCalled();
    expect(startRequestLeaseHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects a stale controller generation before canonical admission takes any lease", async () => {
    const staleConflict = new ConflictError({
      code: "STATE_CONFLICT",
      message: "Session control generation is stale.",
      details: { sessionControlCode: "SESSION_CONTROL_GENERATION_STALE" },
    });
    const admitChatTurn = vi.fn(() => {
      throw staleConflict;
    });
    const { host, assertActiveTurnWrite, closeTurnWrite, startRequestLeaseHeartbeat } = buildHarness({ admitChatTurn });

    await expect(
      agentSendChatMessage(host, "session-1", REQUEST, { externalCompanion: externalCompanionContext() }),
    ).rejects.toBe(staleConflict);

    // Rejection happens at the canonical admission boundary; nothing downstream runs.
    expect(startRequestLeaseHeartbeat).not.toHaveBeenCalled();
    expect(assertActiveTurnWrite).not.toHaveBeenCalled();
    expect(closeTurnWrite).not.toHaveBeenCalled();
  });

  it("rejects an expired external lease before canonical admission (stale lease guard)", async () => {
    const staleLease = new ConflictError({
      code: "STATE_CONFLICT",
      message: "Session control lease is stale.",
      details: { sessionControlCode: "SESSION_CONTROL_STALE" },
    });
    const admitChatTurn = vi.fn(() => {
      throw staleLease;
    });
    const { host, startRequestLeaseHeartbeat } = buildHarness({ admitChatTurn });

    await expect(
      agentSendChatMessage(host, "session-1", REQUEST, { externalCompanion: externalCompanionContext() }),
    ).rejects.toBe(staleLease);
    expect(startRequestLeaseHeartbeat).not.toHaveBeenCalled();
  });

  it("blocks the streamed external turn and closes it content-free when the generation advances mid-turn", async () => {
    const authorityChanged = new ConflictError({
      code: "STATE_CONFLICT",
      message: "Mutation admission no longer matches the current session controller authority.",
      details: { admissionCode: "SESSION_MUTATION_ADMISSION_AUTHORITY_CHANGED" },
    });
    const { host, admitChatTurn, closeTurnWrite } = buildHarness({
      assertActiveTurnWrite: vi.fn(() => {
        throw authorityChanged;
      }),
    });

    await expect(
      consume(
        agentSendChatMessageStream(host, "session-1", REQUEST, { externalCompanion: externalCompanionContext() }),
      ),
    ).rejects.toBe(authorityChanged);

    expect(admitChatTurn).toHaveBeenCalledTimes(1);
    // The late fence blocks the result and the admission is terminalized content-free
    // (ids/status/actor only) — never re-labelled completed.
    expect(closeTurnWrite).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", actorId: COMPANION.companionSessionId }),
    );
    const [closeInput] = closeTurnWrite.mock.calls[0];
    expect(closeInput).not.toHaveProperty("content");
    expect(closeInput).not.toHaveProperty("message");
  });

  it("carries the caller-presented generation into the admission CAS so a superseded client cannot admit", async () => {
    const sentinel = new Error("stop after admission");
    const { host, admitChatTurn } = buildHarness({
      assertActiveTurnWrite: vi.fn(() => {
        throw sentinel;
      }),
    });

    await expect(
      agentSendChatMessage(host, "session-1", REQUEST, {
        externalCompanion: externalCompanionContext({ expectedGeneration: 9 }),
      }),
    ).rejects.toBe(sentinel);

    const [admissionInput] = admitChatTurn.mock.calls[0];
    expect(admissionInput.actor.expectedGeneration).toBe(9);
  });
});
