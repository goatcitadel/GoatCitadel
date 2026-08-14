import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({ request: api.request }));

import {
  createWorkspaceHook,
  fetchWorkspaceHookRuns,
  fetchWorkspaceHooks,
  redriveWorkspaceHookRun,
  testWorkspaceHook,
} from "./hooks.js";

describe("shared hooks API", () => {
  beforeEach(() => {
    api.request.mockReset();
    api.request.mockResolvedValue({});
  });

  it("uses typed, workspace-scoped endpoints for list, synthetic test, creation, and permitted redrive", async () => {
    await fetchWorkspaceHooks("workspace:1", 999);
    await fetchWorkspaceHookRuns("workspace:1", 0);
    await createWorkspaceHook("workspace-1", {
      label: "Signed observer",
      trigger: "tool.call.after",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/events", secret: "write-only" } },
    });
    await testWorkspaceHook("workspace-1", "hook:1");
    await redriveWorkspaceHookRun("workspace-1", "run:1");

    expect(api.request.mock.calls).toEqual([
      ["/api/v1/workspaces/workspace%3A1/hooks?limit=500"],
      ["/api/v1/workspaces/workspace%3A1/hooks/runs?limit=1"],
      [
        "/api/v1/workspaces/workspace-1/hooks",
        expect.objectContaining({ method: "POST" }),
      ],
      ["/api/v1/workspaces/workspace-1/hooks/hook%3A1/test", { method: "POST" }],
      ["/api/v1/workspaces/workspace-1/hooks/runs/run%3A1/redrive", { method: "POST" }],
    ]);
  });

  it("rejects unscoped or malformed hook identifiers before making a request", async () => {
    await expect(fetchWorkspaceHooks("bad workspace")).rejects.toThrow(/valid workspace scope/i);
    await expect(testWorkspaceHook("workspace-1", "bad hook")).rejects.toThrow(/valid hook id/i);
    expect(api.request).not.toHaveBeenCalled();
  });
});
