import React from "react";
import { readFileSync } from "node:fs";
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
    expect(markup).toContain("surface-layout-cowork");
    expect(markup).toContain("surface-grid-cowork");
    expect(markup).toContain('data-dominant-artifact="workflow"');
    expect(markup).toContain('data-thread-placement="support"');
    expect(markup).toContain('data-support-thread-behavior="stacked"');
    expect(markup).toContain('data-dock-behavior="drawer"');
    expect(markup).toContain("Workflow column");
    expect(markup).toContain("Context dock");
    expect(markup.indexOf("Workflow column")).toBeLessThan(markup.indexOf("Primary column"));
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
    expect(markup).toContain("surface-layout-code");
    expect(markup).toContain("surface-grid-code");
    expect(markup).toContain('data-dominant-artifact="workbench"');
    expect(markup).toContain('data-desktop-density="code"');
    expect(markup).not.toContain("Context dock");
  });

  it("keeps the code support lane left of the workbench on desktop", () => {
    const css = readFileSync(new URL("../../styles/chat-surface.css", import.meta.url), "utf8");

    expect(css).toContain(".chat-v11-main-grid.surface-grid-code.with-dock-collapsed");
    expect(css).toContain('grid-template-areas: "primary secondary";');
  });
});
