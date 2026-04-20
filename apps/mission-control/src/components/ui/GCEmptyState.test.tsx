import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GCEmptyState } from "./GCEmptyState";

describe("GCEmptyState", () => {
  it("renders the simplified empty-state contract without dashed card chrome", () => {
    const markup = renderToStaticMarkup(
      <GCEmptyState
        title="Nothing here yet"
        description="Start by creating the first item."
        primaryAction={<button type="button">Create item</button>}
        secondaryAction={<button type="button">Refresh</button>}
      />,
    );

    expect(markup).toContain("Nothing here yet");
    expect(markup).toContain("Start by creating the first item.");
    expect(markup).toContain("Create item");
    expect(markup).toContain("Refresh");
    expect(markup).not.toContain("border-dashed");
  });

  it("keeps legacy subtitle/action props working while pages migrate", () => {
    const markup = renderToStaticMarkup(
      <GCEmptyState title="Legacy" subtitle="Still supported" action={<button type="button">Continue</button>} />,
    );

    expect(markup).toContain("Still supported");
    expect(markup).toContain("Continue");
  });
});
