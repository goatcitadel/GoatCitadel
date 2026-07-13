// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeSelectableList } from "./NativeSelectableList";

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
    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>[^<]*<div[^>]*>[^<]*<strong>OpenAI/u);
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>[^<]*<div[^>]*>[^<]*<strong>Anthropic/u);
  });
});
