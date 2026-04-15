import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./PageTabs", () => ({
  PageTabs: ({ items }: { items?: Array<{ label: string }> }) => <div>{items?.map((item) => item.label).join(" ")}</div>,
}));
vi.mock("./SectionTitle", () => ({
  SectionTitle: ({ title, subtitle }: { title?: React.ReactNode; subtitle?: React.ReactNode }) => (
    <header className="page-chrome-density-compact">
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </header>
  ),
}));
vi.mock("./StatCard", () => ({
  StatCard: ({ label, value, note, className }: {
    label?: React.ReactNode;
    value?: React.ReactNode;
    note?: React.ReactNode;
    className?: string;
  }) => (
    <div className={`stat-card-compact ${className ?? ""}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note}
    </div>
  ),
}));
vi.mock("./ShellDetailPanelContext", () => ({
  useShellDetailPanel: () => ({
    registerEntry: () => () => undefined,
  }),
}));

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
    expect(markup).not.toContain("The active Tune lane");
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
