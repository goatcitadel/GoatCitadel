import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { turnsRoutes } from "./turns.js";

function buildApp(
  createChatCompletion: ReturnType<typeof vi.fn>,
  getAgent?: ReturnType<typeof vi.fn>,
): FastifyInstance {
  const app = Fastify();
  app.decorate("services", {
    llm: { createChatCompletion },
    agents: {
      getAgent:
        getAgent ??
        (() => {
          throw new Error("agent not found");
        }),
    },
  } as never);
  return app;
}

const validBody = {
  session_id: "mg_session_1",
  turn_id: "mg_turn_1",
  agent_ref: "agent_1",
  operation: "mattergoat_collaborate",
  user_ref: "user_1",
  channel_ref: "chan_1",
  messages: [
    { role: "system", message: "system prompt", file_ids: [] },
    { role: "user", author_ref: "user_1", message: "alice: why is this failing?", file_ids: [] },
  ],
};

describe("turns routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("runs a stateless completion and maps the structured response", async () => {
    const createChatCompletion = vi.fn(async () => ({
      model: "gpt-x",
      choices: [
        {
          index: 0,
          message: {
            content: "Here is my answer.\n\n### Approval Needed\nNo\n\n<<MG:HANDOFF_COMPLETE:a:b:c>>",
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
      routing: { effectiveProviderId: "openai", effectiveModel: "gpt-x" },
    }));
    app = buildApp(createChatCompletion);
    await app.register(turnsRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/turns/complete",
      payload: validBody,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.message).toContain("Here is my answer.");
    // Markers are parsed from the model's own output and returned structurally.
    expect(json.markers).toEqual(["HANDOFF_COMPLETE"]);
    expect(json.needs_approval).toBe(false);
    expect(json.provider).toBe("openai");
    expect(json.model).toBe("gpt-x");
    expect(json.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(typeof json.run_id).toBe("string");

    // Messages mapped to role+content; author_ref is not forwarded to the model.
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    const arg = createChatCompletion.mock.calls[0][0] as { messages: unknown };
    expect(arg.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "alice: why is this failing?" },
    ]);
    expect(createChatCompletion.mock.calls[0][1]).toEqual({
      operationId: "mattergoat:mg_session_1:mg_turn_1:agent_1",
      dispatchGeneration: "mattergoat-turn:mg_turn_1",
      callKind: "delegation_worker",
      workspaceId: "default",
      sessionId: "mg_session_1",
      turnId: "mg_turn_1",
      taskId: "mattergoat:mattergoat_collaborate:mg_turn_1",
      agentId: "agent_1",
      workerId: "agent_1",
    });
  });

  it("runs as the referenced agent's provider/model and prepends its framing", async () => {
    const createChatCompletion = vi.fn(async () => ({
      choices: [{ index: 0, message: { content: "ok" } }],
      usage: {},
      routing: { effectiveProviderId: "anthropic", effectiveModel: "claude-x" },
    }));
    const getAgent = vi.fn(() => ({
      agentId: "agent_1",
      presetDefaults: {
        preferredProviderId: "anthropic",
        preferredModel: "claude-x",
        promptFraming: "You are the Researcher.",
      },
    }));
    app = buildApp(createChatCompletion, getAgent);
    await app.register(turnsRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/turns/complete",
      payload: validBody,
    });

    expect(res.statusCode).toBe(200);
    expect(getAgent).toHaveBeenCalledWith("agent_1");

    const arg = createChatCompletion.mock.calls[0][0] as {
      providerId?: string;
      model?: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(arg.providerId).toBe("anthropic");
    expect(arg.model).toBe("claude-x");
    // The agent's framing is prepended as a leading system message.
    expect(arg.messages[0]).toEqual({ role: "system", content: "You are the Researcher." });
    expect(arg.messages[1]).toEqual({ role: "system", content: "system prompt" });
  });

  it("falls back to the default when agent_ref does not resolve", async () => {
    const createChatCompletion = vi.fn(async () => ({
      choices: [{ index: 0, message: { content: "ok" } }],
      usage: {},
      routing: {},
    }));
    const getAgent = vi.fn(() => {
      throw new Error("agent not found");
    });
    app = buildApp(createChatCompletion, getAgent);
    await app.register(turnsRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/turns/complete",
      payload: validBody,
    });

    expect(res.statusCode).toBe(200);
    const arg = createChatCompletion.mock.calls[0][0] as {
      providerId?: string;
      model?: string;
      messages: unknown[];
    };
    expect(arg.providerId).toBeUndefined();
    expect(arg.model).toBeUndefined();
    expect(arg.messages).toHaveLength(2); // no framing prepended
  });

  it("detects an approval gate from the model output", async () => {
    const createChatCompletion = vi.fn(async () => ({
      choices: [{ index: 0, message: { content: "### Approval Needed\nYes — restarts a service." } }],
      usage: {},
      routing: {},
    }));
    app = buildApp(createChatCompletion);
    await app.register(turnsRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/turns/complete",
      payload: validBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().needs_approval).toBe(true);
  });

  it.each(["ModelUsageSettlementError", "ModelUsageDispatchUncertainError", "ModelUsageDispatchPersistenceError"])(
    "fails the turn closed and redacts %s",
    async (errorName) => {
      const accountingError = Object.assign(new Error(`canonical usage failure secret-token: ${errorName}`), {
        name: errorName,
      });
      const createChatCompletion = vi.fn(async () => {
        throw accountingError;
      });
      app = buildApp(createChatCompletion);
      await app.register(turnsRoutes);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/turns/complete",
        payload: validBody,
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "Internal server error" });
      expect(res.body).not.toContain("secret-token");
      expect(createChatCompletion).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          operationId: "mattergoat:mg_session_1:mg_turn_1:agent_1",
          dispatchGeneration: "mattergoat-turn:mg_turn_1",
          workspaceId: "default",
          sessionId: "mg_session_1",
          turnId: "mg_turn_1",
          agentId: "agent_1",
        }),
      );
    },
  );

  it("rejects an invalid body with 400", async () => {
    app = buildApp(vi.fn());
    await app.register(turnsRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/turns/complete",
      payload: { session_id: "x" },
    });

    expect(res.statusCode).toBe(400);
  });
});
