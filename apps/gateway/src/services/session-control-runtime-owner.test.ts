import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import {
  DecisionCommittedHeartbeatAdmissionError,
  createAuthenticatedOperatorAdmissionContext,
  type SessionControlService,
} from "./session-control-service.js";
import {
  cancelExpiredUnboundChatTurnAdmissionsOnBoot,
  SessionControlRuntimeOwner,
} from "./session-control-runtime-owner.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionControlRuntimeOwner", () => {
  it("creates a unique explicit request owner for each turn admission", () => {
    const admitOperatorChatTurn = vi.fn((input) => ({
      identity: { admissionId: "a", sessionIncarnationId: "i" },
      requestClaim: { runtimeOwnerId: input.runtimeOwnerId, leaseRevision: 1 },
    }));
    const owner = new SessionControlRuntimeOwner({ admitOperatorChatTurn } as unknown as SessionControlService);
    const input = {
      sessionId: "session-1",
      turnId: "turn-1",
      request: { content: "hello" },
      actorId: "operator-1",
      idempotencyKey: "admit-1",
      correlationId: "correlation-1",
    };

    const first = owner.admitOperatorChatTurn(input);
    const second = owner.admitOperatorChatTurn({ ...input, turnId: "turn-2", idempotencyKey: "admit-2" });

    expect(first.requestClaim?.runtimeOwnerId).toMatch(/^chat-turn-request:/u);
    expect(second.requestClaim?.runtimeOwnerId).toMatch(/^chat-turn-request:/u);
    expect(second.requestClaim?.runtimeOwnerId).not.toBe(first.requestClaim?.runtimeOwnerId);
  });

  it("does not invoke heartbeat recovery outside the decision-committed window", async () => {
    const admission = { identity: { admissionId: "operator-admission" } } as never;
    const admitOperatorChatTurn = vi.fn(() => admission);
    const recover = vi.fn(async () => undefined);
    const owner = new SessionControlRuntimeOwner({ admitOperatorChatTurn } as unknown as SessionControlService);

    await expect(
      owner.admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery(authenticatedOperatorInput(), recover),
    ).resolves.toBe(admission);

    expect(admitOperatorChatTurn).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });

  it("recovers a decision-committed heartbeat and retries the identical operator admission once", async () => {
    const recovery = decisionCommittedRecoveryIdentity();
    const admission = { identity: { admissionId: "operator-admission" } } as never;
    const admitOperatorChatTurn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new DecisionCommittedHeartbeatAdmissionError(recovery);
      })
      .mockReturnValueOnce(admission);
    const recover = vi.fn(async () => undefined);
    const owner = new SessionControlRuntimeOwner({ admitOperatorChatTurn } as unknown as SessionControlService);

    await expect(
      owner.admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery(authenticatedOperatorInput(), recover),
    ).resolves.toBe(admission);

    expect(recover).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith(recovery);
    expect(admitOperatorChatTurn).toHaveBeenCalledTimes(2);
    expect(admitOperatorChatTurn.mock.calls[1]?.[0]).toEqual(admitOperatorChatTurn.mock.calls[0]?.[0]);
    expect(admitOperatorChatTurn.mock.calls[0]?.[0].runtimeOwnerId).toMatch(/^chat-turn-request:/u);
  });

  it("fails closed without an operator retry when canonical heartbeat recovery fails", async () => {
    const recovery = decisionCommittedRecoveryIdentity();
    const admitOperatorChatTurn = vi.fn(() => {
      throw new DecisionCommittedHeartbeatAdmissionError(recovery);
    });
    const recoveryFailure = new Error("bounded recovery timed out");
    const recover = vi.fn(async () => {
      throw recoveryFailure;
    });
    const owner = new SessionControlRuntimeOwner({ admitOperatorChatTurn } as unknown as SessionControlService);

    await expect(
      owner.admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery(authenticatedOperatorInput(), recover),
    ).rejects.toBe(recoveryFailure);

    expect(admitOperatorChatTurn).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("passes an explicit system actor through the generic admission owner", () => {
    const admitChatTurn = vi.fn((input) => ({
      identity: { admissionId: "a", sessionIncarnationId: "i" },
      requestActor: { actorKind: "system", actorId: input.actor.actorId },
      requestClaim: { runtimeOwnerId: input.runtimeOwnerId, leaseRevision: 1 },
    }));
    const owner = new SessionControlRuntimeOwner({ admitChatTurn } as unknown as SessionControlService);

    const admission = owner.admitChatTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      request: { content: "system work" },
      actor: { actorKind: "system", actorId: "system:scheduler:job-1" },
      idempotencyKey: "admit-1",
      correlationId: "correlation-1",
    });

    expect(admitChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { actorKind: "system", actorId: "system:scheduler:job-1" },
        runtimeOwnerId: expect.stringMatching(/^chat-turn-request:/u),
      }),
    );
    expect(admission.requestActor).toEqual({
      actorKind: "system",
      actorId: "system:scheduler:job-1",
    });
  });

  it("derives one stable request owner for the same internal system occurrence", () => {
    const admitChatTurn = vi.fn((input) => ({
      identity: { admissionId: "a", sessionIncarnationId: "i" },
      requestActor: input.actor,
      requestClaim: { runtimeOwnerId: input.runtimeOwnerId, leaseRevision: 1 },
    }));
    const owner = new SessionControlRuntimeOwner({ admitChatTurn } as unknown as SessionControlService);
    const input = {
      sessionId: "session-1",
      turnId: "turn-1",
      request: { content: "scheduled work" },
      systemActorId: "system:cron:job-1",
      occurrenceId: "run-cron-1",
      idempotencyKey: "admit-1",
      correlationId: "run-cron-1",
    };

    const first = owner.admitSystemChatTurn(input);
    const replay = owner.admitSystemChatTurn(input);

    expect(first.requestClaim?.runtimeOwnerId).toMatch(/^chat-turn-system:[a-f0-9]{64}$/u);
    expect(replay.requestClaim?.runtimeOwnerId).toBe(first.requestClaim?.runtimeOwnerId);
    expect(admitChatTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ actor: { actorKind: "system", actorId: "system:cron:job-1" } }),
    );
  });

  it("forwards storage-owned heartbeat admission and recovery without deriving a second lease owner", () => {
    const admitted = {
      admission: { identity: { admissionId: "heartbeat-admission" } },
      record: { admissionId: "heartbeat-admission" },
    };
    const admitSystemHeartbeatOccurrence = vi.fn(() => admitted);
    const recoverSystemHeartbeatOccurrence = vi.fn(() => ({ disposition: "live" as const }));
    const owner = new SessionControlRuntimeOwner({
      admitSystemHeartbeatOccurrence,
      recoverSystemHeartbeatOccurrence,
    } as unknown as SessionControlService);
    const admissionInput = {
      occurrenceRequest: { occurrenceId: "heartbeat-occurrence" },
      request: { content: "heartbeat" },
    } as never;
    const recoveryInput = {
      occurrence: { occurrenceId: "heartbeat-occurrence" },
      request: { content: "heartbeat" },
    } as never;

    expect(owner.admitSystemHeartbeatOccurrence(admissionInput)).toBe(admitted);
    expect(owner.recoverSystemHeartbeatOccurrence(recoveryInput)).toEqual({ disposition: "live" });
    expect(admitSystemHeartbeatOccurrence).toHaveBeenCalledWith(admissionInput);
    expect(recoverSystemHeartbeatOccurrence).toHaveBeenCalledWith(recoveryInput);
  });

  it("preserves the exact frozen heartbeat occurrence discriminator when reconstructing a durable claim", () => {
    const owner = new SessionControlRuntimeOwner({} as SessionControlService);
    const occurrence = {
      kind: "system_heartbeat_occurrence" as const,
      operation: "chat_system_heartbeat" as const,
      occurrenceId: "occurrence-1",
      correlationId: "occurrence-1",
      claimSha256: "a".repeat(64),
      durableRunId: "run-1",
    };

    const admission = owner.withDurableClaim(
      {
        admissionId: "admission-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        sessionIncarnationId: "incarnation-1",
        turnId: "turn-1",
        aggregateRevision: 1,
        controllerGeneration: 1,
        actorKind: "system",
        actorId: "system-heartbeat",
        operation: "chat_system_heartbeat",
        materialSha256: "b".repeat(64),
      },
      { content: "heartbeat" },
      { actorKind: "system", actorId: "system-heartbeat" },
      { durableRunId: "run-1", claimToken: "claim-1", leaseRevision: 2 },
      occurrence,
    );

    expect(admission.systemHeartbeatOccurrence).toEqual(occurrence);
    expect(Object.isFrozen(admission.systemHeartbeatOccurrence)).toBe(true);
    expect(Object.isFrozen(admission.durableClaim)).toBe(true);
    expect(admission.systemHeartbeatOccurrence).not.toBe(occurrence);
  });

  it("renews the explicit claim and surfaces heartbeat failure before later work", async () => {
    vi.useFakeTimers();
    const failure = new Error("lease lost");
    const renewRequestLease = vi.fn(() => {
      throw failure;
    });
    const owner = new SessionControlRuntimeOwner({ renewRequestLease } as unknown as SessionControlService);
    const admission = {
      identity: {} as never,
      requestClaim: { runtimeOwnerId: "runtime-1", leaseRevision: 1 },
    };
    const handle = owner.startRequestLeaseHeartbeat(admission);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(renewRequestLease).toHaveBeenCalledWith(admission);
    expect(() => handle.assertHealthy()).toThrow(failure);
    handle.stop();
  });

  it("refuses to arm a request-lease heartbeat without an admission to renew", () => {
    vi.useFakeTimers();
    const renewRequestLease = vi.fn();
    const owner = new SessionControlRuntimeOwner({ renewRequestLease } as unknown as SessionControlService);

    expect(() => owner.startRequestLeaseHeartbeat(undefined as never)).toThrow(
      /request-lease heartbeat requires an admission/iu,
    );

    // A rejected call must leave nothing pending: a stray interval outlives the
    // caller and fires against a torn-down admission long after shutdown.
    expect(vi.getTimerCount()).toBe(0);
    expect(renewRequestLease).not.toHaveBeenCalled();
  });

  it("arms no interval for an admission that holds no request lease", async () => {
    vi.useFakeTimers();
    const renewRequestLease = vi.fn();
    const owner = new SessionControlRuntimeOwner({ renewRequestLease } as unknown as SessionControlService);

    const handle = owner.startRequestLeaseHeartbeat({ identity: {} } as unknown as ActiveTurnAdmission);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renewRequestLease).not.toHaveBeenCalled();
    expect(() => handle.assertHealthy()).not.toThrow();
    expect(() => handle.stop()).not.toThrow();
  });

  it("drains expired unbound admissions in bounded stable startup batches", () => {
    const cancelExpiredUnboundTurnAdmissions = vi
      .fn()
      .mockReturnValueOnce(Array.from({ length: 100 }, (_, index) => `admission-${index}`))
      .mockReturnValueOnce(["admission-final"]);

    const cancelled = cancelExpiredUnboundChatTurnAdmissionsOnBoot(
      { cancelExpiredUnboundTurnAdmissions },
      "gateway-startup:correlation-1",
    );

    expect(cancelled).toHaveLength(101);
    expect(cancelExpiredUnboundTurnAdmissions).toHaveBeenCalledTimes(2);
    expect(cancelExpiredUnboundTurnAdmissions).toHaveBeenNthCalledWith(1, {
      actorId: "system:gateway-startup",
      idempotencyKeyPrefix: "gateway-startup:expired-unbound-chat-turn",
      correlationId: "gateway-startup:correlation-1",
      limit: 100,
    });
  });

  it("delegates every controller-protocol operation to the sole control-domain owner unchanged", () => {
    const methods = [
      "createExternalRequest",
      "cancelExternalRequest",
      "handoff",
      "heartbeat",
      "reconnect",
      "release",
      "revoke",
      "getControl",
      "getDetail",
      "listControls",
      "listEvents",
    ] as const;
    const service = Object.fromEntries(
      methods.map((method) => [method, vi.fn(() => `result:${method}`)]),
    ) as unknown as SessionControlService;
    const owner = new SessionControlRuntimeOwner(service);

    for (const method of methods) {
      const command = { marker: method };
      const result = (owner[method] as (input: unknown) => unknown)(command);
      expect(result).toBe(`result:${method}`);
      expect(service[method] as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(command);
      expect(service[method] as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    }
  });
});

function authenticatedOperatorInput() {
  return {
    sessionId: "session-1",
    turnId: "operator-turn-1",
    request: {
      content: "operator work",
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "loopback" as const,
    },
    actorId: "operator-1",
    idempotencyKey: "operator-admission-1",
    correlationId: "operator-turn-1",
    authenticatedOperator: createAuthenticatedOperatorAdmissionContext({
      actorId: "operator-1",
      authActorSource: "loopback",
    }),
  };
}

function decisionCommittedRecoveryIdentity() {
  return {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sessionIncarnationId: "incarnation-1",
    turnId: "heartbeat-turn-1",
    occurrenceId: "heartbeat-occurrence-1",
    heartbeatAdmissionId: "heartbeat-admission-1",
    durableRunId: "heartbeat-run-1",
  };
}
