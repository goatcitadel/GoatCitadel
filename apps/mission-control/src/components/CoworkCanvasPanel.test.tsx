import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoworkCanvasPanel } from "./CoworkCanvasPanel";

describe("CoworkCanvasPanel", () => {
  it("prioritizes orchestration context when a workflow is active", () => {
    const markup = renderToStaticMarkup(
      <CoworkCanvasPanel
        items={[]}
        orchestration={
          {
            workflowTemplate: "research_plan",
            status: "running",
            finalSummary: "Research is in motion and implementation is queued behind it.",
            routeDecision: {
              selectedRoles: ["Researcher", "Coder"],
            },
            steps: [
              {
                stepId: "step-1",
                role: "Researcher",
                providerId: "openai",
                model: "gpt-5.4",
                status: "completed",
                summary: "Collected constraints and scoped the problem.",
              },
              {
                stepId: "step-2",
                role: "Coder",
                providerId: "anthropic",
                model: "sonnet",
                status: "running",
              },
            ],
          } as any
        }
      />,
    );

    expect(markup).toContain("Execution Board");
    expect(markup).toContain("Workflow research_plan");
    expect(markup).toContain("Researcher -&gt; Coder");
    expect(markup).toContain("Planned steps");
    expect(markup).toContain("Role execution");
    expect(markup).toContain("Collected constraints and scoped the problem.");
    expect(markup).toContain("Research is in motion and implementation is queued behind it.");
    expect(markup).toContain("Tools used");
  });
});
