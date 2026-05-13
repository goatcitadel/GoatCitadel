import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("./AgenticRuntimeVisibilityPanel", () => ({
  AgenticRuntimeVisibilityPanel: () => <section>Runtime visibility stub</section>,
}));

vi.mock("./ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    confirmLabel,
    onCancel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmLabel?: string;
    onCancel: () => void;
    onConfirm: () => void;
  }) =>
    open ? (
      <section>
        <p>{title}</p>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel ?? "Confirm"}
        </button>
      </section>
    ) : null,
}));

import { CodeWorkbenchPanel } from "./CodeWorkbenchPanel";

function nodeText(node: { children?: unknown[] }): string {
  return (
    node.children
      ?.map((child) =>
        typeof child === "string" || typeof child === "number"
          ? String(child)
          : child && typeof child === "object" && "children" in child
            ? nodeText(child as { children?: unknown[] })
            : "",
      )
      .join("") ?? ""
  );
}

function baseWorkbenchProps(overrides: Record<string, unknown> = {}) {
  return {
    selectedTurn: null,
    needsProjectBinding: false,
    loading: false,
    busy: false,
    saving: false,
    error: null,
    hasDirtyDraft: false,
    onCreateWorktree: vi.fn(),
    onSelectFile: vi.fn(),
    onDraftChange: vi.fn(),
    onExpandedPathsChange: vi.fn(),
    onRefresh: vi.fn(),
    onSaveFile: vi.fn(),
    onDiscardDraft: vi.fn(),
    onRunHelperSnippet: vi.fn(),
    ...overrides,
  } as any;
}

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

  it("auto-selects the expected pane from available workbench data", () => {
    const renderer = create(
      <CodeWorkbenchPanel
        {...baseWorkbenchProps({
          selectedTurn: {
            turnId: "turn-snippets",
            assistantMessage: { content: "```ts\nconsole.log('snippet')\n```" },
            trace: { status: "completed" },
            toolRuns: [],
          },
          needsProjectBinding: true,
        })}
      />,
    );
    expect(
      renderer.root.findAll(
        (node) => Array.isArray(node.children) && node.children.join("").includes("Draft snippets"),
      ),
    ).not.toHaveLength(0);

    act(() => {
      renderer.update(
        <CodeWorkbenchPanel
          {...baseWorkbenchProps({
            selectedTurn: { turnId: "turn-diff", assistantMessage: { content: "" }, trace: { status: "completed" } },
            selectedFileDiff: {
              state: {} as any,
              path: "src/index.ts",
              language: "typescript",
              changed: true,
              originalContent: "old",
              modifiedContent: "new",
            },
          })}
        />,
      );
    });
    expect(
      renderer.root
        .findAll((node) => Array.isArray(node.children))
        .map((node) => node.children.join(""))
        .join(" "),
    ).toContain("No selected-file diff is ready yet.");

    act(() => {
      renderer.update(
        <CodeWorkbenchPanel
          {...baseWorkbenchProps({
            selectedTurn: { turnId: "turn-repo", assistantMessage: { content: "" }, trace: { status: "completed" } },
            diff: {
              state: {} as any,
              scopePath: ".",
              changedFiles: ["src/index.ts"],
              summary: { changedFiles: 1, additions: 0, deletions: 0 },
              diff: "",
            },
          })}
        />,
      );
    });
    expect(
      renderer.root
        .findAll((node) => Array.isArray(node.children))
        .map((node) => node.children.join(""))
        .join(" "),
    ).toContain("No diff is available yet.");

    act(() => {
      renderer.update(
        <CodeWorkbenchPanel
          {...baseWorkbenchProps({
            selectedTurn: { turnId: "turn-output", assistantMessage: { content: "" }, trace: { status: "completed" } },
            output: {
              state: {} as any,
              helperRuns: [],
              output: "validation-only output",
              lastUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          })}
        />,
      );
    });
    expect(
      renderer.root
        .findAll((node) => Array.isArray(node.children))
        .map((node) => node.children.join(""))
        .join(" "),
    ).toContain("validation-only output");
  });

  it("covers artifact close, missing artifact, blank validation, and blocked operation guards", () => {
    const callbacks = {
      onRunValidationCommand: vi.fn(),
      onApplyPatch: vi.fn(),
      onExportPatch: vi.fn(),
      onRevertFile: vi.fn(),
      onRevertAll: vi.fn(),
      onCloseGeneratedArtifact: vi.fn(),
    };
    const renderer = create(
      <CodeWorkbenchPanel
        {...baseWorkbenchProps({
          selectedTurn: {
            turnId: "turn-artifact",
            assistantMessage: { content: "```patch\n+patched\n```" },
            trace: { status: "completed" },
            toolRuns: [],
          },
          generatedArtifact: {
            artifactId: "artifact-1",
            sessionId: "session-1",
            turnId: "turn-artifact",
            title: "Implementation note",
            kind: "markdown",
            content: "# Result",
            sourceSurface: "code",
            version: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          ...callbacks,
        })}
      />,
    );
    const buttonByText = (label: string) =>
      renderer.root.findAllByType("button").find((button) => nodeText(button).includes(label))!;

    act(() => {
      buttonByText("Close artifact").props.onClick();
    });
    expect(callbacks.onCloseGeneratedArtifact).toHaveBeenCalled();

    act(() => {
      renderer.update(
        <CodeWorkbenchPanel
          {...baseWorkbenchProps({
            selectedTurn: {
              turnId: "turn-artifact",
              assistantMessage: { content: "" },
              trace: { status: "completed" },
              toolRuns: [],
            },
            workbenchState: {
              sessionId: "session-1",
              projectId: "project-1",
              baseRef: "main",
              worktreePath: "./.worktrees/session-1",
              worktreeStatus: "ready",
              activeFilePath: null,
              validationStatus: "idle",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            ...callbacks,
          })}
        />,
      );
    });
    expect(
      renderer.root
        .findAll((node) => Array.isArray(node.children))
        .map((node) => node.children.join(""))
        .join(" "),
    ).toContain("No generated artifact is open.");

    act(() => {
      buttonByText("File").props.onClick();
    });
    expect(
      renderer.root
        .findAll((node) => Array.isArray(node.children))
        .map((node) => node.children.join(""))
        .join(" "),
    ).toContain("No file is selected yet.");

    act(() => {
      renderer.root.findByProps({ "aria-label": "Validation command" }).props.onChange({ target: { value: "   " } });
    });
    act(() => {
      buttonByText("Test").props.onClick();
      buttonByText("Apply").props.onClick();
    });
    expect(callbacks.onRunValidationCommand).not.toHaveBeenCalled();
    expect(callbacks.onApplyPatch).not.toHaveBeenCalled();
    expect(buttonByText("Export").props.disabled).toBe(true);
    expect(buttonByText("Revert file").props.disabled).toBe(true);
  });

  it("keeps repo operations blocked before a ready worktree exists", () => {
    const callbacks = {
      onCreateWorktree: vi.fn(),
      onRunValidationCommand: vi.fn(),
      onApplyPatch: vi.fn(),
      onExportPatch: vi.fn(),
      onRevertFile: vi.fn(),
      onRevertAll: vi.fn(),
    };
    const renderer = create(
      <CodeWorkbenchPanel
        {...baseWorkbenchProps({
          projectName: "Atlas",
          workbenchState: {
            sessionId: "session-1",
            projectId: "project-1",
            baseRef: "main",
            worktreePath: null,
            worktreeStatus: "creating",
            activeFilePath: null,
            validationStatus: "idle",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          selectedTurn: {
            turnId: "turn-blocked",
            assistantMessage: { content: "" },
            trace: { status: "waiting_for_user_input" },
          },
          ...callbacks,
        })}
      />,
    );
    const buttonByText = (label: string) =>
      renderer.root.findAllByType("button").find((button) => nodeText(button).includes(label))!;

    expect(
      renderer.root
        .findAll((node) => Array.isArray(node.children))
        .map((node) => node.children.join(""))
        .join(" "),
    ).toContain("The selected turn is waiting for your answer in the main thread.");

    act(() => {
      buttonByText("Create worktree").props.onClick();
      buttonByText("Test").props.onClick();
      buttonByText("Apply").props.onClick();
    });
    expect(callbacks.onCreateWorktree).toHaveBeenCalled();
    expect(callbacks.onRunValidationCommand).not.toHaveBeenCalled();
    expect(callbacks.onApplyPatch).not.toHaveBeenCalled();
    expect(buttonByText("Export").props.disabled).toBe(true);
    expect(buttonByText("Revert file").props.disabled).toBe(true);
    expect(buttonByText("Revert all").props.disabled).toBe(true);
  });

  it("drives workbench toolbar and pane actions through the interactive shell", () => {
    const callbacks = {
      onCreateWorktree: vi.fn(),
      onSelectFile: vi.fn(),
      onDraftChange: vi.fn(),
      onExpandedPathsChange: vi.fn(),
      onRefresh: vi.fn(),
      onSaveFile: vi.fn(),
      onDiscardDraft: vi.fn(),
      onRunValidationCommand: vi.fn(),
      onApplyPatch: vi.fn(),
      onExportPatch: vi.fn(),
      onRevertFile: vi.fn(),
      onRevertAll: vi.fn(),
      onRunHelperSnippet: vi.fn(),
      onCloseGeneratedArtifact: vi.fn(),
    };
    const selectedTurn = {
      turnId: "turn-1",
      assistantMessage: {
        content: "```js\nconsole.log(1)\n```\n```diff\n+patched\n```",
      },
      trace: {
        status: "waiting_for_approval",
      },
      toolRuns: [{ toolRunId: "tool-1" }],
    } as any;
    const renderer = create(
      <CodeWorkbenchPanel
        selectedTurn={selectedTurn}
        projectName="Atlas"
        needsProjectBinding={false}
        workbenchState={{
          sessionId: "session-1",
          projectId: "project-1",
          baseRef: "main",
          worktreePath: "./.worktrees/session-1",
          worktreeStatus: "ready",
          activeFilePath: "src/index.ts",
          validationStatus: "failed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }}
        workbenchTree={{
          state: {} as any,
          rootPath: "./.worktrees/session-1",
          changedFiles: ["src/index.ts", "src/other.ts"],
          items: [
            { path: "src/index.ts", name: "index.ts", kind: "file", changed: true, depth: 1 },
            { path: "src/other.ts", name: "other.ts", kind: "file", changed: false, depth: 1 },
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
          content: "const answer = 0;",
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
          changedFiles: ["src/index.ts", "src/other.ts"],
          summary: { changedFiles: 2, additions: 4, deletions: 1 },
          diff: "+const answer = 42;",
        }}
        output={{
          state: {} as any,
          helperRuns: [
            {
              runId: "run-1",
              status: "failed",
              language: "typescript",
              requestedOutputIntent: "validation",
              stdoutPreview: "stdout",
              stderrPreview: "stderr",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          output: "vitest failed",
          lastUpdatedAt: "2026-01-01T00:00:00.000Z",
        }}
        loading={false}
        busy={false}
        saving={false}
        error="Validation failed"
        hasDirtyDraft={false}
        {...callbacks}
      />,
    );

    const buttonByText = (label: string) =>
      renderer.root.findAllByType("button").find((button) => button.children.join("").includes(label))!;

    act(() => {
      renderer.root.findByProps({ "aria-label": "Validation command" }).props.onChange({
        target: { value: "pnpm test -- --runInBand" },
      });
      buttonByText("Refresh").props.onClick();
      buttonByText("Save file").props.onClick();
      buttonByText("Test").props.onClick();
      buttonByText("Export").props.onClick();
      buttonByText("Revert file").props.onClick();
    });
    expect(callbacks.onRefresh).toHaveBeenCalled();
    expect(callbacks.onSaveFile).toHaveBeenCalled();
    expect(callbacks.onRunValidationCommand).toHaveBeenCalledWith({
      command: "pnpm",
      args: ["test"],
    });
    expect(callbacks.onExportPatch).toHaveBeenCalled();
    expect(callbacks.onRevertFile).toHaveBeenCalledWith("src/index.ts");

    act(() => {
      buttonByText("Draft snippets").props.onClick();
    });
    act(() => {
      buttonByText("diff 2").props.onClick();
    });
    act(() => {
      buttonByText("Run helper").props.onClick();
      buttonByText("Apply").props.onClick();
    });
    expect(callbacks.onRunHelperSnippet).toHaveBeenCalledWith("typescript", "+patched");
    expect(callbacks.onApplyPatch).toHaveBeenCalledWith("+patched");

    act(() => {
      buttonByText("Selected diff").props.onClick();
    });
    expect(
      renderer.root.findAll(
        (node) => Array.isArray(node.children) && node.children.join("").includes("Selected-file diff"),
      ),
    ).not.toHaveLength(0);

    act(() => {
      buttonByText("Run log").props.onClick();
    });
    expect(
      renderer.root.findAll((node) => Array.isArray(node.children) && node.children.join("").includes("vitest failed")),
    ).not.toHaveLength(0);
  });

  it("handles dirty-file guards, empty panes, keyboard save, and revert confirmations", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        addEventListener: vi.fn((eventName: string, listener: (event: KeyboardEvent) => void) => {
          listeners.set(eventName, listener);
        }),
        removeEventListener: vi.fn((eventName: string) => {
          listeners.delete(eventName);
        }),
      },
    });

    const callbacks = {
      onCreateWorktree: vi.fn(),
      onSelectFile: vi.fn(),
      onDraftChange: vi.fn(),
      onExpandedPathsChange: vi.fn(),
      onRefresh: vi.fn(),
      onSaveFile: vi.fn(),
      onDiscardDraft: vi.fn(),
      onRunValidationCommand: vi.fn(),
      onApplyPatch: vi.fn(),
      onExportPatch: vi.fn(),
      onRevertFile: vi.fn(),
      onRevertAll: vi.fn(),
      onRunHelperSnippet: vi.fn(),
    };
    const baseProps = {
      selectedTurn: {
        turnId: "turn-empty",
        assistantMessage: {
          content: "No fenced helper snippets in this turn.",
        },
        trace: {
          status: "completed",
        },
        toolRuns: [],
      } as any,
      projectName: "Atlas",
      needsProjectBinding: false,
      workbenchState: {
        sessionId: "session-1",
        projectId: "project-1",
        baseRef: "main",
        worktreePath: "./.worktrees/session-1",
        worktreeStatus: "ready",
        activeFilePath: "src/index.ts",
        validationStatus: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      workbenchTree: {
        state: {} as any,
        rootPath: "./.worktrees/session-1",
        changedFiles: ["src/index.ts"],
        items: [
          { path: "src/index.ts", name: "index.ts", kind: "file", changed: true, depth: 1 },
          { path: "src/other.ts", name: "other.ts", kind: "file", changed: false, depth: 1 },
        ],
      },
      selectedFile: {
        state: {} as any,
        path: "src/index.ts",
        sizeBytes: 0,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        contentType: "text/typescript",
        language: "typescript",
        changed: true,
        content: "const answer = 0;",
      },
      selectedFileDiff: null,
      draftContent: "const answer = 1;",
      expandedPaths: ["src"],
      diff: {
        state: {} as any,
        scopePath: ".",
        changedFiles: [],
        summary: { changedFiles: 0, additions: 0, deletions: 0 },
        diff: "",
      },
      output: {
        state: {} as any,
        helperRuns: [],
        output: "",
        lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
      loading: false,
      busy: false,
      saving: false,
      error: null,
      hasDirtyDraft: true,
      ...callbacks,
    };

    const renderer = create(<CodeWorkbenchPanel {...baseProps} />);
    const buttonByText = (label: string) =>
      renderer.root.findAllByType("button").find((button) => nodeText(button).includes(label))!;

    const preventDefault = vi.fn();
    act(() => {
      listeners.get("keydown")?.({
        ctrlKey: true,
        metaKey: false,
        key: "s",
        preventDefault,
      } as unknown as KeyboardEvent);
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(callbacks.onSaveFile).toHaveBeenCalled();

    act(() => {
      buttonByText("other.ts").props.onClick();
    });
    expect(callbacks.onSelectFile).not.toHaveBeenCalledWith("src/other.ts");

    act(() => {
      buttonByText("Discard and switch").props.onClick();
    });
    expect(callbacks.onDiscardDraft).toHaveBeenCalled();
    expect(callbacks.onSelectFile).toHaveBeenCalledWith("src/other.ts");

    for (const label of ["Selected diff", "Repo diff", "Run log", "Draft snippets"]) {
      act(() => {
        buttonByText(label).props.onClick();
      });
    }
    const renderedText = renderer.root
      .findAll((node) => Array.isArray(node.children))
      .map((node) => node.children.join(""))
      .join(" ");
    expect(renderedText).toContain("No extracted helper snippets are available");

    act(() => {
      renderer.update(
        <CodeWorkbenchPanel
          {...baseProps}
          hasDirtyDraft={false}
          workbenchTree={{ ...baseProps.workbenchTree, changedFiles: ["src/index.ts"] }}
          diff={{
            state: {} as any,
            scopePath: ".",
            changedFiles: ["src/index.ts"],
            summary: { changedFiles: 1, additions: 1, deletions: 0 },
            diff: "",
          }}
        />,
      );
    });
    act(() => {
      buttonByText("Revert all").props.onClick();
    });
    act(() => {
      buttonByText("Revert all changes").props.onClick();
    });
    expect(callbacks.onRevertAll).toHaveBeenCalled();

    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });
});
