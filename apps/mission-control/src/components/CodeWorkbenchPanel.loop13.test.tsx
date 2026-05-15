import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./WorkbenchFileTree", () => ({
  WorkbenchFileTree: ({
    items,
    onExpandedPathsChange,
    onSelectFile,
  }: {
    items: Array<{ path: string; name: string }>;
    onExpandedPathsChange: (paths: string[]) => void;
    onSelectFile: (path: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onExpandedPathsChange(["src", "src/nested"])}>
        expand tree
      </button>
      {items.map((item) => (
        <button key={item.path} type="button" onClick={() => onSelectFile(item.path)}>
          {`file:${item.name}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("./WorkbenchMonacoEditor", () => ({
  WorkbenchMonacoEditor: ({
    language,
    onChange,
    readOnly,
    value,
  }: {
    language?: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
    value: string;
  }) => (
    <textarea
      aria-label={`editor:${language ?? "plaintext"}:${readOnly ? "read" : "write"}`}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      readOnly={readOnly}
    />
  ),
}));

vi.mock("./MonacoDiffEditor", () => ({
  MonacoDiffEditor: ({ language, modified, original }: { language: string; modified: string; original: string }) => (
    <div>{`diff:${language}:${original}->${modified}`}</div>
  ),
}));

vi.mock("./ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    confirmLabel,
    onCancel,
    onConfirm,
  }: {
    open?: boolean;
    title?: string;
    confirmLabel?: string;
    onCancel?: () => void;
    onConfirm?: () => void;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

vi.mock("./StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("./chat/GeneratedArtifactViewer", () => ({
  GeneratedArtifactViewer: ({ artifact }: { artifact: { title: string } }) => <div>artifact:{artifact.title}</div>,
}));

import { CodeWorkbenchPanel } from "./CodeWorkbenchPanel";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(" ");
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function text(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function nodeText(node: { children?: unknown[] }): string {
  return (node.children ?? [])
    .map((child) =>
      typeof child === "string" ? child : child && typeof child === "object" ? nodeText(child as any) : "",
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function button(renderer: ReactTestRenderer, label: string, occurrence = 0) {
  const found = renderer.root
    .findAll((node) => node.type === "button" && nodeText(node).includes(label))
    .at(occurrence);
  if (!found) {
    throw new Error(`Button not found: ${label}`);
  }
  return found;
}

function baseProps(overrides: Partial<React.ComponentProps<typeof CodeWorkbenchPanel>> = {}) {
  return {
    selectedTurn: {
      turnId: "turn-1",
      assistantMessage: {
        content: "```js\nconsole.log('one')\n```\n```ts\nconst two: number = 2\n```",
      },
      trace: { status: "completed" },
      toolRuns: [{ toolRunId: "tool-1" }],
    } as any,
    projectName: "Atlas",
    needsProjectBinding: false,
    workbenchState: {
      sessionId: "session-1",
      worktreeStatus: "ready",
      validationStatus: "failed",
      baseRef: "main",
      worktreePath: ".worktrees/session-1",
    } as any,
    workbenchTree: {
      rootPath: ".worktrees/session-1",
      changedFiles: ["src/current.ts", "src/next.ts"],
      items: [
        { path: "src/current.ts", name: "current.ts", kind: "file", depth: 1, changed: true },
        { path: "src/next.ts", name: "next.ts", kind: "file", depth: 1, changed: false },
      ],
    } as any,
    selectedFile: {
      path: "src/current.ts",
      language: "typescript",
      content: "const oldValue = 1;",
      changed: true,
      sizeBytes: 128,
    } as any,
    selectedFileDiff: {
      path: "src/current.ts",
      language: "typescript",
      originalContent: "const oldValue = 0;",
      modifiedContent: "const oldValue = 1;",
    } as any,
    draftContent: "const oldValue = 2;",
    expandedPaths: ["src"],
    diff: {
      changedFiles: ["src/current.ts", "src/next.ts"],
      summary: { changedFiles: 2, additions: 4, deletions: 1 },
      diff: "diff --git a/src/current.ts b/src/current.ts",
    } as any,
    output: {
      helperRuns: [
        {
          runId: "helper-1",
          language: "typescript",
          status: "failed",
          requestedOutputIntent: undefined,
          stderrPreview: "type error",
        },
      ],
      output: "vitest failed",
    } as any,
    loading: false,
    busy: false,
    saving: false,
    error: "Workbench warning",
    hasDirtyDraft: true,
    onCreateWorktree: vi.fn(),
    onSelectFile: vi.fn(),
    onDraftChange: vi.fn(),
    onExpandedPathsChange: vi.fn(),
    onRefresh: vi.fn(),
    onSaveFile: vi.fn(),
    onDiscardDraft: vi.fn(),
    onRunHelperSnippet: vi.fn(),
    ...overrides,
  } satisfies React.ComponentProps<typeof CodeWorkbenchPanel>;
}

describe("CodeWorkbenchPanel loop 13 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const listeners = new Map<string, Set<(event: any) => void>>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn((type: string, listener: (event: any) => void) => {
          const bucket = listeners.get(type) ?? new Set<(event: any) => void>();
          bucket.add(listener);
          listeners.set(type, bucket);
        }),
        removeEventListener: vi.fn((type: string, listener: (event: any) => void) => {
          listeners.get(type)?.delete(listener);
        }),
        dispatchEvent: vi.fn((event: { type: string }) => {
          for (const listener of listeners.get(event.type) ?? []) {
            listener(event);
          }
          return true;
        }),
      },
    });
  });

  it("guards dirty file switches, supports keyboard save, and runs extracted helper snippets", async () => {
    const props = baseProps();
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<CodeWorkbenchPanel {...props} />);
      });

      expect(text(renderer)).toContain("Unsaved changes");
      expect(text(renderer)).toContain("Workbench warning");

      await act(async () => {
        window.dispatchEvent({
          type: "keydown",
          key: "s",
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
        } as any);
      });
      expect(props.onSaveFile).toHaveBeenCalledTimes(1);

      await act(async () => {
        button(renderer, "file:next.ts").props.onClick();
      });
      expect(text(renderer)).toContain("Discard unsaved file changes?");
      await act(async () => {
        button(renderer, "Cancel").props.onClick();
      });
      expect(props.onSelectFile).not.toHaveBeenCalled();

      await act(async () => {
        button(renderer, "file:next.ts").props.onClick();
      });
      await act(async () => {
        button(renderer, "Discard and switch").props.onClick();
      });
      expect(props.onDiscardDraft).toHaveBeenCalledTimes(1);
      expect(props.onSelectFile).toHaveBeenCalledWith("src/next.ts");

      await act(async () => {
        button(renderer, "Draft snippets").props.onClick();
      });
      await act(async () => {
        button(renderer, "Run helper").props.onClick();
      });
      expect(props.onRunHelperSnippet).toHaveBeenLastCalledWith("javascript", "console.log('one')");

      await act(async () => {
        button(renderer, "ts 2").props.onClick();
      });
      await act(async () => {
        button(renderer, "Run helper").props.onClick();
      });
      expect(props.onRunHelperSnippet).toHaveBeenLastCalledWith("typescript", "const two: number = 2");

      await act(async () => {
        button(renderer, "Selected diff").props.onClick();
      });
      expect(text(renderer)).toContain("diff:typescript:const oldValue = 0;->const oldValue = 2;");

      await act(async () => {
        button(renderer, "Run log").props.onClick();
      });
      expect(text(renderer)).toContain("vitest failed");
      expect(text(renderer)).toContain("type error");
    } finally {
      renderer.unmount();
    }
  });

  it("shows unready, blocked, empty, and artifact states without changing behavior", async () => {
    const onCreateWorktree = vi.fn();
    const onCloseGeneratedArtifact = vi.fn();
    const props = baseProps({
      selectedTurn: {
        turnId: "turn-2",
        assistantMessage: { content: "" },
        trace: { status: "waiting_for_approval" },
        toolRuns: [],
      } as any,
      workbenchState: {
        sessionId: "session-2",
        worktreeStatus: "initializing",
        validationStatus: "running",
      } as any,
      workbenchTree: { items: [], changedFiles: [] } as any,
      selectedFile: null,
      selectedFileDiff: null,
      draftContent: undefined,
      diff: { changedFiles: [], summary: { changedFiles: 0, additions: 0, deletions: 0 }, diff: "" } as any,
      output: { helperRuns: [], output: "" } as any,
      hasDirtyDraft: false,
      error: null,
      onCreateWorktree,
      generatedArtifact: {
        artifactId: "artifact-1",
        sessionId: "session-2",
        turnId: "turn-2",
        sourceSurface: "code",
        kind: "markdown",
        title: "Operator note",
        content: "# Note",
        version: 1,
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
      } as any,
      onCloseGeneratedArtifact,
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<CodeWorkbenchPanel {...props} />);
      });

      expect(text(renderer)).toContain("Create worktree");
      await act(async () => {
        button(renderer, "Create worktree").props.onClick();
      });
      expect(onCreateWorktree).toHaveBeenCalledTimes(1);
      expect(text(renderer)).toContain("A human approval is required before the run can proceed.");
      expect(text(renderer)).toContain("artifact: Operator note");

      await act(async () => {
        button(renderer, "Close artifact").props.onClick();
      });
      expect(onCloseGeneratedArtifact).toHaveBeenCalledTimes(1);

      await act(async () => {
        button(renderer, "Repo diff").props.onClick();
      });
      expect(text(renderer)).toContain("No diff is available yet.");

      await act(async () => {
        button(renderer, "Run log").props.onClick();
      });
      expect(text(renderer)).toContain("No run log output has landed yet.");

      await act(async () => {
        button(renderer, "Draft snippets").props.onClick();
      });
      expect(text(renderer)).toContain("No extracted helper snippets are available for this turn.");
    } finally {
      renderer.unmount();
    }
  });
});
