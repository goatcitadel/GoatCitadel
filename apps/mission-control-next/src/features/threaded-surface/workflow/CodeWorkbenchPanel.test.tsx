import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@goatcitadel/mission-control-shared/components/AgenticRuntimeVisibilityPanel", () => ({
  AgenticRuntimeVisibilityPanel: () => null,
}));

vi.mock("@goatcitadel/mission-control-shared/components/MonacoDiffEditor", () => ({
  MonacoDiffEditor: () => null,
}));

vi.mock("@goatcitadel/mission-control-shared/components/WorkbenchMonacoEditor", () => ({
  WorkbenchMonacoEditor: () => null,
}));

vi.mock("@goatcitadel/mission-control-shared/components/WorkbenchFileTree", () => ({
  WorkbenchFileTree: () => null,
}));

vi.mock("@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer", () => ({
  GeneratedArtifactViewer: () => null,
}));

vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({
  compareCodeModeRuns: vi.fn(async () => null),
  fetchCodeModeExecutionBackends: vi.fn(async () => ({ backends: [] })),
  fetchCodeModeRun: vi.fn(async () => null),
  fetchCodeModeRunArtifact: vi.fn(async () => null),
  fetchCodeModeRuns: vi.fn(async () => ({ items: [] })),
}));

vi.mock("@goatcitadel/mission-control-shared/api/agentic", () => ({
  fetchAgenticChannelDeliveries: vi.fn(async () => ({ items: [] })),
  fetchAgenticRuntimeAvailability: vi.fn(async () => null),
}));

import { NextCodeWorkbenchPanel } from "./CodeWorkbenchPanel";

function buildCodePanel(overrides: Record<string, unknown> = {}) {
  const noop = vi.fn();
  return {
    kind: "code" as const,
    props: {
      workspaceId: "default",
      selectedTurn: null,
      projectName: "demo-project",
      needsProjectBinding: false,
      workbenchState: undefined,
      workbenchTree: undefined,
      selectedFile: null,
      selectedFileDiff: null,
      draftContent: null,
      expandedPaths: [],
      diff: null,
      output: null,
      loading: false,
      busy: false,
      saving: false,
      error: null,
      hasDirtyDraft: false,
      generatedArtifact: null,
      onCloseGeneratedArtifact: noop,
      availableProjects: [],
      selectedProjectCandidateId: undefined,
      sourceBindingBusy: false,
      onBindExistingProject: noop,
      onImportProjectSource: noop,
      onCreateWorktree: noop,
      onSelectFile: noop,
      onDraftChange: noop,
      onExpandedPathsChange: noop,
      onRefresh: noop,
      onSaveFile: noop,
      onFileOperation: noop,
      onDiscardDraft: noop,
      onRunValidationCommand: noop,
      onApplyPatch: noop,
      onExportPatch: noop,
      onRevertFile: noop,
      onRevertAll: noop,
      onRunHelperSnippet: noop,
      onOpenApprovals: noop,
      ...overrides,
    },
  };
}

function findButtonByAriaLabel(root: ReactTestInstance, ariaLabel: string): ReactTestInstance {
  return root.findByProps({ "aria-label": ariaLabel });
}

describe("NextCodeWorkbenchPanel more-menu Escape handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  it("claims Escape to close the more-menu without leaking it to the document-bubble stream-stop hook", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", {
      activeElement: null,
      contains: () => false,
      querySelector: () => null,
      addEventListener,
      removeEventListener,
    });

    const panel = buildCodePanel();

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<NextCodeWorkbenchPanel panel={panel} />);
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByAriaLabel(renderer!.root, "More workbench actions").props.onClick();
      await Promise.resolve();
    });
    expect(renderer!.root.findAllByProps({ className: "mc-next-workbench-more-popover" })).toHaveLength(1);

    const keydownCall = addEventListener.mock.calls.find(([type]) => type === "keydown");
    expect(keydownCall).toBeDefined();
    const escapeHandler = keydownCall?.[1] as
      | ((event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void)
      | undefined;
    expect(escapeHandler).toBeTypeOf("function");

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      escapeHandler?.({ key: "Escape", preventDefault, stopPropagation });
    });

    // The menu closed...
    expect(renderer!.root.findAllByProps({ className: "mc-next-workbench-more-popover" })).toHaveLength(0);
    // ...and claimed the event so the document-bubble useEscapeToStopStream
    // hook (which only fires when `!event.defaultPrevented`) would skip it.
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("does not touch the Escape event when the more-menu is closed", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", {
      activeElement: null,
      contains: () => false,
      querySelector: () => null,
      addEventListener,
      removeEventListener,
    });

    const panel = buildCodePanel();

    await act(async () => {
      create(<NextCodeWorkbenchPanel panel={panel} />);
      await Promise.resolve();
    });

    // The more-menu was never opened, so its `useEffect` never registers a
    // "keydown" listener at all (it early-returns while `moreMenuOpen` is false).
    expect(addEventListener.mock.calls.find(([type]) => type === "keydown")).toBeUndefined();
  });
});
