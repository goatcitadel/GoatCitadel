import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChatToolRoutes } from "./chat.tools.js";

const artifactId = "11111111-1111-4111-8111-111111111111";

describe("chat tool routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  function createApp(chatTools: Record<string, unknown>) {
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", { chatTools } as never);
    registerChatToolRoutes(app);
    return app;
  }

  it("lists pending approvals with the active approval summary", async () => {
    const listChatPendingApprovals = vi.fn(() => [
      { approvalId: "stale-approval", stale: true },
      { approvalId: "active-approval" },
      { approvalId: "queued-approval", stale: false },
    ]);
    createApp({ listChatPendingApprovals });

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/chat/tools/approvals?sessionId=session-1",
    });
    const invalid = await app!.inject({
      method: "GET",
      url: "/api/v1/chat/tools/approvals",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { approvalId: "stale-approval", stale: true },
        { approvalId: "active-approval" },
        { approvalId: "queued-approval", stale: false },
      ],
      activeApprovalId: "active-approval",
      remainingCount: 1,
    });
    expect(listChatPendingApprovals).toHaveBeenCalledWith("session-1");
    expect(invalid.statusCode).toBe(400);
  });

  it("serves chat tool artifacts and reports validation or service errors", async () => {
    const getChatToolArtifactContent = vi.fn(async () => ({ artifactId, content: "hello" }));
    createApp({ getChatToolArtifactContent });

    const response = await app!.inject({
      method: "GET",
      url: `/api/v1/chat/tools/artifacts/${artifactId}?workspaceId=workspace-1`,
    });
    const invalid = await app!.inject({
      method: "GET",
      url: "/api/v1/chat/tools/artifacts/not-a-uuid",
    });

    getChatToolArtifactContent.mockRejectedValueOnce(new Error("artifact not found"));
    const failed = await app!.inject({
      method: "GET",
      url: `/api/v1/chat/tools/artifacts/${artifactId}?workspaceId=workspace-1`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ artifactId, content: "hello" });
    expect(getChatToolArtifactContent).toHaveBeenCalledWith(artifactId, { workspaceId: "workspace-1" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.params).toBeDefined();
    expect(invalid.json().error.query).toBeDefined();
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toEqual({ error: "artifact not found" });
  });

  it("approves and denies tool approvals with validation and service failures surfaced", async () => {
    const resolveChatToolApproval = vi.fn(async (_sessionId, _approvalId, decision, options) => ({
      allowScope: options?.allowScope ?? "once",
      grant: decision === "approve" ? { toolName: "shell.exec" } : undefined,
      resumed: decision === "approve",
      resumedTurnId: decision === "approve" ? "turn-1" : undefined,
      resumedRunId: decision === "approve" ? "run-1" : undefined,
    }));
    createApp({ resolveChatToolApproval });

    const defaultApproval = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/tools/approve",
      payload: { sessionId: "session-1", approvalId: "approval-1" },
    });
    const workspaceApproval = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/tools/approve",
      payload: { sessionId: "session-1", approvalId: "approval-2", allowScope: "workspace" },
    });
    const invalidApproval = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/tools/approve",
      payload: { sessionId: "", approvalId: "approval-3" },
    });
    resolveChatToolApproval.mockRejectedValueOnce(new Error("approval failed"));
    const failedApproval = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/tools/approve",
      payload: { sessionId: "session-1", approvalId: "approval-3" },
    });
    const invalidDenial = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/tools/deny",
      payload: { sessionId: "session-1", approvalId: "" },
    });
    const denial = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/tools/deny",
      payload: { sessionId: "session-1", approvalId: "approval-4" },
    });

    resolveChatToolApproval.mockRejectedValueOnce(new Error("approval already resolved"));
    const failedDenial = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/tools/deny",
      payload: { sessionId: "session-1", approvalId: "approval-5" },
    });

    expect(defaultApproval.statusCode).toBe(200);
    expect(defaultApproval.json()).toMatchObject({
      ok: true,
      approvalId: "approval-1",
      allowScope: "once",
      resumed: true,
      resumedTurnId: "turn-1",
      resumedRunId: "run-1",
    });
    expect(workspaceApproval.json()).toMatchObject({ allowScope: "workspace", approvalId: "approval-2" });
    expect(resolveChatToolApproval).toHaveBeenCalledWith("session-1", "approval-1", "approve", {
      allowScope: "once",
      resolvedBy: "operator-test",
    });
    expect(resolveChatToolApproval).toHaveBeenCalledWith("session-1", "approval-2", "approve", {
      allowScope: "workspace",
      resolvedBy: "operator-test",
    });
    expect(invalidApproval.statusCode).toBe(400);
    expect(failedApproval.statusCode).toBe(400);
    expect(failedApproval.json()).toEqual({ error: "approval failed" });
    expect(invalidDenial.statusCode).toBe(400);
    expect(denial.statusCode).toBe(200);
    expect(denial.json()).toEqual({ ok: true, approvalId: "approval-4" });
    expect(resolveChatToolApproval).toHaveBeenCalledWith("session-1", "approval-4", "reject", {
      resolvedBy: "operator-test",
    });
    expect(failedDenial.statusCode).toBe(400);
    expect(failedDenial.json()).toEqual({ error: "approval already resolved" });
  });
});
