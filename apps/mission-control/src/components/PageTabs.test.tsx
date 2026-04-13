import React from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageTabs } from "./PageTabs";

function stubMatchMedia(matches = false) {
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PageTabs", () => {
  it("renders tiered nav buttons on desktop", () => {
    stubMatchMedia(false);
    const renderer = create(
      <PageTabs
        items={[
          { id: "chat", label: "Chat" },
          { id: "code", label: "Code" },
        ]}
        activeId="chat"
        tier="page"
        ariaLabel="Work surfaces"
        onSelect={() => undefined}
      />,
    );
    const tree = renderer.toJSON() as ReactTestRendererJSON;
    const text = JSON.stringify(tree);

    expect(text).toContain("gc-nav-tier-page");
    expect(text).toContain("active");
    expect(tree?.props["aria-label"]).toBe("Work surfaces");
  });

  it("falls back to a select for compact vertical tabs", async () => {
    stubMatchMedia(true);
    const onSelect = vi.fn();
    const renderer = create(
      <PageTabs
        items={[
          { id: "general", label: "General" },
          { id: "runtime", label: "Runtime" },
        ]}
        activeId="general"
        tier="section"
        vertical
        ariaLabel="Tune sections"
        onSelect={onSelect}
      />,
    );

    const select = renderer.root.findByProps({ className: "page-tabs-select" });
    await act(async () => {
      select.props.onChange?.("runtime");
    });

    expect(onSelect).toHaveBeenCalledWith("runtime");
    expect(select.props["aria-label"]).toBe("Tune sections");
  });
});
