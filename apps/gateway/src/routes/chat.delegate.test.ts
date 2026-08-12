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

  it("keeps Explorer SSE observation detached from durable cancellation authority", async () => {
    const runChatDelegationStream = vi.fn(async function* () {
      yield {
        type: "done",
        result: {
          runId: "explorer-run",
          taskId: "task-1",
          status: "completed",
          steps: [],
          stitchedOutput: "done",
          citations: [],
        },
      };
    });
    app = buildApp({ runChatDelegationStream });

    const explorer = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate/stream",
      payload: {
        objective: "Inspect the workspace",
        roles: ["Workspace explorer"],
        executionProfile: "read_only_explorer",
        policyRunId: "durable-parent",
      },
    });
    expect(explorer.statusCode).toBe(200);
    expect(runChatDelegationStream.mock.calls[0]?.[2]).toEqual({});

    const standard = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate/stream",
      payload: { objective: "Delegate normally", roles: ["QA"] },
    });
    expect(standard.statusCode).toBe(200);
    expect(runChatDelegationStream.mock.calls[1]?.[2]?.abortSignal).toBeInstanceOf(AbortSignal);
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

  it.each([
    [
      "Windows",
      "Explorer failed below F:\\private\\operator\\workspace\\secret.txt",
      "Explorer failed below [outside-workspace-path] Authorization: [REDACTED]",
    ],
    [
      "POSIX",
      "Explorer failed below /home/operator/private/workspace/secret.txt",
      "Explorer failed below [outside-workspace-path]; Authorization: [REDACTED]",
    ],
  ])("contains %s host paths and secrets in direct explorer errors", async (_platform, serviceMessage, safeMessage) => {
    const chatDelegate = {
      runChatDelegation: vi.fn(async () => {
        throw new Error(`${serviceMessage}; Authorization: Bearer explorer-secret`);
      }),
    };
    app = buildApp(chatDelegate);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate",
      payload: {
        objective: "Inspect the workspace",
        roles: ["Workspace explorer"],
        mode: "sequential",
        executionProfile: "read_only_explorer",
        policyRunId: "durable-parent",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: safeMessage,
    });
    expect(response.body).not.toContain("operator");
    expect(response.body).not.toContain("explorer-secret");
  });

  it("lists server-owned scope candidates and accepts only opaque candidate ids", async () => {
    const candidateId = "a".repeat(64);
    const chatDelegate = {
      listChatDelegatedScopeCandidates: vi.fn(async () => ({
        runId: "run-1",
        stepId: "step-1",
        scopeHash: "b".repeat(64),
        candidates: [{ candidateId, label: "docs", scopeHash: "b".repeat(64) }],
      })),
      requestChatDelegatedScopeExpansion: vi.fn(async () => ({
        runId: "run-1",
        stepId: "step-1",
        approvalId: "approval-1",
        waitingForApproval: true,
      })),
    };
    app = buildApp(chatDelegate);
    const base = "/api/v1/chat/sessions/sess-1/delegations/run-1/steps/step-1";

    const listed = await app.inject({ method: "GET", url: `${base}/scope-candidates` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ candidates: [{ candidateId, label: "docs" }] });
    expect(chatDelegate.listChatDelegatedScopeCandidates).toHaveBeenCalledWith({
      sessionId: "sess-1",
      runId: "run-1",
      stepId: "step-1",
    });

    const rawPath = await app.inject({
      method: "POST",
      url: `${base}/scope-expansion`,
      payload: { path: "C:\\private", candidateIds: [candidateId] },
    });
    expect(rawPath.statusCode).toBe(400);
    expect(chatDelegate.requestChatDelegatedScopeExpansion).not.toHaveBeenCalled();

    const requested = await app.inject({
      method: "POST",
      url: `${base}/scope-expansion`,
      payload: { candidateIds: [candidateId] },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({ approvalId: "approval-1", waitingForApproval: true });
    expect(chatDelegate.requestChatDelegatedScopeExpansion).toHaveBeenCalledWith({
      sessionId: "sess-1",
      runId: "run-1",
      stepId: "step-1",
      candidateIds: [candidateId],
    });
  });

  it.each([
    [
      "candidate list",
      "Windows",
      "GET",
      "/scope-candidates",
      undefined,
      "Unable to inspect F:\\private\\operator\\workspace; Authorization: Bearer scope-secret",
      "Unable to inspect [outside-workspace-path] Authorization: [REDACTED]",
    ],
    [
      "candidate list",
      "POSIX",
      "GET",
      "/scope-candidates",
      undefined,
      "Unable to inspect /home/operator/private/workspace; Authorization: Bearer scope-secret",
      "Unable to inspect [outside-workspace-path]; Authorization: [REDACTED]",
    ],
    [
      "expansion",
      "Windows",
      "POST",
      "/scope-expansion",
      { candidateIds: ["a".repeat(64)] },
      "Unable to expand F:\\private\\operator\\workspace; Authorization: Bearer scope-secret",
      "Unable to expand [outside-workspace-path] Authorization: [REDACTED]",
    ],
    [
      "expansion",
      "POSIX",
      "POST",
      "/scope-expansion",
      { candidateIds: ["a".repeat(64)] },
      "Unable to expand /home/operator/private/workspace; Authorization: Bearer scope-secret",
      "Unable to expand [outside-workspace-path]; Authorization: [REDACTED]",
    ],
  ])(
    "contains %s %s host paths and secrets in public scope errors",
    async (_route, _platform, method, suffix, payload, serviceMessage, safeMessage) => {
      const reject = vi.fn(async () => {
        throw new Error(serviceMessage);
      });
      app = buildApp({
        listChatDelegatedScopeCandidates: reject,
        requestChatDelegatedScopeExpansion: reject,
      });

      const response = await app.inject({
        method,
        url: `/api/v1/chat/sessions/sess-1/delegations/run-1/steps/step-1${suffix}`,
        ...(payload ? { payload } : {}),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: safeMessage });
      expect(response.body).not.toContain("operator");
      expect(response.body).not.toContain("scope-secret");
    },
  );

  it("returns the latest persisted workspace explorer report for reload recovery", async () => {
    const getLatestChatWorkspaceExplorer = vi.fn(async () => ({
      item: {
        run: {
          runId: "explorer-run",
          parentRunId: "durable-parent",
          sessionId: "sess-1",
          taskId: "task-1",
          objective: "Find the owner",
          roles: ["workspace-explorer"],
          mode: "sequential",
          status: "completed",
          workflowTemplate: "read_only_workspace_explorer",
          stitchedOutput: "Gateway owns it.",
          citations: [],
          startedAt: "2026-08-12T00:00:00.000Z",
        },
        steps: [
          {
            stepId: "step-1",
            runId: "explorer-run",
            role: "workspace-explorer",
            status: "completed",
            index: 0,
            startedAt: "2026-08-12T00:00:00.000Z",
            scopeControl: {
              rootPath: "F:\\code\\personal-ai",
              requestedPaths: ["apps/gateway"],
              resolvedPaths: ["F:\\code\\personal-ai\\apps\\gateway"],
              approvedPaths: ["apps/gateway"],
              scopeHash: "scope-hash",
              dispatchGeneration: 1,
            },
          },
        ],
        explorer: {
          profile: "read_only_explorer",
          answer: "Gateway owns it.",
          evidenceReferences: ["apps/gateway/src/services/gateway-service.ts"],
          searchedScope: {
            kind: "server_owned_delegated_scope",
            approvedPaths: ["apps/gateway"],
            scopeHashes: ["scope-hash"],
          },
          partialResult: false,
          gaps: [],
        },
      },
    }));
    app = buildApp({ getLatestChatWorkspaceExplorer });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/delegations/latest-explorer",
    });

    expect(response.statusCode).toBe(200);
    expect(getLatestChatWorkspaceExplorer).toHaveBeenCalledWith("sess-1");
    expect(response.json()).toMatchObject({
      item: {
        run: { runId: "explorer-run", parentRunId: "durable-parent" },
        explorer: { answer: "Gateway owns it." },
        steps: [{ scopeControl: { approvedPaths: ["apps/gateway"], scopeHash: "scope-hash" } }],
      },
    });
    expect(response.body).not.toContain("rootPath");
    expect(response.body).not.toContain("resolvedPaths");
    expect(response.body).not.toContain("F:\\\\code");
  });

  it.each([
    ["latest explorer", "/api/v1/chat/sessions/sess-1/delegations/latest-explorer", "getLatestChatWorkspaceExplorer"],
    ["delegation detail", "/api/v1/chat/sessions/sess-1/delegations/explorer-run", "getChatDelegationRun"],
  ])("projects %s recovery errors without host paths or secrets", async (_label, url, method) => {
    const reject = vi.fn(async () => {
      throw new Error("ENOENT at F:\\private\\operator\\repo; Authorization: Bearer explorer-secret");
    });
    app = buildApp({ [method]: reject });

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "ENOENT at [outside-workspace-path] Authorization: [REDACTED]",
    });
    expect(response.body).not.toContain("operator");
    expect(response.body).not.toContain("explorer-secret");
  });
});

function buildApp(chatDelegate: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { chatDelegate } as never);
  registerChatDelegateRoutes(next);
  return next;
}
