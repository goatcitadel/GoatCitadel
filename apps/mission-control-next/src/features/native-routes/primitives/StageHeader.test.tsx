// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageHeader } from "./StageHeader";

describe("StageHeader", () => {
  it("renders eyebrow, title, and area data-attribute", () => {
    const markup = renderToStaticMarkup(
      <StageHeader area="projects" eyebrow="Projects · Workspace" title="Active projects" />,
    );
    expect(markup).toContain('class="mc-next-stage-head"');
    expect(markup).toContain('data-area="projects"');
    expect(markup).toContain("Projects · Workspace");
    expect(markup).toContain("<h1>Active projects</h1>");
  });

  it("supports all 7 area slugs via data-area", () => {
    const areas = ["chat", "cowork", "code", "projects", "library", "ops", "settings"] as const;
    for (const area of areas) {
      const markup = renderToStaticMarkup(<StageHeader area={area} eyebrow="x" title="y" />);
      expect(markup).toContain(`data-area="${area}"`);
    }
  });

  it("renders description when provided, omits sub element otherwise", () => {
    const withDescription = renderToStaticMarkup(
      <StageHeader area="ops" eyebrow="Ops" title="Runtime" description="Daemon posture" />,
    );
    expect(withDescription).toContain("Daemon posture");
    expect(withDescription).toContain('class="mc-next-stage-head-sub"');

    const withoutDescription = renderToStaticMarkup(<StageHeader area="ops" eyebrow="Ops" title="Runtime" />);
    expect(withoutDescription).not.toContain('class="mc-next-stage-head-sub"');
  });

  it("renders metric strip when metrics provided", () => {
    const markup = renderToStaticMarkup(
      <StageHeader
        area="ops"
        eyebrow="Ops"
        title="Runtime"
        metrics={[
          { label: "Tokens", value: "428" },
          { label: "Cost", value: "$0.018", delta: { value: "+1.2%", tone: "up" } },
        ]}
      />,
    );
    expect(markup).toContain('class="mc-next-stage-head-metrics"');
    expect(markup).toContain("Tokens");
    expect(markup).toContain("428");
    expect(markup).toContain("$0.018");
    expect(markup).toContain("+1.2%");
    expect(markup).toContain('data-tone="up"');
  });

  it("renders actions slot when provided", () => {
    const markup = renderToStaticMarkup(
      <StageHeader area="library" eyebrow="Library" title="Memory" actions={<button type="button">Refresh</button>} />,
    );
    expect(markup).toContain('class="mc-next-stage-head-actions"');
    expect(markup).toContain("Refresh");
  });

  it("omits the head-row entirely when neither metrics nor actions present", () => {
    const markup = renderToStaticMarkup(<StageHeader area="chat" eyebrow="Chat" title="Hello" description="World" />);
    expect(markup).not.toContain("mc-next-stage-head-row");
    expect(markup).not.toContain("mc-next-stage-head-metrics");
    expect(markup).not.toContain("mc-next-stage-head-actions");
  });

  it("renders the accent dot in eyebrow", () => {
    const markup = renderToStaticMarkup(<StageHeader area="chat" eyebrow="Chat" title="t" />);
    expect(markup).toContain("mc-next-stage-head-eyebrow-dot");
  });
});
