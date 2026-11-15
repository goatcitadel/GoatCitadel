// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("shows an explanation and optional next action", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <EmptyState
          title="Nothing waiting on you"
          description="New decisions appear here."
          action={<button type="button">Open Chat</button>}
        />,
      );
    });
    expect(renderer.root.findByType("h2").props.children).toBe("Nothing waiting on you");
    expect(renderer.root.findByType("p").props.children).toBe("New decisions appear here.");
    expect(renderer.root.findByType("button").props.children).toBe("Open Chat");
  });

  it("shows a failed load with an alert icon, still not as a live region", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EmptyState tone="error" title="Health unavailable" description="Try again." />);
    });
    const icons = renderer.root.findAll((node) => node.type === "svg");
    expect(icons).toHaveLength(1);
    expect(icons[0]!.props["aria-hidden"]).toBe("true");
    expect(renderer.root.findByType("section").props.role).toBeUndefined();
  });

  it("shows no icon by default", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EmptyState title="Nothing here" />);
    });
    expect(renderer.root.findAll((node) => node.type === "svg")).toHaveLength(0);
  });
});
