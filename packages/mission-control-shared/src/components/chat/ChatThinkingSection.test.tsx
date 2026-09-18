import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import { ChatThinkingSection } from "./ChatThinkingSection";

describe("ChatThinkingSection", () => {
  it("renders nothing when there is no thinking text", () => {
    const renderer = create(<ChatThinkingSection thinking={undefined} turnStatus="completed" />);
    expect(renderer.toJSON()).toBeNull();
  });

  it("renders nothing for an empty string", () => {
    const renderer = create(<ChatThinkingSection thinking="" turnStatus="running" />);
    expect(renderer.toJSON()).toBeNull();
  });

  it("opens available thinking while active and collapses it after completion", () => {
    const renderer = create(<ChatThinkingSection thinking="Weighing the options." turnStatus="running" />);
    const details = renderer.root.findByType("details");
    expect(details.props.className).toBe("mc-next-thread-thinking");
    expect(details.props.open).toBe(true);

    const summary = renderer.root.findByType("summary");
    expect(summary.children.join("")).toBe("Thinking…");

    const body = renderer.root.findByProps({ className: "mc-next-thread-thinking-body" });
    expect(body.children.join("")).toBe("Weighing the options.");
    act(() => renderer.update(<ChatThinkingSection thinking="Done." turnStatus="completed" />));
    expect(renderer.root.findByType("details").props.open).toBe(false);
  });

  it("preserves explicit disclosure choices across deltas and completion", () => {
    const renderer = create(<ChatThinkingSection thinking="First" turnStatus="running" />);
    act(() => renderer.root.findByType("summary").props.onClick({ preventDefault() {} }));
    act(() => renderer.update(<ChatThinkingSection thinking="First, second" turnStatus="running" />));
    expect(renderer.root.findByType("details").props.open).toBe(false);
    act(() => renderer.root.findByType("summary").props.onClick({ preventDefault() {} }));
    act(() => renderer.update(<ChatThinkingSection thinking="Done" turnStatus="completed" />));
    expect(renderer.root.findByType("details").props.open).toBe(true);
  });

  it("renders 'Thought process' once the turn has settled", () => {
    const renderer = create(<ChatThinkingSection thinking="Weighed the options." turnStatus="completed" />);
    const summary = renderer.root.findByType("summary");
    expect(summary.children.join("")).toBe("Thought process");
  });

  it("never sets aria-live or role=status (single-live-region rule)", () => {
    const renderer = create(<ChatThinkingSection thinking="Weighing." turnStatus="running" />);
    expect(renderer.root.findAll((node) => node.props["aria-live"] !== undefined)).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.props.role === "status")).toHaveLength(0);
  });
});
