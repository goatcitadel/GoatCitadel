// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeSelectableList, shouldWindowRows } from "./NativeSelectableList";
import { statusChipTone } from "./status-chip-tone";

describe("NativeSelectableList", () => {
  it("announces the current selection while preserving button semantics", () => {
    const markup = renderToStaticMarkup(
      <NativeSelectableList
        ariaLabel="Provider choices"
        items={[
          { id: "openai", title: "OpenAI" },
          { id: "anthropic", title: "Anthropic" },
        ]}
        selectedId="openai"
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Provider choices"');
    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>.*?<strong>OpenAI/u);
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>.*?<strong>Anthropic/u);
  });

  it("shows a description and a status chip in compact rows", () => {
    const markup = renderToStaticMarkup(
      <NativeSelectableList items={[{
        id: "search",
        title: "Web search",
        body: "Searches the web.",
        status: { label: "On", tone: "done" },
      }]} />,
    );
    expect(markup).toContain("Searches the web.");
    expect(markup).toContain('data-tone="success"');
    expect(markup).toContain("On");
  });

  it("windows a long list when it has a bounded height", () => {
    expect(shouldWindowRows({ itemCount: 101, maxHeight: "40rem", virtualized: false, hasChildren: false })).toBe(true);
    expect(shouldWindowRows({ itemCount: 101, maxHeight: "", virtualized: false, hasChildren: false })).toBe(false);
    expect(shouldWindowRows({ itemCount: 60, maxHeight: "40rem", virtualized: true, hasChildren: false })).toBe(true);
    expect(shouldWindowRows({ itemCount: 60, maxHeight: "40rem", virtualized: false, hasChildren: false })).toBe(false);
  });

  it("maps each vocabulary tone to a chip tone", () => {
    expect((["running", "waiting", "done", "failed", "neutral"] as const).map(statusChipTone)).toEqual([
      "live", "warning", "success", "critical", "muted",
    ]);
  });
});
