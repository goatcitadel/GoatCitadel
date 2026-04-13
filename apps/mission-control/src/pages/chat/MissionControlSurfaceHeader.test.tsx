import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MissionControlSurfaceHeader } from "./MissionControlSurfaceHeader";

describe("MissionControlSurfaceHeader", () => {
  it("keeps provider and runtime trust out of the local header chrome", () => {
    const markup = renderToStaticMarkup(
      <MissionControlSurfaceHeader
        mode="code"
        sessionTitle="Patch queue"
        summary="Review the diff and move the run forward."
        trust={{
          workspaceLabel: "Primary Ops",
          gatewayTone: "success",
          gatewayLabel: "Gateway healthy",
          approvalsSummary: "2 decisions",
          activeModeLabel: "Code",
          providerModelSummary: "OpenAI / gpt-5.4",
          runtimeSummary: "3 active runtimes",
        }}
        dockOpen
        onToggleDock={() => undefined}
      />,
    );

    expect(markup).toContain("Execution posture stays exact");
    expect(markup).toContain("Patch queue");
    expect(markup).not.toContain("OpenAI / gpt-5.4");
    expect(markup).not.toContain("3 active runtimes");
    expect(markup).not.toContain("Gateway healthy");
  });
});
