import React from "react";
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
          Cancel {title}
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

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    selectedTurn: {
      turnId: "turn-1",
      assistantMessage: { content: "No helper snippets." },
      trace: { status: "completed" },
      toolRuns: [],
    },
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
      state: {},
      rootPath: "./.worktrees/session-1",
      changedFiles: ["src/index.ts"],
      items: [
        { path: "src/index.ts", name: "index.ts", kind: "file", changed: true, depth: 1 },
        { path: "src/other.ts", name: "other.ts", kind: "file", changed: false, depth: 1 },
      ],
    },
    selectedFile: {
      state: {},
      path: "src/index.ts",
      sizeBytes: 18,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      contentType: "text/typescript",
      language: "typescript",
      changed: true,
      content: "const value = 1;",
    },
    selectedFileDiff: null,
    draftContent: "const value = 2;",
    expandedPaths: ["src"],
    diff: {
      state: {},
      scopePath: ".",
      changedFiles: ["src/index.ts"],
      summary: { changedFiles: 1, additions: 1, deletions: 0 },
      diff: "+const value = 2;",
    },
    output: {
      state: {},
      helperRuns: [],
      output: "",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
    loading: false,
    busy: false,
    saving: false,
    error: null,
    hasDirtyDraft: true,
    onCreateWorktree: vi.fn(),
    onSelectFile: vi.fn(),
    onDraftChange: vi.fn(),
    onExpandedPathsChange: vi.fn(),
    onRefresh: vi.fn(),
    onSaveFile: vi.fn(),
    onDiscardDraft: vi.fn(),
    onRunHelperSnippet: vi.fn(),
    onRevertAll: vi.fn(),
    ...overrides,
  } as any;
}

describe("CodeWorkbenchPanel tail coverage", () => {
  it("lets operators cancel destructive workbench confirmations without dispatching mutations", () => {
    const callbacks = {
      onSelectFile: vi.fn(),
      onDiscardDraft: vi.fn(),
      onRevertAll: vi.fn(),
    };
    const renderer = create(<CodeWorkbenchPanel {...baseProps(callbacks)} />);

    const buttonByText = (label: string) =>
      renderer.root.findAllByType("button").find((button) => nodeText(button).includes(label))!;

    act(() => {
      buttonByText("Revert all").props.onClick();
    });
    act(() => {
      buttonByText("Cancel Revert all worktree changes?").props.onClick();
    });
    expect(callbacks.onRevertAll).not.toHaveBeenCalled();

    act(() => {
      buttonByText("other.ts").props.onClick();
    });
    act(() => {
      buttonByText("Cancel Discard unsaved file changes?").props.onClick();
    });
    expect(callbacks.onDiscardDraft).not.toHaveBeenCalled();
    expect(callbacks.onSelectFile).not.toHaveBeenCalled();
  });

  it("runs validation, helper, and patch snippet actions from the active workbench pane", () => {
    const callbacks = {
      onRunValidationCommand: vi.fn(),
      onRunHelperSnippet: vi.fn(),
      onApplyPatch: vi.fn(),
      onSelectFile: vi.fn(),
    };
    const renderer = create(
      <CodeWorkbenchPanel
        {...baseProps({
          ...callbacks,
          hasDirtyDraft: false,
          draftContent: undefined,
          selectedTurn: {
            turnId: "turn-snippets",
            assistantMessage: {
              content: [
                "Draft helpers:",
                "```",
                "const fallbackLanguage = true;",
                "```",
                "```js",
                "console.log('js helper');",
                "```",
                "```diff",
                "*** Begin Patch",
                "*** End Patch",
                "```",
              ].join("\n"),
            },
            trace: { status: "completed" },
            toolRuns: [],
          },
        })}
      />,
    );

    const buttonByText = (label: string) =>
      renderer.root.findAllByType("button").find((button) => nodeText(button).includes(label))!;
    const validationInput = renderer.root.findByProps({ "aria-label": "Validation command" });

    act(() => {
      validationInput.props.onChange({ target: { value: "   " } });
    });
    callbacks.onRunValidationCommand.mockClear();
    act(() => {
      buttonByText("Test").props.onClick();
    });
    expect(callbacks.onRunValidationCommand).not.toHaveBeenCalled();

    act(() => {
      validationInput.props.onChange({ target: { value: "pnpm test --filter shared" } });
    });
    act(() => {
      buttonByText("Test").props.onClick();
    });
    expect(callbacks.onRunValidationCommand).toHaveBeenCalledWith({
      command: "pnpm",
      args: ["test", "--filter", "shared"],
    });

    act(() => {
      buttonByText("Draft snippets").props.onClick();
    });
    act(() => {
      buttonByText("Run helper").props.onClick();
    });
    expect(callbacks.onRunHelperSnippet).toHaveBeenCalledWith("typescript", "const fallbackLanguage = true;");

    act(() => {
      buttonByText("js 2").props.onClick();
    });
    act(() => {
      buttonByText("Run helper").props.onClick();
    });
    expect(callbacks.onRunHelperSnippet).toHaveBeenCalledWith("javascript", "console.log('js helper');");

    act(() => {
      buttonByText("diff 3").props.onClick();
    });
    act(() => {
      buttonByText("Apply").props.onClick();
    });
    expect(callbacks.onApplyPatch).toHaveBeenCalledWith("*** Begin Patch\n*** End Patch");

    act(() => {
      buttonByText("other.ts").props.onClick();
    });
    expect(callbacks.onSelectFile).toHaveBeenCalledWith("src/other.ts");
  });

  it("renders output run status variants and clean selected-file labels", () => {
    const renderer = create(
      <CodeWorkbenchPanel
        {...baseProps({
          hasDirtyDraft: false,
          selectedFile: {
            state: {},
            path: "src/index.ts",
            sizeBytes: 0,
            modifiedAt: "2026-01-01T00:00:00.000Z",
            contentType: "text/typescript",
            language: "typescript",
            changed: false,
            content: "const value = 1;",
          },
          output: {
            state: {},
            output: "pnpm test passed",
            helperRuns: [
              {
                runId: "run-completed",
                language: "typescript",
                status: "completed",
                requestedOutputIntent: "lint",
                stdoutPreview: "ok",
                stderrPreview: "",
              },
              {
                runId: "run-failed",
                language: "javascript",
                status: "failed",
                requestedOutputIntent: null,
                stdoutPreview: "",
                stderrPreview: "boom",
              },
              {
                runId: "run-pending",
                language: "python",
                status: "queued",
                requestedOutputIntent: undefined,
              },
            ],
            lastUpdatedAt: "2026-01-01T00:00:00.000Z",
          },
        })}
      />,
    );

    const buttonByText = (label: string) =>
      renderer.root.findAllByType("button").find((button) => nodeText(button).includes(label))!;

    expect(nodeText(renderer.root)).toContain("typescript · saved");

    act(() => {
      buttonByText("Run log").props.onClick();
    });

    const text = nodeText(renderer.root);
    expect(text).toContain("pnpm test passed");
    expect(text).toContain("completed");
    expect(text).toContain("failed");
    expect(text).toContain("queued");
    expect(text).toContain("lint");
    expect(text).toContain("helper");
    expect(text).toContain("boom");
  });
});
