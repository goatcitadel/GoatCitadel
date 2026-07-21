import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  ConflictError,
  NotFoundError,
  SESSION_CONTROL_CLIENT_INSTANCE_HEADER,
  SESSION_CONTROL_GENERATION_HEADER,
  SESSION_CONTROL_TOKEN_HEADER,
} from "@goatcitadel/contracts";
import { installRouteAccessTracking } from "./route-access.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { registerSessionControlRoutes } from "./session-control.js";
import { registerChatMessageRoutes } from "./chat.messages.js";

const TOKEN_HEADER_KEY = SESSION_CONTROL_TOKEN_HEADER.toLowerCase();
const GENERATION_HEADER_KEY = SESSION_CONTROL_GENERATION_HEADER.toLowerCase();
const VALID_TOKEN_HASH = "a".repeat(64);
const COMPANION_SESSION_ID = "companion-1";
const DEVICE_GRANT_ID = "grant-1";
const CLIENT_INSTANCE_ID = "client-a";

type Principal = "operator" | "scc" | "generic-companion" | "anon";

function stampAuth(request: FastifyRequest, principal: Principal): void {
  const target = request as unknown as {
    authActorSource: string;
    authActorId: string;
    authPrincipalPurpose?: string;
    authCompanionSessionId?: string;
    authGrantId?: string;
  };
  target.authPrincipalPurpose = undefined;
  target.authCompanionSessionId = undefined;
  target.authGrantId = undefined;
  switch (principal) {
    case "operator":
      target.authActorSource = "token";
      target.authActorId = "operator:1";
      break;
    case "scc":
      target.authActorSource = "companion";
      target.authActorId = "companion:1";
      target.authPrincipalPurpose = "session_control_client";
      target.authCompanionSessionId = COMPANION_SESSION_ID;
      target.authGrantId = DEVICE_GRANT_ID;
      break;
    case "generic-companion":
      target.authActorSource = "companion";
      target.authActorId = "companion:g";
      target.authPrincipalPurpose = "general_companion";
      target.authCompanionSessionId = "companion-g";
      target.authGrantId = "grant-g";
      break;
    default:
      target.authActorSource = "none";
      target.authActorId = "anonymous";
  }
}

interface MockServices {
  sessionControl: Record<string, ReturnType<typeof vi.fn>>;
  chatMessages: Record<string, ReturnType<typeof vi.fn>>;
}

function buildServices(overrides: Partial<MockServices> = {}): MockServices {
  return {
    sessionControl: {
      createExternalRequest: vi.fn(() => ({ request: { requestId: "req-1" } })),
      handoff: vi.fn(() => ({ request: { requestId: "req-1" }, control: { generation: 2 } })),
      heartbeat: vi.fn(() => ({ generation: 2, control: { generation: 2 } })),
      reconnect: vi.fn(() => ({ supersededGeneration: 2, control: { generation: 3 } })),
      release: vi.fn(() => ({ releasedGeneration: 2, control: { generation: 3 } })),
      revoke: vi.fn(() => ({ target: "current_controller", revokedGeneration: 2 })),
      authorizeExternalSessionRead: vi.fn(),
      getDetail: vi.fn(() => ({ control: { ownerKind: "operator", generation: 1 }, pendingRequests: [] })),
      ...overrides.sessionControl,
    },
    chatMessages: {
      agentSendChatMessage: vi.fn(() => ({ turnId: "turn-1" })),
      agentSendChatMessageStream: vi.fn(),
      listChatMessages: vi.fn(() => []),
      ...overrides.chatMessages,
    },
  };
}

async function buildApp(services: MockServices, principal: Principal): Promise<FastifyInstance> {
  const app = Fastify();
  installRouteAccessTracking(app);
  app.decorate("gatewayConfig", {
    assistant: { auth: { mode: "token", allowLoopbackBypass: false } },
  } as never);
  app.decorate("requireOperatorAuth", async (request: FastifyRequest, reply) => {
    if (["token", "basic", "loopback"].includes((request as unknown as { authActorSource: string }).authActorSource)) {
      return undefined;
    }
    return reply.code(403).send({ error: "Operator authentication is required." });
  });
  app.decorate("services", services as never);
  app.decorateRequest("authActorSource", "none");
  app.decorateRequest("authActorId", "anonymous");
  app.decorateRequest("authPrincipalPurpose", undefined);
  app.decorateRequest("authCompanionSessionId", undefined);
  app.decorateRequest("authGrantId", undefined);
  app.addHook("onRequest", async (request) => {
    stampAuth(request, principal);
  });
  await app.register(idempotencyHeaderPlugin, {});
  registerSessionControlRoutes(app);
  registerChatMessageRoutes(app);
  await app.ready();
  return app;
}

function companionHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "idempotency-key": "idem-http-1",
    [SESSION_CONTROL_CLIENT_INSTANCE_HEADER]: CLIENT_INSTANCE_ID,
    ...extra,
  };
}

const REQUEST_BODY = {
  expectedGeneration: 1,
  clientInstanceId: CLIENT_INSTANCE_ID,
  tokenHashSha256: VALID_TOKEN_HASH,
  capabilities: ["send"],
  idempotencyKey: "idem-req-1",
};
const HEARTBEAT_BODY = { expectedGeneration: 2, idempotencyKey: "idem-hb-1" };
const HANDOFF_BODY = {
  requestId: "req-1",
  expectedGeneration: 1,
  effectiveCapabilities: ["send"],
  idempotencyKey: "idem-ho-1",
};
const REVOKE_BODY = {
  target: "current_controller",
  expectedGeneration: 2,
  mode: "revoke",
  idempotencyKey: "idem-rv-1",
};

describe("session-control routes: access-class matrix", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("admits a session-control companion to POST control/requests and rejects operators and generic companions", async () => {
    const services = buildServices();
    app = await buildApp(services, "scc");
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/requests",
      headers: companionHeaders(),
      payload: REQUEST_BODY,
    });
    expect(ok.statusCode).toBe(200);
    expect(services.sessionControl.createExternalRequest).toHaveBeenCalledTimes(1);
    await app.close();

    app = await buildApp(buildServices(), "operator");
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/requests",
      headers: companionHeaders(),
      payload: REQUEST_BODY,
    });
    expect(denied.statusCode).toBe(403);
    await app.close();

    app = await buildApp(buildServices(), "generic-companion");
    const genericDenied = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/requests",
      headers: companionHeaders(),
      payload: REQUEST_BODY,
    });
    expect(genericDenied.statusCode).toBe(403);
  });

  it("restricts handoff and revoke to operators and rejects session-control companions", async () => {
    const services = buildServices();
    app = await buildApp(services, "operator");
    const handoff = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/handoff",
      headers: { "idempotency-key": "idem-http-2" },
      payload: HANDOFF_BODY,
    });
    expect(handoff.statusCode).toBe(200);
    expect(services.sessionControl.handoff).toHaveBeenCalledTimes(1);
    const revoke = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/revoke",
      headers: { "idempotency-key": "idem-http-3" },
      payload: REVOKE_BODY,
    });
    expect(revoke.statusCode).toBe(200);
    await app.close();

    app = await buildApp(buildServices(), "scc");
    const handoffDenied = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/handoff",
      headers: companionHeaders({ "idempotency-key": "idem-http-4" }),
      payload: HANDOFF_BODY,
    });
    expect(handoffDenied.statusCode).toBe(403);
  });

  it("admits a session-control companion to heartbeat and rejects operators", async () => {
    const services = buildServices();
    app = await buildApp(services, "scc");
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/heartbeat",
      headers: companionHeaders({ [TOKEN_HEADER_KEY]: "plain-secret" }),
      payload: HEARTBEAT_BODY,
    });
    expect(ok.statusCode).toBe(200);
    await app.close();

    app = await buildApp(buildServices(), "operator");
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/heartbeat",
      headers: { "idempotency-key": "idem-http-5", [TOKEN_HEADER_KEY]: "plain-secret" },
      payload: HEARTBEAT_BODY,
    });
    expect(denied.statusCode).toBe(403);
  });

  it.each([
    {
      route: "reconnect",
      body: { expectedGeneration: 2, newTokenHashSha256: "b".repeat(64), idempotencyKey: "idem-rc-1" },
      service: "reconnect" as const,
    },
    {
      route: "release",
      body: { expectedGeneration: 2, idempotencyKey: "idem-rl-1" },
      service: "release" as const,
    },
  ])(
    "restricts control/$route to session-control companions (denies operator and generic companion)",
    async ({ route, body, service }) => {
      const operatorServices = buildServices();
      app = await buildApp(operatorServices, "operator");
      const operatorDenied = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/session-1/control/${route}`,
        headers: { "idempotency-key": `idem-http-op-${route}`, [TOKEN_HEADER_KEY]: "plain-secret" },
        payload: body,
      });
      expect(operatorDenied.statusCode).toBe(403);
      expect(operatorServices.sessionControl[service]).not.toHaveBeenCalled();
      await app.close();

      const genericServices = buildServices();
      app = await buildApp(genericServices, "generic-companion");
      const genericDenied = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/session-1/control/${route}`,
        headers: companionHeaders({ "idempotency-key": `idem-http-gc-${route}`, [TOKEN_HEADER_KEY]: "plain-secret" }),
        payload: body,
      });
      expect(genericDenied.statusCode).toBe(403);
      expect(genericServices.sessionControl[service]).not.toHaveBeenCalled();
    },
  );

  it("shares GET control between operators and bound companions but denies generic companions", async () => {
    app = await buildApp(buildServices(), "operator");
    expect((await app.inject({ method: "GET", url: "/api/v1/chat/sessions/session-1/control" })).statusCode).toBe(200);
    await app.close();

    const sccServices = buildServices({
      sessionControl: {
        getDetail: vi.fn(() => ({
          control: {
            ownerKind: "external_companion",
            generation: 2,
            boundExternalController: { companionSessionId: COMPANION_SESSION_ID, clientInstanceId: CLIENT_INSTANCE_ID },
            capabilities: ["send"],
          },
          pendingRequests: [],
        })),
      } as never,
    });
    app = await buildApp(sccServices, "scc");
    const sccRead = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/session-1/control",
      headers: { [SESSION_CONTROL_CLIENT_INSTANCE_HEADER]: CLIENT_INSTANCE_ID },
    });
    expect(sccRead.statusCode).toBe(200);
    await app.close();

    app = await buildApp(buildServices(), "generic-companion");
    expect((await app.inject({ method: "GET", url: "/api/v1/chat/sessions/session-1/control" })).statusCode).toBe(403);
  });
});

describe("session-control routes: headers, token hashing, command shaping", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("sets no-store and no-cache on control responses", async () => {
    app = await buildApp(buildServices(), "operator");
    const reply = await app.inject({ method: "GET", url: "/api/v1/chat/sessions/session-1/control" });
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["pragma"]).toBe("no-cache");
  });

  it("hashes the plaintext token from the frozen header into the service command", async () => {
    const services = buildServices();
    app = await buildApp(services, "scc");
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/heartbeat",
      headers: companionHeaders({ [TOKEN_HEADER_KEY]: "plain-secret" }),
      payload: HEARTBEAT_BODY,
    });
    expect(reply.statusCode).toBe(200);
    const command = services.sessionControl.heartbeat.mock.calls[0]?.[0];
    expect(command.presentedTokenHashSha256).toBe(createHash("sha256").update("plain-secret", "utf8").digest("hex"));
  });

  it("rejects a heartbeat body that tries to carry token material (strict schema fails closed)", async () => {
    const services = buildServices();
    app = await buildApp(services, "scc");
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/heartbeat",
      headers: companionHeaders({ [TOKEN_HEADER_KEY]: "plain-secret" }),
      payload: { ...HEARTBEAT_BODY, tokenHashSha256: "f".repeat(64) },
    });
    expect(reply.statusCode).toBe(400);
    expect(services.sessionControl.heartbeat).not.toHaveBeenCalled();
  });

  it("fails closed when the control token header is absent on heartbeat", async () => {
    const services = buildServices();
    app = await buildApp(services, "scc");
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/heartbeat",
      headers: companionHeaders(),
      payload: HEARTBEAT_BODY,
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().details.sessionControlCode).toBe("SESSION_CONTROL_TOKEN_INVALID");
    expect(services.sessionControl.heartbeat).not.toHaveBeenCalled();
  });

  it("projects the authenticated companion binding and header client instance into createExternalRequest", async () => {
    const services = buildServices();
    app = await buildApp(services, "scc");
    await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-9/control/requests",
      headers: companionHeaders(),
      payload: REQUEST_BODY,
    });
    const command = services.sessionControl.createExternalRequest.mock.calls[0]?.[0];
    expect(command.sessionId).toBe("session-9");
    expect(command.actor).toMatchObject({
      actorKind: "external_companion",
      companionSessionId: COMPANION_SESSION_ID,
      deviceGrantId: DEVICE_GRANT_ID,
      clientInstanceId: CLIENT_INSTANCE_ID,
      principalPurpose: "session_control_client",
    });
    expect(command.input.capabilities).toEqual(["send"]);
  });

  it("surfaces a typed session-control conflict from the service as a 409 with its code", async () => {
    const services = buildServices({
      sessionControl: {
        handoff: vi.fn(() => {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: "stale",
            details: { sessionControlCode: "SESSION_CONTROL_GENERATION_STALE" },
          });
        }),
      } as never,
    });
    app = await buildApp(services, "operator");
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/handoff",
      headers: { "idempotency-key": "idem-http-9" },
      payload: HANDOFF_BODY,
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().details.sessionControlCode).toBe("SESSION_CONTROL_GENERATION_STALE");
  });

  it("maps a not-found session from the service to a 404", async () => {
    const services = buildServices({
      sessionControl: {
        getDetail: vi.fn(() => {
          throw new NotFoundError({ entity: "Chat session", id: "missing" });
        }),
      } as never,
    });
    app = await buildApp(services, "operator");
    const reply = await app.inject({ method: "GET", url: "/api/v1/chat/sessions/missing/control" });
    expect(reply.statusCode).toBe(404);
  });

  it("rejects a malformed control body before calling the service", async () => {
    const services = buildServices();
    app = await buildApp(services, "scc");
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/control/requests",
      headers: companionHeaders(),
      payload: { capabilities: ["read"] },
    });
    expect(reply.statusCode).toBe(400);
    expect(services.sessionControl.createExternalRequest).not.toHaveBeenCalled();
  });
});

describe("external companion send wiring", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("populates the external companion admission context from headers on agent-send", async () => {
    const services = buildServices();
    app = await buildApp(services, "scc");
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/agent-send",
      headers: companionHeaders({ [TOKEN_HEADER_KEY]: "plain-secret", [GENERATION_HEADER_KEY]: "2" }),
      payload: { content: "hello" },
    });
    expect(reply.statusCode).toBe(200);
    const call = services.chatMessages.agentSendChatMessage.mock.calls[0];
    expect(call?.[2]).toBeUndefined(); // no authenticated-operator context on external send
    expect(call?.[3]).toMatchObject({
      kind: "session_control_companion_send",
      companionSessionId: COMPANION_SESSION_ID,
      deviceGrantId: DEVICE_GRANT_ID,
      clientInstanceId: CLIENT_INSTANCE_ID,
      principalPurpose: "session_control_client",
      tokenHashSha256: createHash("sha256").update("plain-secret", "utf8").digest("hex"),
      expectedGeneration: 2,
    });
  });

  it("surfaces a stale-generation rejection from canonical admission as a 409", async () => {
    const services = buildServices({
      chatMessages: {
        agentSendChatMessage: vi.fn(() => {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: "stale",
            details: { sessionControlCode: "SESSION_CONTROL_GENERATION_STALE" },
          });
        }),
      } as never,
    });
    app = await buildApp(services, "scc");
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/agent-send",
      headers: companionHeaders({ [TOKEN_HEADER_KEY]: "plain-secret", [GENERATION_HEADER_KEY]: "9" }),
      payload: { content: "hello" },
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().details.sessionControlCode).toBe("SESSION_CONTROL_GENERATION_STALE");
  });

  it("fails closed when a purpose-bound companion send omits the control token header", async () => {
    const services = buildServices();
    app = await buildApp(services, "scc");
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/agent-send",
      headers: companionHeaders({ [GENERATION_HEADER_KEY]: "2" }),
      payload: { content: "hello" },
    });
    expect(reply.statusCode).toBe(409);
    expect(services.chatMessages.agentSendChatMessage).not.toHaveBeenCalled();
  });

  it("keeps the operator send path unchanged (no external context, requires route decision)", async () => {
    const services = buildServices();
    app = await buildApp(services, "operator");
    // No routeDecision → the operator freshness gate rejects before admission.
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/agent-send",
      headers: { "idempotency-key": "idem-op-send" },
      payload: { content: "hello" },
    });
    expect(reply.statusCode).toBe(409);
    expect(services.chatMessages.agentSendChatMessage).not.toHaveBeenCalled();
  });
});

describe("external companion transcript read wiring", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("reads messages for a companion the single authorize gate admits, projecting its actor", async () => {
    const services = buildServices(); // default authorizeExternalSessionRead is a no-op (admits)
    app = await buildApp(services, "scc");
    const reply = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/session-1/messages",
      headers: { [SESSION_CONTROL_CLIENT_INSTANCE_HEADER]: CLIENT_INSTANCE_ID },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["cache-control"]).toBe("private, no-store");
    expect(reply.headers["pragma"]).toBe("no-cache");
    expect(services.chatMessages.listChatMessages).toHaveBeenCalledTimes(1);
    // The route delegates authz to the single service gate with the projected actor + sessionId.
    expect(services.sessionControl.authorizeExternalSessionRead).toHaveBeenCalledWith({
      actor: {
        actorKind: "external_companion",
        companionSessionId: COMPANION_SESSION_ID,
        deviceGrantId: DEVICE_GRANT_ID,
        clientInstanceId: CLIENT_INSTANCE_ID,
        principalPurpose: "session_control_client",
      },
      sessionId: "session-1",
    });
  });

  it("denies the read (no content) when the authorize gate throws capability-denied", async () => {
    const services = buildServices({
      sessionControl: {
        authorizeExternalSessionRead: vi.fn(() => {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: "denied",
            details: { sessionControlCode: "SESSION_CONTROL_CAPABILITY_DENIED" },
          });
        }),
      } as never,
    });
    app = await buildApp(services, "scc");
    const reply = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/session-1/messages",
      headers: { [SESSION_CONTROL_CLIENT_INSTANCE_HEADER]: CLIENT_INSTANCE_ID },
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().details.sessionControlCode).toBe("SESSION_CONTROL_CAPABILITY_DENIED");
    expect(services.chatMessages.listChatMessages).not.toHaveBeenCalled();
  });

  it("leaves the operator read path unchanged without consulting the authorize gate", async () => {
    const services = buildServices();
    app = await buildApp(services, "operator");
    const reply = await app.inject({ method: "GET", url: "/api/v1/chat/sessions/session-1/messages" });
    expect(reply.statusCode).toBe(200);
    expect(services.sessionControl.authorizeExternalSessionRead).not.toHaveBeenCalled();
    expect(services.chatMessages.listChatMessages).toHaveBeenCalledTimes(1);
  });
});
