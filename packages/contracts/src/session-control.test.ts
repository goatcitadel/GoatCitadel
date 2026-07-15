import { describe, expect, it } from "vitest";
import {
  EXTERNAL_SESSION_CONTROL_CAPABILITIES,
  OPERATOR_SESSION_CONTROL_ACTIONS,
  SESSION_CONTROL_CONFLICT_CODES,
  SESSION_CONTROL_GENERATION_HEADER,
  SESSION_CONTROL_HEARTBEAT_CADENCE_SECONDS,
  SESSION_CONTROL_LEASE_STATES,
  SESSION_CONTROL_LIVE_LEASE_SECONDS,
  SESSION_CONTROL_MAX_LIST_ITEMS,
  SESSION_CONTROL_OPERATIONS,
  SESSION_CONTROL_OWNER_KINDS,
  SESSION_CONTROL_PROTOCOL_OPERATIONS,
  SESSION_CONTROL_RECONNECT_WINDOW_SECONDS,
  SESSION_CONTROL_REQUEST_STATUSES,
  SESSION_CONTROL_TOKEN_HEADER,
  SESSION_CONTROL_TOKEN_TTL_SECONDS,
  assertSessionControlEffectiveCapabilities,
  assertSessionControlHandoffTransition,
  assertSessionControlHeartbeatTransition,
  assertSessionControlReconnectTransition,
  assertSessionControlReleaseTransition,
  assertSessionControlRevokeTransition,
  normalizeExternalSessionControlCapabilities,
  normalizeSessionControlTokenHashSha256,
  parseSessionControlDetailResponse,
  parseSessionControlEventRecord,
  parseSessionControlGenerationHeader,
  parseSessionControlHandoffInput,
  parseSessionControlHandoffResponse,
  parseSessionControlHeartbeatInput,
  parseSessionControlHeartbeatResponse,
  parseSessionControlListResponse,
  parseSessionControlReconnectInput,
  parseSessionControlReconnectResponse,
  parseSessionControlRecord,
  parseSessionControlReleaseInput,
  parseSessionControlReleaseResponse,
  parseSessionControlRequestInput,
  parseSessionControlRequestRecord,
  parseSessionControlRequestResponse,
  parseSessionControlRevokeInput,
  parseSessionControlRevokeResponse,
  sessionControlTokenFingerprint,
  type ExternalSessionControlCapabilitySet,
  type SessionControlRecord,
} from "./session-control.js";

const TOKEN_HASH = "a".repeat(64);
const NOW = "2026-07-14T12:00:00.000Z";

function operatorControl(
  generation = 3,
  lastEventReasonCode: "release" | "operator_revoke" | "emergency_takeover" | "session_initialized" = "release",
) {
  return {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    generation,
    ownerKind: "operator" as const,
    leaseState: "operator_active" as const,
    capabilities: [] as const,
    lastEventId: "event-operator",
    lastEventReasonCode,
    updatedAt: NOW,
  };
}

function externalControl(
  generation = 2,
  lastEventReasonCode: "handoff" | "heartbeat" | "lease_stale" | "reconnect" = "handoff",
) {
  return {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    generation,
    ownerKind: "external_companion" as const,
    leaseState: "external_live" as const,
    capabilities: ["send", "read"] as const,
    boundExternalController: {
      companionSessionId: "companion-a",
      clientInstanceId: "client-a",
      principalPurpose: "session_control_client" as const,
      tokenFingerprint: "aaaaaaaa",
    },
    lastHeartbeatAt: NOW,
    leaseExpiresAt: "2026-07-14T12:01:00.000Z",
    reconnectExpiresAt: "2026-07-14T12:05:00.000Z",
    lastEventId: "event-external",
    lastEventReasonCode,
    updatedAt: NOW,
  };
}

function requestBase() {
  return {
    requestId: "request-a",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    companionSessionId: "companion-a",
    clientInstanceId: "client-a",
    tokenFingerprint: "aaaaaaaa",
    requestedCapabilities: ["send", "read"] as const,
    requestedGeneration: 1,
    idempotencyKey: "request-idempotency-a",
    expiresAt: "2026-07-14T12:15:00.000Z",
    createdAt: NOW,
  };
}

const pendingRequest = () => ({ ...requestBase(), status: "pending" as const });
const activatedRequest = () => ({
  ...requestBase(),
  status: "activated" as const,
  activatedGeneration: 2,
  decidedAt: NOW,
  decidedByActorId: "operator-a",
  decisionReasonCode: "handoff" as const,
});
const cancelledRequest = () => ({
  ...requestBase(),
  status: "cancelled" as const,
  decidedAt: NOW,
  decidedByActorId: "operator-a",
  decisionReasonCode: "request_cancelled" as const,
});

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "event-a",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    previousGeneration: 1,
    nextGeneration: 2,
    previousOwnerKind: "operator",
    nextOwnerKind: "external_companion",
    previousLeaseState: "operator_active",
    nextLeaseState: "external_live",
    reasonCode: "handoff",
    actorKind: "operator",
    actorId: "operator-a",
    correlationId: "correlation-a",
    createdAt: NOW,
    ...overrides,
  };
}

function _assertSessionControlProjectionTypes(record: SessionControlRecord): void {
  if (record.ownerKind !== "external_companion") return;
  // @ts-expect-error Parsed authority is deeply readonly.
  record.generation = 999;
  type ExternalRecord = Extract<SessionControlRecord, { ownerKind: "external_companion" }>;
  // @ts-expect-error External projected capabilities cannot be empty.
  const _emptyCapabilities: ExternalRecord["capabilities"] = [];
  // @ts-expect-error External projected capabilities cannot be read-only.
  const _readOnlyCapabilities: ExternalRecord["capabilities"] = ["read"];
  // @ts-expect-error External projected capabilities cannot contain duplicates.
  const _duplicateCapabilities: ExternalRecord["capabilities"] = ["send", "send"];
}

describe("session control contract vocabulary", () => {
  it("keeps authority partitions disjoint and exhaustive", () => {
    const partitions = [
      new Set(EXTERNAL_SESSION_CONTROL_CAPABILITIES),
      new Set(SESSION_CONTROL_PROTOCOL_OPERATIONS),
      new Set(OPERATOR_SESSION_CONTROL_ACTIONS),
    ];
    for (let left = 0; left < partitions.length; left += 1) {
      for (let right = left + 1; right < partitions.length; right += 1) {
        expect([...partitions[left]!].filter((value) => partitions[right]!.has(value as never))).toEqual([]);
      }
    }
    expect(new Set(partitions.flatMap((partition) => [...partition]))).toEqual(new Set(SESSION_CONTROL_OPERATIONS));
    expect(SESSION_CONTROL_OWNER_KINDS).toEqual(["operator", "external_companion"]);
    expect(SESSION_CONTROL_LEASE_STATES).toHaveLength(7);
    expect(SESSION_CONTROL_REQUEST_STATUSES).toHaveLength(5);
    expect(SESSION_CONTROL_CONFLICT_CODES).toHaveLength(8);
  });

  it("freezes exact headers, bounds, and liveness timings", () => {
    expect(SESSION_CONTROL_TOKEN_HEADER).toBe("X-GoatCitadel-Session-Control-Token");
    expect(SESSION_CONTROL_GENERATION_HEADER).toBe("X-GoatCitadel-Control-Generation");
    expect(SESSION_CONTROL_MAX_LIST_ITEMS).toBe(200);
    expect({
      tokenTtl: SESSION_CONTROL_TOKEN_TTL_SECONDS,
      heartbeat: SESSION_CONTROL_HEARTBEAT_CADENCE_SECONDS,
      liveLease: SESSION_CONTROL_LIVE_LEASE_SECONDS,
      reconnect: SESSION_CONTROL_RECONNECT_WINDOW_SECONDS,
    }).toEqual({ tokenTtl: 900, heartbeat: 15, liveLease: 60, reconnect: 300 });
  });
});

describe("secret-safe input validation", () => {
  it("accepts and freezes only canonical send-owning capability sets", () => {
    const sendOnly = normalizeExternalSessionControlCapabilities(["send"]);
    const sendRead = normalizeExternalSessionControlCapabilities(["read", "send"]);
    const _exactSendOnly: ExternalSessionControlCapabilitySet = sendOnly;
    const _exactSendRead: ExternalSessionControlCapabilitySet = sendRead;
    expect(sendOnly).toEqual(["send"]);
    expect(sendRead).toEqual(["send", "read"]);
    expect(Object.isFrozen(sendOnly)).toBe(true);
    expect(Object.isFrozen(sendRead)).toBe(true);
    expect(assertSessionControlEffectiveCapabilities(["send", "read"], ["send"])).toEqual(["send"]);
    expect(() => assertSessionControlEffectiveCapabilities(["send"], ["send", "read"])).toThrow(
      /effective capability set is invalid/u,
    );
    for (const invalid of [
      [],
      ["read"],
      ["send", "send"],
      ["send", "heartbeat"],
      ["send", "handoff"],
      ["send", "revoke"],
      ["send", "unknown"],
      ["send", 1],
      null,
    ]) {
      expect(() => normalizeExternalSessionControlCapabilities(invalid)).toThrow(/capability set is invalid/u);
    }
  });

  it("never exposes attacker-controlled keys or values from public parsers", () => {
    const secret = "apiKey_SUPER_SECRET_abc123";
    const baseRequest = {
      expectedGeneration: 1,
      clientInstanceId: "client-a",
      tokenHashSha256: TOKEN_HASH,
      capabilities: ["send"],
      idempotencyKey: "request-a",
    };
    const request = {
      ...baseRequest,
      [secret]: "private-value",
    };
    const nestedResponse = { generation: 2, control: { ...externalControl(), [secret]: "private-value" } };
    const accessorRequest = { ...baseRequest };
    Object.defineProperty(accessorRequest, "tokenHashSha256", {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    const proxyRequest = new Proxy(
      { ...request, [secret]: undefined },
      {
        ownKeys: () => {
          throw new Error(secret);
        },
      },
    );
    class RequestEnvelope {
      expectedGeneration = 1;
      clientInstanceId = "client-a";
      tokenHashSha256 = TOKEN_HASH;
      capabilities = ["send"];
      idempotencyKey = "request-a";
    }
    const nullPrototypeRequest = Object.assign(Object.create(null), request) as unknown;
    for (const action of [
      () => parseSessionControlRequestInput(request),
      () => parseSessionControlHeartbeatResponse(nestedResponse),
      () => parseSessionControlRecord({ ...operatorControl(), ownerKind: secret }),
      () => normalizeExternalSessionControlCapabilities(["send", secret]),
      () => normalizeSessionControlTokenHashSha256(secret),
      () => parseSessionControlRequestInput(accessorRequest),
      () => parseSessionControlRequestInput(proxyRequest),
      () => parseSessionControlRequestInput(new RequestEnvelope()),
      () => parseSessionControlRequestInput(nullPrototypeRequest),
    ]) {
      let message = "";
      try {
        action();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("private-value");
    }
  });

  it("requires a lowercase SHA-256 hash and exposes only its last eight characters", () => {
    expect(normalizeSessionControlTokenHashSha256(TOKEN_HASH)).toBe(TOKEN_HASH);
    expect(sessionControlTokenFingerprint(TOKEN_HASH)).toBe("aaaaaaaa");
    for (const invalid of ["A".repeat(64), "a".repeat(63), `${"a".repeat(64)} `, "token", null]) {
      expect(() => normalizeSessionControlTokenHashSha256(invalid)).toThrow(/token hash is invalid/u);
    }
  });

  it("parses only canonical positive decimal generation headers", () => {
    expect(parseSessionControlGenerationHeader("1")).toBe(1);
    expect(parseSessionControlGenerationHeader(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    for (const invalid of [undefined, 1, "", "0", "-1", "+1", " 1", "1 ", "01", "1.0", "1e2", "9007199254740992"]) {
      expect(() => parseSessionControlGenerationHeader(invalid)).toThrow(/generation header is invalid/u);
    }
  });

  it("rejects body-claimed identity and freezes exact mutation inputs", () => {
    const request = {
      expectedGeneration: 1,
      clientInstanceId: "client-a",
      tokenHashSha256: TOKEN_HASH,
      capabilities: ["send"],
      idempotencyKey: "request-a",
    };
    expect(parseSessionControlRequestInput(request).expectedGeneration).toBe(1);
    for (const claimed of ["actorId", "workspaceId", "purpose", "sessionId", "companionSessionId", "grantId"]) {
      expect(() => parseSessionControlRequestInput({ ...request, [claimed]: "forged" })).toThrow(/request is invalid/u);
    }
    expect(
      parseSessionControlHandoffInput({
        requestId: "request-a",
        expectedGeneration: 1,
        effectiveCapabilities: ["send"],
        idempotencyKey: "handoff-a",
      }).effectiveCapabilities,
    ).toEqual(["send"]);
    expect(parseSessionControlHeartbeatInput({ expectedGeneration: 2, idempotencyKey: "heartbeat-a" })).toBeTruthy();
    expect(
      parseSessionControlReconnectInput({
        expectedGeneration: 2,
        newTokenHashSha256: TOKEN_HASH,
        idempotencyKey: "reconnect-a",
      }),
    ).toBeTruthy();
    expect(parseSessionControlReleaseInput({ expectedGeneration: 2, idempotencyKey: "release-a" })).toBeTruthy();
    expect(
      parseSessionControlRevokeInput({
        target: "current_controller",
        expectedGeneration: 2,
        mode: "emergency_takeover",
        idempotencyKey: "revoke-a",
      }),
    ).toBeTruthy();
    expect(() =>
      parseSessionControlRevokeInput({
        target: "request",
        requestId: "request-a",
        reasonCode: "auth_revoked",
        idempotencyKey: "revoke-a",
      }),
    ).toThrow(/revoke is invalid/u);
  });
});

describe("authority and request projections", () => {
  it("accepts only exact operator-active or bound external-live/stale controls", () => {
    expect(parseSessionControlRecord(operatorControl()).ownerKind).toBe("operator");
    const parsedExternal = parseSessionControlRecord(externalControl());
    expect(parsedExternal.ownerKind).toBe("external_companion");
    if (parsedExternal.ownerKind !== "external_companion") throw new Error("Expected an external controller.");
    expect(Object.isFrozen(parsedExternal)).toBe(true);
    expect(Object.isFrozen(parsedExternal.boundExternalController)).toBe(true);
    expect(() => {
      (parsedExternal as { generation: number }).generation = 999;
    }).toThrow(TypeError);
    expect(() => {
      (parsedExternal.boundExternalController as { clientInstanceId: string }).clientInstanceId = "forged";
    }).toThrow(TypeError);
    expect(
      parseSessionControlRecord({ ...externalControl(2, "lease_stale"), leaseState: "external_stale" }).leaseState,
    ).toBe("external_stale");
    for (const invalid of [
      { ...operatorControl(), leaseState: "external_live" },
      { ...operatorControl(), boundExternalController: externalControl().boundExternalController },
      { ...externalControl(), capabilities: [] },
      { ...externalControl(), capabilities: ["read"] },
      { ...externalControl(), boundExternalController: undefined },
      { ...externalControl(), leaseExpiresAt: undefined },
      { ...externalControl(), leaseState: "released" },
      { ...externalControl(), leaseExpiresAt: "2026-07-14T12:00:59.999Z" },
      { ...externalControl(), leaseExpiresAt: "2026-07-14T12:01:00.001Z" },
      { ...externalControl(), reconnectExpiresAt: "2026-07-14T12:04:59.999Z" },
      { ...externalControl(), reconnectExpiresAt: "2026-07-14T12:05:00.001Z" },
      {
        ...externalControl(),
        lastHeartbeatAt: "2026-07-14T12:06:00.000Z",
        leaseExpiresAt: "2026-07-14T12:01:00.000Z",
        reconnectExpiresAt: "2026-07-14T12:05:00.000Z",
      },
      { ...externalControl(), updatedAt: "2026-07-14T11:59:59.000Z" },
      operatorControl(2, "release"),
      externalControl(2, "reconnect"),
    ]) {
      expect(() => parseSessionControlRecord(invalid)).toThrow(/record is invalid/u);
    }
  });

  it("binds pending and terminal request fields to the observed generation", () => {
    expect(parseSessionControlRequestRecord(pendingRequest()).status).toBe("pending");
    expect(parseSessionControlRequestRecord(activatedRequest()).status).toBe("activated");
    expect(() => parseSessionControlRequestRecord({ ...pendingRequest(), decidedAt: NOW })).toThrow(
      /record is invalid/u,
    );
    expect(() => parseSessionControlRequestRecord({ ...activatedRequest(), decidedAt: undefined })).toThrow(
      /record is invalid/u,
    );
    expect(() => parseSessionControlRequestRecord({ ...activatedRequest(), activatedGeneration: 3 })).toThrow(
      /record is invalid/u,
    );
    expect(() =>
      parseSessionControlRequestRecord({ ...activatedRequest(), decidedAt: activatedRequest().expiresAt }),
    ).toThrow(/record is invalid/u);
    expect(() =>
      parseSessionControlRequestRecord({ ...pendingRequest(), expiresAt: "2026-07-14T11:59:59.000Z" }),
    ).toThrow(/record is invalid/u);
    expect(() =>
      parseSessionControlRequestRecord({ ...activatedRequest(), decidedAt: "2026-07-14T12:16:00.000Z" }),
    ).toThrow(/record is invalid/u);
    expect(() =>
      parseSessionControlRequestRecord({
        ...requestBase(),
        status: "rejected",
        decidedAt: NOW,
        decidedByActorId: "operator-a",
        decisionReasonCode: "session_deleted",
      }),
    ).toThrow(/record is invalid/u);
    expect(() =>
      parseSessionControlRequestRecord({ ...pendingRequest(), requestedCapabilities: ["read", "send"] }),
    ).toThrow(/record is invalid/u);
  });
});

describe("event and response transition truth", () => {
  it("enforces the exact reason, owner, actor, and generation matrix", () => {
    expect(
      parseSessionControlEventRecord(
        event({
          previousGeneration: undefined,
          previousOwnerKind: undefined,
          previousLeaseState: undefined,
          nextGeneration: 1,
          nextOwnerKind: "operator",
          nextLeaseState: "operator_active",
          reasonCode: "session_initialized",
          actorKind: "system",
        }),
      ).reasonCode,
    ).toBe("session_initialized");
    expect(parseSessionControlEventRecord(event()).reasonCode).toBe("handoff");
    expect(() => parseSessionControlEventRecord(event({ previousOwnerKind: "external_companion" }))).toThrow(
      /event record is invalid/u,
    );
    expect(() =>
      parseSessionControlEventRecord(
        event({
          previousGeneration: 2,
          nextGeneration: 2,
          previousOwnerKind: "external_companion",
          nextOwnerKind: "external_companion",
          previousLeaseState: "external_live",
          nextLeaseState: "external_live",
          reasonCode: "request_created",
          actorKind: "external_companion",
        }),
      ),
    ).toThrow(/event record is invalid/u);
    for (const impossibleExternalGenerationOne of [
      event({
        previousGeneration: 1,
        nextGeneration: 1,
        previousOwnerKind: "external_companion",
        nextOwnerKind: "external_companion",
        previousLeaseState: "external_live",
        nextLeaseState: "external_live",
        reasonCode: "heartbeat",
        actorKind: "external_companion",
      }),
      event({
        previousGeneration: 1,
        nextGeneration: 2,
        previousOwnerKind: "external_companion",
        nextOwnerKind: "external_companion",
        previousLeaseState: "external_stale",
        nextLeaseState: "external_live",
        reasonCode: "reconnect",
        actorKind: "external_companion",
      }),
      event({
        previousGeneration: 1,
        nextGeneration: 2,
        previousOwnerKind: "external_companion",
        nextOwnerKind: "operator",
        previousLeaseState: "external_live",
        nextLeaseState: "operator_active",
        reasonCode: "release",
        actorKind: "external_companion",
      }),
    ]) {
      expect(() => parseSessionControlEventRecord(impossibleExternalGenerationOne)).toThrow(/event record is invalid/u);
    }
    expect(() =>
      parseSessionControlEventRecord(
        event({
          previousGeneration: 2,
          nextGeneration: 2,
          previousOwnerKind: "operator",
          nextOwnerKind: "operator",
          previousLeaseState: "deleted",
          nextLeaseState: "deleted",
          reasonCode: "request_cancelled",
          actorKind: "operator",
        }),
      ),
    ).toThrow(/event record is invalid/u);
    expect(() =>
      parseSessionControlEventRecord(
        event({
          previousGeneration: 2,
          nextGeneration: 2,
          previousOwnerKind: "external_companion",
          nextOwnerKind: "external_companion",
          previousLeaseState: "operator_active",
          nextLeaseState: "operator_active",
          reasonCode: "mutation_denied",
          actorKind: "system",
        }),
      ),
    ).toThrow(/event record is invalid/u);
    expect(
      parseSessionControlEventRecord(
        event({
          previousGeneration: 2,
          nextGeneration: 3,
          previousOwnerKind: "external_companion",
          nextOwnerKind: "external_companion",
          previousLeaseState: "external_stale",
          nextLeaseState: "external_live",
          reasonCode: "reconnect",
          actorKind: "external_companion",
        }),
      ).nextGeneration,
    ).toBe(3);
    expect(() =>
      parseSessionControlEventRecord(
        event({
          previousGeneration: 2,
          nextGeneration: 2,
          previousOwnerKind: "external_companion",
          nextOwnerKind: "external_companion",
          previousLeaseState: "external_live",
          nextLeaseState: "external_live",
          reasonCode: "heartbeat",
          actorKind: "system",
        }),
      ),
    ).toThrow(/event record is invalid/u);
    expect(
      parseSessionControlEventRecord(
        event({
          previousGeneration: 2,
          nextGeneration: 2,
          previousOwnerKind: "operator",
          nextOwnerKind: undefined,
          previousLeaseState: "operator_active",
          nextLeaseState: "deleted",
          reasonCode: "session_deleted",
          actorKind: "operator",
        }),
      ).nextOwnerKind,
    ).toBeUndefined();
    expect(() =>
      parseSessionControlEventRecord(
        event({
          previousGeneration: 2,
          nextGeneration: 2,
          previousOwnerKind: "external_companion",
          nextOwnerKind: undefined,
          previousLeaseState: "external_live",
          nextLeaseState: "deleted",
          reasonCode: "session_deleted",
          actorKind: "operator",
        }),
      ),
    ).toThrow(/event record is invalid/u);
    expect(
      parseSessionControlEventRecord(
        event({
          previousGeneration: 2,
          nextGeneration: 3,
          previousOwnerKind: undefined,
          nextOwnerKind: "operator",
          previousLeaseState: "deleted",
          nextLeaseState: "operator_active",
          reasonCode: "session_reactivated",
          actorKind: "operator",
        }),
      ).nextGeneration,
    ).toBe(3);
  });

  it("binds every response to its exact request, owner, and generation outcome", () => {
    expect(parseSessionControlRequestResponse({ request: pendingRequest() }).request.status).toBe("pending");
    expect(
      parseSessionControlHandoffResponse({ request: activatedRequest(), control: externalControl() }),
    ).toBeTruthy();
    expect(
      parseSessionControlHeartbeatResponse({ generation: 2, control: externalControl(2, "heartbeat") }).control
        .leaseState,
    ).toBe("external_live");
    expect(
      parseSessionControlReconnectResponse({ supersededGeneration: 2, control: externalControl(3, "reconnect") }),
    ).toBeTruthy();
    expect(parseSessionControlReleaseResponse({ releasedGeneration: 2, control: operatorControl() })).toBeTruthy();
    const requestRevoke = parseSessionControlRevokeResponse({ target: "request", request: cancelledRequest() });
    expect(requestRevoke.target).toBe("request");
    if (requestRevoke.target !== "request") throw new Error("Expected a request-target revoke response.");
    expect(requestRevoke.request.status).toBe("cancelled");
    expect(
      parseSessionControlRevokeResponse({
        target: "current_controller",
        revokedGeneration: 2,
        mode: "revoke",
        control: operatorControl(3, "operator_revoke"),
      }),
    ).toBeTruthy();

    expect(() => parseSessionControlHandoffResponse({ request: pendingRequest(), control: externalControl() })).toThrow(
      /handoff response is invalid/u,
    );
    expect(() =>
      parseSessionControlHandoffResponse({
        request: { ...activatedRequest(), requestedCapabilities: ["send"] },
        control: externalControl(),
      }),
    ).toThrow(/handoff response is invalid/u);
    expect(() =>
      parseSessionControlHeartbeatResponse({ generation: 99, control: externalControl(2, "heartbeat") }),
    ).toThrow(/heartbeat response is invalid/u);
    expect(parseSessionControlHeartbeatResponse({ generation: 2, control: externalControl() })).toBeTruthy();
    expect(() =>
      parseSessionControlReconnectResponse({ supersededGeneration: 99, control: externalControl(3, "reconnect") }),
    ).toThrow(/reconnect response is invalid/u);
    expect(() => parseSessionControlReleaseResponse({ releasedGeneration: 1, control: operatorControl() })).toThrow(
      /release response is invalid/u,
    );
    expect(() =>
      parseSessionControlReleaseResponse({ releasedGeneration: 2, control: operatorControl(3, "operator_revoke") }),
    ).toThrow(/release response is invalid/u);
    expect(() =>
      parseSessionControlRevokeResponse({
        target: "current_controller",
        revokedGeneration: 99,
        mode: "revoke",
        control: operatorControl(3, "operator_revoke"),
      }),
    ).toThrow(/revoke response is invalid/u);
    expect(() =>
      parseSessionControlRevokeResponse({
        target: "current_controller",
        revokedGeneration: 2,
        mode: "emergency_takeover",
        control: operatorControl(3, "operator_revoke"),
      }),
    ).toThrow(/revoke response is invalid/u);
  });

  it("keeps heartbeat at N and every ownership transition at exactly N plus one", () => {
    expect(() => assertSessionControlHeartbeatTransition(7, 7)).not.toThrow();
    expect(() => assertSessionControlHeartbeatTransition(7, 8)).toThrow(/retain/u);
    for (const assertion of [
      assertSessionControlReconnectTransition,
      assertSessionControlHandoffTransition,
      assertSessionControlReleaseTransition,
      assertSessionControlRevokeTransition,
    ]) {
      expect(() => assertion(7, 8)).not.toThrow();
      expect(() => assertion(7, 7)).toThrow(/exactly once/u);
      expect(() => assertion(7, 9)).toThrow(/exactly once/u);
      expect(() => assertion(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(/exactly once/u);
    }
  });
});

describe("content-free bounded projections", () => {
  it("rejects content, approval, secret, and full-hash fields recursively", () => {
    const forbiddenFields = [
      "message",
      "prompt",
      "content",
      "parts",
      "attachments",
      "toolResult",
      "approvalToken",
      "token",
      "tokenHashSha256",
    ];
    for (const field of forbiddenFields) {
      expect(() =>
        parseSessionControlHeartbeatResponse({
          generation: 2,
          control: { ...externalControl(2, "heartbeat"), [field]: "secret" },
        }),
      ).toThrow(/response is invalid/u);
      expect(() => parseSessionControlRequestResponse({ request: { ...pendingRequest(), [field]: "secret" } })).toThrow(
        /response is invalid/u,
      );
    }
  });

  it("bounds and freezes list/detail arrays and requires canonical UTC timestamps", () => {
    const list = parseSessionControlListResponse({ items: [operatorControl()] });
    const detail = parseSessionControlDetailResponse({
      control: operatorControl(1, "session_initialized"),
      pendingRequests: [pendingRequest()],
    });
    expect(Object.isFrozen(list.items)).toBe(true);
    expect(Object.isFrozen(detail.pendingRequests)).toBe(true);
    expect(() =>
      parseSessionControlListResponse({
        items: Array.from({ length: SESSION_CONTROL_MAX_LIST_ITEMS + 1 }, () => operatorControl()),
      }),
    ).toThrow(/list response is invalid/u);
    expect(() =>
      parseSessionControlRecord({ ...operatorControl(), updatedAt: "2026-07-14T05:00:00.000-07:00" }),
    ).toThrow(/record is invalid/u);
    expect(() =>
      parseSessionControlDetailResponse({
        control: operatorControl(),
        pendingRequests: [{ ...pendingRequest(), sessionId: "foreign-session" }],
      }),
    ).toThrow(/detail response is invalid/u);
    expect(() =>
      parseSessionControlDetailResponse({ control: operatorControl(), pendingRequests: [pendingRequest()] }),
    ).toThrow(/detail response is invalid/u);
    const externalDetail = parseSessionControlDetailResponse({ control: externalControl(), pendingRequests: [] });
    expect(externalDetail.control.ownerKind).toBe("external_companion");
    expect(Object.isFrozen(externalDetail.pendingRequests)).toBe(true);
    expect(() =>
      parseSessionControlDetailResponse({ control: externalControl(), pendingRequests: [pendingRequest()] }),
    ).toThrow(/detail response is invalid/u);
    expect(() =>
      parseSessionControlDetailResponse({
        control: operatorControl(1, "session_initialized"),
        pendingRequests: [pendingRequest(), pendingRequest()],
      }),
    ).toThrow(/detail response is invalid/u);
    expect(() =>
      parseSessionControlListResponse({
        items: [operatorControl(), { ...operatorControl(), workspaceId: "workspace-b" }],
      }),
    ).toThrow(/list response is invalid/u);
  });
});
