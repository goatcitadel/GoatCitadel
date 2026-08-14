import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createWorkspaceHook: vi.fn(),
  deleteWorkspaceHook: vi.fn(),
  fetchWorkspaceHookRuns: vi.fn(),
  fetchWorkspaceHooks: vi.fn(),
  redriveWorkspaceHookRun: vi.fn(),
  testWorkspaceHook: vi.fn(),
}));

vi.mock("./hooks-api", () => api);

import { HooksSection } from "./HooksSection";

function collectText(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : collectText(child as ReactTestInstance)).join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAllByType("button").find((candidate) => collectText(candidate).includes(label));
  if (!button) throw new Error(`Missing button ${label}`);
  return button;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("HooksSection", () => {
  it("shows custody and durable delivery truth without rendering hook secrets or payload text", async () => {
    api.fetchWorkspaceHooks.mockResolvedValue({
      items: [{
        hookId: "hook-1",
        workspaceId: "default",
        label: "Deployment observer",
        trigger: "tool.call.after",
        phase: "after",
        mode: "observe",
        enabled: true,
        priority: 100,
        timeoutMs: 5000,
        failPolicy: "open",
        dataScope: "metadata",
        action: { type: "webhook", webhook: { url: "https://hooks.example.test/events", secretRef: "keychain:goatcitadel:hook:1" } },
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }],
    });
    api.fetchWorkspaceHookRuns.mockResolvedValue({
      items: [{
        runId: "run-1",
        hookId: "hook-1",
        workspaceId: "default",
        trigger: "tool.call.after",
        entityType: "tool_call",
        entityId: "tool-1",
        mode: "observe",
        status: "completed",
        idempotencyKey: "opaque",
        attemptCount: 1,
        requestPayload: { prompt: "never-render-this-payload" },
        responsePayload: { response: "never-render-this-response" },
        errorText: "super-secret remote failure detail",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }],
    });
    api.testWorkspaceHook.mockResolvedValue({ runId: "test-run" });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <HooksSection
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          route={{ area: "settings", section: "hooks", theme: "ops" } as never}
          section="hooks"
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });
    await flush();

    const text = collectText(renderer.root);
    expect(text).toContain("Governed hooks");
    expect(text).toContain("Deployment observer");
    expect(text).toContain("Keychain");
    expect(text).toContain("completed · attempt 1");
    expect(text).not.toContain("keychain:goatcitadel:hook:1");
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("never-render-this-payload");
    expect(text).not.toContain("never-render-this-response");
    expect(text).toContain("Delivery failure detail is redacted");

    await act(async () => {
      findButton(renderer.root, "Run safe test").props.onClick();
      await Promise.resolve();
    });
    expect(api.testWorkspaceHook).toHaveBeenCalledWith("default", "hook-1");
  });
});
