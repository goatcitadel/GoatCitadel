import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ConflictError, SESSION_CONTROL_CLIENT_INSTANCE_HEADER } from "@goatcitadel/contracts";
import { installRouteAccessTracking } from "./route-access.js";
import { registerSessionControlRoutes } from "./session-control.js";

const CLIENT_INSTANCE_ID = "client-a";

type Principal = "operator" | "scc" | "anon";

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
  if (principal === "operator") {
    target.authActorSource = "token";
    target.authActorId = "operator:1";
  } else if (principal === "scc") {
    target.authActorSource = "companion";
    target.authActorId = "companion:1";
    target.authPrincipalPurpose = "session_control_client";
    target.authCompanionSessionId = "companion-1";
    target.authGrantId = "grant-1";
  } else {
    target.authActorSource = "none";
    target.authActorId = "anonymous";
  }
}

function controlEventRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
}

function page(
  events: Array<{ cursor: number; event: Record<string, unknown> }>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    events,
    lowWatermark: events.length > 0 ? 1 : 0,
    highWatermark: events.length > 0 ? events[events.length - 1]!.cursor : 0,
    truncated: false,
    generation: 4,
    ownerKind: "external_companion",
    leaseState: "external_live",
    ...overrides,
  };
}

async function buildStreamApp(
  pageControlEventStream: ReturnType<typeof vi.fn>,
  principal: Principal,
): Promise<{ app: FastifyInstance; address: string }> {
  const app = Fastify();
  installRouteAccessTracking(app);
  app.decorate("gatewayConfig", { assistant: { auth: { mode: "token", allowLoopbackBypass: false } } } as never);
  app.decorate("requireOperatorAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    if (["token", "basic", "loopback"].includes((request as unknown as { authActorSource: string }).authActorSource)) {
      return undefined;
    }
    return reply.code(403).send({ error: "Operator authentication is required." });
  });
  app.decorate("services", { sessionControl: { pageControlEventStream } } as never);
  app.decorateRequest("authActorSource", "none");
  app.decorateRequest("authActorId", "anonymous");
  app.decorateRequest("authPrincipalPurpose", undefined);
  app.decorateRequest("authCompanionSessionId", undefined);
  app.decorateRequest("authGrantId", undefined);
  app.addHook("onRequest", async (request) => {
    stampAuth(request, principal);
  });
  registerSessionControlRoutes(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, address };
}

async function readSseUntil(response: Response, done: (buffer: string) => boolean): Promise<string> {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let buffer = "";
  for (let index = 0; index < 80; index += 1) {
    const chunk = await reader!.read();
    if (chunk.value) {
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    if (done(buffer) || chunk.done) {
      break;
    }
  }
  await reader!.cancel();
  return buffer;
}

const STREAM_PATH = "/api/v1/chat/sessions/session-1/control/events/stream";
const companionStreamHeaders = { [SESSION_CONTROL_CLIENT_INSTANCE_HEADER]: CLIENT_INSTANCE_ID };

describe("session-control event stream route", () => {
  let app: FastifyInstance | null = null;
  const originalPollMs = process.env.GOATCITADEL_SESSION_CONTROL_STREAM_POLL_MS;

  beforeEach(() => {
    process.env.GOATCITADEL_SESSION_CONTROL_STREAM_POLL_MS = "20";
  });

  afterEach(async () => {
    if (originalPollMs === undefined) {
      delete process.env.GOATCITADEL_SESSION_CONTROL_STREAM_POLL_MS;
    } else {
      process.env.GOATCITADEL_SESSION_CONTROL_STREAM_POLL_MS = originalPollMs;
    }
    await app?.close();
    app = null;
  });

  it("replays ordered content-free control events with cursors, no-store headers, truthful diagnostics, and no approval token", async () => {
    const pageFn = vi
      .fn()
      .mockImplementationOnce(() =>
        page(
          [
            {
              cursor: 1,
              event: controlEventRecord({ eventId: "sce-1", reasonCode: "session_initialized", nextGeneration: 1 }),
            },
            { cursor: 2, event: controlEventRecord({ eventId: "sce-2", reasonCode: "handoff", nextGeneration: 2 }) },
          ],
          { generation: 7 },
        ),
      )
      .mockImplementation(() => page([], { highWatermark: 2, generation: 7 }));
    const built = await buildStreamApp(pageFn, "scc");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}`, { headers: companionStreamHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");

    const text = await readSseUntil(response, (buffer) => buffer.includes("event: stream-ready"));
    expect(text).toContain("event: control-event");
    expect(text).toContain("id: 1");
    expect(text).toContain("id: 2");
    expect(text).toContain('"reasonCode":"handoff"');
    expect(text.indexOf("id: 1")).toBeLessThan(text.indexOf("id: 2"));
    expect(text).toContain('"sentThrough":2');
    expect(text).toContain('"acknowledgedThrough":0');
    expect(text).toContain('"pending":0');
    expect(text).toContain('"oldestRetainedCursor":1');
    expect(text).toContain('"newestRetainedCursor":2');
    // The frozen bounded-buffer watermarks are surfaced explicitly (invariant 24).
    expect(text).toContain('"bufferLowWatermark":64');
    expect(text).toContain('"bufferHighWatermark":256');
    // The envelope/stream-ready generation (7) is the current controller generation,
    // distinct from each event's own nextGeneration (1/2).
    expect(text).toContain('"generation":7');
    // Content-free: no approval action token may ride the control-event stream.
    expect(text).not.toMatch(/grat_|approvalActionToken|"token"/);
    // The first (replay) call carried no client cursor.
    expect(pageFn.mock.calls[0]?.[0]).toMatchObject({ sessionId: "session-1", afterCursor: undefined });
  });

  it("denies a send-only or unbound external reader with its typed 409 before opening a stream", async () => {
    const pageFn = vi.fn(() => {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Session control read is denied.",
        details: { sessionControlCode: "SESSION_CONTROL_CAPABILITY_DENIED" },
      });
    });
    const built = await buildStreamApp(pageFn, "scc");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}`, { headers: companionStreamHeaders });
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    const body = await response.json();
    expect(body.details.sessionControlCode).toBe("SESSION_CONTROL_CAPABILITY_DENIED");
  });

  it("denies an anonymous reader via the access class", async () => {
    const pageFn = vi.fn(() => page([]));
    const built = await buildStreamApp(pageFn, "anon");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}`);
    expect(response.status).toBe(403);
    expect(pageFn).not.toHaveBeenCalled();
    await response.body?.cancel();
  });

  it("surfaces a revoke transition to an operator reader as a delivered control event (operator retains read)", async () => {
    const pageFn = vi
      .fn()
      .mockImplementationOnce(() =>
        page([
          { cursor: 1, event: controlEventRecord({ eventId: "sce-1", reasonCode: "handoff", nextGeneration: 2 }) },
        ]),
      )
      .mockImplementationOnce(() =>
        page(
          [
            {
              cursor: 2,
              event: controlEventRecord({
                eventId: "sce-2",
                reasonCode: "auth_revoked",
                previousOwnerKind: "external_companion",
                nextOwnerKind: "operator",
                nextLeaseState: "operator_active",
                previousGeneration: 4,
                nextGeneration: 5,
                actorKind: "system",
              }),
            },
          ],
          { generation: 5, ownerKind: "operator", leaseState: "operator_active", highWatermark: 2 },
        ),
      )
      .mockImplementation(() =>
        page([], { generation: 5, ownerKind: "operator", leaseState: "operator_active", highWatermark: 2 }),
      );
    const built = await buildStreamApp(pageFn, "operator");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}`);
    const text = await readSseUntil(response, (buffer) => buffer.includes('"reasonCode":"auth_revoked"'));
    expect(text).toContain('"reasonCode":"auth_revoked"');
    expect(text).toContain("id: 2");
    expect(text).toContain('"nextOwnerKind":"operator"');
    expect(text).toContain('"generation":5');
    // The operator stream is NOT force-closed by the transition.
    expect(text).not.toContain("event: control-revoked");
  });

  it("closes an external reader's stream with control-revoked when its page throws mid-stream and delivers nothing further", async () => {
    const pageFn = vi
      .fn()
      .mockImplementationOnce(() =>
        page([{ cursor: 1, event: controlEventRecord({ eventId: "sce-1", reasonCode: "handoff" }) }]),
      )
      .mockImplementation(() => {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "Session control read is denied.",
          details: { sessionControlCode: "SESSION_CONTROL_CAPABILITY_DENIED" },
        });
      });
    const built = await buildStreamApp(pageFn, "scc");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}`, { headers: companionStreamHeaders });
    const text = await readSseUntil(response, (buffer) => buffer.includes("event: control-revoked"));
    expect(text).toContain("event: control-revoked");
    expect(text).toContain('"reason":"SESSION_CONTROL_CAPABILITY_DENIED"');
    // No control-event frame appears after the terminal close.
    const revokedAt = text.indexOf("event: control-revoked");
    expect(text.indexOf("event: control-event", revokedAt)).toBe(-1);
  });

  it("emits replay-gap and closes when the client cursor is ahead of the retained window", async () => {
    const pageFn = vi.fn(() => page([], { highWatermark: 3, lowWatermark: 1 }));
    const built = await buildStreamApp(pageFn, "scc");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}?afterCursor=99`, { headers: companionStreamHeaders });
    expect(response.status).toBe(200);
    const text = await readSseUntil(response, (buffer) => buffer.includes("event: replay-gap"));
    expect(text).toContain("event: replay-gap");
    expect(text).toContain('"reason":"cursor_beyond_retained"');
    expect(text).toContain('"requestedCursor":99');
    expect(text).toContain('"newestRetainedCursor":3');
    expect(text).not.toContain("event: stream-ready");
  });

  it("closes with backpressure when a single live batch crosses the frozen high watermark", async () => {
    const bigBatch = Array.from({ length: 300 }, (_, index) => ({
      cursor: index + 1,
      event: controlEventRecord({ eventId: `sce-${index + 1}`, reasonCode: "heartbeat" }),
    }));
    const pageFn = vi
      .fn()
      .mockImplementationOnce(() => page([], { highWatermark: 0 }))
      .mockImplementation(() => page(bigBatch, { highWatermark: 300 }));
    const built = await buildStreamApp(pageFn, "scc");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}`, { headers: companionStreamHeaders });
    const text = await readSseUntil(response, (buffer) => buffer.includes("event: backpressure"));
    expect(text).toContain("event: backpressure");
    expect(text).toContain('"reason":"high_watermark_exceeded"');
  });

  it("ignores a control token supplied in the query string: it neither authorizes nor is echoed", async () => {
    const pageFn = vi.fn(() => {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Session control read is denied.",
        details: { sessionControlCode: "SESSION_CONTROL_CAPABILITY_DENIED" },
      });
    });
    const built = await buildStreamApp(pageFn, "scc");
    app = built.app;

    const response = await fetch(
      `${built.address}${STREAM_PATH}?X-GoatCitadel-Session-Control-Token=super-secret&token=super-secret`,
      { headers: companionStreamHeaders },
    );
    // The query token cannot substitute for the bound-controller + delegated-read gate.
    expect(response.status).toBe(409);
    const bodyText = await response.text();
    expect(bodyText).not.toContain("super-secret");
  });
});
