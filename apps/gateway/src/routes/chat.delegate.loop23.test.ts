import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChatDelegateRoutes } from "./chat.delegate.js";

describe("chat delegate route defaults loop 23", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("defaults omitted delegation modes to sequential without reshaping optional fields", async () => {
    const chatDelegate = {
      acceptChatDelegation: vi.fn(async () => ({ runId: "accepted" })),
      getChatDelegationRun: vi.fn(),
      runChatDelegation: vi.fn(async () => ({ runId: "run-1" })),
      suggestChatDelegation: vi.fn(async () => ({ suggestionId: "suggest-1" })),
    };
    app = Fastify();
    app.decorate("services", { chatDelegate } as never);
    registerChatDelegateRoutes(app);

    const run = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/delegate",
      payload: {
        objective: "Review the run",
        roles: ["QA"],
      },
    });
    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/delegate/accept",
      payload: {
        objective: "Accept the run",
        roles: ["QA"],
      },
    });

    expect(run.statusCode).toBe(200);
    expect(accept.statusCode).toBe(200);
    expect(chatDelegate.runChatDelegation).toHaveBeenCalledWith("session-1", {
      objective: "Review the run",
      roles: ["QA"],
      mode: "sequential",
    });
    expect(chatDelegate.acceptChatDelegation).toHaveBeenCalledWith("session-1", {
      objective: "Accept the run",
      roles: ["QA"],
    });
  });
});
