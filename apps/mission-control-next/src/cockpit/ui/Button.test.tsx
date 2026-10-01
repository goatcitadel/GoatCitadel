// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

describe("cockpit buttons", () => {
  it("defaults to a non-submitting secondary control", () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Button>Save</Button>); });
    const button = renderer.root.findByType("button");
    expect(button.props.type).toBe("button");
    expect(button.props.className).toContain("border-line");
  });

  it("preserves the primary contrast pair while hovered", () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Button variant="primary">Save edits</Button>); });
    const classes = renderer.root.findByType("button").props.className.split(" ");
    expect(classes).toContain("bg-accent");
    expect(classes).toContain("text-accent-ink");
    expect(classes).toContain("hover:underline");
    expect(classes.some((value: string) => value.startsWith("hover:opacity-") || value.startsWith("hover:brightness-"))).toBe(false);
  });

  it("labels icon-only actions", () => {
    const onClick = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<IconButton label="Open inbox" icon={<span />} onClick={onClick} />); });
    const button = renderer.root.findByType("button");
    expect(button.props["aria-label"]).toBe("Open inbox");
    act(() => button.props.onClick());
    expect(onClick).toHaveBeenCalledOnce();
  });
});
