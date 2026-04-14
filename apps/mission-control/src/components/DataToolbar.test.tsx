import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DataToolbar } from "./DataToolbar";

vi.mock("./EmbeddedPageChrome", () => ({
  useEmbeddedPageChrome: () => false,
}));

describe("DataToolbar", () => {
  it("renders the passive center slot between the primary and secondary regions", () => {
    const markup = renderToStaticMarkup(
      <DataToolbar primary={<span>Filters</span>} center={<span>Idle state</span>} secondary={<span>Create</span>} />,
    );

    expect(markup).toContain("data-toolbar-has-center");
    expect(markup).toContain("Filters");
    expect(markup).toContain("Idle state");
    expect(markup).toContain("Create");
  });

  it("does not render empty primary or secondary regions when a slot is omitted", () => {
    const markup = renderToStaticMarkup(<DataToolbar center={<span>Idle state</span>} />);

    expect(markup).toContain("data-toolbar-has-center");
    expect(markup).not.toContain("data-toolbar-primary");
    expect(markup).not.toContain("data-toolbar-secondary");
  });
});
