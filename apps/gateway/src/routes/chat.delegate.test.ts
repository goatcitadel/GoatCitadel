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
    const rawResponse = {
      runId: "run-1",
      taskId: "task-1",
      status: "completed",
      steps: [
        {
          stepId: "step-1",
          runId: "run-1",
          role: "Researcher",
          status: "completed",
          index: 0,
          startedAt: "2026-07-09T00:00:00.000Z",
          output: "Authorization: Bearer delegated-step-secret",
        },
      ],
      stitchedOutput: "Result https://discord.com/api/webhooks/123/delegated-path-secret",
      citations: [],
    };
    const rawRun = {
      runId: "run-1",
      sessionId: "sess-1",
      taskId: "task-1",
      objective: "Operator objective Authorization: Bearer user-owned-secret",
      roles: ["Researcher"],
      mode: "sequential",
      status: "completed",
      startedAt: "2026-07-09T00:00:00.000Z",
      citations: [],
      finalSummary: "Provider used apiKey=get-run-secret",
    };
    const chatDelegate = {
      runChatDelegation: vi.fn(async () => rawResponse),
      getChatDelegationRun: vi.fn(() => rawRun),
      suggestChatDelegation: vi.fn(async () => ({
        suggestion: {
          suggestionId: "suggestion-1",
          sessionId: "sess-1",
          objective: "Operator suggestion Authorization: Bearer suggestion-user-secret",
          roles: ["Planner"],
          mode: "sequential",
          confidence: 0.9,
          reason: "Provider failed with Authorization: Bearer suggestion-reason-secret",
          source: "manual",
          createdAt: "2026-07-09T00:00:00.000Z",
        },
      })),
      acceptChatDelegation: vi.fn(async () => ({ ...rawResponse, runId: "run-accepted" })),
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
    expect(run.json()).toMatchObject({
      steps: [{ output: "Authorization: [REDACTED]" }],
      stitchedOutput: "Result https://discord.com/api/webhooks/[REDACTED]/[REDACTED]",
    });
    expect(chatDelegate.runChatDelegation).toHaveBeenCalledWith("sess-1", {
      objective: "Review the launch plan",
      roles: ["Researcher", "QA"],
      mode: "parallel",
      surfaceMode: "chat",
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
    expect(fetched.json()).toMatchObject({
      objective: "Operator objective Authorization: Bearer user-owned-secret",
      finalSummary: "Provider used apiKey=[REDACTED]",
    });
    expect(chatDelegate.getChatDelegationRun).toHaveBeenCalledWith("sess-1", "run-1");

    const suggested = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate/suggest",
      payload: { objective: "Plan it", roles: ["Planner"], mode: "sequential" },
    });
    expect(suggested.statusCode).toBe(200);
    expect(suggested.json()).toMatchObject({
      suggestion: {
        objective: "Operator suggestion Authorization: Bearer suggestion-user-secret",
        reason: "Provider failed with Authorization: [REDACTED]",
      },
    });
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
    expect(accepted.json()).toMatchObject({
      steps: [{ output: "Authorization: [REDACTED]" }],
      stitchedOutput: "Result https://discord.com/api/webhooks/[REDACTED]/[REDACTED]",
    });
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
    expect(rawResponse.steps[0]?.output).toContain("delegated-step-secret");
    expect(rawRun.finalSummary).toContain("get-run-secret");
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
