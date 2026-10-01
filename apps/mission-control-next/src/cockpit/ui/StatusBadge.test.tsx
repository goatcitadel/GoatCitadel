// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("pairs status words with a non-color signal", () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<StatusBadge status={{ tone: "waiting", label: "Waiting on you" }} />); });
    const badge = renderer.root.findByType("span");
    expect(badge.props["data-tone"]).toBe("waiting");
    expect(JSON.stringify(renderer.toJSON())).toContain("Waiting on you");
    expect(badge.findAll((node) => node.props["aria-hidden"] === "true").length).toBeGreaterThan(0);
  });
});
