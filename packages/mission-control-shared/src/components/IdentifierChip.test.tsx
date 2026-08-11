// @vitest-environment happy-dom
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatIdentifierMiddle, IdentifierChip } from "./IdentifierChip";

describe("IdentifierChip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps short identifiers intact and middle-ellipsizes long identifiers", () => {
    expect(formatIdentifierMiddle("prompt-1")).toBe("prompt-1");
    expect(formatIdentifierMiddle("11111111-2222-3333-4444-555555555555")).toBe("11111111…555555");
  });

  it("exposes the full labeled identifier while rendering a compact value", () => {
    const value = "11111111-2222-3333-4444-555555555555";
    const renderer = create(<IdentifierChip value={value} label="Approval" copyable={false} />);

    const code = renderer.root.findByType("code");
    expect(code.children).toEqual(["11111111…555555"]);
    expect(code.props["aria-label"]).toBe(`Approval identifier: ${value}`);
    expect(code.props.title).toBe(value);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("copies the full identifier and reports success without copying the shortened value", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const value = "11111111-2222-3333-4444-555555555555";
    const renderer = create(<IdentifierChip value={value} label="Approval" />);

    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });

    expect(writeText).toHaveBeenCalledWith(value);
    expect(renderer.root.findByType("button").props["aria-label"]).toBe("Copied approval identifier");
    expect(renderer.root.findByProps({ "aria-live": "polite" }).children).toEqual(["Copied"]);
  });

  it("offers a retry state when the clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const renderer = create(<IdentifierChip value="prompt-1" label="Prompt" />);

    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });

    expect(renderer.root.findByProps({ "aria-live": "polite" }).children).toEqual(["Retry"]);
  });
});
