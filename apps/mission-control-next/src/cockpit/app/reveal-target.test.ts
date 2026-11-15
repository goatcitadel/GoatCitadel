// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { revealTarget } from "./reveal-target";

describe("revealTarget", () => {
  it("scrolls to the target and focuses its first field", () => {
    document.body.innerHTML = '<li id="t"><h5>Brave Search</h5><input aria-label="key" /></li>';
    const target = document.getElementById("t")!;
    target.scrollIntoView = vi.fn();
    expect(revealTarget(target)).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("key");
  });

  it("focuses the element itself when asked", () => {
    document.body.innerHTML = '<h2 id="h" tabindex="-1">QA Goat</h2>';
    revealTarget(document.getElementById("h"), "self");
    expect(document.activeElement?.id).toBe("h");
  });

  it("does nothing for a missing target", () => {
    expect(revealTarget(null)).toBe(false);
  });
});
