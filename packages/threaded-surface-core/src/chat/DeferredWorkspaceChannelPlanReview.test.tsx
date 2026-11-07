import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { DeferredWorkspaceChannelPlanReview } from "./DeferredWorkspaceChannelPlanReview";
const gate = vi.hoisted(() => ({ loads: 0, release: undefined as (() => void) | undefined }));
vi.mock("@goatcitadel/mission-control-shared/components/PageErrorBoundary", () => ({
  PageErrorBoundary: ({ children }: { children: unknown }) => <>{children as never}</>,
}));
vi.mock("./WorkspaceChannelPlanReview", async () => {
  gate.loads++;
  await new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  return {
    WorkspaceChannelPlanReview: ({ workspaceId, routeSearch }: { workspaceId: string; routeSearch: string }) => {
      const [value, setValue] = useState(0);
      return new URLSearchParams(routeSearch).has("channelPlan") ? (
        <button onClick={() => setValue(value + 1)}>
          Review {workspaceId} draft {value}
        </button>
      ) : null;
    },
  };
});
it("loads only a real route demand, including malformed/restored handoffs, and retains state only within its workspace", async () => {
  let renderer!: ReactTestRenderer;
  const pane = (workspaceId: string, routeSearch: string) => (
    <DeferredWorkspaceChannelPlanReview
      key={workspaceId}
      workspaceId={workspaceId}
      routeSearch={routeSearch}
      onOpenApprovals={vi.fn()}
    />
  );
  try {
    await act(async () => {
      renderer = create(pane("workspace-1", "?sessionId=chat-1"));
    });
    expect(gate.loads).toBe(0);
    await act(async () => {
      renderer.update(pane("workspace-1", "?channelPlan=malformed"));
    });
    await vi.waitFor(() => expect(gate.release).toBeTypeOf("function"));
    expect(gate.loads).toBe(1);
    await act(async () => {
      renderer.update(pane("workspace-2", "?channelPlan=restored"));
      gate.release!();
      await vi.dynamicImportSettled();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("workspace-2");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("workspace-1");
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(renderer.root.findByType("button").children.join("")).toBe("Review workspace-2 draft 1");
    await act(async () => {
      renderer.update(pane("workspace-2", ""));
    });
    await act(async () => {
      renderer.update(pane("workspace-2", "?channelPlan=restored"));
    });
    expect(renderer.root.findByType("button").children.join("")).toBe("Review workspace-2 draft 1");
    expect(gate.loads).toBe(1);
    await act(async () => {
      renderer.update(pane("workspace-3", "?channelPlan=restored"));
    });
    expect(renderer.root.findByType("button").children.join("")).toBe("Review workspace-3 draft 0");
  } finally {
    gate.release?.();
    if (renderer) await act(async () => renderer.unmount());
  }
});
