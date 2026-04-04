import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatComposerPlusMenu } from "./ChatComposerPlusMenu";

function getTrigger(renderer: ReactTestRenderer) {
  return renderer.root.find((node) => node.type === "button");
}

describe("ChatComposerPlusMenu", () => {
  it("tracks open state on the trigger and closes again when disabled", async () => {
    const onAttachFiles = vi.fn();
    const onRunQuickResearch = vi.fn();

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <ChatComposerPlusMenu
            onAttachFiles={onAttachFiles}
            onRunQuickResearch={onRunQuickResearch}
          />,
        );
      });

      const trigger = getTrigger(renderer);
      expect(trigger.props["aria-label"]).toBe("Open chat actions");
      expect(trigger.props["aria-expanded"]).toBe(false);

      await act(async () => {
        trigger.props.onClick({ defaultPrevented: false });
      });

      expect(getTrigger(renderer).props["aria-expanded"]).toBe(true);

      await act(async () => {
        renderer.update(
          <ChatComposerPlusMenu
            disabled
            onAttachFiles={onAttachFiles}
            onRunQuickResearch={onRunQuickResearch}
          />,
        );
      });

      expect(getTrigger(renderer).props["aria-expanded"]).toBe(false);
      expect(onAttachFiles).not.toHaveBeenCalled();
      expect(onRunQuickResearch).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });
});
