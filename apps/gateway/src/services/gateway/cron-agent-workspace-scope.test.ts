import { expect, it } from "vitest";
import { resolveCronAgentWorkspaceScope } from "./cron-agent-workspace-scope.js";
it("binds reviewed Chat work to its actual private workspace inside the active job citadel", async () => {
  const workspace = { workspaceId: "project", citadelId: "personal", lifecycleStatus: "active" },
    meta = { workspaceId: "project", origin: "operator", lifecycleStatus: "active" };
  const storage = {
    workspaces: { get: async () => workspace },
    chatSessionMeta: { get: async () => meta },
    sessions: { getBySessionId: async () => ({ kind: "dm" }) },
  };
  const job = {
    jobId: "j",
    citadelId: "personal",
    actionConfig: { agentTurn: { sessionId: "s", workspaceId: "project" } },
  };
  expect(
    await resolveCronAgentWorkspaceScope(storage as never, job as never, {
      citadelId: "personal",
      workspaceId: "default",
    }),
  ).toEqual({ citadelId: "personal", workspaceId: "project" });
  workspace.citadelId = "other";
  await expect(
    resolveCronAgentWorkspaceScope(storage as never, job as never, { citadelId: "personal", workspaceId: "default" }),
  ).rejects.toThrow();
  workspace.citadelId = "personal";
  meta.lifecycleStatus = "archived";
  await expect(
    resolveCronAgentWorkspaceScope(storage as never, job as never, { citadelId: "personal" }),
  ).rejects.toThrow();
  expect(
    await resolveCronAgentWorkspaceScope(storage as never, { jobId: "legacy" } as never, {
      citadelId: "personal",
      workspaceId: "default",
    }),
  ).toEqual({ citadelId: "personal", workspaceId: "default" });
});
