import { renderToStaticMarkup } from "react-dom/server";
import { Server } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedPageHeaderProvider, useEmbeddedPageHeader } from "./embedded-page-header";
import { NativePageFrame } from "./NativeRoutePageLayout";

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: vi.fn(),
}));

function frame(releaseStatus?: "experimental" | "ship") {
  return (
    <NativePageFrame
      icon={Server}
      kicker="Ops"
      title="Kanban"
      description="Tasks and runs, grouped by their latest recorded state."
      loading={false}
      error={null}
      releaseStatus={releaseStatus}
      metrics={[{ label: "Status", value: "running" }]}
      actions={<button type="button">New task</button>}
    >
      <div>body</div>
    </NativePageFrame>
  );
}

function Probe() {
  return <span>{useEmbeddedPageHeader() ? "embedded" : "standalone"}</span>;
}

describe("embedded page header", () => {
  it("defaults to standalone and reports embedded inside the provider", () => {
    expect(renderToStaticMarkup(<Probe />)).toContain("standalone");
    expect(
      renderToStaticMarkup(
        <EmbeddedPageHeaderProvider>
          <Probe />
        </EmbeddedPageHeaderProvider>,
      ),
    ).toContain("embedded");
  });

  it("keeps the frame's own h1, icon and title row outside the provider", () => {
    const html = renderToStaticMarkup(frame("experimental"));
    expect(html).toContain("<h1>Kanban</h1>");
    expect(html).toContain("mc-next-directory-icon");
    expect(html).toContain("Experimental");
    expect(html).not.toContain("data-embedded-header");
  });

  it("drops the h1 and icon inside the provider but keeps description, badge, metrics, actions and body", () => {
    const html = renderToStaticMarkup(<EmbeddedPageHeaderProvider>{frame("experimental")}</EmbeddedPageHeaderProvider>);
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("mc-next-directory-icon");
    expect(html).toContain('data-embedded-header="true"');
    expect(html).toContain("Experimental");
    expect(html).toContain("Tasks and runs, grouped by their latest recorded state.");
    expect(html).toContain("running");
    expect(html).toContain("New task");
    expect(html).toContain("body");
  });

  it("omits the empty title row when an embedded frame has no release-scope badge", () => {
    const html = renderToStaticMarkup(<EmbeddedPageHeaderProvider>{frame("ship")}</EmbeddedPageHeaderProvider>);
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("mc-next-directory-title-row");
    expect(html).not.toContain("mc-next-experimental-badge");
  });
});
