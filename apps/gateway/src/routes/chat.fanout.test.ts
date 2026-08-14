import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
import { registerChatFanoutRoutes } from "./chat.fanout.js";

describe("chat fan-out routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) return;
    await app.close();
    app = null;
  });

  it("stops only the canonical aggregate for the requested Chat session", async () => {
    const stopChatFanout = vi.fn(async () => ({
      invocationId: "fanout-1",
      status: "cancelled" as const,
      terminalReason: "operator_stop",
    }));
    app = buildApp({ stopChatFanout });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/fanouts/fanout-1/stop",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      invocationId: "fanout-1",
      status: "cancelled",
      terminalReason: "operator_stop",
    });
    expect(stopChatFanout).toHaveBeenCalledWith("session-1", "fanout-1");
  });

  it("does not disclose an aggregate that is absent or bound to another session", async () => {
    const stopChatFanout = vi.fn(async () => {
      throw new NotFoundError({ entity: "Chat fan-out invocation", id: "fanout-other-session" });
    });
    app = buildApp({ stopChatFanout });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/fanouts/fanout-other-session/stop",
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Chat fan-out invocation was not found for this session." });
    expect(response.body).not.toContain("fanout-other-session");
  });

  it("rejects malformed aggregate identifiers before calling the service", async () => {
    const stopChatFanout = vi.fn();
    app = buildApp({ stopChatFanout });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/fanouts/%20/stop",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(stopChatFanout).not.toHaveBeenCalled();
  });
});

function buildApp(chatDelegate: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { chatDelegate } as never);
  registerChatFanoutRoutes(next);
  return next;
}
