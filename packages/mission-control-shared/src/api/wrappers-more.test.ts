import { beforeEach, describe, expect, it, vi } from "vitest";

import * as agentCatalog from "./agent-catalog";
import * as agentic from "./agentic";
import * as browserSessions from "./browser-sessions";
import * as capabilities from "./capabilities";
import * as cron from "./cron";
import * as demo from "./demo";
import * as durable from "./durable";
import * as recipes from "./orchestration-recipes";
import * as researchSearch from "./research-search";
import * as sessions from "./sessions";
import * as shellClient from "./shell-client";
import * as updateScout from "./update-scout";
import * as workspaces from "./workspaces";
import {
  ApiRequestError,
  inferDefaultGatewayBaseUrl,
  inferOriginSurface,
  isPrivateOrCarrierGradeIpv4,
  isTrustedGatewayHost,
  normalizeHttpMethod,
  parseApiError,
  shouldRetrySafeRequest,
  sleep,
  unwrapApiResponse,
} from "./http-internal";
import { consumeSseResponse, iterateSsePayloads, parseSseJson } from "./streaming";

const apiMocks = vi.hoisted(() => ({
  request: vi.fn(),
  connectEventStream: vi.fn(),
}));

vi.mock("./client-core.js", () => ({
  clearGatewayAuthState: vi.fn(),
  consumeGatewayAccessBootstrapFromLocation: vi.fn(),
  getGatewayApiBaseUrl: vi.fn(() => "http://localhost:8787"),
  getGatewayAuthStorageMode: vi.fn(() => "session"),
  persistGatewayAuthState: vi.fn(),
  preflightGatewayAccess: vi.fn(),
  readStoredGatewayAuthState: vi.fn(),
  request: apiMocks.request,
  setGatewayAuthStorageMode: vi.fn(),
}));

vi.mock("./client.js", () => ({
  connectEventStream: apiMocks.connectEventStream,
}));

async function expectCall(operation: Promise<unknown>, path: string, init?: Partial<RequestInit>) {
  await operation;
  const [actualPath, actualInit] = apiMocks.request.mock.calls.at(-1) ?? [];
  expect(actualPath).toBe(path);
  if (init) {
    expect(actualInit).toMatchObject(init);
  }
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectSsePayloads(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string[]> {
  const payloads: string[] = [];
  for await (const payload of iterateSsePayloads(body, signal)) {
    payloads.push(payload);
  }
  return payloads;
}

describe("additional shared API wrappers", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    apiMocks.request.mockReset();
    apiMocks.request.mockResolvedValue({ ok: true });
  });

  it("routes capability, durable, workspace, cron, session, agentic, and catalog APIs", async () => {
    await expectCall(capabilities.fetchCapabilityCatalog(), "/api/v1/capabilities/catalog?scope=inspectable");
    await expectCall(capabilities.fetchCapabilityCatalog("all" as never), "/api/v1/capabilities/catalog?scope=all");
    await expectCall(capabilities.fetchCapabilityCatalogSnapshot("snap/1"), "/api/v1/capabilities/snapshots/snap%2F1");
    await expectCall(capabilities.fetchCapabilityProposals(999), "/api/v1/capabilities/proposals?limit=500");
    await expectCall(
      capabilities.createCapabilityProposal({ proposalKind: "skill", title: "T", summary: "S", payload: {} }),
      "/api/v1/capabilities/proposals",
      {
        method: "POST",
      },
    );
    await expectCall(capabilities.fetchCapabilityProposal("proposal/1"), "/api/v1/capabilities/proposals/proposal%2F1");
    await expectCall(
      capabilities.fetchCapabilityCandidate("candidate/1"),
      "/api/v1/capabilities/candidates/candidate%2F1",
    );
    await expectCall(
      capabilities.promoteCapabilityCandidate("candidate/1", "version/1"),
      "/api/v1/capabilities/candidates/candidate%2F1/promote",
      {
        method: "POST",
      },
    );
    await expectCall(
      capabilities.revokeCapabilityCandidate("candidate/1"),
      "/api/v1/capabilities/candidates/candidate%2F1/revoke",
      {
        method: "POST",
      },
    );
    await expectCall(
      capabilities.rollbackCapabilityCandidate("candidate/1", "version/0"),
      "/api/v1/capabilities/candidates/candidate%2F1/rollback",
      {
        method: "POST",
      },
    );
    await expectCall(capabilities.fetchCodeModeRuns(0), "/api/v1/code-mode/runs?limit=1");
    await expectCall(
      capabilities.fetchCodeModeRuns({
        limit: 5,
        workspaceId: "workspace/1",
        sessionId: "session/1",
        turnId: "turn/1",
        status: "failed",
      }),
      "/api/v1/code-mode/runs?limit=5&workspaceId=workspace%2F1&sessionId=session%2F1&turnId=turn%2F1&status=failed",
    );
    await expectCall(capabilities.fetchCodeModeRun("run/1"), "/api/v1/code-mode/runs/run%2F1");
    await expectCall(
      capabilities.fetchCodeModeRun("run/1", {
        sessionId: "session/1",
        turnId: "turn/1",
        workspaceId: "workspace/1",
      }),
      "/api/v1/code-mode/runs/run%2F1?sessionId=session%2F1&turnId=turn%2F1&workspaceId=workspace%2F1",
    );
    await expectCall(capabilities.createCodeModeRun({ prompt: "ship it" } as never), "/api/v1/code-mode/runs", {
      method: "POST",
    });

    await expectCall(durable.createDurableRun({ kind: "chat" } as never), "/api/v1/durable/runs", { method: "POST" });
    await expectCall(durable.fetchDurableRun("run/1"), "/api/v1/durable/runs/run%2F1");
    await expectCall(durable.fetchObserveRunTrace("run/1"), "/api/v1/observe/runs/run%2F1/trace");
    await expectCall(
      durable.fetchDurableRunTimeline("run/1", 9999),
      "/api/v1/durable/runs/run%2F1/timeline?limit=2000",
    );
    await expectCall(durable.pauseDurableRun("run/1", "operator"), "/api/v1/durable/runs/run%2F1/pause", {
      method: "POST",
    });
    await expectCall(durable.resumeDurableRun("run/1"), "/api/v1/durable/runs/run%2F1/resume", { method: "POST" });
    await expectCall(durable.cancelDurableRun("run/1"), "/api/v1/durable/runs/run%2F1/cancel", { method: "POST" });
    await expectCall(durable.retryDurableRun("run/1", { reason: "retry" }), "/api/v1/durable/runs/run%2F1/retry", {
      method: "POST",
    });
    await expectCall(
      durable.wakeDurableRun("run/1", { eventKey: "approval.resolved" }),
      "/api/v1/durable/runs/run%2F1/events/wake",
      {
        method: "POST",
      },
    );
    await expectCall(durable.recoverDurableDeadLetter("entry/1"), "/api/v1/durable/dead-letters/entry%2F1/recover", {
      method: "POST",
    });

    await expectCall(workspaces.fetchWorkspaces("all", 999), "/api/v1/workspaces?view=all&limit=500");
    await expectCall(workspaces.createWorkspace({ name: "Workspace" } as never), "/api/v1/workspaces", {
      method: "POST",
    });
    await expectCall(
      workspaces.updateWorkspace("workspace/1", { name: "New" } as never),
      "/api/v1/workspaces/workspace%2F1",
      {
        method: "PATCH",
      },
    );
    await expectCall(workspaces.archiveWorkspace("workspace/1"), "/api/v1/workspaces/workspace%2F1/archive", {
      method: "POST",
    });
    await expectCall(workspaces.restoreWorkspace("workspace/1"), "/api/v1/workspaces/workspace%2F1/restore", {
      method: "POST",
    });
    await expectCall(workspaces.fetchGlobalGuidance(), "/api/v1/guidance/global");
    await expectCall(workspaces.updateGlobalGuidance("agents" as never, "body"), "/api/v1/guidance/global/agents", {
      method: "PUT",
    });
    await expectCall(workspaces.fetchWorkspaceGuidance("workspace/1"), "/api/v1/workspaces/workspace%2F1/guidance");
    await expectCall(
      workspaces.updateWorkspaceGuidance("workspace/1", "agents" as never, "body"),
      "/api/v1/workspaces/workspace%2F1/guidance/agents",
      { method: "PUT" },
    );

    await expectCall(cron.fetchCronJobs(), "/api/v1/cron/jobs");
    await expectCall(cron.fetchCronJob("job/1"), "/api/v1/cron/jobs/job%2F1");
    await expectCall(cron.createCronJob({ jobId: "job", name: "Job", schedule: "* * * * *" }), "/api/v1/cron/jobs", {
      method: "POST",
    });
    await expectCall(cron.updateCronJob("job/1", { enabled: false }), "/api/v1/cron/jobs/job%2F1", { method: "PATCH" });
    await expectCall(cron.startCronJob("job/1"), "/api/v1/cron/jobs/job%2F1/start", { method: "POST" });
    await expectCall(cron.pauseCronJob("job/1"), "/api/v1/cron/jobs/job%2F1/pause", { method: "POST" });
    await expectCall(cron.runCronJobNow("job/1"), "/api/v1/cron/jobs/job%2F1/run", { method: "POST" });
    await expectCall(cron.fetchCronReviewQueue(9999), "/api/v1/cron/review-queue?limit=1000");
    await expectCall(cron.retryCronReviewQueueItem("item/1"), "/api/v1/cron/review-queue/item%2F1/retry", {
      method: "POST",
    });
    await expectCall(cron.fetchCronRunDiff("run/1"), "/api/v1/cron/runs/run%2F1/diff");
    await expectCall(cron.deleteCronJob("job/1"), "/api/v1/cron/jobs/job%2F1", { method: "DELETE" });
    await expectCall(demo.fetchDemoState(), "/api/v1/demo/state");
    await expectCall(demo.bootstrapDemo(), "/api/v1/demo/bootstrap", { method: "POST" });
    await expectCall(
      browserSessions.fetchBrowserSessions({ workspaceId: "workspace/1", status: "active", limit: 999 }),
      "/api/v1/browser-sessions?workspaceId=workspace%2F1&status=active&limit=500",
    );
    await expectCall(
      browserSessions.createBrowserSession({ workspaceId: "workspace/1", label: "Ops browser" }),
      "/api/v1/browser-sessions",
      { method: "POST" },
    );
    await expectCall(browserSessions.fetchBrowserSession("session/1"), "/api/v1/browser-sessions/session%2F1");
    await expectCall(browserSessions.closeBrowserSession("session/1"), "/api/v1/browser-sessions/session%2F1", {
      method: "DELETE",
    });
    await expectCall(
      browserSessions.createBrowserSessionGrant("session/1", { actorId: "operator", scopes: ["read"] }),
      "/api/v1/browser-sessions/session%2F1/grants",
      { method: "POST" },
    );
    await expectCall(
      browserSessions.fetchBrowserSessionGrants("session/1", { status: "active", limit: 999 }),
      "/api/v1/browser-sessions/session%2F1/grants?status=active&limit=500",
    );
    await expectCall(
      browserSessions.rotateBrowserSessionGrant("session/1", "grant/1"),
      "/api/v1/browser-sessions/session%2F1/grants/grant%2F1/rotate",
      { method: "POST" },
    );
    await expectCall(
      browserSessions.revokeBrowserSessionGrant("session/1", "grant/1"),
      "/api/v1/browser-sessions/session%2F1/grants/grant%2F1",
      { method: "DELETE" },
    );
    await expectCall(
      browserSessions.fetchBrowserSessionEvents("session/1", 999),
      "/api/v1/browser-sessions/session%2F1/events?limit=500",
    );

    await expectCall(sessions.fetchSessions(), "/api/v1/sessions?limit=50");
    await expectCall(sessions.fetchSessionSummary("session/1"), "/api/v1/sessions/session%2F1/summary");
    await expectCall(sessions.fetchSessionTimeline("session/1", 0), "/api/v1/sessions/session%2F1/timeline?limit=1");
    await expectCall(
      sessions.fetchRuntimeLifecycle({ sessionId: "s", turnId: "t", runId: "r", approvalId: "a", taskId: "task" }),
      "/api/v1/runtime/lifecycle?sessionId=s&turnId=t&runId=r&approvalId=a&taskId=task",
    );
    await expectCall(
      sessions.fetchRuntimeLifecycleExport({
        sessionId: "s",
        includeTranscript: false,
        includeTimeline: true,
        timelineLimit: 9999,
        format: "trust_report",
      }),
      "/api/v1/runtime/lifecycle/export?sessionId=s&includeTranscript=false&includeTimeline=true&timelineLimit=1000&format=trust_report",
    );

    await expectCall(agentic.fetchAgenticRuntimeAvailability(), "/api/v1/agentic/availability");
    await expectCall(
      agentic.fetchAgenticChannelDeliveries({ connectionId: "conn/1", limit: 5 }),
      "/api/v1/comms/deliveries?connectionId=conn%2F1&limit=5",
    );
    await expectCall(
      agentic.fetchAgenticRuns({
        workspaceId: "w",
        surface: "cowork" as never,
        sessionId: "s",
        boardId: "b",
        parentRunId: "p",
        status: "running" as never,
        cursor: "c",
        limit: 9,
      }),
      "/api/v1/agentic/runs?workspaceId=w&surface=cowork&sessionId=s&boardId=b&parentRunId=p&status=running&cursor=c&limit=9",
    );
    await expectCall(
      agentic.fetchAgenticRunTree("run/1", { workspaceId: "w" }),
      "/api/v1/agentic/runs/run%2F1/tree?workspaceId=w",
    );
    await expectCall(
      agentic.controlAgenticRun("run/1", { action: "cancel" } as never, { workspaceId: "w" }),
      "/api/v1/agentic/runs/run%2F1/control?workspaceId=w",
      {
        method: "POST",
      },
    );

    await expectCall(
      agentCatalog.fetchImportedAgentCatalog({
        workspaceId: "w",
        division: "ops",
        search: "qa",
        state: "active" as never,
        parseStatus: "parsed" as never,
        limit: 5000,
      }),
      "/api/v1/agents/catalog?workspaceId=w&division=ops&search=qa&state=active&parseStatus=parsed&limit=1000",
    );
    await expectCall(agentCatalog.fetchImportedAgentCatalog(), "/api/v1/agents/catalog?limit=300");
    await expectCall(agentCatalog.fetchImportedAgentCatalogEntry("entry/1"), "/api/v1/agents/catalog/entry%2F1");
    await expectCall(agentCatalog.importAgencyAgentCatalog(), "/api/v1/agents/catalog/import/agency-agents", {
      method: "POST",
    });
    await expectCall(
      agentCatalog.patchImportedAgentCatalogState("entry/1", { state: "active" } as never),
      "/api/v1/agents/catalog/entry%2F1/state",
      {
        method: "PATCH",
      },
    );
    await expectCall(
      agentCatalog.activateImportedAgentCatalogEntry("entry/1", { sessionId: "session" } as never),
      "/api/v1/agents/catalog/entry%2F1/activate-session",
      { method: "POST" },
    );

    await expectCall(shellClient.fetchWorkspaces("archived", 0), "/api/v1/workspaces?view=archived&limit=1");
    await expectCall(
      shellClient.createGatewayDeviceAccessRequest({ deviceLabel: "Phone" } as never),
      "/api/v1/auth/device-requests",
      {
        method: "POST",
      },
    );
    await expectCall(
      shellClient.pollGatewayDeviceAccessRequestStatus("request/1", "secret"),
      "/api/v1/auth/device-requests/request%2F1/status",
      { headers: { "x-goatcitadel-device-request-secret": "secret" } },
    );
    await expectCall(
      shellClient.resolveApproval("approval/1", { decision: "approve" } as never),
      "/api/v1/approvals/approval%2F1/resolve",
      {
        method: "POST",
      },
    );
    await expectCall(
      shellClient.resolveApprovalWithRemoteToken("token", "reject"),
      "/api/v1/approvals/remote-resolve",
      {
        method: "POST",
      },
    );

    await expectCall(
      recipes.previewWorkflowRecipe({ request: "plan" } as never),
      "/api/v1/orchestration/recipes/preview",
      {
        method: "POST",
      },
    );
    await expectCall(
      recipes.createWorkflowRecipePlan({ request: "plan" } as never),
      "/api/v1/orchestration/recipes/plans",
      {
        method: "POST",
      },
    );
    await expectCall(
      recipes.draftAutomationRecipe({ taskDescription: "Review updates" }),
      "/api/v1/orchestration/recipes/draft-automation",
      {
        method: "POST",
      },
    );
    await expectCall(recipes.fetchWorkflowRecipeTemplates(), "/api/v1/orchestration/recipes/templates");
    await expectCall(
      researchSearch.runResearchSearch({ query: "provider pricing", engines: ["google"] }),
      "/api/v1/research/search",
      {
        method: "POST",
      },
    );
    await expectCall(
      updateScout.runUpdateScout({ sources: [{ sourceRef: "https://clawhub.ai/maximeprades/auto-updater" }] }),
      "/api/v1/update-scout/reports",
      {
        method: "POST",
      },
    );
  });
});

describe("streaming and HTTP helpers", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("parses SSE streams, ignores empty events, and throws on stream errors", async () => {
    const chunks: unknown[] = [];
    await consumeSseResponse(
      sseStream([": comment\n\n", 'event: chunk\ndata: {"type":"delta","text":"hi"}\n\n', 'data: {"type":"done"}\n\n']),
      (chunk) => chunks.push(chunk),
    );
    expect(chunks).toEqual([{ type: "delta", text: "hi" }, { type: "done" }]);

    await expect(
      consumeSseResponse(sseStream(['data: {"type":"error","error":"bad"}\n\n']), () => undefined),
    ).rejects.toThrow("bad");
    // A final `data:` event not terminated by a blank line is flushed at EOF
    // (legal SSE) rather than thrown away as incomplete.
    await expect(collectSsePayloads(sseStream(['data: {"final":true}']))).resolves.toEqual(['{"final":true}']);
    // Residual bytes with no `data:` line are still treated as incomplete.
    await expect(collectSsePayloads(sseStream(["event: chunk\nid: 1"]))).rejects.toThrow("incomplete");
    await expect(() => parseSseJson("{not json")).toThrow("Malformed SSE event payload");
  });

  it("handles aborts, oversized buffers, and partial multi-line SSE data", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collectSsePayloads(sseStream(['data: {"type":"delta"}\n\n']), controller.signal)).resolves.toEqual([]);

    const originalDomException = globalThis.DOMException;
    vi.stubGlobal("DOMException", undefined);
    const fallbackController = new AbortController();
    fallbackController.abort();
    await expect(
      collectSsePayloads(sseStream(['data: {"type":"delta"}\n\n']), fallbackController.signal),
    ).resolves.toEqual([]);
    vi.stubGlobal("DOMException", originalDomException);

    await expect(collectSsePayloads(sseStream(['data: {"a":1}\ndata: {"b":2}\n\n']))).resolves.toEqual([
      '{"a":1}\n{"b":2}',
    ]);

    await expect(collectSsePayloads(sseStream(["x".repeat(256_001)]))).rejects.toThrow("buffer limit");
  });

  it("normalizes gateway HTTP behavior and trusted host detection", async () => {
    expect(normalizeHttpMethod()).toBe("GET");
    expect(normalizeHttpMethod("post")).toBe("POST");
    const networkError = new ApiRequestError("network", { kind: "network", method: "GET", path: "/" });
    const httpError = new ApiRequestError("retry", { kind: "http", method: "GET", path: "/", status: 503 });
    expect(shouldRetrySafeRequest("GET", networkError)).toBe(true);
    expect(shouldRetrySafeRequest("GET", httpError)).toBe(true);
    expect(shouldRetrySafeRequest("POST", networkError)).toBe(false);
    expect(unwrapApiResponse<{ ok: boolean }>({ success: true, data: { ok: true } })).toEqual({ ok: true });
    expect(parseApiError(JSON.stringify({ error: "no", authMode: "token" }))).toEqual({
      body: { error: "no", authMode: "token" },
      authMode: "token",
    });
    expect(parseApiError("plain text")).toEqual({ body: "plain text" });
    expect(isPrivateOrCarrierGradeIpv4("10.1.2.3")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateOrCarrierGradeIpv4("999.1.1.1")).toBe(false);
    expect(isTrustedGatewayHost("localhost")).toBe(true);
    expect(isTrustedGatewayHost("box.ts.net")).toBe(true);
    expect(isTrustedGatewayHost("api.example.com", ".example.com")).toBe(true);
    expect(isTrustedGatewayHost("api.example.com", "api.example.com")).toBe(true);
    expect(isTrustedGatewayHost("evil.com")).toBe(false);
    expect(inferOriginSurface("/api/v1/chat/stream")).toBe("chat");
    expect(inferOriginSurface("/api/v1/addons")).toBe("addons");
    expect(inferOriginSurface("/api/v1/voice")).toBe("voice");
    expect(inferOriginSurface("/api/v1/mcp")).toBe("mcp");
    expect(inferOriginSurface("/api/v1/integrations")).toBe("integrations");
    expect(inferOriginSurface("/api/v1/other")).toBe("app");

    vi.useFakeTimers();
    const slept = sleep(10);
    vi.advanceTimersByTime(10);
    await slept;
  });

  it("infers safe gateway URLs and falls back from untrusted browser hosts", () => {
    expect(inferDefaultGatewayBaseUrl()).toBe("http://127.0.0.1:8787");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("window", {
      location: {
        protocol: "https:",
        hostname: "untrusted.example",
      },
    });
    expect(inferDefaultGatewayBaseUrl()).toBe("https://127.0.0.1:8787");
    expect(warn).toHaveBeenCalled();
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        hostname: "localhost",
      },
    });
    expect(inferDefaultGatewayBaseUrl()).toBe("http://localhost:8787");
    warn.mockRestore();
  });
});
