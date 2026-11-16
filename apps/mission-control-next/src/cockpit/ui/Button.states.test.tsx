// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";

describe("cockpit button sizes", () => {
  it.each([
    ["sm", "min-h-7"],
    ["md", "min-h-9"],
  ] as const)("a %s button has a minimum height, not a fixed one (U-CH-005)", (size, min) => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Button size={size}>A label long enough to wrap onto a second line</Button>);
    });
    const button = renderer.root.findByType("button");
    expect(button.props.className).toContain(min);
    expect(button.props.className).not.toMatch(/(^|\s)h-(7|9)(\s|$)/);
  });
});
