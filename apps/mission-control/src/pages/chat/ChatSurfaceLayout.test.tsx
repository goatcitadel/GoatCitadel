import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatSurfaceLayout } from "./ChatSurfaceLayout";

describe("ChatSurfaceLayout", () => {
  it("renders the promoted secondary column and dock for cowork", () => {
    const markup = renderToStaticMarkup(
      <ChatSurfaceLayout
        mode="cowork"
        dockOpen
        sessionRail={<div>Session rail</div>}
        workflowColumn={<div>Workflow column</div>}
        primaryColumn={<div>Primary column</div>}
        contextDock={<div>Context dock</div>}
      />,
    );

    expect(markup).toContain("with-cowork");
    expect(markup).toContain("with-dock-open");
    expect(markup).toContain("Workflow column");
    expect(markup).toContain("Context dock");
  });

  it("omits the dock column when the dock is collapsed", () => {
    const markup = renderToStaticMarkup(
      <ChatSurfaceLayout
        mode="code"
        dockOpen={false}
        sessionRail={<div>Session rail</div>}
        workflowColumn={<div>Workbench column</div>}
        primaryColumn={<div>Primary column</div>}
        contextDock={<div>Context dock</div>}
      />,
    );

    expect(markup).toContain("with-code");
    expect(markup).toContain("with-dock-collapsed");
    expect(markup).not.toContain("Context dock");
  });
});
