import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MissionControlSurfaceHeader } from "./MissionControlSurfaceHeader";

describe("MissionControlSurfaceHeader", () => {
  it("renders the operator trust strip inside the local header chrome", () => {
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
          requestedProviderModelSummary: "OpenAI / gpt-5.4",
          effectiveProviderModelSummary: "local / llama-3.2",
          selectionSourceSummary: "Selection: session",
          fallbackSummary: "Fallback armed",
          fallbackTone: "warning",
          runtimeSummary: "3 active runtimes",
          runtimeTone: "warning",
        }}
        dockOpen
        onToggleDock={() => undefined}
      />,
    );

    expect(markup).toContain("Patch queue");
    expect(markup).toContain("Review the diff and move the run forward.");
    expect(markup).toContain("Gateway healthy");
    expect(markup).toContain("2 decisions");
    expect(markup).toContain("Requested");
    expect(markup).toContain("OpenAI / gpt-5.4");
    expect(markup).toContain("Effective");
    expect(markup).toContain("local / llama-3.2");
    expect(markup).toContain("Selection: session");
    expect(markup).toContain("Fallback armed");
    expect(markup).toContain("3 active runtimes");
  });
});
