// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeferredBtwSideChatPanel } from "./DeferredChatLeaves";
const pending = vi.hoisted(() => ({ reject: undefined as ((error: Error) => void) | undefined }));
vi.mock("../../../features/threaded-surface/ThreadedBtwSideChatPanel", async () => {
  await new Promise((_resolve, reject) => {
    pending.reject = reject;
  });
  return { ThreadedBtwSideChatPanel: () => null };
});
it("hides an Aside import failure after close and exposes recovery on reopen", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  type Props = Parameters<typeof DeferredBtwSideChatPanel>[0];
  const panel = (open: boolean) => (
    <DeferredBtwSideChatPanel
      sideChat={{ open, workspaceId: "workspace-1", parentSessionId: "session-1" } as Props["sideChat"]}
    />
  );
  try {
    await act(async () => {
      root.render(panel(true));
    });
    await vi.waitFor(() => expect(pending.reject).toBeTypeOf("function"));
    await act(async () => {
      root.render(panel(false));
    });
    await act(async () => {
      pending.reject!(new TypeError("Failed to fetch dynamically imported module"));
      await vi.dynamicImportSettled();
    });
    const error = container.querySelector('[role="alert"]');
    expect(error).not.toBeNull();
    expect(error!.closest("[hidden]")).not.toBeNull();
    await act(async () => {
      root.render(panel(true));
    });
    expect(container.querySelector('[role="alert"]')!.closest("[hidden]")).toBeNull();
    expect(container.textContent).toContain("Reload app");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Reload app" && !button.disabled,
      ),
    ).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
  }
});
