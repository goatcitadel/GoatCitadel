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
    expect(markup).toContain("page-chrome-density-compact");
    expect(markup).toContain("Main content");
  });

  it("renders the posture bar mode without reintroducing summary cards", () => {
    const markup = renderToStaticMarkup(
      <TuneHubLayout
        title="General"
        subtitle="Core defaults"
        summaryMode="posture"
        summaries={[
          { label: "Current decision", value: "Providers", note: "The active Tune lane", tone: "accent" },
          { label: "Operator focus", value: "Defaults before detail", note: "Shared posture" },
        ]}
      >
        <div>Main content</div>
      </TuneHubLayout>,
    );

    expect(markup).toContain("tune-posture-bar");
    expect(markup).toContain("tune-posture-item-accent");
    expect(markup).not.toContain("operator-summary-card");
    expect(markup).toContain("Main content");
  });

  it("skips the summary strip when no summaries are provided and keeps guide details out of the inline header", () => {
    const markup = renderToStaticMarkup(
      <TuneHubLayout
        title="Runtime"
        subtitle="Runtime controls"
        guideTitle="What this controls"
        guideBody="Only open when you need extra posture help."
      >
        <div>Main content</div>
      </TuneHubLayout>,
    );

    expect(markup).not.toContain("operator-summary-strip");
    expect(markup).not.toContain("tune-hub-guide");
    expect(markup).toContain("Main content");
  });
});
