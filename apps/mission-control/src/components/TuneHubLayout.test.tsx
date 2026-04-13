import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TuneHubLayout } from "./TuneHubLayout";

describe("TuneHubLayout", () => {
  it("renders compact operator summaries before the main tune content", () => {
    const markup = renderToStaticMarkup(
      <TuneHubLayout
        title="General"
        subtitle="Keep current defaults and posture visible before deeper settings."
        summaries={[
          { label: "Posture", value: "Balanced", note: "Default operator mode", tone: "accent" },
          { label: "Risk", value: "Low", note: "No active warnings" },
        ]}
      >
        <div>Main content</div>
      </TuneHubLayout>,
    );

    expect(markup).toContain("operator-summary-strip");
    expect(markup).toContain("operator-summary-card");
    expect(markup).toContain("stat-card-compact");
    expect(markup).toContain("Main content");
  });
});
