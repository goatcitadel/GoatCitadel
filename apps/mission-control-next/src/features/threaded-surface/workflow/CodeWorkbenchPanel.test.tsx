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
  fetchCapabilityCatalogSnapshot: vi.fn(async () => null),
  fetchCodeModeExecutionBackends: vi.fn(async () => ({
    generatedAt: "2026-07-13T00:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    defaultBackendId: "trusted_code",
    activeBackendId: "trusted_code",
    items: [],
  })),
  fetchCodeModeRun: vi.fn(async () => null),
  fetchCodeModeRunArtifact: vi.fn(async () => null),
  fetchCodeModeRunVerificationEvidence: vi.fn(async () => ({ items: [] })),
  fetchCodeModeRuns: vi.fn(async () => ({ items: [] })),
  verifyCodeModeRun: vi.fn(async () => null),
}));

vi.mock("@goatcitadel/mission-control-shared/api/agentic", () => ({
  fetchAgenticChannelDeliveries: vi.fn(async () => ({ items: [] })),
  fetchAgenticRuntimeAvailability: vi.fn(async () => null),
}));

import { NextCodeWorkbenchPanel, summarizeCapabilitySnapshotProfile } from "./CodeWorkbenchPanel";
import {
  fetchCodeModeRun,
  fetchCodeModeRunVerificationEvidence,
  fetchCodeModeRuns,
  verifyCodeModeRun,
} from "@goatcitadel/mission-control-shared/api/capabilities";
import type { CodeModeRunRecord, CodeModeVerificationEvidenceRecord } from "@goatcitadel/contracts";

function buildCodePanel(overrides: Record<string, unknown> = {}) {
  const noop = vi.fn();
  return {
    kind: "code" as const,
    props: {
      workspaceId: "default",
      selectedTurn: null,
      projectName: "demo-project",
      needsProjectBinding: false,
      workbenchState: null,
      workbenchTree: null,
      selectedFile: null,
      selectedFileDiff: null,
      draftContent: "",
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

describe("summarizeCapabilitySnapshotProfile", () => {
  it("summarizes frozen callable and inspect-only catalog evidence", () => {
    expect(
      summarizeCapabilitySnapshotProfile({
        snapshotId: "cap-snap-1",
        createdAt: "2026-07-04T12:00:00.000Z",
        callableEntries: [
          {
            capabilityId: "tool:fs.read",
            kind: "tool",
            category: "built_in",
            title: "fs.read",
            summary: "Read files",
            callable: true,
          },
          {
            capabilityId: "skill:review",
            kind: "skill",
            category: "project_local",
            title: "Review",
            summary: "Review code",
            callable: true,
          },
        ],
        inspectableEntries: [
          {
            capabilityId: "tool:fs.read",
            kind: "tool",
            category: "built_in",
            title: "fs.read",
            summary: "Read files",
            callable: true,
          },
          {
            capabilityId: "skill:review",
            kind: "skill",
            category: "project_local",
            title: "Review",
            summary: "Review code",
            callable: true,
          },
          {
            capabilityId: "proposal:write",
            kind: "proposal",
            category: "self_generated",
            title: "Write helper",
            summary: "Pending proposal",
            callable: false,
            reviewWarning: "Inspectable only until activation.",
          },
        ],
      }),
    ).toMatchObject({
      snapshotId: "cap-snap-1",
      inspectableCount: 3,
      callableCount: 2,
      callableToolCount: 1,
      callableSkillCount: 1,
      inspectableOnlyCount: 1,
      reviewWarningCount: 1,
    });
  });
});

describe("NextCodeWorkbenchPanel Code Mode verification truth", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.mocked(fetchCodeModeRuns).mockReset();
    vi.mocked(fetchCodeModeRun).mockReset();
    vi.mocked(fetchCodeModeRunVerificationEvidence).mockReset();
    vi.mocked(verifyCodeModeRun).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps execution, artifact integrity, and named semantic proof distinct", async () => {
    const unverifiedRun = buildCompletedCodeModeRun();
    const verifiedEvidence = buildVerifiedEvidence();
    const verifiedRun: CodeModeRunRecord = {
      ...unverifiedRun,
      verification: {
        status: "verified",
        evidenceId: verifiedEvidence.evidenceId,
        subjectHash: verifiedEvidence.subject.subjectHash,
        updatedAt: verifiedEvidence.createdAt,
      },
    };
    vi.mocked(fetchCodeModeRuns).mockResolvedValue({ items: [unverifiedRun] });
    vi.mocked(fetchCodeModeRun).mockResolvedValue(unverifiedRun);
    vi.mocked(fetchCodeModeRunVerificationEvidence).mockResolvedValue({ items: [] });
    vi.mocked(verifyCodeModeRun).mockResolvedValue({ run: verifiedRun, evidence: verifiedEvidence });

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <NextCodeWorkbenchPanel
          panel={buildCodePanel({
            workbenchState: {
              sessionId: "session-a",
              worktreeStatus: "ready",
              validationStatus: "idle",
              createdAt: "2026-07-13T00:00:00.000Z",
              updatedAt: "2026-07-13T00:00:00.000Z",
            },
          })}
        />,
      );
      await flushPromises();
    });
    await act(async () => {
      renderer!.root
        .findAllByProps({ role: "tab" })
        .find((tab) => renderedText(tab) === "Run log")!
        .props.onClick();
      await flushPromises();
    });

    expect(renderedText(renderer!.root)).toContain("Execution: completed");
    expect(renderedText(renderer!.root)).toContain("Verification: completed_unverified");
    expect(renderedText(renderer!.root)).toContain("Artifact integrity: hashes matched");
    expect(renderedText(renderer!.root)).toContain("no fresh durable named semantic proof");

    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Guarded Code Mode verification command" }).props.onChange({
        target: { value: "typecheck" },
      });
      await flushPromises();
    });
    const proofButton = renderer!.root
      .findAllByType("button")
      .find((button) => renderedText(button) === "Run named proof");
    expect(proofButton).toBeDefined();

    await act(async () => {
      proofButton!.props.onClick();
      await flushPromises();
    });

    expect(verifyCodeModeRun).toHaveBeenCalledWith(
      "run-a",
      { commandName: "typecheck" },
      { sessionId: "session-a", turnId: "turn-a", workspaceId: "default" },
    );
    expect(renderedText(renderer!.root)).toContain("Verification: verified");
    expect(renderedText(renderer!.root)).toContain("Fresh named proof passed: pnpm run typecheck (targeted scope)");
    expect(renderedText(renderer!.root)).toContain("does not establish hostile-code sandboxing");
  });

  it("refreshes the run ledger after the helper submission settles", async () => {
    const approvalPendingRun: CodeModeRunRecord = {
      ...buildCompletedCodeModeRun(),
      runId: "run-pending",
      status: "approval_pending",
      approvalId: "approval-pending",
      requestedOutputIntent: "workbench_helper",
      startedAt: undefined,
      finishedAt: undefined,
    };
    let resolveHelperSubmission: () => void = () => undefined;
    const helperSubmission = new Promise<void>((resolve) => {
      resolveHelperSubmission = resolve;
    });
    const onRunHelperSnippet = vi.fn(() => helperSubmission);
    vi.mocked(fetchCodeModeRuns)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [approvalPendingRun] });
    vi.mocked(fetchCodeModeRun).mockResolvedValue(approvalPendingRun);
    vi.mocked(fetchCodeModeRunVerificationEvidence).mockResolvedValue({ items: [] });

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <NextCodeWorkbenchPanel
          panel={buildCodePanel({
            selectedTurn: {
              turnId: "turn-a",
              userMessage: { content: "Run this helper." },
              assistantMessage: { content: "```ts\nconsole.log('snippet');\n```" },
              trace: { sessionId: "session-a", toolRuns: [] },
            },
            workbenchState: {
              sessionId: "session-a",
              worktreeStatus: "ready",
              validationStatus: "idle",
              createdAt: "2026-07-30T00:00:00.000Z",
              updatedAt: "2026-07-30T00:00:00.000Z",
            },
            onRunHelperSnippet,
          })}
        />,
      );
      await flushPromises();
    });
    expect(fetchCodeModeRuns).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.root
        .findAllByProps({ role: "tab" })
        .find((tab) => renderedText(tab) === "Snippets")!
        .props.onClick();
      await flushPromises();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) => renderedText(button) === "Run helper snippet")!
        .props.onClick();
      await flushPromises();
    });

    expect(onRunHelperSnippet).toHaveBeenCalledWith("ts", "console.log('snippet');");
    expect(fetchCodeModeRuns).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveHelperSubmission();
      await flushPromises();
    });

    expect(fetchCodeModeRuns).toHaveBeenCalledTimes(2);
    expect(fetchCodeModeRuns).toHaveBeenLastCalledWith({
      sessionId: "session-a",
      workspaceId: "default",
      turnId: "turn-a",
      limit: 25,
    });
    await act(async () => {
      renderer!.root
        .findAllByProps({ role: "tab" })
        .find((tab) => renderedText(tab) === "Run log")!
        .props.onClick();
      await flushPromises();
    });
    expect(renderedText(renderer!.root)).toContain("1 Code Mode runs");
    expect(renderedText(renderer!.root)).toContain("approval_pending");
    expect(renderedText(renderer!.root)).toContain("workbench_helper");
  });
});

function buildCompletedCodeModeRun(): CodeModeRunRecord {
  const sourceArtifact = {
    artifactId: "source-a",
    relPath: ".assistant/code-mode-artifacts/run-a/source.ts",
    sha256: "a".repeat(64),
    bytes: 10,
    mimeType: "text/typescript",
    createdAt: "2026-07-13T00:00:00.000Z",
  };
  const wrapperArtifact = {
    ...sourceArtifact,
    artifactId: "wrapper-a",
    relPath: ".assistant/code-mode-artifacts/run-a/wrapper.json",
    sha256: "b".repeat(64),
    mimeType: "application/json",
  };
  const policyArtifact = {
    ...sourceArtifact,
    artifactId: "policy-a",
    relPath: ".assistant/code-mode-artifacts/run-a/policy.json",
    sha256: "c".repeat(64),
    mimeType: "application/json",
  };
  return {
    runId: "run-a",
    status: "completed",
    language: "typescript",
    workspaceId: "default",
    sessionId: "session-a",
    turnId: "turn-a",
    saveCandidateOnSuccess: false,
    capabilitySnapshotId: "snapshot-a",
    codeModeInputHash: "input-a",
    wrapperManifestHash: "wrapper-a",
    policySnapshotHash: "policy-a",
    codeHash: sourceArtifact.sha256,
    executionRecovery: {
      generation: 1,
      phase: "terminal",
      disposition: "terminal",
      finalTranscriptEventId: "code-mode-final:run-a",
    },
    codeArtifact: sourceArtifact,
    wrapperManifestArtifact: wrapperArtifact,
    policySnapshotArtifact: policyArtifact,
    stdoutTruncated: false,
    stderrTruncated: false,
    trustedCodeWriteVerification: {
      mode: "trusted_code_artifact_hash_check",
      claimBoundary: "trusted_code_artifact_integrity_not_hostile_sandbox",
      verifiedAt: "2026-07-13T00:00:02.000Z",
      artifacts: [
        {
          artifactKind: "source",
          artifactId: sourceArtifact.artifactId,
          relPath: sourceArtifact.relPath,
          expectedSha256: sourceArtifact.sha256,
          actualSha256: sourceArtifact.sha256,
          verified: true,
        },
      ],
      notes: ["Artifact integrity is distinct from semantic verification."],
    },
    verification: {
      status: "completed_unverified",
      updatedAt: "2026-07-13T00:00:02.000Z",
    },
    createdAt: "2026-07-13T00:00:00.000Z",
    startedAt: "2026-07-13T00:00:01.000Z",
    finishedAt: "2026-07-13T00:00:02.000Z",
  };
}

function buildVerifiedEvidence(): CodeModeVerificationEvidenceRecord {
  return {
    evidenceId: "proof-a",
    runId: "run-a",
    status: "verified",
    workspaceId: "default",
    sessionId: "session-a",
    turnId: "turn-a",
    commandName: "typecheck",
    commandLabel: "pnpm run typecheck",
    command: "pnpm",
    args: ["run", "typecheck"],
    scope: "targeted",
    commandRunId: "command-a",
    commandStatus: "passed",
    exitCode: 0,
    startedAt: "2026-07-13T00:00:02.000Z",
    finishedAt: "2026-07-13T00:00:03.000Z",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputArtifactRefs: ["workbench-output:command-a"],
    subject: {
      subjectHash: "d".repeat(64),
      codeModeInputHash: "input-a",
      codeHash: "a".repeat(64),
      wrapperManifestHash: "wrapper-a",
      policySnapshotHash: "policy-a",
      worktreeIdentityHash: "e".repeat(64),
      worktreeStateHash: "f".repeat(64),
      changedFiles: [],
      changedFilesTruncated: false,
      artifacts: [],
    },
    createdAt: "2026-07-13T00:00:03.000Z",
  };
}

function renderedText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : renderedText(child)))
    .join("");
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
