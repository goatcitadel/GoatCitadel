import { describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import type {
  SessionControlDetailResponse,
  SessionControlEventRecord,
  SessionControlListResponse,
  SessionControlRecord,
  SessionControlRequestRecord,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { SessionControlService } from "./session-control-service.js";
import type { SessionControlExternalCompanionActor, SessionControlOperatorActor } from "./session-control-service.js";

const WORKSPACE = "workspace-1";
const SESSION = "session-1";
const COMPANION = "companion-session-1";
const DEVICE = "device-grant-1";
const CLIENT = "client-1";
const OTHER_CLIENT = "client-2";
const TOKEN_HASH = "a".repeat(64);
const NEW_TOKEN_HASH = "b".repeat(64);
const CORRELATION = "correlation-1";

const CREATED_AT = "2026-07-15T18:00:00.000Z";
const DECIDED_AT = "2026-07-15T18:05:00.000Z";
const EXPIRES_AT = "2026-07-15T18:15:00.000Z";
const HEARTBEAT_AT = "2026-07-15T19:00:00.000Z";
const LEASE_AT = "2026-07-15T19:01:00.000Z";
const RECONNECT_AT = "2026-07-15T19:05:00.000Z";
const UPDATED_AT = "2026-07-15T19:00:00.000Z";

const operatorActor: SessionControlOperatorActor = { actorKind: "operator", actorId: "operator-1" };
const externalActor: SessionControlExternalCompanionActor = {
  actorKind: "external_companion",
  companionSessionId: COMPANION,
  deviceGrantId: DEVICE,
  clientInstanceId: CLIENT,
  principalPurpose: "session_control_client",
};

function operatorControl(overrides: Partial<SessionControlRecord> = {}): SessionControlRecord {
  return {
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    generation: 1,
    ownerKind: "operator",
    leaseState: "operator_active",
    capabilities: [],
    lastEventId: "event-operator-1",
    lastEventReasonCode: "session_initialized",
    updatedAt: UPDATED_AT,
    ...overrides,
  } as SessionControlRecord;
}

function externalControl(overrides: Partial<SessionControlRecord> = {}): SessionControlRecord {
  return {
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    generation: 2,
    ownerKind: "external_companion",
    leaseState: "external_live",
    capabilities: ["send", "read"],
    boundExternalController: {
      companionSessionId: COMPANION,
      clientInstanceId: CLIENT,
      principalPurpose: "session_control_client",
      tokenFingerprint: "abcd1234",
    },
    lastHeartbeatAt: HEARTBEAT_AT,
    leaseExpiresAt: LEASE_AT,
    reconnectExpiresAt: RECONNECT_AT,
    lastEventId: "event-external-1",
    lastEventReasonCode: "handoff",
    updatedAt: UPDATED_AT,
    ...overrides,
  } as SessionControlRecord;
}

function pendingRequest(overrides: Partial<SessionControlRequestRecord> = {}): SessionControlRequestRecord {
  return {
    requestId: "request-1",
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    companionSessionId: COMPANION,
    clientInstanceId: CLIENT,
    tokenFingerprint: "abcd1234",
    requestedCapabilities: ["send", "read"],
    requestedGeneration: 1,
    idempotencyKey: "request-idem-1",
    expiresAt: EXPIRES_AT,
    createdAt: CREATED_AT,
    status: "pending",
    ...overrides,
  } as SessionControlRequestRecord;
}

function activatedRequest(overrides: Partial<SessionControlRequestRecord> = {}): SessionControlRequestRecord {
  return {
    requestId: "request-1",
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    companionSessionId: COMPANION,
    clientInstanceId: CLIENT,
    tokenFingerprint: "abcd1234",
    requestedCapabilities: ["send", "read"],
    requestedGeneration: 1,
    idempotencyKey: "request-idem-1",
    expiresAt: EXPIRES_AT,
    createdAt: CREATED_AT,
    status: "activated",
    activatedGeneration: 2,
    decidedAt: DECIDED_AT,
    decidedByActorId: "operator-1",
    decisionReasonCode: "handoff",
    ...overrides,
  } as SessionControlRequestRecord;
}

function cancelledRequest(overrides: Partial<SessionControlRequestRecord> = {}): SessionControlRequestRecord {
  return {
    requestId: "request-1",
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    companionSessionId: COMPANION,
    clientInstanceId: CLIENT,
    tokenFingerprint: "abcd1234",
    requestedCapabilities: ["send", "read"],
    requestedGeneration: 1,
    idempotencyKey: "request-idem-1",
    expiresAt: EXPIRES_AT,
    createdAt: CREATED_AT,
    status: "cancelled",
    decidedAt: DECIDED_AT,
    decidedByActorId: "operator-1",
    decisionReasonCode: "request_cancelled",
    ...overrides,
  } as SessionControlRequestRecord;
}

type SessionControlFakes = Partial<Record<string, ReturnType<typeof vi.fn>>>;

function buildService(
  fakes: SessionControlFakes = {},
  meta: { workspaceId: string; sessionId: string } | null = { workspaceId: WORKSPACE, sessionId: SESSION },
): {
  service: SessionControlService;
  sessionControls: Record<string, ReturnType<typeof vi.fn>>;
  metaGet: ReturnType<typeof vi.fn>;
} {
  const sessionControls: Record<string, ReturnType<typeof vi.fn>> = {
    createExternalRequest: vi.fn(),
    cancelExternalRequest: vi.fn(),
    handoff: vi.fn(),
    heartbeat: vi.fn(),
    reconnect: vi.fn(),
    release: vi.fn(),
    revoke: vi.fn(),
    getControl: vi.fn(),
    getDetail: vi.fn(),
    listControls: vi.fn(),
    listEvents: vi.fn(),
    ...fakes,
  };
  const metaGet = vi.fn(() => meta ?? undefined);
  const storage = {
    chatSessionMeta: { get: metaGet },
    sessionControls,
    sessionMutationAdmissions: {},
  } as unknown as Storage;
  return { service: new SessionControlService(storage), sessionControls, metaGet };
}

function expectSessionControlCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ConflictError);
  expect((error as ConflictError).details).toMatchObject({ sessionControlCode: code });
}

describe("SessionControlService controller protocol", () => {
  describe("createExternalRequest", () => {
    it("resolves the stored workspace and forwards only content-free companion material to storage", () => {
      const { service, sessionControls, metaGet } = buildService({
        createExternalRequest: vi.fn(() => ({
          disposition: "created",
          request: pendingRequest(),
          control: operatorControl(),
        })),
      });

      const response = service.createExternalRequest({
        actor: externalActor,
        sessionId: SESSION,
        correlationId: CORRELATION,
        input: {
          expectedGeneration: 1,
          clientInstanceId: CLIENT,
          tokenHashSha256: TOKEN_HASH,
          capabilities: ["send", "read"],
          idempotencyKey: "request-idem-1",
        },
      });

      expect(metaGet).toHaveBeenCalledWith(SESSION);
      expect(sessionControls.createExternalRequest).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        companionSessionId: COMPANION,
        deviceGrantId: DEVICE,
        clientInstanceId: CLIENT,
        principalPurpose: "session_control_client",
        expectedGeneration: 1,
        tokenHashSha256: TOKEN_HASH,
        capabilities: ["send", "read"],
        idempotencyKey: "request-idem-1",
        correlationId: CORRELATION,
      });
      expect(response.request.status).toBe("pending");
    });

    it("rejects an operator actor before touching storage", () => {
      const { service, sessionControls, metaGet } = buildService();
      let observed: unknown;
      try {
        service.createExternalRequest({
          actor: operatorActor as unknown as SessionControlExternalCompanionActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          input: {
            expectedGeneration: 1,
            clientInstanceId: CLIENT,
            tokenHashSha256: TOKEN_HASH,
            capabilities: ["send"],
            idempotencyKey: "request-idem-1",
          },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(metaGet).not.toHaveBeenCalled();
      expect(sessionControls.createExternalRequest).not.toHaveBeenCalled();
    });

    it("rejects a companion whose principal purpose is not session_control_client", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.createExternalRequest({
          actor: { ...externalActor, principalPurpose: "general_companion" as never },
          sessionId: SESSION,
          correlationId: CORRELATION,
          input: {
            expectedGeneration: 1,
            clientInstanceId: CLIENT,
            tokenHashSha256: TOKEN_HASH,
            capabilities: ["send"],
            idempotencyKey: "request-idem-1",
          },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(sessionControls.createExternalRequest).not.toHaveBeenCalled();
    });

    it("rejects a body client instance id that does not match the authenticated companion", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.createExternalRequest({
          actor: externalActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          input: {
            expectedGeneration: 1,
            clientInstanceId: OTHER_CLIENT,
            tokenHashSha256: TOKEN_HASH,
            capabilities: ["send"],
            idempotencyKey: "request-idem-1",
          },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(sessionControls.createExternalRequest).not.toHaveBeenCalled();
    });

    it("rejects a read-only capability set before storage", () => {
      const { service, sessionControls } = buildService();
      expect(() =>
        service.createExternalRequest({
          actor: externalActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          input: {
            expectedGeneration: 1,
            clientInstanceId: CLIENT,
            tokenHashSha256: TOKEN_HASH,
            capabilities: ["read"] as never,
            idempotencyKey: "request-idem-1",
          },
        }),
      ).toThrow();
      expect(sessionControls.createExternalRequest).not.toHaveBeenCalled();
    });

    it("fails not-found when the session has no stored metadata", () => {
      const { service, sessionControls } = buildService({}, null);
      expect(() =>
        service.createExternalRequest({
          actor: externalActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          input: {
            expectedGeneration: 1,
            clientInstanceId: CLIENT,
            tokenHashSha256: TOKEN_HASH,
            capabilities: ["send"],
            idempotencyKey: "request-idem-1",
          },
        }),
      ).toThrow(/not found/iu);
      expect(sessionControls.createExternalRequest).not.toHaveBeenCalled();
    });
  });

  describe("handoff", () => {
    it("forwards operator-authorized effective capabilities and maps the activation response", () => {
      const { service, sessionControls } = buildService({
        handoff: vi.fn(() => ({
          disposition: "created",
          request: activatedRequest(),
          control: externalControl({ generation: 2, lastEventReasonCode: "handoff" }),
        })),
      });

      const response = service.handoff({
        actor: operatorActor,
        sessionId: SESSION,
        correlationId: CORRELATION,
        input: {
          requestId: "request-1",
          expectedGeneration: 1,
          effectiveCapabilities: ["send", "read"],
          idempotencyKey: "handoff-idem-1",
        },
      });

      expect(sessionControls.handoff).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        requestId: "request-1",
        expectedGeneration: 1,
        effectiveCapabilities: ["send", "read"],
        operatorActorId: "operator-1",
        idempotencyKey: "handoff-idem-1",
        correlationId: CORRELATION,
      });
      expect(response.control.generation).toBe(2);
      expect(response.request.status).toBe("activated");
    });

    it("rejects a companion actor before storage", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.handoff({
          actor: externalActor as unknown as SessionControlOperatorActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          input: {
            requestId: "request-1",
            expectedGeneration: 1,
            effectiveCapabilities: ["send"],
            idempotencyKey: "handoff-idem-1",
          },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(sessionControls.handoff).not.toHaveBeenCalled();
    });

    it("rejects a read-only effective capability set with a validation error before storage", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.handoff({
          actor: operatorActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          input: {
            requestId: "request-1",
            expectedGeneration: 1,
            effectiveCapabilities: ["read"] as never,
            idempotencyKey: "handoff-idem-1",
          },
        });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(ValidationError);
      expect(sessionControls.handoff).not.toHaveBeenCalled();
    });

    it("rejects an operator-action or unknown effective capability member with a validation error", () => {
      const { service, sessionControls } = buildService();
      const invalidSets = [
        ["send", "handoff"],
        ["send", "revoke"],
        ["send", "bogus"],
      ] as unknown[] as never[];
      for (const effectiveCapabilities of invalidSets) {
        let observed: unknown;
        try {
          service.handoff({
            actor: operatorActor,
            sessionId: SESSION,
            correlationId: CORRELATION,
            input: {
              requestId: "request-1",
              expectedGeneration: 1,
              effectiveCapabilities,
              idempotencyKey: "handoff-idem-1",
            },
          });
        } catch (error) {
          observed = error;
        }
        expect(observed).toBeInstanceOf(ValidationError);
      }
      expect(sessionControls.handoff).not.toHaveBeenCalled();
    });
  });

  describe("heartbeat", () => {
    it("presents the header token hash and maps the live-lease response", () => {
      const { service, sessionControls } = buildService({
        heartbeat: vi.fn(() => ({
          disposition: "created",
          control: externalControl({ generation: 2, lastEventReasonCode: "heartbeat" }),
        })),
      });

      const response = service.heartbeat({
        actor: externalActor,
        sessionId: SESSION,
        correlationId: CORRELATION,
        presentedTokenHashSha256: TOKEN_HASH,
        input: { expectedGeneration: 2, idempotencyKey: "heartbeat-idem-1" },
      });

      expect(sessionControls.heartbeat).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        companionSessionId: COMPANION,
        deviceGrantId: DEVICE,
        clientInstanceId: CLIENT,
        principalPurpose: "session_control_client",
        expectedGeneration: 2,
        tokenHashSha256: TOKEN_HASH,
        idempotencyKey: "heartbeat-idem-1",
        correlationId: CORRELATION,
      });
      expect(response.generation).toBe(2);
      expect(response.control.leaseState).toBe("external_live");
    });

    it("rejects an operator actor for an intrinsic protocol operation", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.heartbeat({
          actor: operatorActor as unknown as SessionControlExternalCompanionActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          presentedTokenHashSha256: TOKEN_HASH,
          input: { expectedGeneration: 2, idempotencyKey: "heartbeat-idem-1" },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(sessionControls.heartbeat).not.toHaveBeenCalled();
    });

    it("rejects a malformed presented control-token hash before storage", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.heartbeat({
          actor: externalActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          presentedTokenHashSha256: "not-a-hash",
          input: { expectedGeneration: 2, idempotencyKey: "heartbeat-idem-1" },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_TOKEN_INVALID");
      expect(sessionControls.heartbeat).not.toHaveBeenCalled();
    });
  });

  describe("reconnect", () => {
    it("rotates the token and maps the superseded/new generation response", () => {
      const { service, sessionControls } = buildService({
        reconnect: vi.fn(() => ({
          disposition: "created",
          control: externalControl({ generation: 3, lastEventReasonCode: "reconnect" }),
        })),
      });

      const response = service.reconnect({
        actor: externalActor,
        sessionId: SESSION,
        correlationId: CORRELATION,
        presentedTokenHashSha256: TOKEN_HASH,
        input: { expectedGeneration: 2, newTokenHashSha256: NEW_TOKEN_HASH, idempotencyKey: "reconnect-idem-1" },
      });

      expect(sessionControls.reconnect).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        companionSessionId: COMPANION,
        deviceGrantId: DEVICE,
        clientInstanceId: CLIENT,
        principalPurpose: "session_control_client",
        expectedGeneration: 2,
        tokenHashSha256: TOKEN_HASH,
        newTokenHashSha256: NEW_TOKEN_HASH,
        idempotencyKey: "reconnect-idem-1",
        correlationId: CORRELATION,
      });
      expect(response.supersededGeneration).toBe(2);
      expect(response.control.generation).toBe(3);
    });

    it("rejects an operator actor for the intrinsic reconnect protocol before storage", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.reconnect({
          actor: operatorActor as unknown as SessionControlExternalCompanionActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          presentedTokenHashSha256: TOKEN_HASH,
          input: { expectedGeneration: 2, newTokenHashSha256: NEW_TOKEN_HASH, idempotencyKey: "reconnect-idem-1" },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(sessionControls.reconnect).not.toHaveBeenCalled();
    });

    it("rejects a malformed presented control-token hash before storage", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.reconnect({
          actor: externalActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          presentedTokenHashSha256: "not-a-hash",
          input: { expectedGeneration: 2, newTokenHashSha256: NEW_TOKEN_HASH, idempotencyKey: "reconnect-idem-1" },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_TOKEN_INVALID");
      expect(sessionControls.reconnect).not.toHaveBeenCalled();
    });
  });

  describe("release", () => {
    it("maps the released generation and the returned operator generation", () => {
      const { service, sessionControls } = buildService({
        release: vi.fn(() => ({
          disposition: "created",
          control: operatorControl({ generation: 3, lastEventReasonCode: "release" }),
        })),
      });

      const response = service.release({
        actor: externalActor,
        sessionId: SESSION,
        correlationId: CORRELATION,
        presentedTokenHashSha256: TOKEN_HASH,
        input: { expectedGeneration: 2, idempotencyKey: "release-idem-1" },
      });

      expect(sessionControls.release).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        companionSessionId: COMPANION,
        deviceGrantId: DEVICE,
        clientInstanceId: CLIENT,
        principalPurpose: "session_control_client",
        expectedGeneration: 2,
        tokenHashSha256: TOKEN_HASH,
        idempotencyKey: "release-idem-1",
        correlationId: CORRELATION,
      });
      expect(response.releasedGeneration).toBe(2);
      expect(response.control.ownerKind).toBe("operator");
    });

    it("rejects an operator actor for the intrinsic release protocol before storage", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.release({
          actor: operatorActor as unknown as SessionControlExternalCompanionActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          presentedTokenHashSha256: TOKEN_HASH,
          input: { expectedGeneration: 2, idempotencyKey: "release-idem-1" },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(sessionControls.release).not.toHaveBeenCalled();
    });

    it("rejects a malformed presented control-token hash before storage", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.release({
          actor: externalActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          presentedTokenHashSha256: "not-a-hash",
          input: { expectedGeneration: 2, idempotencyKey: "release-idem-1" },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_TOKEN_INVALID");
      expect(sessionControls.release).not.toHaveBeenCalled();
    });
  });

  describe("revoke", () => {
    it("revokes the current external controller via the operator revoke op", () => {
      const { service, sessionControls } = buildService({
        revoke: vi.fn(() => ({
          disposition: "created",
          control: operatorControl({ generation: 3, lastEventReasonCode: "emergency_takeover" }),
        })),
      });

      const response = service.revoke({
        actor: operatorActor,
        sessionId: SESSION,
        correlationId: CORRELATION,
        input: {
          target: "current_controller",
          expectedGeneration: 2,
          mode: "emergency_takeover",
          idempotencyKey: "revoke-idem-1",
        },
      });

      expect(sessionControls.revoke).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        expectedGeneration: 2,
        mode: "emergency_takeover",
        operatorActorId: "operator-1",
        idempotencyKey: "revoke-idem-1",
        correlationId: CORRELATION,
      });
      if (response.target !== "current_controller") throw new Error("expected current_controller revoke");
      expect(response.revokedGeneration).toBe(2);
      expect(response.mode).toBe("emergency_takeover");
    });

    it("revokes a pending request via the operator cancel op", () => {
      const { service, sessionControls } = buildService({
        cancelExternalRequest: vi.fn(() => ({
          disposition: "created",
          request: cancelledRequest(),
          control: operatorControl(),
        })),
      });

      const response = service.revoke({
        actor: operatorActor,
        sessionId: SESSION,
        correlationId: CORRELATION,
        input: { target: "request", requestId: "request-1", idempotencyKey: "revoke-idem-1" },
      });

      expect(sessionControls.cancelExternalRequest).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        requestId: "request-1",
        operatorActorId: "operator-1",
        idempotencyKey: "revoke-idem-1",
        correlationId: CORRELATION,
      });
      expect(sessionControls.revoke).not.toHaveBeenCalled();
      if (response.target !== "request") throw new Error("expected request revoke");
      expect(response.request.status).toBe("cancelled");
    });

    it("rejects a companion actor before storage", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.revoke({
          actor: externalActor as unknown as SessionControlOperatorActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          input: {
            target: "current_controller",
            expectedGeneration: 2,
            mode: "revoke",
            idempotencyKey: "revoke-idem-1",
          },
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(sessionControls.revoke).not.toHaveBeenCalled();
    });
  });

  describe("cancelExternalRequest", () => {
    it("cancels a pending request for the operator and returns the cancelled record", () => {
      const { service, sessionControls } = buildService({
        cancelExternalRequest: vi.fn(() => ({
          disposition: "created",
          request: cancelledRequest(),
          control: operatorControl(),
        })),
      });

      const request = service.cancelExternalRequest({
        actor: operatorActor,
        sessionId: SESSION,
        correlationId: CORRELATION,
        requestId: "request-1",
        idempotencyKey: "cancel-idem-1",
      });

      expect(sessionControls.cancelExternalRequest).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        requestId: "request-1",
        operatorActorId: "operator-1",
        idempotencyKey: "cancel-idem-1",
        correlationId: CORRELATION,
      });
      expect(request.status).toBe("cancelled");
    });

    it("rejects a companion actor before storage", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.cancelExternalRequest({
          actor: externalActor as unknown as SessionControlOperatorActor,
          sessionId: SESSION,
          correlationId: CORRELATION,
          requestId: "request-1",
          idempotencyKey: "cancel-idem-1",
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(sessionControls.cancelExternalRequest).not.toHaveBeenCalled();
    });
  });

  describe("getControl", () => {
    it("returns content-free status for the operator", () => {
      const control = externalControl();
      const { service, sessionControls } = buildService({ getControl: vi.fn(() => control) });
      expect(service.getControl({ actor: operatorActor, sessionId: SESSION })).toBe(control);
      expect(sessionControls.getControl).toHaveBeenCalledWith(WORKSPACE, SESSION);
    });

    it("returns status to the bound external controller without a delegated read capability", () => {
      const control = externalControl({ capabilities: ["send"] });
      const { service } = buildService({ getControl: vi.fn(() => control) });
      expect(service.getControl({ actor: externalActor, sessionId: SESSION })).toBe(control);
    });

    it("returns status to a companion that owns a pending request while the operator still owns the session", () => {
      const control = operatorControl();
      const { service } = buildService({
        getControl: vi.fn(() => control),
        getDetail: vi.fn(() => ({ control, pendingRequests: [pendingRequest()] }) as SessionControlDetailResponse),
      });
      expect(service.getControl({ actor: externalActor, sessionId: SESSION })).toBe(control);
    });

    it("denies a companion that is neither the bound controller nor a pending requester", () => {
      const control = operatorControl();
      const { service } = buildService({
        getControl: vi.fn(() => control),
        getDetail: vi.fn(() => ({ control, pendingRequests: [] }) as SessionControlDetailResponse),
      });
      let observed: unknown;
      try {
        service.getControl({ actor: externalActor, sessionId: SESSION });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_CAPABILITY_DENIED");
    });
  });

  describe("getDetail", () => {
    it("returns every pending request to the operator", () => {
      const detail = {
        control: operatorControl(),
        pendingRequests: [
          pendingRequest(),
          pendingRequest({
            requestId: "request-2",
            companionSessionId: "companion-session-2",
            clientInstanceId: OTHER_CLIENT,
          }),
        ],
      } as SessionControlDetailResponse;
      const { service } = buildService({ getDetail: vi.fn(() => detail) });
      expect(service.getDetail({ actor: operatorActor, sessionId: SESSION })).toBe(detail);
    });

    it("filters pending requests to the requesting companion", () => {
      const own = pendingRequest();
      const foreign = pendingRequest({
        requestId: "request-2",
        companionSessionId: "companion-session-2",
        clientInstanceId: OTHER_CLIENT,
      });
      const detail = { control: operatorControl(), pendingRequests: [own, foreign] } as SessionControlDetailResponse;
      const { service } = buildService({ getDetail: vi.fn(() => detail) });
      const scoped = service.getDetail({ actor: externalActor, sessionId: SESSION });
      expect(scoped.pendingRequests).toHaveLength(1);
      expect(scoped.pendingRequests[0]!.requestId).toBe("request-1");
    });

    it("denies a companion with no relationship to the session", () => {
      const detail = { control: operatorControl(), pendingRequests: [] } as SessionControlDetailResponse;
      const { service } = buildService({ getDetail: vi.fn(() => detail) });
      let observed: unknown;
      try {
        service.getDetail({ actor: externalActor, sessionId: SESSION });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_CAPABILITY_DENIED");
    });
  });

  describe("listControls", () => {
    it("lists workspace controls for the operator", () => {
      const list = { items: [externalControl()] } as SessionControlListResponse;
      const { service, sessionControls } = buildService({ listControls: vi.fn(() => list) });
      expect(service.listControls({ actor: operatorActor, workspaceId: WORKSPACE, limit: 25 })).toBe(list);
      expect(sessionControls.listControls).toHaveBeenCalledWith(WORKSPACE, 25);
    });

    it("denies a companion from enumerating a workspace", () => {
      const { service, sessionControls } = buildService();
      let observed: unknown;
      try {
        service.listControls({
          actor: externalActor as unknown as SessionControlOperatorActor,
          workspaceId: WORKSPACE,
        });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(sessionControls.listControls).not.toHaveBeenCalled();
    });
  });

  describe("listEvents", () => {
    it("returns control history for the operator", () => {
      const events: SessionControlEventRecord[] = [];
      const { service, sessionControls } = buildService({ listEvents: vi.fn(() => events) });
      expect(service.listEvents({ actor: operatorActor, sessionId: SESSION, limit: 10 })).toBe(events);
      expect(sessionControls.listEvents).toHaveBeenCalledWith(WORKSPACE, SESSION, { limit: 10 });
    });

    it("returns control history to a bound controller that holds the read capability", () => {
      const events: SessionControlEventRecord[] = [];
      const { service, sessionControls } = buildService({
        getControl: vi.fn(() => externalControl({ capabilities: ["send", "read"] })),
        listEvents: vi.fn(() => events),
      });
      expect(service.listEvents({ actor: externalActor, sessionId: SESSION })).toBe(events);
      expect(sessionControls.listEvents).toHaveBeenCalledWith(WORKSPACE, SESSION, {});
    });

    it("denies a send-only bound controller from reading control history", () => {
      const { service, sessionControls } = buildService({
        getControl: vi.fn(() => externalControl({ capabilities: ["send"] })),
      });
      let observed: unknown;
      try {
        service.listEvents({ actor: externalActor, sessionId: SESSION });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_CAPABILITY_DENIED");
      expect(sessionControls.listEvents).not.toHaveBeenCalled();
    });

    it("denies a companion that is not the bound controller", () => {
      const { service } = buildService({
        getControl: vi.fn(() =>
          externalControl({
            boundExternalController: {
              companionSessionId: "companion-session-2",
              clientInstanceId: OTHER_CLIENT,
              principalPurpose: "session_control_client",
              tokenFingerprint: "abcd1234",
            },
          }),
        ),
      });
      let observed: unknown;
      try {
        service.listEvents({ actor: externalActor, sessionId: SESSION });
      } catch (error) {
        observed = error;
      }
      expectSessionControlCode(observed, "SESSION_CONTROL_CAPABILITY_DENIED");
    });
  });

  describe("read purpose-gate ordering (existence oracle)", () => {
    const wrongPurposeCompanion = {
      ...externalActor,
      principalPurpose: "general_companion",
    } as unknown as SessionControlExternalCompanionActor;

    it("rejects a wrong-purpose companion on every read before any session-existence read", () => {
      const reads: Array<(service: SessionControlService) => unknown> = [
        (service) => service.getControl({ actor: wrongPurposeCompanion, sessionId: SESSION }),
        (service) => service.getDetail({ actor: wrongPurposeCompanion, sessionId: SESSION }),
        (service) => service.listEvents({ actor: wrongPurposeCompanion, sessionId: SESSION }),
      ];
      for (const read of reads) {
        for (const meta of [{ workspaceId: WORKSPACE, sessionId: SESSION }, null]) {
          const { service, sessionControls, metaGet } = buildService({}, meta);
          let observed: unknown;
          try {
            read(service);
          } catch (error) {
            observed = error;
          }
          expectSessionControlCode(observed, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
          expect(metaGet).not.toHaveBeenCalled();
          expect(sessionControls.getControl).not.toHaveBeenCalled();
          expect(sessionControls.getDetail).not.toHaveBeenCalled();
        }
      }
    });

    it("gives a wrong-purpose companion an identical getControl rejection whether or not the session exists", () => {
      const existing = buildService();
      let existingError: unknown;
      try {
        existing.service.getControl({ actor: wrongPurposeCompanion, sessionId: SESSION });
      } catch (error) {
        existingError = error;
      }

      const missing = buildService({}, null);
      let missingError: unknown;
      try {
        missing.service.getControl({ actor: wrongPurposeCompanion, sessionId: "nonexistent-session" });
      } catch (error) {
        missingError = error;
      }

      expectSessionControlCode(existingError, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expectSessionControlCode(missingError, "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED");
      expect(existing.metaGet).not.toHaveBeenCalled();
      expect(missing.metaGet).not.toHaveBeenCalled();
      expect(existing.sessionControls.getControl).not.toHaveBeenCalled();
      expect(missing.sessionControls.getControl).not.toHaveBeenCalled();
    });
  });
});
