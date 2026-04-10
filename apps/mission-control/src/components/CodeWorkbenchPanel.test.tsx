import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeWorkbenchPanel } from "./CodeWorkbenchPanel";

describe("CodeWorkbenchPanel", () => {
  it("renders a repo-first workbench when project and worktree context are available", () => {
    const markup = renderToStaticMarkup(
      <CodeWorkbenchPanel
        selectedTurn={
          {
            turnId: "turn-1",
            assistantMessage: {
              content: "```ts\nconst answer = 42;\n```",
            },
            trace: {
              status: "completed",
            },
            toolRuns: [],
          } as any
        }
        projectName="Atlas"
        needsProjectBinding={false}
        workbenchState={{
          sessionId: "session-1",
          projectId: "project-1",
          baseRef: "main",
          worktreePath: "./.worktrees/session-1",
          worktreeStatus: "ready",
          activeFilePath: "src/index.ts",
          validationStatus: "passed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }}
        workbenchTree={{
          state: {} as any,
          rootPath: "./.worktrees/session-1",
          changedFiles: ["src/index.ts"],
          items: [
            {
              path: "src/index.ts",
              name: "index.ts",
              kind: "file",
              changed: true,
              depth: 1,
            },
          ],
        }}
        selectedFile={{
          state: {} as any,
          path: "src/index.ts",
          sizeBytes: 18,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          contentType: "text/typescript",
          language: "typescript",
          changed: true,
          content: "const answer = 42;",
        }}
        diff={{
          state: {} as any,
          scopePath: ".",
          changedFiles: ["src/index.ts"],
          summary: {
            changedFiles: 1,
            additions: 1,
            deletions: 0,
          },
          diff: "+const answer = 42;",
        }}
        output={{
          state: {} as any,
          helperRuns: [
            {
              runId: "run-1",
              status: "completed",
              language: "typescript",
              requestedOutputIntent: "workbench_helper",
              stdoutPreview: "ok",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          output: "vitest passed",
          lastUpdatedAt: "2026-01-01T00:00:00.000Z",
        }}
        loading={false}
        busy={false}
        error={null}
        onCreateWorktree={() => undefined}
        onSelectFile={() => undefined}
        onRefresh={() => undefined}
        onRunHelperSnippet={() => undefined}
      />,
    );

    expect(markup).toContain("Repo-first implementation surface for Atlas.");
    expect(markup).toContain("Project ready");
    expect(markup).toContain("Repo files");
    expect(markup).toContain("Review rail");
    expect(markup).toContain("Draft snippets");
    expect(markup).toContain("Active file: src/index.ts");
  });

  it("keeps the unbound posture explicit before execution", () => {
    const markup = renderToStaticMarkup(
      <CodeWorkbenchPanel
        selectedTurn={null}
        needsProjectBinding
        loading={false}
        busy={false}
        error={null}
        onCreateWorktree={() => undefined}
        onSelectFile={() => undefined}
        onRefresh={() => undefined}
        onRunHelperSnippet={() => undefined}
      />,
    );

    expect(markup).toContain("Bind a project before this session can open a repo-backed workbench.");
    expect(markup).toContain("Unbound");
    expect(markup).toContain("Project binding is required before repo operations can start.");
    expect(markup).toContain("Draft snippets remain available as a secondary helper lane.");
  });
});
