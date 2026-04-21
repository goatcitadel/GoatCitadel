import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
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
        selectedFileDiff={{
          state: {} as any,
          path: "src/index.ts",
          language: "typescript",
          changed: true,
          originalContent: "const answer = 0;",
          modifiedContent: "const answer = 42;",
        }}
        draftContent="const answer = 42;"
        expandedPaths={["src"]}
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
        saving={false}
        error={null}
        hasDirtyDraft={false}
        onCreateWorktree={() => undefined}
        onSelectFile={() => undefined}
        onDraftChange={() => undefined}
        onExpandedPathsChange={() => undefined}
        onRefresh={() => undefined}
        onSaveFile={() => undefined}
        onDiscardDraft={() => undefined}
        onRunHelperSnippet={() => undefined}
      />,
    );

    expect(markup).toContain("Repo-first implementation surface for Atlas.");
    expect(markup).toContain("Project ready");
    expect(markup).toContain("Repo files");
    expect(markup).toContain("Support rail");
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
        saving={false}
        error={null}
        hasDirtyDraft={false}
        onCreateWorktree={() => undefined}
        onSelectFile={() => undefined}
        onDraftChange={() => undefined}
        onExpandedPathsChange={() => undefined}
        onRefresh={() => undefined}
        onSaveFile={() => undefined}
        onDiscardDraft={() => undefined}
        onRunHelperSnippet={() => undefined}
      />,
    );

    expect(markup).toContain("Bind a project before this session can open a repo-backed workbench.");
    expect(markup).toContain("Unbound");
    expect(markup).toContain("Project binding is required before repo operations can start.");
    expect(markup).toContain("Draft snippets remain available as a secondary helper panel.");
  });

  it("foregrounds the artifact pane when a generated artifact is open", () => {
    let renderer: ReturnType<typeof create> | null = null;

    act(() => {
      renderer = create(
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
          needsProjectBinding
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
          generatedArtifact={{
            artifactId: "artifact-1",
            sessionId: "session-1",
            turnId: "turn-1",
            title: "Implementation note",
            kind: "markdown",
            content: "# Result",
            sourceSurface: "code",
            version: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }}
          loading={false}
          busy={false}
          saving={false}
          error={null}
          hasDirtyDraft={false}
          onCreateWorktree={() => undefined}
          onSelectFile={() => undefined}
          onDraftChange={() => undefined}
          onExpandedPathsChange={() => undefined}
          onRefresh={() => undefined}
          onSaveFile={() => undefined}
          onDiscardDraft={() => undefined}
          onRunHelperSnippet={() => undefined}
        />,
      );
    });

    const buttons = renderer!.root.findAllByType("button");
    const artifactTab = buttons.find(
      (button) =>
        button.children.join("") === "Artifact" &&
        typeof button.props.className === "string" &&
        button.props.className.includes("active"),
    );

    expect(artifactTab).toBeTruthy();
    expect(
      renderer!.root.findAll(
        (node) => Array.isArray(node.children) && node.children.join("").includes("Generated artifact"),
      ),
    ).not.toHaveLength(0);
  });
});
