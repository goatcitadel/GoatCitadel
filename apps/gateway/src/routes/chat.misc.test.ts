import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
import { registerChatMiscRoutes } from "./chat.misc.js";

describe("chat misc routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  function createApp(chatSupport: Record<string, unknown>) {
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      chatSupport: { assertCallerPolicyScope: vi.fn(async () => undefined), ...chatSupport },
    } as never);
    registerChatMiscRoutes(app);
    return app;
  }

  it("server-stamps slash-command approval resolution with the authenticated actor", async () => {
    const parseChatCommand = vi.fn(async () => ({
      ok: true,
      command: "/approve",
      args: ["approval-1"],
      message: "Approved approval-1.",
    }));
    createApp({ parseChatCommand });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/commands/parse",
      payload: { commandText: "/approve approval-1" },
    });

    expect(response.statusCode).toBe(200);
    expect(parseChatCommand).toHaveBeenCalledWith(
      "session-1",
      "/approve approval-1",
      expect.objectContaining({
        resolvedBy: "operator-test",
        operatorId: "operator-test",
        authActorId: "operator-test",
        authActorSource: "loopback",
        surface: "chat",
      }),
    );
  });

  it("preserves parent governance fields on slash-command delegation", async () => {
    const parseChatCommand = vi.fn(async () => ({
      ok: true,
      command: "/delegate",
      args: ["qa"],
      message: "Delegation delegate-1 completed with 1 steps.",
    }));
    createApp({ parseChatCommand });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/commands/parse",
      payload: {
        commandText: "/delegate QA :: verify the release",
        policyRunId: "parent-run-1",
        policyTaskId: "parent-task-1",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
        surface: "cowork",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseChatCommand).toHaveBeenCalledWith(
      "session-1",
      "/delegate QA :: verify the release",
      expect.objectContaining({
        policyRunId: "parent-run-1",
        policyTaskId: "parent-task-1",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
        operatorId: "operator-test",
        authActorId: "operator-test",
        authActorSource: "loopback",
        surface: "chat",
      }),
    );
  });

  it("server-stamps research policy context while preserving parent run fields", async () => {
    const runChatResearch = vi.fn(async () => ({
      runId: "research-run-1",
      query: "policy context",
      summary: "done",
      sources: [],
    }));
    createApp({ runChatResearch });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/research/run",
      payload: {
        query: "policy context",
        mode: "quick",
        policyRunId: "parent-run-1",
        policyTaskId: "parent-task-1",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runChatResearch).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        policyRunId: "parent-run-1",
        policyTaskId: "parent-task-1",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
        operatorId: "operator-test",
        authActorId: "operator-test",
        authActorSource: "loopback",
        surface: "chat",
      }),
    );
  });

  it("checks that caller policy ids belong to the session and rejects foreign ones", async () => {
    const parseChatCommand = vi.fn();
    const runChatResearch = vi.fn();
    const assertCallerPolicyScope = vi.fn(async (_sessionId: string, scope: { policyTaskId?: string }) => {
      if (scope.policyTaskId === "foreign-task") {
        throw new ConflictError({ message: "policyTaskId foreign-task does not belong to Chat session session-1." });
      }
    });
    createApp({ parseChatCommand, runChatResearch, assertCallerPolicyScope });

    const command = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/commands/parse",
      payload: { commandText: "/delegate QA :: verify", policyRunId: "parent-run-1", policyTaskId: "foreign-task" },
    });
    const research = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/research/run",
      payload: { query: "policy context", policyTaskId: "foreign-task" },
    });

    for (const response of [command, research]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "policyTaskId foreign-task does not belong to Chat session session-1.",
      });
    }
    expect(assertCallerPolicyScope).toHaveBeenNthCalledWith(1, "session-1", {
      policyRunId: "parent-run-1",
      policyTaskId: "foreign-task",
    });
    expect(assertCallerPolicyScope).toHaveBeenNthCalledWith(2, "session-1", { policyTaskId: "foreign-task" });
    expect(parseChatCommand).not.toHaveBeenCalled();
    expect(runChatResearch).not.toHaveBeenCalled();
  });

  it("server-stamps proactive triggers with the authenticated actor for later policy decisions", async () => {
    const triggerChatSessionProactive = vi.fn(async () => ({
      runId: "proactive-run-1",
      sessionId: "session-1",
      status: "completed",
    }));
    createApp({ triggerChatSessionProactive });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/proactive/trigger",
      payload: { source: "manual", reason: "operator requested a check-in" },
    });

    expect(response.statusCode).toBe(200);
    expect(triggerChatSessionProactive).toHaveBeenCalledWith("session-1", {
      source: "manual",
      reason: "operator requested a check-in",
      operatorId: "operator-test",
      authActorId: "operator-test",
      authActorSource: "loopback",
    });
  });

  it("awaits proactive run lists before serializing response items", async () => {
    const listChatSessionProactiveRuns = vi.fn(async () => [
      {
        runId: "proactive-run-1",
        sessionId: "session-1",
        status: "suggested",
      },
    ]);
    createApp({ listChatSessionProactiveRuns });

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/session-1/proactive/runs?limit=12",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ runId: "proactive-run-1", sessionId: "session-1", status: "suggested" }],
    });
    expect(listChatSessionProactiveRuns).toHaveBeenCalledWith("session-1", 12);
  });
});
