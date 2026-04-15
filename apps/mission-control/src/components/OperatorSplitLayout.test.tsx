import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatorSplitLayout } from "./OperatorSplitLayout";

describe("OperatorSplitLayout", () => {
  it("renders a dominant primary region with a sticky inspector lane", () => {
    const markup = renderToStaticMarkup(
      <OperatorSplitLayout primary={<div>Primary content</div>} inspector={<div>Inspector content</div>} />,
    );

    expect(markup).toContain("operator-split-layout");
    expect(markup).toContain("operator-split-grid");
    expect(markup).toContain("operator-split-inspector-sticky");
    expect(markup).toContain("Primary content");
    expect(markup).toContain("Inspector content");
  });
});
