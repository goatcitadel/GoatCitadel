import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import {
  fetchAgenticChannelDeliveries,
  fetchAgenticRuntimeAvailability,
} from "@goatcitadel/mission-control-shared/api/agentic";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { WorkbenchFileTree } from "@goatcitadel/mission-control-shared/components/WorkbenchFileTree";
import { ThreadedWorkflowPanel } from "./ThreadedWorkflowPanel";

vi.mock("@goatcitadel/mission-control-shared/api/agentic", () => ({
  fetchAgenticChannelDeliveries: vi.fn(),
  fetchAgenticRuntimeAvailability: vi.fn(),
}));

const mockedFetchAgenticRuntimeAvailability = vi.mocked(fetchAgenticRuntimeAvailability);
const mockedFetchAgenticChannelDeliveries = vi.mocked(fetchAgenticChannelDeliveries);

function instanceText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (value && typeof value === "object" && "children" in value) {
    return instanceText((value as { children?: unknown }).children);
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map(instanceText).join("");
}

function buildCoworkPanel(onAgenticControl = vi.fn()): Extract<MissionThreadedWorkflowPanel, { kind: "cowork" }> {
  return {
    kind: "cowork",
    props: {
      viewModel: {
        empty: false,
        activeTurnId: null,
        selectedTurnId: null,
        hasHistoricalSelection: false,
        headerTitle: "Cowork run",
        headerSummary: "Runtime controls are visible.",
        sourceLabel: "Live",
        freshnessLabel: "Fresh",
        completenessLabel: "Complete",
        stageCards: [],
        now: { label: "Now", title: "Running", summary: "Run in progress.", facts: [] },
        nextAction: null,
        blockers: [],
        operatorActionItems: { items: [], overflow: 0 },
        planItems: { items: [], overflow: 0 },
        roleItems: { items: [], overflow: 0 },
        timelineItems: { items: [], overflow: 0 },
        outputItems: { items: [], overflow: 0 },
        continuationGate: {
          decision: "continue",
          reasonCodes: [],
          summary: "Continue.",
          metrics: {
            stepsSinceCheckpoint: 0,
            toolRunCount: 0,
            failedToolRunCount: 0,
            retryFailureStreak: 0,
            approvalWait: false,
            userInputWait: false,
            evidenceGapCount: 0,
          },
          recommendedAction: "Continue.",
          createdAt: "2026-05-05T12:00:00.000Z",
        },
        runMap: {
          objective: "Runtime controls",
          currentState: "Running",
          nextAction: "Observe",
          planNodes: [],
          checkpoints: [],
        },
        stateGaps: [],
        evidenceSummary: {
          label: "Evidence",
          detail: "No gaps",
          toolCallCount: 0,
          checkpointCount: 0,
          evidenceGapCount: 0,
        },
        agenticRuntime: {
          runId: "run-1",
          generatedAt: "2026-05-05T12:00:00.000Z",
          nodeCount: 1,
          edgeCount: 0,
          diagnostics: [],
          treeNodes: [],
          controls: [
            {
              id: "pause",
              action: "pause",
              title: "Pause run",
              enabled: true,
              status: "available",
              runtimeEffect: "state_only",
              meta: "state only",
              note: "Records a durable pause intent.",
            },
            {
              id: "kill_child",
              action: "kill_child",
              title: "Kill child agent",
              enabled: false,
              status: "disabled",
              runtimeEffect: "state_only",
              meta: "state only",
              note: "Requires an agentSessionId.",
            },
          ],
        },
        raw: { activeTurn: null, selectedTurn: null, orchestrationCheckpoints: [] },
      },
      onAgenticControl,
    },
  };
}

function buildCodePanel(
  overrides: Partial<Extract<MissionThreadedWorkflowPanel, { kind: "code" }>["props"]> = {},
): Extract<MissionThreadedWorkflowPanel, { kind: "code" }> {
  const workbenchState = {
    sessionId: "session-1",
    projectId: "project-1",
    baseRef: "main",
    worktreePath: "F:\\code\\personal-ai\\.worktrees\\session-1",
    worktreeStatus: "ready",
    validationStatus: "failed",
    createdAt: "2026-05-05T12:00:00.000Z",
    updatedAt: "2026-05-05T12:00:00.000Z",
  } as const;
  return {
    kind: "code",
    props: {
      selectedTurn: {
        turnId: "turn-1",
        sessionId: "session-1",
        userMessage: {
          messageId: "user-1",
          role: "user",
          content: "Apply this",
          createdAt: "2026-05-05T12:00:00.000Z",
        },
        assistantMessage: {
          messageId: "assistant-1",
          role: "assistant",
          content: "No pending patch here.",
          createdAt: "2026-05-05T12:00:01.000Z",
        },
        trace: { status: "completed", toolRuns: [] },
        toolRuns: [],
        attachments: [],
        knowledgeAttachments: [],
      } as any,
      projectName: "GoatCitadel",
      needsProjectBinding: false,
      workbenchState,
      workbenchTree: {
        state: workbenchState,
        rootPath: "F:\\code\\personal-ai",
        changedFiles: ["src/app.ts"],
        items: [],
      },
      selectedFile: null,
      selectedFileDiff: null,
      draftContent: "",
      expandedPaths: [],
      diff: {
        state: workbenchState,
        scopePath: "F:\\code\\personal-ai",
        changedFiles: ["src/app.ts"],
        summary: { changedFiles: 1, additions: 1, deletions: 0 },
        diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@\n+console.log('current');\n",
      },
      output: { state: workbenchState, output: "", helperRuns: [] } as any,
      loading: false,
      busy: false,
      saving: false,
      error: null,
      hasDirtyDraft: false,
      generatedArtifact: null,
      onCloseGeneratedArtifact: vi.fn(),
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
      ...overrides,
    },
  };
}

describe("ThreadedWorkflowPanel", () => {
  beforeEach(() => {
    mockedFetchAgenticRuntimeAvailability.mockResolvedValue({
      generatedAt: "2026-05-05T12:00:00.000Z",
      items: [],
      harnesses: [
        {
          harnessId: "codex",
          label: "Codex CLI",
          status: "unavailable",
          callable: false,
          reasons: ["Executable was not found."],
          checkedAt: "2026-05-05T12:00:00.000Z",
          sandboxRequired: true,
          sandboxSatisfied: false,
        },
      ],
      plugins: [
        {
          runtimeId: "bad-plugin",
          kind: "plugin",
          label: "Broken plugin",
          status: "blocked",
          integrityStatus: "quarantined",
          permissions: ["filesystem"],
          secretsRequired: [],
          callableExposure: "blocked",
          healthMessage: "Manifest parse failed.",
        },
      ],
      providers: [
        {
          runtimeId: "openai",
          kind: "provider",
          label: "OpenAI",
          status: "callable",
          integrityStatus: "verified",
          permissions: [],
          secretsRequired: [],
          callableExposure: "callable",
          healthMessage: "Ready.",
        },
      ],
      channels: [
        {
          capabilityId: "telegram",
          label: "Telegram",
          family: "channel",
          status: "not_configured",
          callable: false,
          reasons: ["No target is configured."],
          checkedAt: "2026-05-05T12:00:00.000Z",
        },
      ],
    });
    mockedFetchAgenticChannelDeliveries.mockResolvedValue({
      count: 1,
      deliveries: [
        {
          deliveryId: "delivery-1",
          connectionId: "11111111-1111-4111-8111-111111111111",
          channelKey: "telegram",
          target: "ops-room",
          status: "stale",
          deliveryStatus: "blocked",
          attempts: 3,
          maxAttempts: 3,
          staleReason: "Final delivery expired after retries.",
          createdAt: "2026-05-05T12:00:00.000Z",
          updatedAt: "2026-05-05T12:05:00.000Z",
        },
      ],
    });
  });

  it("renders actionable agentic controls while keeping contextual controls disabled", async () => {
    const onAgenticControl = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={buildCoworkPanel(onAgenticControl)} />);
      await Promise.resolve();
    });

    const root = renderer!.root;
    const pauseButton = root.findAllByType("button").find((button) => button.children.includes("Record pause intent"));
    const killButton = root.findAllByType("button").find((button) => button.children.includes("Record kill intent"));

    expect(pauseButton).toBeTruthy();
    expect(pauseButton?.props.disabled).toBe(false);
    expect(killButton).toBeTruthy();
    expect(killButton?.props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("State-only: records intent in GoatCitadel state");

    act(() => {
      pauseButton?.props.onClick();
    });
    expect(onAgenticControl).toHaveBeenCalledWith(expect.objectContaining({ action: "pause", enabled: true }));
  });

  it("renders runtime availability and durable delivery disabled reasons", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={buildCoworkPanel()} />);
      await Promise.resolve();
    });

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("Codex CLI");
    expect(rendered).toContain("Executable was not found.");
    expect(rendered).toContain("Broken plugin");
    expect(rendered).toContain("quarantined");
    expect(rendered).toContain("Telegram");
    expect(rendered).toContain("No target is configured.");
    expect(rendered).toContain("Channel delivery");
    expect(rendered).toContain("Final delivery expired after retries.");
  });

  it("does not apply the current worktree diff without a separate pending patch", async () => {
    const onApplyPatch = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={buildCodePanel({ onApplyPatch })} />);
      await Promise.resolve();
    });

    const applyButton = renderer!.root.findAllByType("button").find((button) => button.children.includes("Apply"));
    expect(applyButton).toBeTruthy();
    expect(applyButton?.props.disabled).toBe(true);
    expect(String(applyButton?.props.title)).toContain("Apply requires a separate pending patch");
    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("Validation: ");
    expect(rendered).toContain("failed");
  });

  it("applies an assistant patch block instead of replaying the worktree diff", async () => {
    const pendingPatch =
      "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@\n+console.log('pending');";
    const onApplyPatch = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            onApplyPatch,
            selectedTurn: {
              ...(buildCodePanel().props.selectedTurn as any),
              assistantMessage: {
                messageId: "assistant-1",
                role: "assistant",
                content: `Here is a patch.\n\n\`\`\`diff\n${pendingPatch}\n\`\`\``,
                createdAt: "2026-05-05T12:00:01.000Z",
              },
            } as any,
          })}
        />,
      );
      await Promise.resolve();
    });

    const applyButton = renderer!.root.findAllByType("button").find((button) => button.children.includes("Apply"));
    expect(applyButton?.props.disabled).toBe(false);
    act(() => {
      applyButton?.props.onClick();
    });
    expect(onApplyPatch).toHaveBeenCalledWith(pendingPatch);
  });

  it("applies the selected patch snippet instead of a hidden first patch", async () => {
    const firstPatch =
      "diff --git a/src/first.ts b/src/first.ts\n--- a/src/first.ts\n+++ b/src/first.ts\n@@\n+console.log('first');";
    const secondPatch =
      "diff --git a/src/second.ts b/src/second.ts\n--- a/src/second.ts\n+++ b/src/second.ts\n@@\n+console.log('second');";
    const onApplyPatch = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            onApplyPatch,
            selectedTurn: {
              ...(buildCodePanel().props.selectedTurn as any),
              assistantMessage: {
                messageId: "assistant-1",
                role: "assistant",
                content: `Two patches.\n\n\`\`\`diff\n${firstPatch}\n\`\`\`\n\n\`\`\`patch\n${secondPatch}\n\`\`\``,
                createdAt: "2026-05-05T12:00:01.000Z",
              },
            } as any,
          })}
        />,
      );
      await Promise.resolve();
    });

    const snippetsTab = renderer!.root.findAllByType("button").find((button) => button.children.includes("Snippets"));
    expect(snippetsTab).toBeTruthy();
    await act(async () => {
      snippetsTab?.props.onClick();
    });
    const secondSnippetButton = renderer!.root
      .findAllByType("button")
      .find((button) => instanceText(button.children).includes("Snippet 2"));
    expect(secondSnippetButton).toBeTruthy();
    await act(async () => {
      secondSnippetButton?.props.onClick();
    });
    const applyButton = renderer!.root.findAllByType("button").find((button) => button.children.includes("Apply"));
    await act(async () => {
      applyButton?.props.onClick();
    });
    expect(onApplyPatch).toHaveBeenCalledWith(secondPatch);
  });

  it("confirms before switching files with unsaved workbench edits", async () => {
    const onSelectFile = vi.fn();
    const onDiscardDraft = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            onSelectFile,
            onDiscardDraft,
            hasDirtyDraft: true,
            selectedFile: {
              state: buildCodePanel().props.workbenchState,
              path: "src/app.ts",
              name: "app.ts",
              language: "typescript",
              content: "console.log('draft');",
              changed: true,
            } as any,
            draftContent: "console.log('unsaved');",
            workbenchTree: {
              state: buildCodePanel().props.workbenchState,
              rootPath: "F:\\code\\personal-ai",
              changedFiles: ["src/app.ts", "src/other.ts"],
              items: [
                { path: "src/app.ts", name: "app.ts", kind: "file", depth: 1, changed: true },
                { path: "src/other.ts", name: "other.ts", kind: "file", depth: 1, changed: false },
              ],
            } as any,
          })}
        />,
      );
      await Promise.resolve();
    });

    const fileTree = renderer!.root.findByType(WorkbenchFileTree);
    act(() => {
      fileTree.props.onSelectFile("src/other.ts");
    });
    expect(onSelectFile).not.toHaveBeenCalled();

    const openConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    expect(openConfirm?.props.title).toBe("Discard unsaved file changes?");
    act(() => {
      openConfirm?.props.onConfirm();
    });
    expect(onDiscardDraft).toHaveBeenCalled();
    expect(onSelectFile).toHaveBeenCalledWith("src/other.ts");
  });

  it("requires confirmation before reverting all worktree changes", async () => {
    const onRevertAll = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={buildCodePanel({ onRevertAll })} />);
      await Promise.resolve();
    });

    const revertButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Revert all"));
    expect(revertButton?.props.disabled).toBe(false);
    act(() => {
      revertButton?.props.onClick();
    });
    expect(onRevertAll).not.toHaveBeenCalled();
    const openConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    expect(openConfirm).toBeTruthy();
    expect(openConfirm?.props.title).toBe("Revert all worktree changes?");
  });
});
