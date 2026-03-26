import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PageErrorBoundary } from "./PageErrorBoundary";

function FlakyPage(props: { shouldThrow: boolean }) {
  if (props.shouldThrow) {
    throw new Error("page-failure");
  }
  return <div>page-ready</div>;
}

describe("PageErrorBoundary", () => {
  it("shows a retryable fallback and resets on retry or page change", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onReturnToChat = vi.fn();
    let renderer = create(<div />);

    try {
      await act(async () => {
        renderer = create(
          <PageErrorBoundary resetKey="settings" pageLabel="Settings" onReturnToChat={onReturnToChat}>
            <FlakyPage shouldThrow />
          </PageErrorBoundary>,
        );
      });

      expect(consoleError).toHaveBeenCalled();
      const buttons = renderer.root.findAllByType("button");
      expect(renderer.root.findAllByType("h3")[0]?.children.join("")).toContain("Settings hit a render failure.");

      await act(async () => {
        buttons[1]?.props.onClick();
      });
      expect(onReturnToChat).toHaveBeenCalledTimes(1);

      await act(async () => {
        buttons[0]?.props.onClick();
      });
      expect(renderer.root.findAllByType("h3")[0]?.children.join("")).toContain("Settings hit a render failure.");

      await act(async () => {
        renderer.update(
          <PageErrorBoundary resetKey="chat" pageLabel="Chat" onReturnToChat={onReturnToChat}>
            <FlakyPage shouldThrow={false} />
          </PageErrorBoundary>,
        );
      });

      expect(renderer.root.findAllByType("div").some((node) => node.children.includes("page-ready"))).toBe(true);
    } finally {
      consoleError.mockRestore();
      renderer.unmount();
    }
  });
});
