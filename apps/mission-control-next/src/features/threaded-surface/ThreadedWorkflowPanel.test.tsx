import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import {
  fetchAgenticChannelDeliveries,
  fetchAgenticRuntimeAvailability,
} from "@goatcitadel/mission-control-shared/api/agentic";
import { fetchCodeModeRun, fetchCodeModeRuns } from "@goatcitadel/mission-control-shared/api/capabilities";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { WorkbenchFileTree } from "@goatcitadel/mission-control-shared/components/WorkbenchFileTree";
import {
  ThreadedWorkflowPanel,
  describeAgenticControlCopy,
  extractCodeBlocks,
  isPendingPatchBlock,
  shortId,
  validationStatusTone,
} from "./ThreadedWorkflowPanel";

vi.mock("@goatcitadel/mission-control-shared/api/agentic", () => ({
  fetchAgenticChannelDeliveries: vi.fn(),
  fetchAgenticRuntimeAvailability: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({
  fetchCodeModeRun: vi.fn(),
  fetchCodeModeRuns: vi.fn(),
}));

const mockedFetchAgenticRuntimeAvailability = vi.mocked(fetchAgenticRuntimeAvailability);
const mockedFetchAgenticChannelDeliveries = vi.mocked(fetchAgenticChannelDeliveries);
const mockedFetchCodeModeRun = vi.mocked(fetchCodeModeRun);
const mockedFetchCodeModeRuns = vi.mocked(fetchCodeModeRuns);

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

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => instanceText(button.children).includes(label));
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
              title: "Pause durable run",
              enabled: true,
              status: "available",
              runtimeEffect: "runtime_pause",
              meta: "live durable run",
              note: "Calls the attached durable run pause path.",
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
      workspaceId: "workspace-1",
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
    mockedFetchCodeModeRuns.mockResolvedValue({
      items: [
        {
          runId: "helper-1",
          status: "completed",
          language: "typescript",
          originSurface: "code",
          requestedOutputIntent: "workbench_helper",
          saveCandidateOnSuccess: false,
          capabilitySnapshotId: "cap-snap-1",
          codeModeInputHash: "input-hash-1234567890",
          wrapperManifestHash: "wrapper-hash-1234567890",
          policySnapshotHash: "policy-hash-1234567890",
          codeHash: "code-hash-1234567890",
          approvalId: "approval-code-1",
          sessionId: "session-1",
          turnId: "turn-1",
          codeArtifact: {
            artifactId: "artifact-code",
            relPath: "data/code-mode-artifacts/helper-1/source.ts",
            sha256: "code-hash-1234567890",
            bytes: 32,
            mimeType: "text/typescript",
            createdAt: "2026-05-05T12:00:00.000Z",
          },
          wrapperManifestArtifact: {
            artifactId: "artifact-wrapper",
            relPath: "data/code-mode-artifacts/helper-1/wrapper-manifest.json",
            sha256: "wrapper-artifact-hash",
            bytes: 32,
            mimeType: "application/json",
            createdAt: "2026-05-05T12:00:00.000Z",
          },
          policySnapshotArtifact: {
            artifactId: "artifact-policy",
            relPath: "data/code-mode-artifacts/helper-1/policy-snapshot.json",
            sha256: "policy-artifact-hash",
            bytes: 32,
            mimeType: "application/json",
            createdAt: "2026-05-05T12:00:00.000Z",
          },
          stdoutPreview: "stdout from ledger",
          stderrPreview: "stderr from ledger",
          stdoutTruncated: false,
          stderrTruncated: false,
          createdAt: "2026-05-05T12:00:00.000Z",
          startedAt: "2026-05-05T12:00:01.000Z",
          finishedAt: "2026-05-05T12:00:02.000Z",
        },
      ],
    });
    mockedFetchCodeModeRun.mockResolvedValue({
      runId: "helper-1",
      status: "completed",
      language: "typescript",
      originSurface: "code",
      requestedOutputIntent: "workbench_helper",
      saveCandidateOnSuccess: false,
      capabilitySnapshotId: "cap-snap-1",
      codeModeInputHash: "input-hash-1234567890",
      wrapperManifestHash: "wrapper-hash-1234567890",
      policySnapshotHash: "policy-hash-1234567890",
      codeHash: "code-hash-1234567890",
      approvalId: "approval-code-1",
      permissionProfileId: "trusted_local_power",
      permissionProfileLabel: "Trusted Local Power",
      localOperatorOverrideId: "override-1",
      sessionId: "session-1",
      turnId: "turn-1",
      sandbox: {
        runnerId: "trusted-code-runner",
        runnerVersion: "1",
        platform: "linux",
        isolationProfile: "trusted-code execution",
        required: true,
        available: true,
        checksPassed: ["sandbox_ready"],
        checksFailed: [],
      },
      codeArtifact: {
        artifactId: "artifact-code",
        relPath: "data/code-mode-artifacts/helper-1/source.ts",
        sha256: "code-hash-1234567890",
        bytes: 32,
        mimeType: "text/typescript",
        createdAt: "2026-05-05T12:00:00.000Z",
      },
      wrapperManifestArtifact: {
        artifactId: "artifact-wrapper",
        relPath: "data/code-mode-artifacts/helper-1/wrapper-manifest.json",
        sha256: "wrapper-artifact-hash",
        bytes: 32,
        mimeType: "application/json",
        createdAt: "2026-05-05T12:00:00.000Z",
      },
      policySnapshotArtifact: {
        artifactId: "artifact-policy",
        relPath: "data/code-mode-artifacts/helper-1/policy-snapshot.json",
        sha256: "policy-artifact-hash",
        bytes: 32,
        mimeType: "application/json",
        createdAt: "2026-05-05T12:00:00.000Z",
      },
      stdoutArtifact: {
        artifactId: "artifact-stdout",
        relPath: "data/code-mode-artifacts/helper-1/stdout.log",
        sha256: "stdout-hash-1234567890",
        bytes: 2,
        mimeType: "text/plain",
        createdAt: "2026-05-05T12:00:02.000Z",
      },
      stderrArtifact: {
        artifactId: "artifact-stderr",
        relPath: "data/code-mode-artifacts/helper-1/stderr.log",
        sha256: "stderr-hash-1234567890",
        bytes: 4,
        mimeType: "text/plain",
        createdAt: "2026-05-05T12:00:02.000Z",
      },
      stdoutPreview: "stdout from detail",
      stderrPreview: "stderr from detail",
      stdoutTruncated: false,
      stderrTruncated: false,
      result: { ok: true },
      createdAt: "2026-05-05T12:00:00.000Z",
      startedAt: "2026-05-05T12:00:01.000Z",
      finishedAt: "2026-05-05T12:00:02.000Z",
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
    const pauseButton = root.findAllByType("button").find((button) => button.children.includes("Pause durable run"));
    const killButton = root.findAllByType("button").find((button) => button.children.includes("Record kill intent"));

    expect(pauseButton).toBeTruthy();
    expect(pauseButton?.props.disabled).toBe(false);
    expect(killButton).toBeTruthy();
    expect(killButton?.props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("State-only: records intent in GoatCitadel state");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Record pause intent");

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
      openConfirm?.props.onCancel();
    });
    expect(onDiscardDraft).not.toHaveBeenCalled();
    expect(onSelectFile).not.toHaveBeenCalled();

    act(() => {
      fileTree.props.onSelectFile("src/other.ts");
    });
    const reopenedConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    act(() => {
      reopenedConfirm?.props.onConfirm();
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
    act(() => {
      openConfirm?.props.onCancel();
    });
    expect(onRevertAll).not.toHaveBeenCalled();

    act(() => {
      revertButton?.props.onClick();
    });
    const reopenedConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    act(() => {
      reopenedConfirm?.props.onConfirm();
    });
    expect(onRevertAll).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before reverting the selected worktree file", async () => {
    const onRevertFile = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            onRevertFile,
            selectedFile: {
              path: "src/app.ts",
              name: "app.ts",
              language: "typescript",
              content: "console.log('current');",
              changed: true,
            } as any,
          })}
        />,
      );
      await Promise.resolve();
    });

    const revertButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Revert file"));
    expect(revertButton?.props.disabled).toBe(false);
    act(() => {
      revertButton?.props.onClick();
    });
    expect(onRevertFile).not.toHaveBeenCalled();
    const openConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    expect(openConfirm).toBeTruthy();
    expect(openConfirm?.props.title).toBe("Revert this file?");
    expect(openConfirm?.props.danger).toBe(true);
    act(() => {
      openConfirm?.props.onCancel();
    });
    expect(onRevertFile).not.toHaveBeenCalled();

    act(() => {
      revertButton?.props.onClick();
    });
    const reopenedConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    act(() => {
      reopenedConfirm?.props.onConfirm();
    });
    expect(onRevertFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("binds existing projects and imports code sources from the unbound workbench state", async () => {
    const onBindExistingProject = vi.fn(async () => undefined);
    const onImportProjectSource = vi.fn(async () => undefined);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            needsProjectBinding: true,
            workbenchState: null,
            workbenchTree: null,
            diff: null,
            output: null,
            availableProjects: [
              { projectId: "project-1", name: "Existing one", workspacePath: "F:\\code\\one" },
              { projectId: "project-2", name: "Existing two", workspacePath: "F:\\code\\two" },
            ],
            onBindExistingProject,
            onImportProjectSource,
          } as any)}
        />,
      );
      await Promise.resolve();
    });

    const select = renderer!.root.findByType("select");
    await act(async () => {
      select.props.onChange({ target: { value: "project-2" } });
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Bind project"))
        ?.props.onClick();
      await Promise.resolve();
    });
    expect(onBindExistingProject).toHaveBeenCalledWith("project-2");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Local folder"))
        ?.props.onClick();
    });
    const localInputs = renderer!.root.findAllByType("input");
    act(() => {
      localInputs
        .find((input) => input.props.placeholder?.includes("my-project"))
        ?.props.onChange({
          target: { value: "  F:\\code\\local-app  " },
        });
      localInputs
        .find((input) => input.props.placeholder === "Use folder name by default")
        ?.props.onChange({
          target: { value: "  Local App  " },
        });
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Import folder"))
        ?.props.onClick();
      await Promise.resolve();
    });
    expect(onImportProjectSource).toHaveBeenCalledWith({
      sourceType: "local_folder",
      sourcePath: "F:\\code\\local-app",
      name: "Local App",
    });

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("GitHub repo"))
        ?.props.onClick();
    });
    const repoInputs = renderer!.root.findAllByType("input");
    act(() => {
      repoInputs
        .find((input) => input.props.placeholder === "https://github.com/owner/repo.git")
        ?.props.onChange({
          target: { value: "  https://github.com/goat/app.git  " },
        });
      repoInputs
        .find((input) => input.props.placeholder === "main")
        ?.props.onChange({
          target: { value: "  feature/coverage  " },
        });
      repoInputs
        .find((input) => input.props.placeholder === "Use repo name by default")
        ?.props.onChange({
          target: { value: "  Goat App  " },
        });
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Clone repo"))
        ?.props.onClick();
      await Promise.resolve();
    });
    expect(onImportProjectSource).toHaveBeenCalledWith({
      sourceType: "github_repo",
      repoUrl: "https://github.com/goat/app.git",
      ref: "feature/coverage",
      name: "Goat App",
    });
  });

  it("keeps unbound source actions inert when required inputs or handlers are missing", async () => {
    const onImportProjectSource = vi.fn(async () => undefined);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            needsProjectBinding: true,
            workbenchState: null,
            workbenchTree: null,
            diff: null,
            output: null,
            availableProjects: [],
            sourceBindingBusy: true,
            onBindExistingProject: undefined,
            onImportProjectSource,
          } as any)}
        />,
      );
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("import a local folder");
    expect(JSON.stringify(renderer!.toJSON())).toContain("GitHub repo");

    const buttons = renderer!.root.findAllByType("button");
    await act(async () => {
      buttons.find((button) => button.children.includes("Importing…"))?.props.onClick();
      buttons.find((button) => button.children.includes("GitHub repo"))?.props.onClick();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Cloning…"))
        ?.props.onClick();
      await Promise.resolve();
    });
    expect(onImportProjectSource).not.toHaveBeenCalled();
  });

  it("covers selected project candidates and empty workbench pane fallbacks", async () => {
    const onBindExistingProject = vi.fn(async () => undefined);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            needsProjectBinding: true,
            workbenchState: null,
            workbenchTree: null,
            diff: null,
            output: null,
            availableProjects: [
              { projectId: "project-1", name: "Existing one", workspacePath: "F:\\code\\one" },
              { projectId: "project-2", name: "Existing two", workspacePath: "F:\\code\\two" },
            ],
            selectedProjectCandidateId: "project-2",
            onBindExistingProject,
          } as any)}
        />,
      );
      await Promise.resolve();
    });

    expect(renderer!.root.findByType("select").props.value).toBe("project-2");
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Bind project"))
        ?.props.onClick();
      await Promise.resolve();
    });
    expect(onBindExistingProject).toHaveBeenCalledWith("project-2");

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            diff: null,
            selectedFileDiff: {
              originalContent: "old",
              modifiedContent: "new",
              language: "typescript",
            } as any,
            selectedTurn: {
              ...(buildCodePanel().props.selectedTurn as any),
              assistantMessage: {
                messageId: "assistant-1",
                role: "assistant",
                content: "No snippets here.",
                createdAt: "2026-05-05T12:00:01.000Z",
              },
            } as any,
          })}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Selected diff"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Choose a repo file to compare");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Repo diff"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Create a worktree or refresh the session");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Snippets"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Code snippets from the latest assistant turn");
  });

  it("covers delayed project defaults, file-selection guards, auto panes, and null panels", async () => {
    const onBindExistingProject = vi.fn(async () => undefined);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            needsProjectBinding: true,
            workbenchState: null,
            workbenchTree: null,
            diff: null,
            output: null,
            availableProjects: [],
            onBindExistingProject,
          } as any)}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.update(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            needsProjectBinding: true,
            workbenchState: null,
            workbenchTree: null,
            diff: null,
            output: null,
            availableProjects: [{ projectId: "project-delayed", name: "Delayed", workspacePath: "F:\\code\\delayed" }],
            onBindExistingProject,
          } as any)}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer!, "Existing project")?.props.onClick();
      await Promise.resolve();
    });
    expect(renderer!.root.findByType("select").props.value).toBe("project-delayed");
    await act(async () => {
      findButton(renderer!, "Bind project")?.props.onClick();
      await Promise.resolve();
    });
    expect(onBindExistingProject).toHaveBeenCalledWith("project-delayed");

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            needsProjectBinding: true,
            workbenchState: null,
            workbenchTree: null,
            diff: null,
            output: null,
            availableProjects: [],
            onBindExistingProject: undefined,
          } as any)}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer!, "Existing project")?.props.onClick();
      findButton(renderer!, "Bind project")?.props.onClick();
      await Promise.resolve();
    });
    expect(onBindExistingProject).toHaveBeenCalledTimes(1);

    const onSelectFile = vi.fn();
    const onDiscardDraft = vi.fn();
    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            onSelectFile,
            onDiscardDraft,
            selectedFile: {
              state: buildCodePanel().props.workbenchState,
              path: "src/app.ts",
              name: "app.ts",
              language: "typescript",
              content: "console.log('ready');",
              changed: true,
            } as any,
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
      fileTree.props.onSelectFile("");
      fileTree.props.onSelectFile("src/app.ts");
      fileTree.props.onSelectFile("src/other.ts");
    });
    expect(onSelectFile).toHaveBeenCalledTimes(1);
    expect(onSelectFile).toHaveBeenCalledWith("src/other.ts");
    act(() => {
      renderer!.root
        .findAllByType(ConfirmModal)
        .find((modal) => modal.props.title === "Discard unsaved file changes?")
        ?.props.onConfirm();
    });
    expect(onDiscardDraft).not.toHaveBeenCalled();

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            diff: null,
            output: {
              state: buildCodePanel().props.workbenchState,
              output: "Auto-selected run output.",
              helperRuns: [],
            } as any,
          })}
        />,
      );
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Auto-selected run output.");

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            diff: null,
            output: null,
            selectedTurn: {
              ...(buildCodePanel().props.selectedTurn as any),
              assistantMessage: {
                messageId: "assistant-1",
                role: "assistant",
                content: "```ts\nconsole.log('auto snippet');\n```",
                createdAt: "2026-05-05T12:00:01.000Z",
              },
            } as any,
          })}
        />,
      );
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Snippet helper");

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            workbenchState: {
              ...(buildCodePanel().props.workbenchState as any),
              worktreeStatus: "creating",
            },
            workbenchTree: null,
            diff: null,
          } as any)}
        />,
      );
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Project-bound workbench for GoatCitadel. Create a worktree to begin repo operations.",
    );

    const nullRenderer = create(<ThreadedWorkflowPanel panel={null as any} />);
    expect(nullRenderer.toJSON()).toBeNull();
  });

  it("runs validation presets and custom commands while respecting blocked states", async () => {
    const onRunValidationCommand = vi.fn();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={buildCodePanel({ onRunValidationCommand })} />);
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.props.title === "pnpm typecheck")
        ?.props.onClick();
    });
    expect(onRunValidationCommand).toHaveBeenCalledWith({ command: "pnpm", args: ["typecheck"] });
    expect(JSON.stringify(renderer!.toJSON())).toContain("No run log or helper output yet.");

    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Validation command" }).props.onChange({
        target: { value: "  pnpm --filter @goatcitadel/mission-control-next test -- ThreadedWorkflowPanel.test.tsx  " },
      });
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Test") && button.props.title === undefined)
        ?.props.onClick();
    });
    expect(onRunValidationCommand).toHaveBeenLastCalledWith({
      command: "pnpm",
      args: ["--filter", "@goatcitadel/mission-control-next", "test", "--", "ThreadedWorkflowPanel.test.tsx"],
    });

    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Validation command" }).props.onChange({
        target: { value: "   " },
      });
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Test") && button.props.title === undefined)
        ?.props.onClick();
    });
    expect(onRunValidationCommand).toHaveBeenCalledTimes(2);

    const blockedRunner = vi.fn();
    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            hasDirtyDraft: true,
            onRunValidationCommand: blockedRunner,
          })}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.props.title === "Save or discard the file draft before running repo operations.")
        ?.props.onClick();
    });
    expect(blockedRunner).not.toHaveBeenCalled();

    const busyRunner = vi.fn();
    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel panel={buildCodePanel({ busy: true, onRunValidationCommand: busyRunner })} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Test") && button.props.title === undefined)
        ?.props.onClick();
    });
    expect(busyRunner).not.toHaveBeenCalled();
  });

  it("renders selected file, diff, repo diff, output, snippets, and artifact panes", async () => {
    const onDraftChange = vi.fn();
    const onExportPatch = vi.fn();
    const onRevertFile = vi.fn();
    const onRunHelperSnippet = vi.fn();
    const onCloseGeneratedArtifact = vi.fn();
    const onOpenApprovals = vi.fn();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            selectedFile: {
              state: buildCodePanel().props.workbenchState,
              path: "src/app.ts",
              name: "app.ts",
              language: "typescript",
              content: "console.log('original');",
              changed: true,
            } as any,
            selectedFileDiff: {
              originalContent: "console.log('original');",
              modifiedContent: "console.log('changed');",
            } as any,
            draftContent: "console.log('draft');",
            output: {
              state: buildCodePanel().props.workbenchState,
              output: "Validation passed.",
              helperRuns: [
                {
                  runId: "helper-1",
                  turnId: "turn-1",
                  language: "typescript",
                  status: "passed",
                  stdoutPreview: "ok",
                  stderrPreview: "warn",
                  createdAt: "2026-05-05T12:00:00.000Z",
                },
              ],
            } as any,
            selectedTurn: {
              ...(buildCodePanel().props.selectedTurn as any),
              assistantMessage: {
                messageId: "assistant-1",
                role: "assistant",
                content: "```ts\nconsole.log('snippet');\n```",
                createdAt: "2026-05-05T12:00:01.000Z",
              },
            } as any,
            onDraftChange,
            onExportPatch,
            onRevertFile,
            onRunHelperSnippet,
            onOpenApprovals,
          })}
        />,
      );
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("src/app.ts");
    renderer!.root.findByProps({ height: 520 }).props.onChange("console.log('next');");
    expect(onDraftChange).toHaveBeenCalledWith("console.log('next');");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Selected diff"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Selected-file diff");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Repo diff"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Repo diff");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Export"))
        ?.props.onClick();
      await Promise.resolve();
    });
    expect(onExportPatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Validation passed.");
    expect(JSON.stringify(renderer!.toJSON())).toContain("warn");
    expect(mockedFetchCodeModeRuns).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      turnId: "turn-1",
      limit: 25,
    });
    expect(mockedFetchCodeModeRun).toHaveBeenCalledWith("helper-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Code Mode run detail");
    expect(JSON.stringify(renderer!.toJSON())).toContain("approval-code-1");
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Open approval queue"))
        ?.props.onClick();
    });
    expect(onOpenApprovals).toHaveBeenCalledWith("approval-code-1");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Trusted Local Power");
    expect(JSON.stringify(renderer!.toJSON())).toContain("override-1");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Code");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Sandbox posture");
    expect(JSON.stringify(renderer!.toJSON())).toContain("trusted-code execution");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Input hash");
    expect(JSON.stringify(renderer!.toJSON())).toContain("input-...7890");
    expect(JSON.stringify(renderer!.toJSON())).toContain("data/code-mode-artifacts/helper-1/source.ts");
    expect(JSON.stringify(renderer!.toJSON())).toContain("stdout from detail");
    expect(JSON.stringify(renderer!.toJSON())).toContain("stderr from detail");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Snippets"))
        ?.props.onClick();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Run helper snippet"))
        ?.props.onClick();
    });
    expect(onRunHelperSnippet).toHaveBeenCalledWith("ts", "console.log('snippet');");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Revert file"))
        ?.props.onClick();
    });
    const revertConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    await act(async () => {
      revertConfirm?.props.onConfirm();
    });
    expect(onRevertFile).toHaveBeenCalledWith("src/app.ts");

    renderer!.unmount();
    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            generatedArtifact: {
              id: "artifact-1",
              title: "Review artifact",
              kind: "markdown",
              sourceSurface: "code",
              content: "# Artifact",
            } as any,
            onCloseGeneratedArtifact,
          })}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Artifact"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Review artifact");
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Close artifact"))
        ?.props.onClick();
    });
    expect(onCloseGeneratedArtifact).toHaveBeenCalledTimes(1);
  });

  it("clears stale Code Mode run detail while fetching a newly selected run", async () => {
    let resolveSecondRun: (value: unknown) => void = () => undefined;
    mockedFetchCodeModeRuns.mockResolvedValueOnce({
      items: [
        {
          runId: "helper-1",
          status: "completed",
          language: "typescript",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalId: "approval-old",
          createdAt: "2026-05-05T12:02:00.000Z",
        },
        {
          runId: "helper-2",
          status: "running",
          language: "typescript",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalId: "approval-new",
          createdAt: "2026-05-05T12:01:00.000Z",
        },
      ] as any,
    });
    mockedFetchCodeModeRun.mockImplementation((runId: string) => {
      if (runId === "helper-1") {
        return Promise.resolve({
          runId: "helper-1",
          status: "completed",
          language: "typescript",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalId: "approval-old",
          createdAt: "2026-05-05T12:02:00.000Z",
        } as any);
      }
      return new Promise((resolve) => {
        resolveSecondRun = resolve;
      }) as any;
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={buildCodePanel()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Run log"))
        ?.props.onClick();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("approval-old");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .filter((button) => button.children.includes("Inspect run"))[1]
        ?.props.onClick();
      await Promise.resolve();
    });
    const loadingRender = JSON.stringify(renderer!.toJSON());
    expect(loadingRender).toContain("Loading run detail...");
    expect(loadingRender).not.toContain("approval-old");

    await act(async () => {
      resolveSecondRun({
        runId: "helper-2",
        status: "running",
        language: "typescript",
        sessionId: "session-1",
        turnId: "turn-1",
        approvalId: "approval-new",
        createdAt: "2026-05-05T12:01:00.000Z",
      });
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("approval-new");
  });

  it("keeps Code Mode run detail scoped to the selected turn", async () => {
    mockedFetchCodeModeRuns.mockResolvedValueOnce({
      items: [
        {
          runId: "other-turn-run",
          status: "completed",
          language: "typescript",
          sessionId: "session-1",
          turnId: "turn-other",
          approvalId: "approval-other",
          permissionProfileLabel: "Wrong Turn Profile",
          createdAt: "2026-05-05T12:03:00.000Z",
        },
        {
          runId: "current-turn-run",
          status: "completed",
          language: "typescript",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalId: "approval-current",
          permissionProfileLabel: "Current Turn Profile",
          createdAt: "2026-05-05T12:01:00.000Z",
        },
      ] as any,
    });
    mockedFetchCodeModeRun.mockResolvedValueOnce({
      runId: "current-turn-run",
      status: "completed",
      language: "typescript",
      sessionId: "session-1",
      turnId: "turn-1",
      approvalId: "approval-current",
      permissionProfileLabel: "Current Turn Profile",
      createdAt: "2026-05-05T12:01:00.000Z",
    } as any);

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={buildCodePanel()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Run log"))
        ?.props.onClick();
      await Promise.resolve();
    });

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(mockedFetchCodeModeRuns).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      turnId: "turn-1",
      limit: 25,
    });
    expect(mockedFetchCodeModeRun).toHaveBeenCalledWith("current-turn-run", {
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
    });
    expect(rendered).toContain("approval-current");
    expect(rendered).toContain("Current Turn Profile");
    expect(rendered).not.toContain("approval-other");
    expect(rendered).not.toContain("Wrong Turn Profile");
  });

  it("keeps the Code Mode approval shortcut when detail loading fails but the run summary has an approval", async () => {
    const onOpenApprovals = vi.fn();
    mockedFetchCodeModeRuns.mockResolvedValueOnce({
      items: [
        {
          runId: "current-turn-run",
          status: "approval_pending",
          language: "typescript",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalId: "approval-current",
          createdAt: "2026-05-05T12:01:00.000Z",
        },
      ] as any,
    });
    mockedFetchCodeModeRun.mockRejectedValueOnce(new Error("detail unavailable"));

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={buildCodePanel({ onOpenApprovals })} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Run log"))
        ?.props.onClick();
      await Promise.resolve();
    });

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("detail unavailable");
    expect(rendered).toContain("approval-current");
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Open approval queue"))
        ?.props.onClick();
    });
    expect(onOpenApprovals).toHaveBeenCalledWith("approval-current");
  });

  it("does not reuse stale Code Mode detail approval after selecting a different run", async () => {
    const onOpenApprovals = vi.fn();
    mockedFetchCodeModeRuns.mockResolvedValueOnce({
      items: [
        {
          runId: "current-turn-run",
          status: "approval_pending",
          language: "typescript",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalId: "approval-current",
          createdAt: "2026-05-05T12:02:00.000Z",
        },
        {
          runId: "previous-turn-run",
          status: "completed",
          language: "typescript",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalId: "approval-previous-summary",
          createdAt: "2026-05-05T12:01:00.000Z",
        },
      ] as any,
    });
    mockedFetchCodeModeRun
      .mockResolvedValueOnce({
        runId: "current-turn-run",
        status: "approval_pending",
        language: "typescript",
        sessionId: "session-1",
        turnId: "turn-1",
        approvalId: "approval-current",
        createdAt: "2026-05-05T12:02:00.000Z",
      } as any)
      .mockResolvedValueOnce({
        runId: "current-turn-run",
        status: "approval_pending",
        language: "typescript",
        sessionId: "session-1",
        turnId: "turn-1",
        approvalId: "approval-current",
        createdAt: "2026-05-05T12:02:00.000Z",
      } as any);

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={buildCodePanel({ onOpenApprovals })} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Run log"))
        ?.props.onClick();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("approval-current");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .filter((button) => button.children.includes("Inspect run"))[1]
        ?.props.onClick();
      await Promise.resolve();
    });

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("previo...-run");
    expect(rendered).toContain("approval-previous-summary");
    expect(rendered).not.toContain("approval-current");
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Open approval queue"))
        ?.props.onClick();
    });
    expect(onOpenApprovals).toHaveBeenLastCalledWith("approval-previous-summary");
  });

  it("keeps legacy Code Mode helper runs visible when turn lineage is missing", async () => {
    mockedFetchCodeModeRuns.mockResolvedValueOnce({
      items: [
        {
          runId: "legacy-helper-run",
          status: "completed",
          language: "typescript",
          sessionId: "session-1",
          approvalId: "approval-legacy",
          permissionProfileLabel: "Legacy Helper Profile",
          createdAt: "2026-05-05T12:01:00.000Z",
        },
      ] as any,
    });
    mockedFetchCodeModeRun.mockResolvedValueOnce({
      runId: "legacy-output-run",
      status: "completed",
      language: "typescript",
      sessionId: "session-1",
      approvalId: "approval-legacy",
      permissionProfileLabel: "Legacy Helper Profile",
      stdoutPreview: "legacy detail stdout",
      createdAt: "2026-05-05T12:02:00.000Z",
    } as any);

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ThreadedWorkflowPanel
          panel={buildCodePanel({
            output: {
              state: buildCodePanel().props.workbenchState,
              output: "Helper completed.",
              helperRuns: [
                {
                  runId: "legacy-output-run",
                  language: "typescript",
                  status: "completed",
                  stdoutPreview: "legacy stdout",
                  createdAt: "2026-05-05T12:02:00.000Z",
                },
              ],
            } as any,
          })}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Run log"))
        ?.props.onClick();
      await Promise.resolve();
    });

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("legacy...-run");
    expect(rendered).toContain("legacy stdout");
    expect(rendered).toContain("Legacy Helper Profile");
    expect(mockedFetchCodeModeRun).toHaveBeenCalledWith("legacy-output-run", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
  });

  it("renders cowork run maps, blockers, tabs, and operator action callbacks", async () => {
    const onOpenDetails = vi.fn();
    const onRefreshRunState = vi.fn();
    const panel = buildCoworkPanel();
    Object.assign(panel.props, {
      onOpenDetails,
      onRefreshRunState,
      agenticControlPending: "pause",
      agenticControlStatus: "Pause intent recorded.",
    });
    Object.assign(panel.props.viewModel, {
      stageCards: [{ label: "Phase", value: "Review" }],
      now: {
        label: "Now",
        title: "Waiting",
        summary: "Operator review is pending.",
        facts: [{ label: "Queue", value: "2 approvals" }],
      },
      nextAction: {
        kind: "refresh_run_state",
        label: "Refresh run state",
        note: "Reload the durable state before continuing.",
      },
      blockers: [{ id: "blocker-1", title: "Missing evidence", summary: "The run needs proof." }],
      operatorActionItems: {
        items: [{ id: "operator-1", title: "Review output", status: "pending", meta: "Owner needed" }],
        overflow: 0,
      },
      planItems: {
        items: [{ id: "plan-1", title: "Check tests", status: "done", note: "Tests passed." }],
        overflow: 0,
      },
      roleItems: { items: [{ id: "role-1", title: "QA", status: "active", meta: "Coverage" }], overflow: 0 },
      timelineItems: {
        items: [{ id: "timeline-1", title: "Checkpoint", status: "saved", meta: "10:00" }],
        overflow: 0,
      },
      outputItems: {
        items: [{ id: "output-1", title: "Report", status: "ready", note: "Ready to inspect." }],
        overflow: 0,
      },
      continuationGate: {
        decision: "checkpoint",
        reasonCodes: ["needs_review"],
        summary: "Checkpoint before continuing.",
        metrics: {
          stepsSinceCheckpoint: 3,
          toolRunCount: 4,
          failedToolRunCount: 1,
          retryFailureStreak: 0,
          approvalWait: true,
          userInputWait: false,
          evidenceGapCount: 2,
        },
        recommendedAction: "Inspect evidence.",
        createdAt: "2026-05-05T12:00:00.000Z",
      },
      runMap: {
        objective: "Finish coverage",
        currentState: "Checkpointed",
        nextAction: "Inspect evidence",
        planNodes: [
          { id: "node-1", label: "Plan", status: "done", meta: "Ready" },
          { id: "node-2", label: "Test", status: "active", meta: "Running" },
        ],
        checkpoints: [
          { id: "checkpoint-1", title: "Started", createdAt: "2026-05-05T12:00:00.000Z" },
          { id: "checkpoint-2", title: "Validated", createdAt: "2026-05-05T12:05:00.000Z" },
        ],
      },
      stateGaps: ["coverage evidence"],
      evidenceSummary: {
        label: "Evidence",
        detail: "2 gaps",
        toolCallCount: 4,
        checkpointCount: 2,
        evidenceGapCount: 2,
      },
      agenticRuntime: {
        ...panel.props.viewModel.agenticRuntime!,
        treeNodes: [{ id: "tree-1", label: "Coordinator", status: "running", meta: "root" }],
        diagnostics: [{ id: "diag-1", title: "Slow lane", status: "warning", meta: "Coverage wait" }],
        controls: [
          ...panel.props.viewModel.agenticRuntime!.controls,
          {
            id: "resume",
            action: "resume",
            title: "Resume run",
            enabled: true,
            status: "available",
            runtimeEffect: "runtime_pause",
            meta: "live",
            note: "Executor supports resume.",
          },
        ],
      },
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={panel} />);
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Pause intent recorded.");
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Refresh run state"))
        ?.props.onClick();
    });
    expect(onRefreshRunState).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Run Map"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Gate: ");
    expect(JSON.stringify(renderer!.toJSON())).toContain("coverage evidence");
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Inspect evidence"))
        ?.props.onClick();
    });
    expect(onOpenDetails).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Timeline"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Checkpoint");

    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Operator actions"))
        ?.props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Review output");
  });

  it("invokes cowork next-action variants and stop callbacks without runtime visibility", async () => {
    const cases = [
      { kind: "retry_turn", label: "Retry turn", prop: "onRetryTurn" },
      { kind: "open_tasks", label: "Open tasks", prop: "onOpenTasks" },
      { kind: "focus_composer", label: "Focus composer", prop: "onFocusComposer" },
      { kind: "inspect_details", label: "Inspect details", prop: "onOpenDetails" },
    ] as const;

    for (const item of cases) {
      const callback = vi.fn();
      const onStopTurn = vi.fn();
      const panel = buildCoworkPanel();
      Object.assign(panel.props, {
        [item.prop]: callback,
        onStopTurn,
      });
      Object.assign(panel.props.viewModel, {
        agenticRuntime: null,
        roleItems: { items: [{ id: "role-1", title: "QA", status: "active" }], overflow: 1 },
        nextAction: {
          kind: item.kind,
          label: item.label,
          note: "Operator action is available.",
        },
      });

      let renderer: ReactTestRenderer | undefined;
      await act(async () => {
        renderer = create(<ThreadedWorkflowPanel panel={panel} />);
        await Promise.resolve();
      });

      expect(JSON.stringify(renderer!.toJSON())).toContain("1+ visible roles");
      await act(async () => {
        findButton(renderer!, "Stop run")?.props.onClick();
        findButton(renderer!, item.label)?.props.onClick();
      });
      const stopConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
      expect(stopConfirm?.props.title).toBe("Stop the active Cowork run?");
      await act(async () => {
        stopConfirm?.props.onConfirm();
      });
      expect(onStopTurn).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);
    }

    const noDetailsPanel = buildCoworkPanel();
    Object.assign(noDetailsPanel.props.viewModel, {
      blockers: [{ id: "blocker-1", title: "Waiting on proof", summary: "No details callback is wired." }],
      runMap: {
        objective: "No details",
        currentState: "Waiting",
        nextAction: "Review manually",
        planNodes: [],
        checkpoints: [],
      },
    });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={noDetailsPanel} />);
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer!, "Run Map")?.props.onClick();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("No details callback is wired.");
    expect(findButton(renderer!, "Inspect evidence")).toBeUndefined();

    const runtimeWithoutControls = buildCoworkPanel();
    Object.assign(runtimeWithoutControls.props, { onAgenticControl: undefined });
    Object.assign(runtimeWithoutControls.props.viewModel, {
      agenticRuntime: {
        ...runtimeWithoutControls.props.viewModel.agenticRuntime!,
        controls: [],
      },
    });
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={runtimeWithoutControls} />);
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("No runtime controls are available.");

    const runtimeWithoutHandler = buildCoworkPanel();
    Object.assign(runtimeWithoutHandler.props, { onAgenticControl: undefined });
    await act(async () => {
      renderer = create(<ThreadedWorkflowPanel panel={runtimeWithoutHandler} />);
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Pause durable run");
    expect(findButton(renderer!, "Pause")).toBeUndefined();
  });

  it("covers workbench helper parsing, tone, short id, and agentic control copy branches", () => {
    const blocks = extractCodeBlocks(
      "Text\n```ts\nconsole.log('helper')\n```\n```diff\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n+one\n```",
    );

    expect(blocks).toEqual([
      { id: "code-block-0", language: "ts", content: "console.log('helper')" },
      { id: "code-block-1", language: "diff", content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n+one" },
    ]);
    expect(extractCodeBlocks("plain text")).toEqual([]);
    expect(isPendingPatchBlock(blocks[0]!)).toBe(false);
    expect(isPendingPatchBlock(blocks[1]!)).toBe(true);
    expect(isPendingPatchBlock({ language: "patch", content: "--- a/a.ts\n+++ b/a.ts" })).toBe(true);
    expect(isPendingPatchBlock({ language: "diff", content: "diff --git a/a.ts b/a.ts\n--- a/a.ts" })).toBe(false);
    expect(extractCodeBlocks("```\ncontent\n```\n```ts\n   \n```")).toEqual([
      { id: "code-block-0", language: "text", content: "content" },
    ]);
    expect(validationStatusTone("passed")).toBe("success");
    expect(validationStatusTone(null)).toBe("warning");
    expect(validationStatusTone("ready")).toBe("warning");
    expect(validationStatusTone("failed")).toBe("critical");
    expect(validationStatusTone("blocked")).toBe("warning");
    expect(validationStatusTone("running")).toBe("warning");
    expect(shortId("abc123456789")).toBe("abc123456789");
    expect(shortId("abcdefghijklmnopqrstuvwxyz")).toBe("abcdef...wxyz");

    expect(
      describeAgenticControlCopy({
        action: "pause",
        runtimeEffect: "runtime_pause",
        title: "Pause",
      } as any),
    ).toEqual({ buttonLabel: "Pause" });
    expect(
      describeAgenticControlCopy({
        action: "kill_child",
        runtimeEffect: "state_only",
        title: "Kill child",
      } as any),
    ).toEqual({
      buttonLabel: "Record kill intent",
      intentNote: "State-only: records intent in GoatCitadel state; it is not a live pause or kill signal by itself.",
    });
    expect(
      describeAgenticControlCopy({
        action: "resume",
        runtimeEffect: "durable_resume",
        title: "Resume",
      } as any),
    ).toEqual({ buttonLabel: "Resume" });
    expect(
      describeAgenticControlCopy({
        action: "pause",
        runtimeEffect: "state_only",
        title: "Pause durable run",
      } as any),
    ).toEqual({
      buttonLabel: "Record pause intent",
      intentNote: "State-only: records intent in GoatCitadel state; it is not a live pause or kill signal by itself.",
    });
    expect(
      describeAgenticControlCopy({
        action: "resume",
        runtimeEffect: "state_only",
        title: "Resume durable run",
      } as any),
    ).toEqual({
      buttonLabel: "Record resume durable run intent",
      intentNote: "State-only: records intent in GoatCitadel state; it is not a live pause or kill signal by itself.",
    });
  });
});
