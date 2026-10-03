import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicLayoutReturn } from "./ClassicLayoutReturn";

const handoff = vi.hoisted(() => ({ request: vi.fn(), opening: false, error: null, dialog: null }));
vi.mock("./use-shell-handoff", () => ({ useShellHandoff: () => handoff }));
let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.clearAllMocks();
});

describe("Classic layout return", () => {
  it("offers a visible layout switch and carries the selected Chat session through the reviewed handoff", async () => {
    await act(async () => {
      renderer = create(<ClassicLayoutReturn sessionId="selected-chat" />);
    });
    const button = renderer.root.findByType("button");
    expect(button.children).toEqual(["Cockpit"]);
    expect(button.props["aria-label"]).toBe("Return to Cockpit layout");
    await act(async () => button.props.onClick());
    expect(handoff.request).toHaveBeenCalledWith("cockpit", { sessionId: "selected-chat" });
  });
});
