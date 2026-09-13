import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryEnumerationControls } from "./MemoryEnumerationControls";

const props = { loaded: 500, visible: 12, total: 1_211, hasMore: true, searching: false, unavailable: false,
  onLoadMore: vi.fn(async () => undefined), onReload: vi.fn(async () => undefined) };

describe("memory enumeration controls", () => {
  it("distinguishes local namespace matches from the complete search total", () => {
    const html = renderToStaticMarkup(<MemoryEnumerationControls {...props} />);
    expect(html).toContain("12 matching results loaded · 500 of 1211 total");
    expect(html).toContain("Namespace and lifecycle counts cover loaded items");
    expect(html).toContain("Load more memory");
    expect(html).not.toContain("Result limit reached");
  });
  it("prevents repeat loading while a continuation is pending and removes the control after the final page", () => {
    const pending = renderToStaticMarkup(<MemoryEnumerationControls {...props} loadingMore />);
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain("disabled");
    const complete = renderToStaticMarkup(<MemoryEnumerationControls {...props} loaded={1_211} visible={1_211} hasMore={false} />);
    expect(complete).toContain("1211 of 1211 total");
    expect(complete).not.toContain("Load more memory");
  });
  it("offers reload after stale-page errors without declaring the retained results current", () => {
    const html = renderToStaticMarkup(<MemoryEnumerationControls {...props} error="Memory changed." />);
    expect(html).toContain("Loaded results may be out of date");
    expect(html).toContain("Reload memory");
    expect(html).not.toContain("Load more memory");
  });
});
