import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PolicyViolationError } from "@goatcitadel/contracts";
import { registerChatDelegateRoutes } from "./chat.delegate.js";

describe("chat delegate routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("runs, fetches, suggests, and accepts delegation through the service facade", async () => {
    const chatDelegate = {
      runChatDelegation: vi.fn(async () => ({ runId: "run-1", status: "completed" })),
      getChatDelegationRun: vi.fn(() => ({ runId: "run-1", status: "completed" })),
      suggestChatDelegation: vi.fn(async () => ({ suggestionId: "suggestion-1" })),
      acceptChatDelegation: vi.fn(async () => ({ runId: "run-accepted" })),
    };
    app = buildApp(chatDelegate);

    const run = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate",
      payload: {
        objective: "Review the launch plan",
        roles: ["Researcher", "QA"],
        mode: "parallel",
        surfaceMode: "cowork",
        providerId: "openai",
        model: "gpt-5.4",
        steps: [{ role: "Researcher", parallelizable: true }],
        permissionProfileId: "profile-parent",
        localOperatorOverrideId: "override-parent",
      },
    });
    expect(run.statusCode).toBe(200);
    expect(chatDelegate.runChatDelegation).toHaveBeenCalledWith("sess-1", {
      objective: "Review the launch plan",
      roles: ["Researcher", "QA"],
      mode: "parallel",
      surfaceMode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      steps: [{ role: "Researcher", parallelizable: true }],
      permissionProfileId: "profile-parent",
      localOperatorOverrideId: "override-parent",
    });

    const fetched = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/delegations/run-1",
    });
    expect(fetched.statusCode).toBe(200);
    expect(chatDelegate.getChatDelegationRun).toHaveBeenCalledWith("sess-1", "run-1");

    const suggested = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate/suggest",
      payload: { objective: "Plan it", roles: ["Planner"], mode: "sequential" },
    });
    expect(suggested.statusCode).toBe(200);
    expect(chatDelegate.suggestChatDelegation).toHaveBeenCalledWith("sess-1", {
      objective: "Plan it",
      roles: ["Planner"],
      mode: "sequential",
    });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate/accept",
      payload: {
        suggestionId: "suggestion-1",
        objective: "Run it",
        roles: ["Planner"],
        mode: "sequential",
        steps: [{ stepId: "step-1", role: "Planner", index: 0 }],
        permissionProfileId: "profile-parent",
        localOperatorOverrideId: "override-parent",
        policyRunId: "parent-run-1",
        policyTaskId: "parent-task-1",
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(chatDelegate.acceptChatDelegation).toHaveBeenCalledWith("sess-1", {
      suggestionId: "suggestion-1",
      objective: "Run it",
      roles: ["Planner"],
      mode: "sequential",
      steps: [{ stepId: "step-1", role: "Planner", index: 0 }],
      permissionProfileId: "profile-parent",
      localOperatorOverrideId: "override-parent",
      policyRunId: "parent-run-1",
      policyTaskId: "parent-task-1",
    });
  });

  it("maps validation, service, not-found, and Goat errors to the public route contract", async () => {
    const chatDelegate = {
      runChatDelegation: vi.fn(async () => {
        throw new Error("delegation failed");
      }),
      getChatDelegationRun: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("run not found");
        })
        .mockImplementationOnce(() => {
          throw new PolicyViolationError({ message: "delegation forbidden" });
        }),
      suggestChatDelegation: vi.fn(async () => {
        throw new Error("suggest failed");
      }),
      acceptChatDelegation: vi.fn(async () => {
        throw new Error("accept failed");
      }),
    };
    app = buildApp(chatDelegate);

    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/sessions/sess-1/delegate", payload: { roles: [] } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/delegate",
        payload: { objective: "run", roles: ["QA"] },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/delegations/run-missing" }),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/delegations/run-forbidden" }),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/sessions/sess-1/delegate/suggest", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/delegate/suggest",
        payload: { objective: "suggest", roles: ["QA"] },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/delegate/accept",
        payload: { objective: "accept", roles: ["QA"] },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });
});

function buildApp(chatDelegate: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { chatDelegate } as never);
  registerChatDelegateRoutes(next);
  return next;
}
