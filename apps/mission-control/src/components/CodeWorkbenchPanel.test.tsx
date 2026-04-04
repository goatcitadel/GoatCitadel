import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeWorkbenchPanel } from "./CodeWorkbenchPanel";

describe("CodeWorkbenchPanel", () => {
  it("highlights project binding state and extracted code snippets", () => {
    const markup = renderToStaticMarkup(
      <CodeWorkbenchPanel
        selectedTurn={{
          turnId: "turn-1",
          assistantMessage: {
            content: "```ts\nconst answer = 42;\n```",
          },
          trace: {
            status: "completed",
          },
        } as any}
        projectName="Atlas"
        needsProjectBinding={false}
      />,
    );

    expect(markup).toContain("Project-bound implementation surface for Atlas.");
    expect(markup).toContain("Project ready");
    expect(markup).toContain("ts 1");
    expect(markup).toContain("Editable scratchpad sourced from fenced code blocks");
  });

  it("keeps the unbound posture explicit before execution", () => {
    const markup = renderToStaticMarkup(
      <CodeWorkbenchPanel
        selectedTurn={null}
        needsProjectBinding
      />,
    );

    expect(markup).toContain("Bind a project to turn this into an execution-ready implementation lane.");
    expect(markup).toContain("Unbound");
    expect(markup).toContain("No code snippets extracted yet.");
  });
});
