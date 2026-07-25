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
    oldestSequence: events.length > 0 ? events[0]!.cursor : 0,
    newestSequence: events.length > 0 ? events[events.length - 1]!.cursor : 0,
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
      .mockImplementation(() => page([], { newestSequence: 2, generation: 7 }));
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
          { generation: 5, ownerKind: "operator", leaseState: "operator_active", newestSequence: 2 },
        ),
      )
      .mockImplementation(() =>
        page([], { generation: 5, ownerKind: "operator", leaseState: "operator_active", newestSequence: 2 }),
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

  it("emits replay-gap and closes ONLY when the client cursor is before the oldest retained event", async () => {
    // oldest retained is 50, so a client claiming it has through 10 is missing an
    // unreachable range (11..49) — a genuine gap, unlike a cursor merely ahead of newest.
    const pageFn = vi.fn(() => page([], { oldestSequence: 50, newestSequence: 100 }));
    const built = await buildStreamApp(pageFn, "scc");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}?afterCursor=10`, { headers: companionStreamHeaders });
    expect(response.status).toBe(200);
    const text = await readSseUntil(response, (buffer) => buffer.includes("event: replay-gap"));
    expect(text).toContain("event: replay-gap");
    expect(text).toContain('"reason":"cursor_before_retained"');
    expect(text).toContain('"requestedCursor":10');
    expect(text).toContain('"oldestRetainedCursor":50');
    expect(text).not.toContain("event: stream-ready");
  });

  it("closes with backpressure when a single live batch crosses the frozen high watermark", async () => {
    const bigBatch = Array.from({ length: 300 }, (_, index) => ({
      cursor: index + 1,
      event: controlEventRecord({ eventId: `sce-${index + 1}`, reasonCode: "heartbeat" }),
    }));
    const pageFn = vi
      .fn()
      .mockImplementationOnce(() => page([]))
      .mockImplementation(() => page(bigBatch));
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

  it("delivers events past 200 by paging forward through truncated replay pages (H1 regression)", async () => {
    const pageFn = vi
      .fn()
      // Replay page 1: oldest heartbeats, more remain (truncated).
      .mockImplementationOnce(() =>
        page(
          [
            { cursor: 199, event: controlEventRecord({ eventId: "sce-199", reasonCode: "heartbeat" }) },
            { cursor: 200, event: controlEventRecord({ eventId: "sce-200", reasonCode: "heartbeat" }) },
          ],
          { oldestSequence: 1, newestSequence: 203, truncated: true },
        ),
      )
      // Catch-up page 2: the RECENT state past 200 — a late handoff and reconnect.
      .mockImplementationOnce(() =>
        page(
          [
            {
              cursor: 201,
              event: controlEventRecord({ eventId: "sce-201", reasonCode: "handoff", nextGeneration: 6 }),
            },
            {
              cursor: 202,
              event: controlEventRecord({ eventId: "sce-202", reasonCode: "reconnect", nextGeneration: 7 }),
            },
            { cursor: 203, event: controlEventRecord({ eventId: "sce-203", reasonCode: "heartbeat" }) },
          ],
          { oldestSequence: 1, newestSequence: 203, truncated: false },
        ),
      )
      .mockImplementation(() => page([], { oldestSequence: 1, newestSequence: 203 }));
    const built = await buildStreamApp(pageFn, "scc");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}`, { headers: companionStreamHeaders });
    const text = await readSseUntil(response, (buffer) => buffer.includes("event: stream-ready"));
    // Events 201+ ARE delivered — not permanently unreachable.
    for (const id of [199, 200, 201, 202, 203]) {
      expect(text).toContain(`id: ${id}`);
    }
    // Cursors are event_sequence-based and monotonic.
    expect(text.indexOf("id: 200")).toBeLessThan(text.indexOf("id: 201"));
    expect(text.indexOf("id: 202")).toBeLessThan(text.indexOf("id: 203"));
    // The recent handoff/reconnect state arrives (not just ancient rows).
    expect(text).toContain('"reasonCode":"handoff"');
    expect(text).toContain('"reasonCode":"reconnect"');
    expect(text).toContain('"sentThrough":203');
    // Page 2 was fetched forward from the last delivered sequence (200), not the start.
    expect(pageFn.mock.calls[1]?.[0]).toMatchObject({ afterCursor: 200 });
  });

  it("keeps an operator observer current past 200: new events arrive on the tail (no silent stall)", async () => {
    const pageFn = vi
      .fn()
      .mockImplementationOnce(() =>
        page(
          [
            { cursor: 201, event: controlEventRecord({ eventId: "sce-201", reasonCode: "heartbeat" }) },
            { cursor: 202, event: controlEventRecord({ eventId: "sce-202", reasonCode: "heartbeat" }) },
          ],
          { oldestSequence: 1, newestSequence: 202, truncated: false },
        ),
      )
      .mockImplementationOnce(() =>
        page(
          [
            {
              cursor: 203,
              event: controlEventRecord({ eventId: "sce-203", reasonCode: "handoff", nextGeneration: 6 }),
            },
            { cursor: 204, event: controlEventRecord({ eventId: "sce-204", reasonCode: "heartbeat" }) },
          ],
          { oldestSequence: 1, newestSequence: 204, truncated: false },
        ),
      )
      .mockImplementation(() => page([], { oldestSequence: 1, newestSequence: 204 }));
    const built = await buildStreamApp(pageFn, "operator");
    app = built.app;

    const response = await fetch(`${built.address}${STREAM_PATH}`);
    const text = await readSseUntil(response, (buffer) => buffer.includes("id: 204"));
    // The tail continues past 200 — the operator is not silently stalled on ancient rows.
    expect(text).toContain("id: 203");
    expect(text).toContain("id: 204");
    expect(text).toContain('"reasonCode":"handoff"');
    expect(text).not.toContain("event: control-revoked");
  });

  it("scopes the stream to the URL session and delegates the cross-session/workspace boundary to the gate", async () => {
    const pageFn = vi.fn(() => {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Session control read is denied.",
        details: { sessionControlCode: "SESSION_CONTROL_CAPABILITY_DENIED" },
      });
    });
    const built = await buildStreamApp(pageFn, "scc");
    app = built.app;

    // Companion is bound (in the harness) to session-1; it requests session-foreign's stream.
    const response = await fetch(`${built.address}/api/v1/chat/sessions/session-foreign/control/events/stream`, {
      headers: companionStreamHeaders,
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.details.sessionControlCode).toBe("SESSION_CONTROL_CAPABILITY_DENIED");
    // The route scoped the read to the URL session and let the gate reject the mismatch.
    expect(pageFn.mock.calls[0]?.[0]).toMatchObject({ sessionId: "session-foreign" });
  });
});
