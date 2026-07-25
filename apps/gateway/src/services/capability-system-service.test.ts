import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  ApprovalResolveInput,
  CapabilityArtifactRecord,
  CapabilityCatalogEntry,
  CapabilityCatalogSnapshotRecord,
  CandidateSkillVersionRecord,
  ChatMessageRecord,
  CodeModeSandboxMetadata,
  CodeModeRunRecord,
  LoadedSkill,
  PendingApprovalAction,
  PermissionProfileRecord,
  RuntimeDecisionTraceAppendInput,
  RuntimeDecisionTraceQuery,
  RuntimeDecisionTraceRecord,
  SkillLifecycleRecord,
  ToolPolicyActorContext,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import { ConflictError } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { CapabilitySystemService, __internal } from "./capability-system-service.js";
import type { CapabilityRuntimeConfig } from "../config.js";

const tempRoots: string[] = [];
const storageCleanups: Array<() => void> = [];
const digestPinnedRunnerImage =
  "ghcr.io/goatcitadel/code-mode-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

afterEach(async () => {
  for (const cleanup of storageCleanups.splice(0).reverse()) cleanup();
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("CapabilitySystemService", () => {
  it("projects only a bounded hexadecimal commitSha from an imported skill source manifest", async () => {
    const validDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-skill-provenance-valid-"));
    const invalidDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-skill-provenance-invalid-"));
    tempRoots.push(validDir, invalidDir);
    const validCommitSha = "a".repeat(40);
    await fs.writeFile(
      path.join(validDir, "source.json"),
      JSON.stringify({ provenance: { commitSha: validCommitSha } }),
      "utf8",
    );
    await fs.writeFile(
      path.join(invalidDir, "source.json"),
      JSON.stringify({ provenance: { commitSha: "not-a-git-object-id" } }),
      "utf8",
    );
    const loadedSkills: LoadedSkill[] = [
      {
        skillId: "valid-import",
        name: "Valid import",
        source: "extra",
        dir: validDir,
        declaredTools: [],
        requires: [],
        keywords: [],
        instructionBody: "valid",
        mtime: "2026-07-13T00:00:00.000Z",
      },
      {
        skillId: "invalid-import",
        name: "Invalid import",
        source: "extra",
        dir: invalidDir,
        declaredTools: [],
        requires: [],
        keywords: [],
        instructionBody: "invalid",
        mtime: "2026-07-13T00:00:00.000Z",
      },
    ];
    const harness = await createHarness({ loadedSkills });

    harness.service.listSkills();

    expect(harness.storage.skillLifecycle.find("valid-import")?.provenance?.commitSha).toBe(validCommitSha);
    expect(harness.storage.skillLifecycle.find("invalid-import")?.provenance?.commitSha).toBeUndefined();
  });

  it("re-enqueues a redacted bounded terminal Code Mode transcript exactly once", async () => {
    const harness = await createHarness();
    harness.storage.sessions.upsert({ sessionId: "session-transcript", sessionKey: "mission:session-transcript" });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      sessionId: "session-transcript",
    });
    const syntheticToken = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    harness.storage.codeModeRuns.upsert({
      ...run,
      status: "failed",
      codeArtifact: {
        ...run.codeArtifact,
        relPath: `code-mode/${syntheticToken}/source.ts`,
      },
      stdoutPreview: `${syntheticToken}\n${"😀".repeat(20_000)}`,
      stderrPreview: `Bearer abcdefghijklmnopqrstuvwxyz`,
      error: `execution interrupted with ${syntheticToken}`,
      errorCode: "execution_interrupted_after_boundary",
      finishedAt: "2026-07-13T00:00:00.000Z",
      executionRecovery: {
        ...run.executionRecovery,
        generation: 1,
        phase: "terminal",
        disposition: "manual_reconciliation",
        interruptedAt: "2026-07-13T00:00:00.000Z",
        interruptionReason: `worker lost ${syntheticToken}`,
      },
    });

    const first = harness.service.reconcileCodeModeFinalTranscriptDeliveries();
    const second = harness.service.reconcileCodeModeFinalTranscriptDeliveries();

    expect(first).toMatchObject({ checked: 1, enqueued: 1, errors: [] });
    expect(second).toMatchObject({ checked: 0, enqueued: 0, errors: [] });
    const eventId = `code-mode-final:${run.runId}`;
    expect(harness.storage.transcriptOutbox.listPending()).toHaveLength(1);
    const event = harness.storage.transcriptOutbox.get(eventId)!.event;
    const message = (event.payload as { message: ChatMessageRecord }).message;
    expect(message.messageId).toBe(eventId);
    expect(Buffer.byteLength(message.content, "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(message.content).not.toContain(syntheticToken);
    expect(message.content).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(message.content).not.toContain("�");
    expect(message.content).toContain("does not establish hostile-code sandboxing");
    expect(harness.storage.chatMessages.get(eventId)?.content).toBe(message.content);
    expect(harness.storage.codeModeRuns.get(run.runId).executionRecovery.finalTranscriptEnqueuedAt).toBe(
      "2026-07-13T00:00:00.000Z",
    );
  });

  it("drains terminal transcript recovery beyond one page and isolates a failing first run", async () => {
    const harness = await createHarness();
    harness.storage.sessions.upsert({ sessionId: "session-transcript-page", sessionKey: "mission:transcript-page" });
    const template = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });
    const syntheticToken = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    for (let index = 0; index < 501; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      harness.storage.codeModeRuns.upsert({
        ...template,
        runId: `code-run-transcript-page-${suffix}`,
        sessionId: index === 0 ? `missing-${syntheticToken}` : "session-transcript-page",
        status: "failed",
        createdAt: new Date(Date.parse("2026-07-13T00:00:00.000Z") + index).toISOString(),
        finishedAt: new Date(Date.parse("2026-07-13T01:00:00.000Z") + index).toISOString(),
        executionRecovery: {
          generation: 1,
          phase: "terminal",
          disposition: "terminal",
          finalTranscriptEventId: `code-mode-final:code-run-transcript-page-${suffix}`,
        },
      });
    }

    const recovered = harness.service.reconcileCodeModeFinalTranscriptDeliveries(100);

    expect(recovered.checked).toBe(501);
    expect(recovered.enqueued).toBe(500);
    expect(recovered.errors).toHaveLength(1);
    expect(recovered.errors[0]).not.toContain(syntheticToken);
    expect(Buffer.byteLength(recovered.errors[0]!, "utf8")).toBeLessThanOrEqual(2_048);
    expect(harness.storage.transcriptOutbox.get("code-mode-final:code-run-transcript-page-500")).toBeDefined();
    expect(
      harness.storage.codeModeRuns.get("code-run-transcript-page-000").executionRecovery.finalTranscriptEnqueuedAt,
    ).toBeUndefined();
  });

  it("caps oversized poison-row transcript recovery errors and reports omitted failures", async () => {
    const harness = await createHarness();
    const template = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });
    const syntheticToken = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    const oversizedFragment = `${syntheticToken}-${"😀".repeat(2_000)}`;
    for (let index = 0; index < 501; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      harness.storage.codeModeRuns.upsert({
        ...template,
        runId: `code-run-poison-${suffix}`,
        sessionId: `missing-${oversizedFragment}-${suffix}`,
        status: "failed",
        createdAt: new Date(Date.parse("2026-07-13T00:00:00.000Z") + index).toISOString(),
        finishedAt: new Date(Date.parse("2026-07-13T01:00:00.000Z") + index).toISOString(),
        executionRecovery: {
          generation: 1,
          phase: "terminal",
          disposition: "terminal",
          finalTranscriptEventId: `code-mode-final:code-run-poison-${suffix}`,
        },
      });
    }

    const recovered = harness.service.reconcileCodeModeFinalTranscriptDeliveries(100);

    expect(recovered.checked).toBe(501);
    expect(recovered.enqueued).toBe(0);
    expect(recovered.errors.length).toBeGreaterThan(0);
    expect(recovered.errors.length).toBeLessThanOrEqual(32);
    expect(recovered.omittedErrors).toBe(501 - recovered.errors.length);
    expect(recovered.errors.reduce((total, error) => total + Buffer.byteLength(error, "utf8"), 0)).toBeLessThanOrEqual(
      24 * 1024,
    );
    for (const error of recovered.errors) {
      expect(Buffer.byteLength(error, "utf8")).toBeLessThanOrEqual(2 * 1024);
      expect(error).not.toContain(syntheticToken);
      expect(error).not.toContain("�");
    }
  });

  it("publishes a UTF-8-safe bounded error when terminal transcript enqueue is deferred", async () => {
    const harness = await createHarness();
    harness.storage.sessions.upsert({ sessionId: "session-transcript-deferred", sessionKey: "mission:deferred" });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      sessionId: "session-transcript-deferred",
    });
    harness.storage.codeModeRuns.upsert({
      ...run,
      status: "failed",
      finishedAt: "2026-07-13T00:00:00.000Z",
      executionRecovery: {
        generation: 1,
        phase: "terminal",
        disposition: "terminal",
        finalTranscriptEventId: `code-mode-final:${run.runId}`,
      },
    });
    const syntheticToken = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    vi.spyOn(harness.storage, "runImmediateTransaction").mockImplementation(() => {
      throw new Error(`${syntheticToken}-${"😀".repeat(20_000)}`);
    });

    await harness.service.executeApprovedCodeModeRun("approval-1");

    const deferredCall = harness.publishRealtime.mock.calls.find(
      ([eventType]) => eventType === "code_mode_transcript_delivery_deferred",
    );
    expect(deferredCall).toBeDefined();
    const error = (deferredCall?.[2] as { error: string }).error;
    expect(Buffer.byteLength(error, "utf8")).toBeLessThanOrEqual(2 * 1024);
    expect(error).not.toContain(syntheticToken);
    expect(error).not.toContain("�");
    expect(error).toContain("...[truncated]");
  });

  it("keeps a terminal Code Mode outcome authoritative when its recovery diagnostic sink also fails", async () => {
    const harness = await createHarness();
    harness.storage.sessions.upsert({ sessionId: "session-transcript-diagnostic", sessionKey: "mission:diagnostic" });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      sessionId: "session-transcript-diagnostic",
    });
    harness.storage.codeModeRuns.upsert({
      ...run,
      status: "failed",
      finishedAt: "2026-07-13T00:00:00.000Z",
      executionRecovery: {
        generation: 1,
        phase: "terminal",
        disposition: "terminal",
        finalTranscriptEventId: `code-mode-final:${run.runId}`,
      },
    });
    vi.spyOn(harness.storage, "runImmediateTransaction").mockImplementation(() => {
      throw new Error("synthetic transcript transaction failure");
    });
    harness.publishRealtime.mockImplementation((eventType: string) => {
      if (eventType === "code_mode_transcript_delivery_deferred") {
        throw new Error("synthetic diagnostic sink failure");
      }
    });

    await expect(harness.service.executeApprovedCodeModeRun("approval-1")).resolves.toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({ runId: run.runId, status: "failed" }),
    });
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "failed",
      executionRecovery: expect.objectContaining({ phase: "terminal" }),
    });
  });

  it("records current sandbox metadata and emits callable-only wrapper manifests for Code Mode runs", async () => {
    const harness = await createHarness({
      toolCatalog: [
        createTool("tool.safe_read", {
          readOnly: true,
          deterministic: true,
          codeModeAllowed: true,
        }),
        createTool("tool.mutate", {
          readOnly: false,
          deterministic: false,
          codeModeAllowed: false,
        }),
      ],
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      requestedOutputIntent: "Summarize a file tree",
      saveCandidateOnSuccess: true,
    });

    expect(run.originSurface).toBe("code");
    expect(run.sandbox).toMatchObject({
      required: true,
      available: false,
    });
    expect(run.executionBackend).toMatchObject({
      backendId: "trusted-code-host",
      kind: "host",
      runtimeSupport: "not_available",
      status: "blocked",
    });
    expect(run.sandbox?.checksFailed).toContain("best_effort_host_disabled");
    expect(harness.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          originSurface: "code",
          sandbox: expect.objectContaining({
            available: false,
          }),
          executionBackend: expect.objectContaining({
            backendId: "trusted-code-host",
            status: "blocked",
          }),
        }),
        linkage: expect.objectContaining({
          originSurface: "code",
          toolName: "code_mode.run",
          actionType: "code_mode.run",
        }),
      }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_created",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        originSurface: "code",
        sandbox: expect.objectContaining({
          available: false,
          required: true,
        }),
      }),
    );

    const manifest = JSON.parse(
      await fs.readFile(path.resolve(harness.rootDir, run.wrapperManifestArtifact.relPath), "utf8"),
    ) as {
      wrappers: Array<{ name: string }>;
    };
    expect(manifest.wrappers).toHaveLength(1);
    expect(manifest.wrappers[0]).toMatchObject({ name: "tool.safe_read" });
  });

  it("records capability profile decision evidence for Code Mode run creation", async () => {
    const harness = await createHarness({
      toolCatalog: [
        createTool("tool.safe_read"),
        createTool("tool.inspect_project", {
          readOnly: true,
          deterministic: true,
          codeModeAllowed: true,
        }),
      ],
    });
    harness.storage.chatTurnTraces.create({ turnId: "turn-1", sessionId: "session-1" });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "default",
    });

    const [decision] = harness.storage.runtimeDecisionTraces.list({ runId: run.runId });
    expect(decision).toMatchObject({
      kind: "capability_profile_frozen",
      scope: {
        workspaceId: "default",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: run.runId,
        approvalId: run.approvalId,
      },
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({
          refType: "capability_snapshot",
          refId: run.capabilitySnapshotId,
        }),
        expect.objectContaining({
          refType: "approval",
          refId: run.approvalId,
        }),
      ]),
    });
    expect(decision?.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "capability", key: "snapshot_id", value: run.capabilitySnapshotId }),
        expect.objectContaining({ source: "capability", key: "callable_count", value: 2 }),
        expect.objectContaining({ source: "capability", key: "callable_tools", value: 2 }),
        expect.objectContaining({ source: "policy", key: "sandbox_available", value: false }),
      ]),
    );
  });

  it("validates Code Mode source as syntax instead of rejecting comments and strings", async () => {
    const harness = await createHarness();

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: `
          // Mentions import("x"), require("x"), process, fetch, and setTimeout without executing them.
          const metadata = {
            import: "literal key",
            require: "literal key",
            process: "literal key",
            fetch: "literal key",
            setTimeout: "literal key",
          };
          const text = "import('x') require('x') process fetch setTimeout";
          return { metadata, text };
        `,
        originSurface: "code",
      }),
    ).resolves.toMatchObject({ status: "approval_pending" });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: `import fs from "node:fs"; return { fs };`,
        originSurface: "code",
      }),
    ).rejects.toThrow("Code Mode source may not reference import statements.");
    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: `const fs = await import("node:fs"); return { fs };`,
        originSurface: "code",
      }),
    ).rejects.toThrow("Code Mode source may not reference dynamic import.");
    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: `const fs = require("node:fs"); return { fs };`,
        originSurface: "code",
      }),
    ).rejects.toThrow("Code Mode source may not reference require.");
    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: `return process.env;`,
        originSurface: "code",
      }),
    ).rejects.toThrow("Code Mode source may not reference process.");
    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: `return await fetch("https://example.test");`,
        originSurface: "code",
      }),
    ).rejects.toThrow("Code Mode source may not reference fetch.");
    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: `setTimeout(() => undefined, 1); return {};`,
        originSurface: "code",
      }),
    ).rejects.toThrow("Code Mode source may not reference timers or schedulers.");
  });

  it("fails closed when an autonomous Code Mode run has no matching grant", async () => {
    const harness = await createHarness();

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
        workspaceId: "workspace-1",
        autonomousActivation: true,
      }),
    ).rejects.toThrow("Autonomous Code Mode activation requires an active matching operator grant.");

    expect(harness.createApproval).not.toHaveBeenCalled();
  });

  it("records matching autonomous Code Mode grants before opening the approval", async () => {
    const harness = await createHarness();
    const grant = harness.service.createAutonomousActivationGrant({
      workspaceId: "workspace-1",
      surfaces: ["code"],
      maxRiskLevel: "danger",
      activationKinds: ["code_mode"],
      toolPatterns: ["code.*"],
      grantor: "operator",
      reason: "Allow one autonomous Code Mode promotion test.",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxActivations: 1,
      budgetUsd: 1,
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      workspaceId: "workspace-1",
      autonomousActivation: true,
      estimatedCostUsd: 0.25,
    });

    expect(run.autonomousActivation).toMatchObject({
      requested: true,
      allowed: true,
      matchedGrantId: grant.grantId,
      riskLevel: "danger",
    });
    expect(harness.service.listAutonomousActivationGrants(true)[0]).toMatchObject({
      grantId: grant.grantId,
      usedActivations: 1,
      usedBudgetUsd: 0.25,
    });
    expect(harness.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          autonomousActivation: expect.objectContaining({ matchedGrantId: grant.grantId }),
        }),
      }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_created",
      "capabilities",
      expect.objectContaining({
        autonomousActivation: expect.objectContaining({ matchedGrantId: grant.grantId }),
      }),
    );
  });

  it("verifies Code Mode artifact previews and compares run snapshots without re-reading unmanaged files", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const baseline = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { run: 'baseline' };",
      originSurface: "code",
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });
    const current = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { run: 'current' };",
      originSurface: "code",
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });

    const sourcePreview = await harness.service.getCodeModeRunArtifactPreview(current.runId, "source", {
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });
    const wrapperPreview = await harness.service.getCodeModeRunArtifactPreview(current.runId, "wrapper_manifest", {
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });
    const comparison = harness.service.compareCodeModeRuns(current.runId, baseline.runId, {
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });

    expect(sourcePreview).toMatchObject({
      runId: current.runId,
      artifactKind: "source",
      content: "return { run: 'current' };",
      sha256: current.codeHash,
      truncated: false,
    });
    expect(wrapperPreview.content).toContain('"wrappers"');
    expect(comparison.matches).toMatchObject({
      source: false,
      input: true,
      permissionProfile: true,
      sandboxAvailability: true,
    });
    expect(comparison.run.capabilitySnapshotId).toBe(current.capabilitySnapshotId);
    expect(comparison.baseline.capabilitySnapshotId).toBe(baseline.capabilitySnapshotId);
  });

  it("exposes audit-only Aider evidence artifacts through Code Mode artifact previews", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { run: 'aider-preview' };",
      originSurface: "code",
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });
    const bundleRoot = `data/code-mode-artifacts/${run.runId}/aider`;
    const requestArtifact = await createManagedArtifact(
      harness.rootDir,
      bundleRoot,
      "request.md",
      "Implement the approved task.",
      "text/markdown",
    );
    const invocationPlanArtifact = await createManagedArtifact(harness.rootDir, bundleRoot, "invocation-plan.json", {
      contractVersion: 1,
      adapterId: "aider-cli-adapter",
    });
    const patchArtifact = await createManagedArtifact(
      harness.rootDir,
      bundleRoot,
      "aider.patch",
      "diff --git a/file.ts b/file.ts\n",
      "text/x-diff",
    );
    const envelope = {
      contractVersion: 1,
      adapterId: "aider-cli-adapter",
      outcome: "patch_produced",
      command: {
        argvRedacted: ["aider", "--yes"],
      },
      patchArtifact: {
        kind: "unified_diff",
        artifact: patchArtifact,
      },
      replay: {
        replaySafe: false,
        policy: "audit_only",
        reason: "Aider workspace mutation replay requires a separate side-effect runner.",
      },
    };
    const resultEnvelopeArtifact = await createManagedArtifact(
      harness.rootDir,
      bundleRoot,
      "result-envelope.json",
      envelope,
    );
    harness.storage.codeModeRuns.upsert({
      ...harness.storage.codeModeRuns.get(run.runId),
      result: {
        aiderAdapter: {
          requestArtifact,
          invocationPlanArtifact,
          resultEnvelopeArtifact,
          envelope,
        },
      },
    });

    const requestPreview = await harness.service.getCodeModeRunArtifactPreview(run.runId, "aider_request", {
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });
    const patchPreview = await harness.service.getCodeModeRunArtifactPreview(run.runId, "aider_patch", {
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });

    expect(requestPreview).toMatchObject({
      runId: run.runId,
      artifactKind: "aider_request",
      content: "Implement the approved task.",
      sha256: requestArtifact.sha256,
    });
    expect(patchPreview).toMatchObject({
      runId: run.runId,
      artifactKind: "aider_patch",
      content: "diff --git a/file.ts b/file.ts\n",
      sha256: patchArtifact.sha256,
    });
  });

  it("fails Code Mode JSON artifact previews closed when managed artifact content is not JSON", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });
    const wrapperPath = path.resolve(harness.rootDir, run.wrapperManifestArtifact.relPath);
    const invalidJson = "{ not-json";
    await fs.writeFile(wrapperPath, invalidJson, "utf8");
    harness.storage.codeModeRuns.upsert({
      ...harness.storage.codeModeRuns.get(run.runId),
      wrapperManifestArtifact: {
        ...run.wrapperManifestArtifact,
        sha256: sha256Text(invalidJson),
      },
    });

    await expect(
      harness.service.getCodeModeRunArtifactPreview(run.runId, "wrapper_manifest", {
        sessionId: "session-a",
        workspaceId: "workspace-a",
      }),
    ).rejects.toThrow("not valid JSON");
  });

  it("refreshes sandbox metadata for each Code Mode run creation", async () => {
    const unavailableSandbox = {
      runnerId: "goatcitadel.best-effort-host",
      runnerVersion: "0.1.0",
      platform: "win32",
      isolationProfile: "best_effort_host/temp_only/no_network",
      required: true,
      available: false,
      checksPassed: [],
      checksFailed: ["best_effort_host_disabled"],
    } satisfies CodeModeSandboxMetadata;
    const availableSandbox = {
      ...unavailableSandbox,
      available: true,
      checksPassed: ["windows_appcontainer_present"],
      checksFailed: [],
    } satisfies CodeModeSandboxMetadata;
    const sandboxSequence = [unavailableSandbox, availableSandbox];
    const harness = await createHarness({
      resolveSandboxMetadata: () => sandboxSequence.shift() ?? availableSandbox,
    });

    const firstRun = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { run: 1 };",
    });
    const secondRun = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { run: 2 };",
    });

    expect(firstRun.sandbox).toMatchObject({ available: false });
    expect(secondRun.sandbox).toMatchObject({ available: true });
    expect(harness.createApproval).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: expect.objectContaining({
          sandbox: expect.objectContaining({ available: true }),
        }),
      }),
    );
  });

  it("creates explicit Docker-backed Aider runs only with audit request metadata", async () => {
    const harness = await createHarness({
      sandboxConfig: { bestEffortHostEnabled: true },
      dockerBackend: {
        enabled: true,
        image: digestPinnedRunnerImage,
      },
      aiderAdapter: {
        enabled: true,
        image: "ghcr.io/goatcitadel/aider-adapter:preview",
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      executionBackendId: "aider-cli-adapter",
      aider: {
        requestMarkdown: "Refactor this run-temp file.",
        repositoryRootRelPath: "workspace",
      },
    });

    expect(run.executionBackend).toMatchObject({
      backendId: "aider-cli-adapter",
      kind: "aider_adapter",
      adapterForBackendId: "docker-container",
      isolationProfile: "docker/aider-audit/no_operator_workspace",
    });
    expect(harness.storage.pendingApprovalActions.find(run.approvalId!)).toMatchObject({
      request: {
        aider: {
          requestMarkdown: "Refactor this run-temp file.",
          repositoryRootRelPath: "workspace",
        },
      },
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        executionBackendId: "aider-cli-adapter",
      }),
    ).rejects.toThrow("Aider Code Mode runs require aider.requestMarkdown.");
  });

  it("lists Code Mode execution backends without promoting Docker or Aider as callable", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const response = harness.service.listCodeModeExecutionBackends();

    expect(response).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      defaultBackendId: "trusted-code-host",
      activeBackendId: "trusted-code-host",
      items: expect.arrayContaining([
        expect.objectContaining({
          backendId: "trusted-code-host",
          kind: "host",
          callable: true,
          runtimeSupport: "active_runner",
        }),
        expect.objectContaining({
          backendId: "docker-container",
          kind: "docker",
          callable: false,
          runtimeSupport: "preview_only",
        }),
        expect.objectContaining({
          backendId: "aider-cli-adapter",
          kind: "aider_adapter",
          callable: false,
          adapterForBackendId: "docker-container",
        }),
        expect.objectContaining({
          backendId: "e2b-reference",
          callable: false,
          evaluationOnly: true,
        }),
      ]),
    });
  });

  it("lists configured Docker as the active Code Mode backend while leaving host as default", async () => {
    const harness = await createHarness({
      dockerBackend: {
        enabled: true,
        image: digestPinnedRunnerImage,
        dockerCommand: "docker",
      },
    });

    const response = harness.service.listCodeModeExecutionBackends();

    expect(response).toMatchObject({
      defaultBackendId: "trusted-code-host",
      activeBackendId: "docker-container",
      items: expect.arrayContaining([
        expect.objectContaining({
          backendId: "trusted-code-host",
          callable: false,
        }),
        expect.objectContaining({
          backendId: "docker-container",
          kind: "docker",
          callable: true,
          status: "available",
          runtimeSupport: "active_runner",
          blockers: [],
          evidence: expect.objectContaining({
            detectedCommand: "docker",
          }),
        }),
        expect.objectContaining({
          backendId: "aider-cli-adapter",
          callable: false,
        }),
      ]),
    });
  });

  it("records configured Docker backend truth on pending Code Mode approvals", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      dockerBackend: {
        enabled: true,
        image: digestPinnedRunnerImage,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });

    expect(run.executionBackend).toMatchObject({
      backendId: "docker-container",
      kind: "docker",
      status: "available",
      runtimeSupport: "active_runner",
      isolationProfile: "docker/stdout-jsonrpc/no_network",
    });
    expect(harness.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          executionBackend: expect.objectContaining({
            backendId: "docker-container",
          }),
        }),
      }),
    );
  });

  it("rejects Code Mode runs for missing sessions or mismatched turn traces", async () => {
    const harness = await createHarness();
    vi.mocked(harness.storage.chatSessionMeta.get).mockReturnValueOnce(undefined);

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        sessionId: "missing-session",
      }),
    ).rejects.toThrow(/session missing-session was not found/);

    harness.storage.chatSessionMeta.patch("session-a", { workspaceId: "workspace-a" });
    harness.storage.chatTurnTraces.create({
      turnId: "turn-b",
      sessionId: "session-b",
      durable: { runId: "durable-b" },
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        sessionId: "session-a",
        turnId: "turn-b",
      }),
    ).rejects.toThrow(/turn turn-b does not belong to session session-a/);

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        turnId: "turn-b",
      }),
    ).rejects.toThrow(/turnId requires a sessionId/);
  });

  it("keeps artifact evidence visible when Code Mode approval creation fails", async () => {
    const harness = await createHarness();
    harness.createApproval.mockRejectedValueOnce(new Error("approval store unavailable"));

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
        requestedOutputIntent: "Capture approval creation failure.",
      }),
    ).rejects.toThrow("approval store unavailable");

    const [failedRun] = harness.storage.codeModeRuns.list();
    expect(failedRun).toMatchObject({
      status: "failed",
      originSurface: "code",
      error: "approval store unavailable",
      errorCode: "approval_create_failed",
      errorDetails: expect.objectContaining({
        phase: "approval_create",
      }),
    });
    await expect(fs.stat(path.resolve(harness.rootDir, failedRun.codeArtifact.relPath))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.resolve(harness.rootDir, failedRun.wrapperManifestArtifact.relPath)),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.resolve(harness.rootDir, failedRun.policySnapshotArtifact.relPath)),
    ).resolves.toBeTruthy();
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_failed",
      "capabilities",
      expect.objectContaining({
        runId: failedRun.runId,
        errorCode: "approval_create_failed",
      }),
    );
  });

  it("rejects late-created Code Mode approvals when approval creation throws with an approval id", async () => {
    const harness = await createHarness({ reserveApprovalWaitRun: true });
    const createApproval = harness.createApproval.getMockImplementation();
    harness.createApproval.mockImplementationOnce(async (input) => {
      await createApproval!(input);
      throw Object.assign(new Error("approval audit unavailable"), {
        approvalId: "approval-1",
      });
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
      }),
    ).rejects.toThrow("approval audit unavailable");

    const [failedRun] = harness.storage.codeModeRuns.list();
    expect(failedRun).toMatchObject({
      status: "failed",
      approvalId: "approval-1",
      errorCode: "approval_create_failed",
      errorDetails: expect.objectContaining({
        phase: "approval_create",
        approvalId: "approval-1",
      }),
    });
    expect(harness.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "reject",
        resolvedBy: "system",
        resolutionNote: expect.stringContaining("approval audit unavailable"),
      }),
    );
    expect(harness.storage.approvals.get("approval-1")).toMatchObject({ status: "rejected" });
    expect(harness.canonicalResolutionEvents).toEqual(["resolved"]);
    expect(harness.canonicalResolutionEffects).toEqual([
      "approval_wait_wake",
      "approval_resolution_signal",
      "approval_observability",
    ]);
    expect(harness.requestRunProcessing).toHaveBeenCalledWith("approval-wait-1");
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          phase: "approval_create",
          errorCode: "approval_create_failed",
        }),
      }),
    );
  });

  it("records late Code Mode approval cleanup failures on the failed run and realtime event", async () => {
    const harness = await createHarness();
    harness.createApproval.mockRejectedValueOnce(
      Object.assign(new Error("approval audit unavailable"), {
        approvalId: "approval-1",
      }),
    );
    harness.storage.approvals.resolve.mockImplementationOnce(() => {
      throw new Error("approval row locked");
    });
    harness.storage.approvalEvents.append.mockImplementationOnce(() => {
      throw new Error("event store locked");
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
      }),
    ).rejects.toThrow("approval audit unavailable");

    const [failedRun] = harness.storage.codeModeRuns.list();
    expect(failedRun.errorDetails).toMatchObject({
      phase: "approval_create",
      approvalId: "approval-1",
      lateApprovalCleanup: {
        approvalId: "approval-1",
        attempted: true,
        status: "failed",
        errors: expect.arrayContaining([
          expect.stringContaining("approval row locked"),
          expect.stringContaining("event store locked"),
        ]),
      },
    });
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_failed",
      "capabilities",
      expect.objectContaining({
        runId: failedRun.runId,
        approvalId: "approval-1",
        errorDetails: expect.objectContaining({
          lateApprovalCleanup: expect.objectContaining({ status: "failed" }),
        }),
      }),
    );
  });

  it("fails pending Code Mode actions when registration fails after pending-action creation", async () => {
    const harness = await createHarness({ reserveApprovalWaitRun: true });
    harness.storage.approvalEvents.append.mockImplementationOnce(() => {
      throw new Error("approval event store unavailable");
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
      }),
    ).rejects.toThrow("approval event store unavailable");

    const [failedRun] = harness.storage.codeModeRuns.list();
    expect(failedRun).toMatchObject({
      status: "failed",
      approvalId: "approval-1",
      errorCode: "approval_registration_failed",
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        runId: failedRun.runId,
        errorCode: "approval_registration_failed",
      }),
    );
    expect(harness.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "reject",
        resolvedBy: "system",
      }),
    );
    expect(harness.storage.approvals.get("approval-1")).toMatchObject({ status: "rejected" });
    expect(harness.canonicalResolutionEvents).toEqual(["resolved"]);
    expect(harness.canonicalResolutionEffects).toEqual([
      "approval_wait_wake",
      "approval_resolution_signal",
      "approval_observability",
    ]);
    expect(harness.requestRunProcessing).toHaveBeenCalledWith("approval-wait-1");
  });

  it("rejects Code Mode approvals when registration fails before a pending action exists", async () => {
    const harness = await createHarness();
    vi.spyOn(harness.storage.pendingApprovalActions, "upsertPending").mockImplementationOnce(() => {
      throw new Error("pending action store unavailable");
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
      }),
    ).rejects.toThrow("pending action store unavailable");

    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        errorCode: "approval_registration_failed",
      }),
    );
    expect(harness.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "reject",
        resolvedBy: "system",
      }),
    );
    expect(harness.storage.approvals.get("approval-1")).toMatchObject({ status: "rejected" });
  });

  it("rejects Code Mode approvals when run-row registration fails after approval creation", async () => {
    const harness = await createHarness();
    vi.spyOn(harness.storage.codeModeRuns, "upsert").mockImplementationOnce(() => {
      throw new Error("code mode run store unavailable");
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
      }),
    ).rejects.toThrow("code mode run store unavailable");

    const [failedRun] = harness.storage.codeModeRuns.list();
    expect(failedRun).toMatchObject({
      status: "failed",
      approvalId: "approval-1",
      errorCode: "approval_registration_failed",
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        errorCode: "approval_registration_failed",
      }),
    );
    expect(harness.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "reject",
        resolvedBy: "system",
      }),
    );
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          errorCode: "approval_registration_failed",
        }),
      }),
    );
    expect(harness.storage.approvals.get("approval-1")).toMatchObject({ status: "rejected" });
  });

  it("executes Code Mode runs approved before expiry even if the worker starts after the approval TTL", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, approvedAt: 'decision-time' };",
      requestedOutputIntent: "Return approval-time execution proof.",
    });
    const approval = harness.approvals.get("approval-1");
    expect(approval).toBeDefined();
    harness.approvals.set("approval-1", {
      ...approval!,
      status: "approved",
      resolvedAt: "2026-04-09T23:59:00.000Z",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const pending = harness.storage.pendingApprovalActions.find("approval-1");
    expect(pending).toBeDefined();
    if (pending) {
      pending.expiresAt = "2026-04-10T00:00:00.000Z";
    }

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "completed",
        trustedCodeWriteVerification: expect.objectContaining({
          mode: "trusted_code_artifact_hash_check",
          claimBoundary: "trusted_code_artifact_integrity_not_hostile_sandbox",
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              artifactKind: "source",
              expectedSha256: run.codeHash,
              actualSha256: run.codeHash,
              verified: true,
            }),
            expect.objectContaining({
              artifactKind: "wrapper_manifest",
              expectedSha256: run.wrapperManifestArtifact.sha256,
              verified: true,
            }),
            expect.objectContaining({
              artifactKind: "policy_snapshot",
              expectedSha256: run.policySnapshotArtifact.sha256,
              verified: true,
            }),
          ]),
          notes: expect.arrayContaining([expect.stringContaining("Does not claim hostile-code sandboxing")]),
        }),
        verification: expect.objectContaining({
          status: "completed_unverified",
        }),
      }),
    });
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "completed",
      verification: expect.objectContaining({
        status: "completed_unverified",
      }),
      trustedCodeWriteVerification: expect.objectContaining({
        claimBoundary: "trusted_code_artifact_integrity_not_hostile_sandbox",
      }),
      result: expect.objectContaining({
        trustedCodeWriteVerification: expect.objectContaining({
          mode: "trusted_code_artifact_hash_check",
        }),
      }),
    });
    await expect(fs.stat(path.join(harness.rootDir, "data", "code-mode-temp", run.runId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not terminalize Code Mode runs when approval execution is interrupted before launch", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });
    const approval = harness.approvals.get("approval-1");
    harness.approvals.set("approval-1", {
      ...approval!,
      status: "approved",
      resolvedAt: "2026-04-10T00:00:00.000Z",
    });
    const controller = new AbortController();
    controller.abort(new Error("approval effect lease ownership moved"));

    const result = await harness.service.executeApprovedCodeModeRun("approval-1", controller.signal);

    expect(result).toBeUndefined();
    const storedRun = harness.storage.codeModeRuns.get(run.runId);
    expect(storedRun).toMatchObject({ status: "approval_pending" });
    expect(storedRun.startedAt).toBeUndefined();
    expect(storedRun).not.toHaveProperty("finishedAt");
    expect(harness.storage.pendingApprovalActions.markResolved).not.toHaveBeenCalledWith(
      "approval-1",
      expect.any(String),
      expect.anything(),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_interrupted",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        approvalId: "approval-1",
        status: "approval_pending",
      }),
    );
  });

  it("releases the execution claim when an abort wins immediately before child dispatch", async () => {
    const controller = new AbortController();
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { shouldNotDispatch: true };",
    });
    const approval = harness.approvals.get("approval-1");
    harness.approvals.set("approval-1", {
      ...approval!,
      status: "approved",
      resolvedAt: "2026-04-10T00:00:00.000Z",
    });
    vi.spyOn(harness.storage.codeModeRuns, "markExecutionBoundaryCrossed").mockImplementationOnce(() => {
      controller.abort(new Error("approval effect lease ownership moved before dispatch"));
      return undefined;
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1", controller.signal);

    expect(result).toBeUndefined();
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "approval_pending",
      executionRecovery: {
        generation: 1,
        phase: "not_started",
        disposition: "retryable",
      },
    });
    expect(harness.storage.pendingApprovalActions.markResolved).not.toHaveBeenCalledWith(
      "approval-1",
      expect.any(String),
      expect.anything(),
    );
    expect(harness.publishRealtime).not.toHaveBeenCalledWith(
      "code_mode_execution_boundary_crossed",
      "capabilities",
      expect.anything(),
    );
  });

  it("resets and releases a tentative boundary when the child channel is known closed before send", async () => {
    const harness = await createHarness({
      sandboxConfig: { required: false, bestEffortHostEnabled: false },
      spawnCodeModeChild: vi.fn(() => fakeCodeModeDispatchChild({ connected: false })) as never,
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { shouldNotDispatch: true };",
    });
    const resetBoundary = vi.spyOn(harness.storage.codeModeRuns, "resetExecutionBoundaryBeforeDispatch");

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toBeUndefined();
    expect(resetBoundary).toHaveBeenCalledOnce();
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "approval_pending",
      executionRecovery: {
        generation: 1,
        phase: "not_started",
        disposition: "retryable",
      },
    });
  });

  it("resets and releases a tentative boundary when the pre-dispatch hook fails after its durable write", async () => {
    const child = fakeCodeModeDispatchChild({ connected: true });
    const send = vi.spyOn(child, "send");
    child.kill = () => {
      child.killed = true;
      setImmediate(() => {
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return true;
    };
    const harness = await createHarness({
      sandboxConfig: { required: false, bestEffortHostEnabled: false },
      spawnCodeModeChild: vi.fn(() => child) as never,
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { shouldNotDispatch: true };",
    });
    harness.publishRealtime.mockImplementation((eventType: string) => {
      if (eventType === "code_mode_execution_boundary_crossed") {
        throw new Error("synthetic boundary notification failure");
      }
    });
    const resetBoundary = vi.spyOn(harness.storage.codeModeRuns, "resetExecutionBoundaryBeforeDispatch");

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(resetBoundary).toHaveBeenCalledOnce();
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "approval_pending",
      executionRecovery: {
        generation: 1,
        phase: "not_started",
        disposition: "retryable",
      },
    });
  });

  it("keeps asynchronous IPC dispatch uncertainty in manual reconciliation", async () => {
    const harness = await createHarness({
      sandboxConfig: { required: false, bestEffortHostEnabled: false },
      spawnCodeModeChild: vi.fn(() =>
        fakeCodeModeDispatchChild({
          connected: true,
          asynchronousSendError: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
        }),
      ) as never,
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { mayHaveDispatched: true };",
    });
    const resetBoundary = vi.spyOn(harness.storage.codeModeRuns, "resetExecutionBoundaryBeforeDispatch");

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        errorCode: "execution_interrupted_after_boundary",
      }),
    });
    expect(resetBoundary).not.toHaveBeenCalled();
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "failed",
      executionRecovery: expect.objectContaining({
        phase: "terminal",
        disposition: "manual_reconciliation",
        interruptionReason: expect.stringContaining("write EPIPE"),
      }),
    });
  });

  it("keeps a correlated child error authoritative over a late IPC acknowledgement failure", async () => {
    const harness = await createHarness({
      sandboxConfig: { required: false, bestEffortHostEnabled: false },
      spawnCodeModeChild: vi.fn(() =>
        fakeCodeModeDispatchChild({
          connected: true,
          asynchronousSendError: new Error("late IPC close after child response"),
          responseBeforeAsynchronousSendError: {
            code: "UNAWAITED_WRAPPER_CALL",
            message: "Code Mode source returned before all wrapper calls were awaited.",
            details: { pendingWrapperCallCount: 1 },
          },
        }),
      ) as never,
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      errorCode: "UNAWAITED_WRAPPER_CALL",
      errorDetails: { pendingWrapperCallCount: 1 },
    });
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "failed",
      errorCode: "UNAWAITED_WRAPPER_CALL",
      executionRecovery: {
        phase: "terminal",
        disposition: "terminal",
      },
    });
  });

  it("fails closed for manual reconciliation when interrupted after child execution starts", async () => {
    const controller = new AbortController();
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      invokeTool: vi.fn(async () => {
        controller.abort(new Error("approval effect lease ownership moved after child start"));
        return {
          outcome: "executed",
          policyReason: "executed",
          auditEventId: "audit-1",
          result: { ok: true },
        };
      }),
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "console.log('tool started'); return await capabilities.tool.safe_read();",
    });
    const approval = harness.approvals.get("approval-1");
    harness.approvals.set("approval-1", {
      ...approval!,
      status: "approved",
      resolvedAt: "2026-04-10T00:00:00.000Z",
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1", controller.signal);

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        errorCode: "execution_interrupted_after_boundary",
      }),
    });
    const storedRun = harness.storage.codeModeRuns.get(run.runId);
    expect(storedRun).toMatchObject({
      status: "failed",
      executionRecovery: {
        phase: "terminal",
        disposition: "manual_reconciliation",
        interruptionReason: "approval effect lease ownership moved after child start",
      },
    });
    expect(storedRun.stdoutPreview).toContain("tool started");
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({ manualReconciliationRequired: true }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_interrupted",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        approvalId: "approval-1",
        status: "failed",
      }),
    );
  });

  it("does not resolve pending actions when another worker already claimed execution", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });
    const approval = harness.approvals.get("approval-1");
    harness.approvals.set("approval-1", {
      ...approval!,
      status: "approved",
      resolvedAt: "2026-04-10T00:00:00.000Z",
    });
    harness.storage.codeModeRuns.claimForExecution({
      runId: run.runId,
      approvalId: "approval-1",
      sandbox: run.sandbox,
      startedAt: new Date().toISOString(),
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toBeUndefined();
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "running",
    });
    expect(harness.storage.pendingApprovalActions.markResolved).not.toHaveBeenCalledWith(
      "approval-1",
      expect.any(String),
      expect.anything(),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_refused",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        status: "running",
        errorCode: "RUN_ALREADY_CLAIMED",
      }),
    );
  });

  it("requeues and completes a pre-restart claimed run immediately after the stale-owner bound", async () => {
    const startedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(startedAtMs);
    try {
      const harness = await createHarness({
        sandboxConfig: {
          required: false,
          bestEffortHostEnabled: false,
        },
      });
      const run = await harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { recovered: true };",
      });
      const approval = harness.approvals.get("approval-1");
      harness.approvals.set("approval-1", {
        ...approval!,
        status: "approved",
        resolvedAt: "2026-04-10T00:00:00.000Z",
      });
      harness.storage.codeModeRuns.claimForExecution({
        runId: run.runId,
        approvalId: "approval-1",
        sandbox: run.sandbox,
        startedAt: new Date(startedAtMs).toISOString(),
      });

      const immediateReplay = await harness.service.executeApprovedCodeModeRun("approval-1");

      expect(immediateReplay).toBeUndefined();
      expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
        status: "running",
        executionRecovery: {
          phase: "claimed",
          disposition: "none",
        },
      });
      expect(harness.storage.pendingApprovalActions.find("approval-1")).toMatchObject({
        resolutionStatus: "pending",
      });

      nowSpy.mockReturnValue(startedAtMs + 15_501);
      const recoveredReplay = await harness.service.executeApprovedCodeModeRun("approval-1");

      expect(recoveredReplay).toMatchObject({
        outcome: "executed",
        result: expect.objectContaining({
          runId: run.runId,
          status: "completed",
        }),
      });
      expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
        status: "completed",
        executionRecovery: {
          phase: "terminal",
          disposition: "terminal",
          generation: 2,
        },
      });
      expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
        "approval-1",
        "executed",
        expect.objectContaining({
          runId: run.runId,
          outcome: "completed",
        }),
      );
      expect(harness.publishRealtime).toHaveBeenCalledWith(
        "code_mode_run_claim_recovered",
        "capabilities",
        expect.objectContaining({
          runId: run.runId,
          status: "approval_pending",
        }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("terminalizes a pre-restart post-boundary run for manual reconciliation after the stale-owner bound", async () => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(startedAtMs);
    try {
      const harness = await createHarness({
        sandboxConfig: {
          required: false,
          bestEffortHostEnabled: false,
        },
      });
      const run = await harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { mustNotReplay: true };",
      });
      const approval = harness.approvals.get("approval-1");
      harness.approvals.set("approval-1", {
        ...approval!,
        status: "approved",
        resolvedAt: "2026-04-10T00:00:00.000Z",
      });
      const claimed = harness.storage.codeModeRuns.claimForExecution({
        runId: run.runId,
        approvalId: "approval-1",
        sandbox: run.sandbox,
        startedAt,
      });
      harness.storage.codeModeRuns.markExecutionBoundaryCrossed({
        runId: run.runId,
        approvalId: "approval-1",
        startedAt,
        executionGeneration: claimed!.executionRecovery.generation,
        boundaryCrossedAt: new Date(startedAtMs + 1).toISOString(),
      });

      expect(await harness.service.executeApprovedCodeModeRun("approval-1")).toBeUndefined();
      expect(harness.storage.pendingApprovalActions.find("approval-1")).toMatchObject({
        resolutionStatus: "pending",
      });

      nowSpy.mockReturnValue(startedAtMs + 15_501);
      const recoveredReplay = await harness.service.executeApprovedCodeModeRun("approval-1");

      expect(recoveredReplay).toMatchObject({
        outcome: "executed",
        result: expect.objectContaining({
          runId: run.runId,
          status: "failed",
          errorCode: "execution_interrupted_after_boundary",
          manualReconciliationRequired: true,
          executionRecovery: expect.objectContaining({
            phase: "terminal",
            disposition: "manual_reconciliation",
          }),
        }),
      });
      expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
        status: "failed",
        executionRecovery: {
          generation: 1,
          phase: "terminal",
          disposition: "manual_reconciliation",
          boundaryCrossedAt: new Date(startedAtMs + 1).toISOString(),
          interruptedAt: expect.any(String),
          interruptionReason: expect.stringContaining("Gateway restarted"),
        },
      });
      expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
        "approval-1",
        "failed",
        expect.objectContaining({
          runId: run.runId,
          recoveredTerminalOutcome: true,
          manualReconciliationRequired: true,
          errorCode: "execution_interrupted_after_boundary",
          executionRecovery: expect.objectContaining({ disposition: "manual_reconciliation" }),
        }),
      );
      expect(harness.publishRealtime).toHaveBeenCalledWith(
        "code_mode_run_manual_reconciliation_required",
        "capabilities",
        expect.objectContaining({
          runId: run.runId,
          status: "failed",
        }),
      );
      expect(harness.publishRealtime).not.toHaveBeenCalledWith(
        "code_mode_run_completed",
        "capabilities",
        expect.anything(),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("terminalizes the linked Code Mode run when a pending action points at a missing row", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });
    const pending = harness.storage.pendingApprovalActions.find("approval-1");
    expect(pending).toBeDefined();
    if (pending) {
      pending.request.runId = "missing-run";
    }

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      policyReason: "code_mode_run:failed",
      result: {
        runId: run.runId,
        status: "failed",
        errorCode: "pending_action_corrupt",
      },
    });
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "failed",
      errorCode: "pending_action_corrupt",
      errorDetails: expect.objectContaining({
        reason: "pending_action_corrupt",
        pendingRunId: "missing-run",
      }),
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        runId: run.runId,
        pendingRunId: "missing-run",
        reason: expect.stringContaining("missing-run"),
        errorCode: "RUN_ID_MISMATCH",
      }),
    );
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          runId: run.runId,
          pendingRunId: "missing-run",
          errorCode: "pending_action_corrupt",
        }),
      }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_failed",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        approvalId: "approval-1",
        errorCode: "pending_action_corrupt",
      }),
    );
  });

  it("terminalizes the linked Code Mode run when a pending action omits its run id", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });
    const pending = harness.storage.pendingApprovalActions.find("approval-1");
    expect(pending).toBeDefined();
    if (pending) {
      delete pending.request.runId;
    }

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      result: {
        runId: run.runId,
        status: "failed",
        errorCode: "pending_action_corrupt",
      },
    });
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "failed",
      errorCode: "pending_action_corrupt",
      errorDetails: expect.objectContaining({
        reason: "pending_action_corrupt",
        pendingRunId: null,
      }),
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        runId: run.runId,
        pendingRunId: null,
        reason: "missing code mode run id",
        errorCode: "RUN_ID_MISSING",
      }),
    );
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          runId: run.runId,
          pendingRunId: null,
          errorCode: "pending_action_corrupt",
        }),
      }),
    );
  });

  it("recovers stale Code Mode execution claims before retrying approved actions", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });
    const approval = harness.approvals.get("approval-1");
    harness.approvals.set("approval-1", {
      ...approval!,
      status: "approved",
      resolvedAt: "2026-04-10T00:00:00.000Z",
    });
    harness.storage.codeModeRuns.claimForExecution({
      runId: run.runId,
      approvalId: "approval-1",
      sandbox: run.sandbox,
      startedAt: "2026-04-10T00:00:01.000Z",
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "completed",
      }),
    });
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({ status: "completed" });
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_claim_recovered",
      "capabilities",
      expect.objectContaining({ runId: run.runId, status: "approval_pending" }),
    );
  });

  it("does not let a lost Code Mode execution claim overwrite a recovered run", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });
    const approval = harness.approvals.get("approval-1");
    harness.approvals.set("approval-1", {
      ...approval!,
      status: "approved",
      resolvedAt: "2026-04-10T00:00:00.000Z",
    });
    const reclaimedStartedAt = "2026-04-10T00:09:00.000Z";
    vi.spyOn(harness.storage.codeModeRuns, "finishExecutionClaim").mockImplementationOnce((input) => {
      const current = harness.storage.codeModeRuns.get(input.runId);
      harness.storage.codeModeRuns.upsert({
        ...current,
        status: "running",
        startedAt: reclaimedStartedAt,
        result: undefined,
        executionRecovery: {
          ...current.executionRecovery,
          generation: current.executionRecovery.generation + 1,
          phase: "claimed",
          disposition: "none",
        },
      });
      return undefined;
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toBeUndefined();
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "running",
      startedAt: reclaimedStartedAt,
    });
    expect(harness.storage.codeModeRuns.get(run.runId).result).toBeUndefined();
    expect(harness.storage.pendingApprovalActions.markResolved).not.toHaveBeenCalledWith(
      "approval-1",
      expect.any(String),
      expect.anything(),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_claim_lost",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        approvalId: "approval-1",
        status: "running",
        currentStartedAt: reclaimedStartedAt,
      }),
    );
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "code_mode_execution_claim_lost",
      }),
    );
  });

  it("stages the Code Mode harness inside the per-run temp root and cleans it after launch", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Verify run-local harness staging.",
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "completed",
      }),
    });
    const runTempRoot = path.join(harness.rootDir, "data", "code-mode-temp", run.runId);
    await expect(fs.stat(runTempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(harness.rootDir, "data", "code-mode-temp", "code-mode-harness.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records launch-time sandbox failure metadata and releases the claim for retry", async () => {
    const unavailableSandbox = {
      runnerId: "goatcitadel.best-effort-host",
      runnerVersion: "0.1.0",
      platform: "win32",
      isolationProfile: "best_effort_host/temp_only/no_network",
      required: true,
      available: false,
      checksPassed: ["mode_best_effort_host"],
      checksFailed: ["best_effort_host_disabled"],
      failClosedReason: "Code Mode sandbox failed closed on win32: best_effort_host_disabled.",
    } satisfies CodeModeSandboxMetadata;
    const availableSandbox = {
      ...unavailableSandbox,
      available: true,
      checksPassed: ["mode_best_effort_host", "win32_appcontainer_prerequisites_available"],
      checksFailed: [],
      failClosedReason: undefined,
    } satisfies CodeModeSandboxMetadata;
    const sandboxSequence = [availableSandbox, availableSandbox, unavailableSandbox];
    const harness = await createHarness({
      sandboxConfig: {
        required: true,
        bestEffortHostEnabled: false,
      },
      resolveSandboxMetadata: () => sandboxSequence.shift() ?? unavailableSandbox,
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Should fail before launch if sandbox disappears.",
    });
    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(run.sandbox).toMatchObject({ available: true });
    expect(result).toBeUndefined();
    expect(storedRun).toMatchObject({
      status: "approval_pending",
      sandbox: expect.objectContaining({
        available: false,
        checksFailed: expect.arrayContaining(["launch_preparation_failed"]),
        failClosedReason: expect.stringContaining("launch preparation failed"),
      }),
      executionRecovery: expect.objectContaining({
        phase: "not_started",
        disposition: "retryable",
        interruptionReason: expect.any(String),
      }),
    });
    expect(storedRun.startedAt).toBeUndefined();
    expect(harness.storage.pendingApprovalActions.markResolved).not.toHaveBeenCalledWith(
      "approval-1",
      expect.any(String),
      expect.anything(),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_dispatch_deferred",
      "capabilities",
      expect.objectContaining({ runId: run.runId, status: "approval_pending" }),
    );
    expect(harness.publishRealtime).not.toHaveBeenCalledWith(
      "code_mode_execution_boundary_crossed",
      "capabilities",
      expect.anything(),
    );
  });

  it("returns candidate and proposal detail and supports promotion, rollback, and revoke", async () => {
    const harness = await createHarness();
    const run = harness.storage.codeModeRuns.upsert({
      runId: "code-run-existing",
      status: "completed",
      language: "typescript",
      saveCandidateOnSuccess: true,
      capabilitySnapshotId: "cap-snap-1",
      codeModeInputHash: "input-hash",
      wrapperManifestHash: "wrap-hash",
      policySnapshotHash: "policy-hash",
      codeHash: "code-hash",
      sandbox: {
        runnerId: "goatcitadel.best-effort-host",
        runnerVersion: "0.1.0",
        platform: "win32",
        isolationProfile: "best_effort_host/temp_only/no_network",
        required: true,
        available: false,
        checksPassed: ["mode_best_effort_host"],
        checksFailed: ["win32_adapter_unimplemented"],
        failClosedReason: "Code Mode sandbox failed closed on win32: win32_adapter_unimplemented.",
      },
      codeArtifact: createArtifact("code.json"),
      wrapperManifestArtifact: createArtifact("wrapper.json"),
      policySnapshotArtifact: createArtifact("policy.json"),
      stdoutTruncated: false,
      stderrTruncated: false,
      createdAt: "2026-04-10T00:00:00.000Z",
      startedAt: "2026-04-10T00:00:01.000Z",
      finishedAt: "2026-04-10T00:00:02.000Z",
      result: { ok: true },
    });

    harness.storage.candidateSkillVersions.upsert(
      await createCandidateVersion(harness.rootDir, {
        candidateId: "candidate-demo",
        versionId: "version-a",
        lifecycleState: "candidate",
        originatingRunId: run.runId,
        updatedAt: "2026-04-10T00:01:00.000Z",
      }),
    );
    harness.storage.candidateSkillVersions.upsert(
      await createCandidateVersion(harness.rootDir, {
        candidateId: "candidate-demo",
        versionId: "version-b",
        lifecycleState: "candidate",
        originatingRunId: run.runId,
        updatedAt: "2026-04-10T00:02:00.000Z",
      }),
    );

    const proposal = harness.service.createProposal({
      proposalKind: "skill",
      title: "Promote candidate-demo",
      summary: "Review the generated candidate",
      payload: { candidateId: "candidate-demo" },
      candidateId: "candidate-demo",
    });

    const initialDetail = harness.service.getCandidateDetail("candidate-demo");
    expect(initialDetail).toMatchObject({
      candidateId: "candidate-demo",
      revision: 1,
      activationBlocked: true,
      originatingRun: expect.objectContaining({ runId: "code-run-existing" }),
    });

    // HX-402 P2 (coverage-preserving remodel): promote/rollback/revoke are
    // approval-first — each verb requests one canonical capability.lifecycle
    // approval and only the recovered effect executes the transition.
    const executeApproved = (pending: { approvalId: string }) => {
      harness.storage.approvals.resolve(pending.approvalId, {
        decision: "approve",
        resolvedBy: "operator-resolver",
      });
      return harness.service.executeApprovedCapabilityLifecycleMutation({ approvalId: pending.approvalId });
    };

    const promoteRequest = harness.service.promoteCandidate("candidate-demo", initialDetail.revision, "version-b");
    if (!promoteRequest.pendingApproval) throw new Error("expected pending promote approval");
    expect(promoteRequest.pendingApproval).toMatchObject({
      kind: "capability.lifecycle",
      action: "candidate_promoted",
      candidateId: "candidate-demo",
      status: "pending",
    });
    // No mutation before approval: the reviewed detail is unchanged.
    expect(harness.service.getCandidateDetail("candidate-demo")).toMatchObject({
      revision: 1,
      activationBlocked: true,
    });
    const promoted = executeApproved(promoteRequest.pendingApproval);
    expect(promoted.revision).toBe(2);
    expect(promoted.detail.activeVersion?.versionId).toBe("version-b");
    expect(promoted.detail.activationBlocked).toBe(false);

    let staleWrite: unknown;
    try {
      harness.service.promoteCandidate("candidate-demo", initialDetail.revision, "version-a");
    } catch (error) {
      staleWrite = error;
    }
    expect(staleWrite).toBeInstanceOf(ConflictError);
    expect(staleWrite).toMatchObject({
      code: "WRITE_CONFLICT",
      details: { expectedRevision: 1, currentRevision: 2 },
    });

    // Byte-identical target state is a pure no-op: no approval row is minted.
    const noOp = harness.service.promoteCandidate("candidate-demo", promoted.revision, "version-b");
    expect(noOp.pendingApproval).toBeNull();
    expect(noOp).toMatchObject({
      noMutationRequired: true,
      detail: expect.objectContaining({ revision: promoted.revision }),
    });

    const rollbackRequest = harness.service.rollbackCandidate("candidate-demo", "version-a", promoted.revision);
    if (!rollbackRequest.pendingApproval) throw new Error("expected pending rollback approval");
    expect(rollbackRequest.pendingApproval.action).toBe("candidate_rolled_back");
    const rolledBack = executeApproved(rollbackRequest.pendingApproval);
    expect(rolledBack.revision).toBe(3);
    expect(rolledBack.detail.activeVersion?.versionId).toBe("version-a");

    const revokeRequest = harness.service.revokeCandidate("candidate-demo", rolledBack.revision, "version-a");
    if (!revokeRequest.pendingApproval) throw new Error("expected pending revoke approval");
    expect(revokeRequest.pendingApproval.action).toBe("candidate_revoked");
    const revoked = executeApproved(revokeRequest.pendingApproval);
    expect(revoked.revision).toBe(4);
    expect(revoked.detail.activationBlocked).toBe(true);

    // Every approved transition wrote its governed lifecycle evidence.
    const governedRows = harness.storage.gatewaySql
      .prepare(`SELECT operation FROM governed_lifecycle_events WHERE domain = 'capability_state' ORDER BY operation`)
      .all() as Array<{ operation: string }>;
    expect(governedRows.map((row) => row.operation)).toEqual([
      "candidate_promoted",
      "candidate_revoked",
      "candidate_rolled_back",
      "proposal_created",
    ]);

    const proposalDetail = harness.service.getProposalDetail(proposal.proposalId);
    expect(proposalDetail).toMatchObject({
      proposal: expect.objectContaining({ proposalId: proposal.proposalId }),
      candidate: expect.objectContaining({ candidateId: "candidate-demo" }),
    });
    expect(proposalDetail.events).toHaveLength(1);
    expect(proposalDetail.events[0]?.eventType).toBe("created");
  });

  it("projects mesh publication entries into the inspectable catalog with callable truth preserved", async () => {
    const meshProjection = {
      nodeId: "node-a",
      admissionGeneration: 1,
      publisherGeneration: 1,
      manifestSha256: "a".repeat(64),
      entrySha256: "b".repeat(64),
      localId: "project.status",
      capabilityKind: "tool" as const,
      status: "review_required" as const,
      reasons: ["operator_review_required"],
      effectPosture: "read_only" as const,
    };
    const meshEntries: CapabilityCatalogEntry[] = [
      {
        capabilityId: "mesh:node-a:tool:project.status",
        kind: "mesh_tool",
        category: "mesh_published",
        title: "Project status",
        summary: "Mesh tool published by node node-a.",
        callable: false,
        mesh: meshProjection,
      },
      {
        capabilityId: "mesh:node-a:skill:project.guide",
        kind: "mesh_skill",
        category: "mesh_published",
        title: "Project guide",
        summary: "Mesh skill published by node node-a.",
        callable: false,
        mesh: { ...meshProjection, localId: "project.guide", capabilityKind: "skill" },
      },
      {
        capabilityId: "mesh:node-a:tool:project.active",
        kind: "mesh_tool",
        category: "mesh_published",
        title: "Project active",
        summary: "Mesh tool with a live activation.",
        callable: true,
        mesh: { ...meshProjection, localId: "project.active", status: "active", reasons: ["activation_live"] },
      },
    ];
    const harness = await createHarness({ meshCatalogEntries: meshEntries });

    const inspectable = harness.service.listCatalog("inspectable");
    const meshInspectable = inspectable.filter((entry) => entry.category === "mesh_published");
    expect(meshInspectable.map((entry) => entry.capabilityId)).toEqual([
      "mesh:node-a:tool:project.status",
      "mesh:node-a:skill:project.guide",
      "mesh:node-a:tool:project.active",
    ]);
    expect(meshInspectable[0]?.mesh?.status).toBe("review_required");

    const callable = harness.service.listCatalog("callable");
    expect(callable.filter((entry) => entry.kind === "mesh_skill")).toEqual([]);
    expect(callable.filter((entry) => entry.category === "mesh_published").map((entry) => entry.capabilityId)).toEqual([
      "mesh:node-a:tool:project.active",
    ]);
    // Mesh entries never satisfy the local-tool filters that feed tool schema
    // resolution and code-mode wrappers.
    const snapshot = harness.service.freezeCatalogSnapshot();
    expect(
      snapshot.callableEntries.some((entry) => entry.kind === "tool" && entry.capabilityId.startsWith("mesh:")),
    ).toBe(false);
    const directory = harness.service.getCompactToolDirectorySnapshot();
    expect(directory.tools.some((tool) => tool.capabilityId.startsWith("mesh:"))).toBe(false);
  });

  it("keeps the catalog unchanged when no mesh projection producer is composed", async () => {
    const harness = await createHarness();
    expect(harness.service.listCatalog("inspectable").some((entry) => entry.category === "mesh_published")).toBe(false);
  });

  it("lists catalog snapshots, runs, proposals, and inline approval queue items", async () => {
    const harness = await createHarness({
      toolCatalog: [createTool("tool.safe_read"), createTool("tool.write", { readOnly: false })],
    });

    expect(harness.service.listCatalog("callable").map((entry) => entry.capabilityId)).toEqual([
      "tool:tool.safe_read",
      "tool:tool.write",
    ]);

    const snapshot = harness.service.freezeCatalogSnapshot();
    expect(harness.service.getCatalogSnapshot(snapshot.snapshotId)).toBe(snapshot);
    expect(snapshot.callableEntries.map((entry) => entry.toolName)).toEqual(["tool.safe_read", "tool.write"]);

    const runRecord: CodeModeRunRecord = {
      runId: "code-run-list",
      status: "approval_pending",
      language: "typescript",
      requestedOutputIntent: "Listable run",
      saveCandidateOnSuccess: false,
      capabilitySnapshotId: snapshot.snapshotId,
      codeModeInputHash: "input-hash",
      wrapperManifestHash: "wrapper-hash",
      policySnapshotHash: "policy-hash",
      codeHash: "code-hash",
      approvalId: "approval-live",
      sandbox: {
        runnerId: "goatcitadel.best-effort-host",
        runnerVersion: "0.1.0",
        platform: "win32",
        isolationProfile: "best_effort_host/temp_only/no_network",
        required: true,
        available: false,
        checksPassed: [],
        checksFailed: ["best_effort_host_disabled"],
      },
      codeArtifact: createArtifact("list-code.ts"),
      wrapperManifestArtifact: createArtifact("list-wrapper.json"),
      policySnapshotArtifact: createArtifact("list-policy.json"),
      stdoutTruncated: false,
      stderrTruncated: false,
      createdAt: "2026-04-10T00:00:00.000Z",
    };
    harness.storage.codeModeRuns.upsert(runRecord);
    expect(harness.service.listCodeModeRuns(5)).toEqual([runRecord]);
    expect(harness.service.getCodeModeRun("code-run-list")).toBe(runRecord);

    const proposal = harness.service.createProposal({
      proposalKind: "skill",
      title: "Review generated skill",
      summary: "Promote once validated",
      payload: { runId: "code-run-list" },
    });
    expect(harness.service.listProposals(10)).toEqual([proposal]);

    const liveApproval: ApprovalRequest = {
      approvalId: "approval-live",
      kind: "tool.invoke",
      riskLevel: "caution",
      status: "pending",
      payload: {},
      preview: {
        toolName: "fs.write",
        description: "Write the generated candidate.",
        reason: "Operator requested Code Mode execution.",
      },
      linkage: { sessionId: "session-1", toolName: "fs.write" },
      createdAt: "2026-04-10T00:00:01.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      explanationStatus: "not_requested",
    };
    const resolvedApproval: ApprovalRequest = {
      ...liveApproval,
      approvalId: "approval-resolved",
      status: "approved",
      expiresAt: "2999-01-01T00:00:00.000Z",
    };
    vi.mocked(harness.storage.approvals.get).mockImplementation((approvalId: string) => {
      if (approvalId === "approval-live") {
        return liveApproval;
      }
      if (approvalId === "approval-resolved") {
        return resolvedApproval;
      }
      throw new Error(`Missing approval ${approvalId}`);
    });
    const liveInlineDetails = {
      request: {
        authorization: "Bearer short",
        webhookUrl: "https://hooks.example.test/services/team/path-secret?token=query-secret",
        DATABASE_PASSWORD: "tiny-secret",
      },
      tokenEnv: "CODE_MODE_TOKEN",
      secretRef: "keychain:code-mode-token",
      tokenBudget: 2_048,
      tokenId: "code-mode-token-id",
    };
    vi.mocked(harness.storage.chatInlineApprovals.listBySession).mockReturnValue([
      {
        approvalId: "approval-live",
        sessionId: "session-1",
        turnId: "turn-1",
        status: "pending",
        createdAt: "2026-04-10T00:00:01.000Z",
        details: liveInlineDetails,
      },
      {
        approvalId: "approval-resolved",
        sessionId: "session-1",
        turnId: "turn-2",
        status: "pending",
        createdAt: "2026-04-10T00:00:02.000Z",
        details: {},
      },
      {
        approvalId: "approval-orphan",
        sessionId: "session-1",
        turnId: "turn-3",
        status: "failed",
        createdAt: "2026-04-10T00:00:03.000Z",
        details: { toolName: "code_mode.run", description: "Missing durable approval row" },
      },
    ] as never);

    const pendingApprovals = harness.service.listChatPendingApprovals("session-1");
    expect(pendingApprovals).toEqual([
      expect.objectContaining({
        approvalId: "approval-live",
        toolName: "fs.write",
        reason: "Write the generated candidate.",
        details: {
          request: {
            authorization: "[REDACTED]",
            webhookUrl: "[REDACTED]",
            DATABASE_PASSWORD: "[REDACTED]",
          },
          tokenEnv: "CODE_MODE_TOKEN",
          secretRef: "keychain:code-mode-token",
          tokenBudget: 2_048,
          tokenId: "code-mode-token-id",
        },
        stale: false,
      }),
      expect.objectContaining({
        approvalId: "approval-resolved",
        stale: true,
        staleReason: "approved",
      }),
      expect.objectContaining({
        approvalId: "approval-orphan",
        toolName: "code_mode.run",
        reason: "Missing durable approval row",
        stale: true,
        staleReason: "failed",
      }),
    ]);
    expect(liveInlineDetails.request.authorization).toBe("Bearer short");
    expect(liveInlineDetails.request.webhookUrl).toContain("path-secret");
    expect(liveInlineDetails.request.DATABASE_PASSWORD).toBe("tiny-secret");
  });

  it("builds compact prompt-facing tool directories from callable tools only", async () => {
    const harness = await createHarness({
      toolCatalog: [
        createTool("tool.safe_read", {
          argSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }),
      ],
    });
    harness.service.createProposal({
      proposalKind: "tool",
      title: "Unactivated tool",
      summary: "Inspectable proposal only",
      payload: {},
    });

    const compact = harness.service.getCompactToolDirectorySnapshot(60_000);
    const schema = harness.service.getToolSchema("tool.safe_read");

    expect(compact).toMatchObject({
      version: "compact-tool-directory.v1",
      source: "callable_catalog",
      ttlMs: 60_000,
      toolCount: 1,
      omitted: {
        inspectableOnlyCount: 1,
        reason: "callable_only",
      },
    });
    expect(compact.tools).toEqual([
      expect.objectContaining({
        capabilityId: "tool:tool.safe_read",
        toolName: "tool.safe_read",
        summary: "tool.safe_read description",
        schemaRef: expect.objectContaining({
          toolName: "tool.safe_read",
          schemaHash: schema.schemaHash,
          schemaUri: "/api/v1/capabilities/tool-directory/schemas/tool.safe_read",
        }),
      }),
    ]);
    expect(JSON.stringify(compact)).not.toContain("properties");
    expect(schema.schema).toMatchObject({
      properties: { path: { type: "string" } },
    });
  });

  it("includes active delegated child approvals when the parent Cowork turn is waiting", async () => {
    const harness = await createHarness();
    const childApproval: ApprovalRequest = {
      approvalId: "approval-child",
      kind: "browser.search",
      riskLevel: "caution",
      status: "pending",
      payload: {},
      preview: {
        toolName: "browser.search",
        description: "Search for store candidates.",
        reason: "Approval required by policy.",
      },
      linkage: { sessionId: "child-session", toolName: "browser.search" },
      createdAt: "2026-04-10T00:00:01.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      explanationStatus: "not_requested",
    };
    vi.mocked(harness.storage.approvals.get).mockImplementation((approvalId: string) => {
      if (approvalId === childApproval.approvalId) {
        return childApproval;
      }
      throw new Error(`Missing approval ${approvalId}`);
    });
    vi.mocked(harness.storage.chatInlineApprovals.listBySession).mockImplementation((sessionId: string) => {
      if (sessionId === "child-session") {
        return [
          {
            approvalId: "approval-child",
            sessionId: "child-session",
            turnId: "child-turn",
            status: "pending",
            createdAt: "2026-04-10T00:00:01.000Z",
            details: {},
          },
        ] as never;
      }
      if (sessionId === "old-child-session") {
        return [
          {
            approvalId: "approval-old-child",
            sessionId: "old-child-session",
            turnId: "old-child-turn",
            status: "pending",
            createdAt: "2026-04-09T00:00:01.000Z",
            details: {},
          },
        ] as never;
      }
      return [];
    });
    vi.mocked(harness.storage.chatExecutionPlans.listBySession).mockReturnValue([
      {
        planId: "plan-parent",
        sessionId: "parent-session",
        turnId: "parent-turn",
        mode: "cowork",
        planningMode: "off",
        status: "running",
        source: "planner_with_template_fallback",
        advisoryOnly: false,
        objective: "Find store candidates.",
        summary: "Research stores.",
        steps: [
          {
            stepId: "worker",
            index: 1,
            objective: "Search.",
            parallelizable: false,
            status: "running",
            childSessionId: "child-session",
          },
        ],
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:01.000Z",
      },
      {
        planId: "plan-old",
        sessionId: "parent-session",
        turnId: "old-parent-turn",
        mode: "cowork",
        planningMode: "off",
        status: "running",
        source: "planner_with_template_fallback",
        advisoryOnly: false,
        objective: "Old run.",
        summary: "Old research stores.",
        steps: [
          {
            stepId: "old-worker",
            index: 1,
            objective: "Old search.",
            parallelizable: false,
            status: "running",
            childSessionId: "old-child-session",
          },
        ],
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:01.000Z",
      },
    ] as never);
    vi.mocked(harness.storage.chatTurnTraces.listBySession).mockReturnValue([
      {
        turnId: "parent-turn",
        sessionId: "parent-session",
        status: "waiting_for_approval",
        orchestration: {
          steps: [
            {
              stepId: "worker",
              status: "running",
              waitStatus: "waiting_for_approval",
            },
          ],
        },
      },
    ] as never);

    expect(harness.service.listChatPendingApprovals("parent-session")).toEqual([
      expect.objectContaining({
        approvalId: "approval-child",
        sessionId: "child-session",
        toolName: "browser.search",
        stale: false,
      }),
    ]);
    expect(harness.storage.chatExecutionPlans.listBySession).toHaveBeenCalledWith("parent-session", 10);
    expect(harness.storage.chatInlineApprovals.listBySession).toHaveBeenCalledWith("parent-session");
    expect(harness.storage.chatInlineApprovals.listBySession).toHaveBeenCalledWith("child-session");
    expect(harness.storage.chatInlineApprovals.listBySession).not.toHaveBeenCalledWith("old-child-session");
  });

  it("marks expired Code Mode approvals terminal when listing and reading run evidence", async () => {
    const harness = await createHarness();
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
      sessionId: "session-code",
    });
    const approval = harness.approvals.get("approval-1");
    if (!approval) {
      throw new Error("missing approval-1");
    }
    harness.approvals.set("approval-1", {
      ...approval,
      status: "pending",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const pending = harness.storage.pendingApprovalActions.find("approval-1");
    if (pending) {
      pending.expiresAt = "2020-01-01T00:00:00.000Z";
    }

    expect(harness.service.listCodeModeRuns({ sessionId: "session-code", limit: 5 })).toEqual([
      expect.objectContaining({
        runId: run.runId,
        status: "expired",
        error: "Code Mode approval expired before execution",
      }),
    ]);
    expect(harness.service.getCodeModeRun(run.runId)).toMatchObject({
      status: "expired",
      error: "Code Mode approval expired before execution",
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        runId: run.runId,
        reason: "Code Mode approval expired before execution",
      }),
    );
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          runId: run.runId,
          status: "expired",
          error: "Code Mode approval expired before execution",
        }),
      }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_failed",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        approvalId: "approval-1",
        status: "expired",
        error: "Code Mode approval expired before execution",
      }),
    );
  });

  it("fails approved Code Mode runs when the pending action row is missing", async () => {
    const harness = await createHarness();
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
      sessionId: "session-code",
    });
    vi.spyOn(harness.storage.pendingApprovalActions, "find").mockReturnValue(undefined);

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      policyReason: "code_mode_run:failed",
      result: {
        runId: run.runId,
        status: "failed",
        errorCode: "pending_action_missing",
      },
    });
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "failed",
      error: "Code Mode pending action is missing; approved run cannot execute safely.",
      errorCode: "pending_action_missing",
      errorDetails: expect.objectContaining({
        phase: "approval_resolution",
        reason: "pending_action_missing",
        approvalStatus: "approved",
      }),
    });
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          runId: run.runId,
          status: "failed",
          errorCode: "pending_action_missing",
        }),
      }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_failed",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        approvalId: "approval-1",
        status: "failed",
        errorCode: "pending_action_missing",
      }),
    );
  });

  it("rejects resolved Code Mode runs on read when the pending action row is missing", async () => {
    const harness = await createHarness();
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
      sessionId: "session-code",
    });
    const approval = harness.approvals.get("approval-1");
    if (!approval) {
      throw new Error("missing approval-1");
    }
    harness.approvals.set("approval-1", {
      ...approval,
      status: "rejected",
      resolvedAt: "2026-04-10T00:01:00.000Z",
      resolvedBy: "operator",
    });
    vi.spyOn(harness.storage.pendingApprovalActions, "find").mockReturnValue(undefined);

    expect(harness.service.getCodeModeRun(run.runId)).toMatchObject({
      status: "rejected",
      error: "Code Mode approval was rejected before the pending action could be recovered.",
      errorCode: "approval_rejected_pending_action_missing",
    });
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          runId: run.runId,
          status: "rejected",
          errorCode: "approval_rejected_pending_action_missing",
        }),
      }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_refused",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        approvalId: "approval-1",
        status: "rejected",
        errorCode: "approval_rejected_pending_action_missing",
      }),
    );
  });

  it("includes approved Code Mode runs that hydrate to failed in failed status listings", async () => {
    const harness = await createHarness();
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
      sessionId: "session-code",
    });
    const approval = harness.approvals.get("approval-1");
    if (!approval) {
      throw new Error("missing approval-1");
    }
    harness.approvals.set("approval-1", {
      ...approval,
      status: "approved",
      resolvedAt: "2026-04-10T00:01:00.000Z",
      resolvedBy: "operator",
    });
    vi.spyOn(harness.storage.pendingApprovalActions, "find").mockReturnValue(undefined);

    expect(
      harness.service.listCodeModeRuns({
        sessionId: "session-code",
        status: "failed",
        limit: 5,
      }),
    ).toEqual([
      expect.objectContaining({
        runId: run.runId,
        status: "failed",
        errorCode: "pending_action_missing",
      }),
    ]);
  });

  it("includes rejected Code Mode runs that hydrate to rejected in rejected status listings", async () => {
    const harness = await createHarness();
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
      sessionId: "session-code",
    });
    const approval = harness.approvals.get("approval-1");
    if (!approval) {
      throw new Error("missing approval-1");
    }
    harness.approvals.set("approval-1", {
      ...approval,
      status: "rejected",
      resolvedAt: "2026-04-10T00:01:00.000Z",
      resolvedBy: "operator",
    });
    vi.spyOn(harness.storage.pendingApprovalActions, "find").mockReturnValue(undefined);

    expect(
      harness.service.listCodeModeRuns({
        sessionId: "session-code",
        status: "rejected",
        limit: 5,
      }),
    ).toEqual([
      expect.objectContaining({
        runId: run.runId,
        status: "rejected",
        errorCode: "approval_rejected_pending_action_missing",
      }),
    ]);
  });

  it("rejects edited Code Mode runs on read when the pending action row is missing", async () => {
    const harness = await createHarness();
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
      sessionId: "session-code",
    });
    const approval = harness.approvals.get("approval-1");
    if (!approval) {
      throw new Error("missing approval-1");
    }
    harness.approvals.set("approval-1", {
      ...approval,
      status: "edited",
      resolvedAt: "2026-04-10T00:01:00.000Z",
      resolvedBy: "operator",
    });
    vi.spyOn(harness.storage.pendingApprovalActions, "find").mockReturnValue(undefined);

    expect(harness.service.getCodeModeRun(run.runId)).toMatchObject({
      status: "rejected",
      error: "Code Mode approval was edited, but Code Mode runs are immutable and cannot execute safely.",
      errorCode: "approval_edited_pending_action_missing",
    });
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          runId: run.runId,
          status: "rejected",
          errorCode: "approval_edited_pending_action_missing",
        }),
      }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_refused",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        approvalId: "approval-1",
        status: "rejected",
        errorCode: "approval_edited_pending_action_missing",
      }),
    );
  });

  it("hydrates expired Code Mode approvals before applying status filters", async () => {
    const harness = await createHarness();
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
      sessionId: "session-code",
    });
    const approval = harness.approvals.get("approval-1");
    if (!approval) {
      throw new Error("missing approval-1");
    }
    harness.approvals.set("approval-1", {
      ...approval,
      status: "pending",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const pending = harness.storage.pendingApprovalActions.find("approval-1");
    if (pending) {
      pending.expiresAt = "2020-01-01T00:00:00.000Z";
    }

    expect(
      harness.service.listCodeModeRuns({
        sessionId: "session-code",
        status: "approval_pending",
        limit: 5,
      }),
    ).toEqual([]);
    expect(
      harness.service.listCodeModeRuns({
        sessionId: "session-code",
        status: "expired",
        limit: 5,
      }),
    ).toEqual([
      expect.objectContaining({
        runId: run.runId,
        status: "expired",
        error: "Code Mode approval expired before execution",
      }),
    ]);
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledTimes(1);
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        runId: run.runId,
        reason: "Code Mode approval expired before execution",
      }),
    );
  });

  it("checks Code Mode run scope before hydrating read-side terminal state", async () => {
    const harness = await createHarness();
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      workspaceId: "workspace-2",
    });
    const approval = harness.approvals.get("approval-1");
    if (!approval) {
      throw new Error("missing approval-1");
    }
    harness.approvals.set("approval-1", {
      ...approval,
      status: "pending",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const pending = harness.storage.pendingApprovalActions.find("approval-1");
    if (pending) {
      pending.expiresAt = "2020-01-01T00:00:00.000Z";
    }

    expect(() => harness.service.getCodeModeRunInScope(run.runId, { workspaceId: "default" })).toThrow(
      /code mode run/i,
    );

    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "approval_pending",
      workspaceId: "workspace-2",
    });
    expect(harness.storage.pendingApprovalActions.markResolved).not.toHaveBeenCalled();
  });

  it("scans pending Code Mode approvals when status filters need read-time hydration", async () => {
    const harness = await createHarness();
    const statusHydrationSpy = vi.spyOn(harness.storage.codeModeRuns, "listFilteredForStatusHydration");
    for (let index = 0; index < 501; index += 1) {
      harness.storage.codeModeRuns.upsert({
        runId: `completed-run-${index}`,
        status: "completed",
        language: "typescript",
        saveCandidateOnSuccess: false,
        capabilitySnapshotId: "snapshot-completed",
        codeModeInputHash: `input-${index}`,
        wrapperManifestHash: `wrapper-${index}`,
        policySnapshotHash: `policy-${index}`,
        codeHash: `code-${index}`,
        codeArtifact: createArtifact(`completed-${index}-code.ts`),
        wrapperManifestArtifact: createArtifact(`completed-${index}-wrapper.json`),
        policySnapshotArtifact: createArtifact(`completed-${index}-policy.json`),
        result: { ok: true },
        createdAt: `2026-04-10T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        startedAt: "2026-04-10T00:01:00.000Z",
        finishedAt: "2026-04-10T00:02:00.000Z",
      });
    }
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
      sessionId: "session-code",
    });
    const approval = harness.approvals.get("approval-1");
    if (!approval) {
      throw new Error("missing approval-1");
    }
    harness.approvals.set("approval-1", {
      ...approval,
      status: "pending",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const pending = harness.storage.pendingApprovalActions.find("approval-1");
    if (pending) {
      pending.expiresAt = "2020-01-01T00:00:00.000Z";
    }

    expect(
      harness.service.listCodeModeRuns({
        sessionId: "session-code",
        status: "expired",
        limit: 5,
      }),
    ).toEqual([
      expect.objectContaining({
        runId: run.runId,
        status: "expired",
      }),
    ]);
    expect(statusHydrationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-code",
        status: "expired",
        limit: 5,
      }),
    );
  });

  it("publishes an explicit advisory event when Code Mode runs without available host isolation", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, mode: 'advisory' };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        sandbox: expect.objectContaining({
          available: false,
          required: false,
        }),
      }),
    });
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_sandbox_unavailable",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        sandbox: expect.objectContaining({
          available: false,
          required: false,
        }),
      }),
    );
  });

  it("persists structured Code Mode child errors", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "throw { code: 'BAD_INPUT', message: 'Invalid guest input', details: { field: 'path' } };",
      requestedOutputIntent: "Return a structured failure.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      error: "BAD_INPUT: Invalid guest input",
      errorCode: "BAD_INPUT",
      errorDetails: { field: "path" },
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      error: "BAD_INPUT: Invalid guest input",
      errorCode: "BAD_INPUT",
      errorDetails: { field: "path" },
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        outcome: "failed",
        runId: run.runId,
      }),
    );
  });

  it("normalizes Code Mode child stream errors with run and stream attribution", () => {
    const streamError = __internal.createCodeModeChildStreamError(
      "code-run-stream-error",
      "stdout",
      new Error("pipe broke"),
    );

    expect(__internal.normalizeCodeModeIpcError(streamError)).toEqual({
      code: "CODE_MODE_CHILD_STREAM_ERROR",
      message: "CODE_MODE_CHILD_STREAM_ERROR: Code Mode child stdout stream failed: pipe broke",
      details: {
        runId: "code-run-stream-error",
        stream: "stdout",
      },
    });
  });

  it("does not rewrite completed Code Mode runs when stale approval replay is attempted", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });
    harness.storage.codeModeRuns.upsert({
      ...harness.storage.codeModeRuns.get(run.runId),
      status: "completed",
      result: { ok: true },
      finishedAt: "2026-05-18T00:00:00.000Z",
    });

    await expect(harness.service.executeApprovedCodeModeRun("approval-1")).resolves.toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({ runId: run.runId, status: "completed" }),
    });

    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "completed",
      result: { ok: true },
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "executed",
      expect.objectContaining({
        runId: run.runId,
        recoveredTerminalOutcome: true,
      }),
    );
    expect(harness.publishRealtime).not.toHaveBeenCalledWith(
      "code_mode_run_refused",
      "capabilities",
      expect.anything(),
    );
  });

  it("fails oversized parent-to-child Code Mode requests immediately", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const oversizedSource = `const payload = "${"x".repeat(140_000)}"; return { length: payload.length };`;

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: oversizedSource,
      requestedOutputIntent: "Exercise parent IPC bounds.",
      saveCandidateOnSuccess: false,
    });

    const startedAt = Date.now();
    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const elapsedMs = Date.now() - startedAt;
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(elapsedMs).toBeLessThan(2_000);
    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      errorCode: "MESSAGE_TOO_LARGE",
      error: "MESSAGE_TOO_LARGE: Code Mode IPC message exceeded the maximum allowed size.",
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      errorCode: "MESSAGE_TOO_LARGE",
      error: "MESSAGE_TOO_LARGE: Code Mode IPC message exceeded the maximum allowed size.",
      errorDetails: expect.objectContaining({
        direction: "parent_to_child",
        method: "run.execute",
      }),
    });
  });

  it("records oversized child-to-parent Code Mode results as structured IPC failures", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: `return { payload: "x".repeat(150_000) };`,
      requestedOutputIntent: "Exercise child IPC bounds.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      errorCode: "MESSAGE_TOO_LARGE",
      error: "MESSAGE_TOO_LARGE: Code Mode IPC message exceeded the maximum allowed size.",
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      errorCode: "MESSAGE_TOO_LARGE",
      error: "MESSAGE_TOO_LARGE: Code Mode IPC message exceeded the maximum allowed size.",
      errorDetails: expect.objectContaining({
        direction: "child_to_parent",
      }),
    });
  });

  it("fails Code Mode runs that return before awaiting wrapper calls", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "capabilities.tool.safe_read(); return { ok: true };",
      requestedOutputIntent: "Exercise unawaited wrapper calls.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      errorCode: "UNAWAITED_WRAPPER_CALL",
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      errorCode: "UNAWAITED_WRAPPER_CALL",
      errorDetails: expect.objectContaining({
        pendingWrapperCallCount: expect.any(Number),
      }),
      executionRecovery: {
        phase: "terminal",
        disposition: "terminal",
      },
    });
    expect(harness.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("bounds timed-out Code Mode runs even when a wrapper ignores cancellation", async () => {
    const invokeTool = vi.fn(async () => new Promise<ToolInvokeResult>(() => undefined));
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      invokeTool,
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return await capabilities.tool.safe_read();",
      requestedOutputIntent: "Exercise timeout around a stuck wrapper.",
      saveCandidateOnSuccess: false,
    });

    const startedAt = Date.now();
    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
    });
    expect(String(result?.result?.error)).toMatch(
      /Code Mode wrapper deadline exceeded|RUN_CANCELLED: Code Mode run exceeded/,
    );
    expect(storedRun).toMatchObject({
      status: "failed",
    });
    const wrapperSignal = invokeTool.mock.calls[0]?.[0].signal;
    expect(wrapperSignal?.aborted).toBe(true);
  }, 25_000);

  it("scopes wrapper invocations to the run's workspace and run identity", async () => {
    const invokeTool = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "executed",
        auditEventId: "audit-1",
        result: { ok: true },
      }),
    );
    const harness = await createHarness({
      sandboxConfig: { required: false, bestEffortHostEnabled: false },
      invokeTool,
    });
    harness.storage.chatSessionMeta.patch("session-scope", { workspaceId: "workspace-scope" });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return await capabilities.tool.safe_read();",
      requestedOutputIntent: "Exercise a scoped wrapper call.",
      saveCandidateOnSuccess: false,
      sessionId: "session-scope",
    });

    await harness.service.executeApprovedCodeModeRun("approval-1");

    // A sandboxed run can only reach the parent tool boundary bound to its own
    // run identity and workspace; it cannot invoke wrappers under another scope.
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "tool.safe_read",
      workspaceId: "workspace-scope",
      runId: run.runId,
      taskId: run.runId,
      agentId: `code-mode:${run.runId}`,
    });
  });

  it("ignores child-supplied scope fields and binds wrappers to the stored run identity", async () => {
    const invokeTool = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "executed",
        auditEventId: "audit-1",
        result: { ok: true },
      }),
    );
    const harness = await createHarness({
      sandboxConfig: { required: false, bestEffortHostEnabled: false },
      invokeTool,
    });
    harness.storage.chatSessionMeta.patch("session-scope", { workspaceId: "workspace-scope" });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      // The wrapper args payload is the only channel a sandboxed guest controls.
      // Smuggle scope-looking keys through it to mimic a compromised/escaped child
      // trying to invoke a wrapper under a forged workspace and run identity.
      source:
        'return await capabilities.tool.safe_read({ workspaceId: "forged-workspace", runId: "forged-run", taskId: "forged-task", agentId: "forged-agent", sessionId: "forged-session" });',
      requestedOutputIntent: "Attempt to forge wrapper scope.",
      saveCandidateOnSuccess: false,
      sessionId: "session-scope",
    });

    await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const invocation = invokeTool.mock.calls[0]?.[0];
    // The parent binds the invocation to the stored run/workspace identity and never
    // honors caller-supplied scope values; the forged keys stay quarantined inside args.
    expect(invocation).toMatchObject({
      toolName: "tool.safe_read",
      workspaceId: "workspace-scope",
      runId: run.runId,
      taskId: run.runId,
      agentId: `code-mode:${run.runId}`,
      args: {
        workspaceId: "forged-workspace",
        runId: "forged-run",
        taskId: "forged-task",
        agentId: "forged-agent",
        sessionId: "forged-session",
      },
    });
    expect(invocation?.workspaceId).not.toBe("forged-workspace");
    expect(invocation?.runId).not.toBe("forged-run");
    expect(invocation?.taskId).not.toBe("forged-task");
    expect(invocation?.agentId).not.toBe("forged-agent");
    expect(invocation?.sessionId).not.toBe("forged-session");
  });

  it("does not pass provider or gateway secrets into Code Mode child environments", () => {
    const priorOpenAi = process.env.OPENAI_API_KEY;
    const priorGatewayToken = process.env.GOATCITADEL_AUTH_TOKEN;
    try {
      process.env.OPENAI_API_KEY = "sk-code-mode-secret";
      process.env.GOATCITADEL_AUTH_TOKEN = "gateway-token-secret";
      const env = __internal.createMinimalSyntheticEnv();

      expect(env.GOATCITADEL_CODE_MODE).toBe("1");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GOATCITADEL_AUTH_TOKEN).toBeUndefined();
    } finally {
      if (priorOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = priorOpenAi;
      }
      if (priorGatewayToken === undefined) {
        delete process.env.GOATCITADEL_AUTH_TOKEN;
      } else {
        process.env.GOATCITADEL_AUTH_TOKEN = priorGatewayToken;
      }
    }
  });

  it("fails closed before child execution when required host isolation is unavailable", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: true,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, shouldNotExecute: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        error: expect.stringContaining("Code Mode sandbox failed closed"),
        sandbox: expect.objectContaining({
          available: false,
          required: true,
        }),
      }),
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Code Mode sandbox failed closed"),
    });
    expect(harness.invokeTool).not.toHaveBeenCalled();
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_sandbox_unavailable",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        sandbox: expect.objectContaining({
          available: false,
          required: true,
        }),
      }),
    );
  });

  it("persists current sandbox metadata when launch-time isolation drifts unavailable", async () => {
    const availableSandbox = {
      runnerId: "goatcitadel.best-effort-host",
      runnerVersion: "0.2.0",
      platform: "linux",
      isolationProfile: "best_effort_host/temp_only/no_network",
      required: true,
      available: true,
      checksPassed: ["linux_firejail_present"],
      checksFailed: [],
    } satisfies CodeModeSandboxMetadata;
    const unavailableSandbox = {
      ...availableSandbox,
      available: false,
      checksPassed: ["mode_best_effort_host"],
      checksFailed: ["linux_firejail_missing"],
      failClosedReason: "Code Mode sandbox failed closed: linux_firejail_missing.",
    } satisfies CodeModeSandboxMetadata;
    const sandboxSequence = [availableSandbox, unavailableSandbox];
    const harness = await createHarness({
      sandboxConfig: {
        required: true,
        bestEffortHostEnabled: true,
      },
      resolveSandboxMetadata: () => sandboxSequence.shift() ?? unavailableSandbox,
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, shouldNotExecute: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });

    expect(run.sandbox).toMatchObject({ available: true, required: true });
    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      sandbox: expect.objectContaining({
        available: false,
        checksFailed: expect.arrayContaining(["linux_firejail_missing"]),
      }),
    });
    expect(storedRun.sandbox).toMatchObject({
      available: false,
      checksFailed: expect.arrayContaining(["linux_firejail_missing"]),
    });
    expect(harness.publishRealtime).not.toHaveBeenCalledWith(
      "code_mode_run_started",
      "capabilities",
      expect.objectContaining({ runId: run.runId }),
    );
    expect(harness.invokeTool).not.toHaveBeenCalled();
  });

  it("fails explicitly when the approved sandbox posture changes before execution", async () => {
    const approvedSandbox = {
      runnerId: "goatcitadel.best-effort-host",
      runnerVersion: "0.2.0",
      platform: "linux",
      isolationProfile: "best_effort_host/temp_only/no_network",
      required: false,
      available: true,
      checksPassed: ["linux_firejail_present"],
      checksFailed: [],
    } satisfies CodeModeSandboxMetadata;
    const driftedSandbox = {
      ...approvedSandbox,
      isolationProfile: "best_effort_host/temp_only/network_allowed",
    } satisfies CodeModeSandboxMetadata;
    const sandboxSequence = [approvedSandbox, driftedSandbox];
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: true,
      },
      resolveSandboxMetadata: () => sandboxSequence.shift() ?? driftedSandbox,
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { shouldNotExecute: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      errorCode: "STATE_CONFLICT",
      error: expect.stringContaining("approved sandbox posture changed"),
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        errorCode: "STATE_CONFLICT",
      }),
    );
    expect(harness.invokeTool).not.toHaveBeenCalled();
  });

  it("fails explicitly when approved sandbox availability downgrades before execution", async () => {
    const approvedSandbox = {
      runnerId: "goatcitadel.best-effort-host",
      runnerVersion: "0.2.0",
      platform: "linux",
      isolationProfile: "best_effort_host/temp_only/no_network",
      required: false,
      available: true,
      checksPassed: ["mode_best_effort_host", "best_effort_host_enabled", "linux_firejail_present"],
      checksFailed: [],
    } satisfies CodeModeSandboxMetadata;
    const driftedSandbox = {
      ...approvedSandbox,
      available: false,
      checksPassed: ["mode_best_effort_host", "best_effort_host_enabled"],
      checksFailed: ["linux_firejail_missing"],
      advisoryUnsandboxedReason:
        "Host isolation unavailable on linux; running advisory trusted-code mode: linux_firejail_missing.",
    } satisfies CodeModeSandboxMetadata;
    const sandboxSequence = [approvedSandbox, driftedSandbox];
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: true,
      },
      resolveSandboxMetadata: () => sandboxSequence.shift() ?? driftedSandbox,
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { shouldNotExecute: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      errorCode: "STATE_CONFLICT",
      error: expect.stringContaining("approved sandbox posture changed at available"),
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        errorCode: "STATE_CONFLICT",
      }),
    );
    expect(harness.invokeTool).not.toHaveBeenCalled();
  });

  it("records unavailable sandbox metadata and releases the claim when launch preparation fails", async () => {
    const availableSandbox = {
      runnerId: "goatcitadel.best-effort-host",
      runnerVersion: "0.1.0",
      platform: "win32",
      isolationProfile: "best_effort_host/temp_only/no_network",
      required: true,
      available: true,
      checksPassed: ["probe_available"],
      checksFailed: [],
    } satisfies CodeModeSandboxMetadata;
    const harness = await createHarness({
      resolveSandboxMetadata: () => availableSandbox,
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
    });
    const blockingPath = path.join(harness.rootDir, "data/code-mode-temp", run.runId);
    await fs.mkdir(path.dirname(blockingPath), { recursive: true });
    await fs.writeFile(blockingPath, "not a directory", "utf8");

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result).toBeUndefined();
    expect(storedRun).toMatchObject({
      status: "approval_pending",
      sandbox: {
        available: false,
        required: true,
        checksFailed: expect.arrayContaining(["launch_preparation_failed"]),
      },
      executionRecovery: expect.objectContaining({
        phase: "not_started",
        disposition: "retryable",
      }),
    });
    expect(storedRun.sandbox?.failClosedReason).toContain("launch preparation failed");
    expect(storedRun.startedAt).toBeUndefined();
    expect(harness.publishRealtime).not.toHaveBeenCalledWith(
      "code_mode_execution_boundary_crossed",
      "capabilities",
      expect.anything(),
    );
  });

  it("refuses Code Mode execution when the durable approval is not approved", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });
    vi.mocked(harness.storage.approvals.get).mockImplementation((approvalId: string) => ({
      approvalId,
      kind: "code_mode.run",
      riskLevel: "caution",
      status: "pending",
      payload: {},
      preview: {},
      linkage: {},
      createdAt: "2026-04-10T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      explanationStatus: "not_requested",
    }));

    await expect(harness.service.executeApprovedCodeModeRun("approval-1")).rejects.toThrow(
      "approval status is pending",
    );
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({ reason: "approval status is pending" }),
    );
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          runId: run.runId,
          status: "failed",
          error: "approval status is pending",
        }),
      }),
    );
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "failed",
      error: "approval status is pending",
    });
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_failed",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        status: "failed",
        error: "approval status is pending",
      }),
    );
  });

  it("expires a Code Mode pending action that was not resolved before its TTL", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });
    const pending = harness.storage.pendingApprovalActions.find("approval-1");
    expect(pending).toBeDefined();
    if (pending) {
      pending.expiresAt = "2020-01-01T00:00:00.000Z";
    }

    await expect(harness.service.executeApprovedCodeModeRun("approval-1")).rejects.toThrow(
      "pending action expired before approval execution",
    );
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({ reason: "Code Mode pending action expired before approval execution" }),
    );
    expect(harness.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          runId: run.runId,
          status: "expired",
        }),
      }),
    );
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "expired",
      error: "Code Mode pending action expired before approval execution",
    });
  });

  it("freezes Code Mode wrapper policy context at run approval time", async () => {
    const resolvePolicyContext = vi.fn(
      (): ToolPolicyActorContext => ({
        operatorId: "operator-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "creation-run-placeholder",
        surface: "code",
        permissionProfileId: "profile-safe",
        permissionProfile: {
          profileId: "profile-safe",
          label: "Safe",
          builtin: true,
          status: "active",
          scope: "global",
          approvalMode: "approve_all",
          legacyToolProfile: "danger",
          toolPatterns: ["tool.safe_read"],
          allow: [],
          deny: ["tool.denied"],
          createdBy: "system",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        },
        localOperatorOverrideId: "override-at-create",
        localOperatorOverride: {
          overrideId: "override-at-create",
          operatorId: "operator-1",
          scope: "run",
          scopeRef: "creation-run-placeholder",
          reason: "test override",
          status: "active",
          createdBy: "operator-1",
          createdAt: "2026-04-10T00:00:00.000Z",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      }),
    );
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      resolvePolicyContext,
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source:
        "const result = await capabilities.tool.safe_read({ path: 'README.md' }); return { result, marker: input.marker };",
      originSurface: "code",
      operatorId: "operator-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      permissionProfileId: "profile-safe",
      localOperatorOverrideId: "override-at-create",
      input: { marker: "approved" },
      requestedOutputIntent: "Read a safe file.",
      saveCandidateOnSuccess: false,
    });
    expect(resolvePolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "operator-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        surface: "code",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-at-create",
      }),
    );
    expect(harness.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          runId: run.runId,
          workspaceId: "workspace-1",
          sessionId: "session-1",
          originSurface: "code",
          permissionProfileId: "profile-safe",
          localOperatorOverrideId: "override-at-create",
        }),
        linkage: expect.objectContaining({
          workspaceId: "workspace-1",
          runId: run.runId,
          sessionId: "session-1",
          originSurface: "code",
          toolName: "code_mode.run",
          actionType: "code_mode.run",
          permissionProfileId: "profile-safe",
          localOperatorOverrideId: "override-at-create",
        }),
      }),
    );
    const pending = harness.storage.pendingApprovalActions.find("approval-1");
    if (pending) {
      pending.request.input = { marker: "tampered" };
      pending.request.policyContext = {
        permissionProfileId: "profile-tampered",
        permissionProfile: {
          profileId: "profile-tampered",
          label: "Tampered",
          builtin: false,
          status: "active",
          scope: "global",
          approvalMode: "bypass",
          toolPatterns: ["*"],
          allow: ["*"],
          deny: [],
          createdBy: "test",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        },
      };
    }

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "completed",
    });
    expect(harness.storage.codeModeRuns.get(run.runId).result).toMatchObject({
      marker: "approved",
    });
    expect(resolvePolicyContext).toHaveBeenCalledTimes(2);
    expect(harness.invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "tool.safe_read",
        policyContext: expect.objectContaining({
          approvedCodeModeRunId: run.runId,
          permissionProfileId: "profile-safe",
          localOperatorOverrideId: "override-at-create",
          localOperatorOverride: expect.objectContaining({
            overrideId: "override-at-create",
            status: "active",
          }),
          permissionProfile: expect.objectContaining({
            approvalMode: "approve_all",
            toolPatterns: ["tool.safe_read"],
            deny: ["tool.denied"],
          }),
        }),
      }),
    );
  });

  it("uses the session workspace as canonical for Code Mode policy resolution", async () => {
    const resolvePolicyContext = vi.fn(
      (input: { workspaceId?: string; sessionId?: string; runId?: string }): ToolPolicyActorContext => ({
        ...input,
        permissionProfileId: `profile-${input.workspaceId}`,
        permissionProfile: createPermissionProfileRecord(`profile-${input.workspaceId}`),
      }),
    );
    const harness = await createHarness({ resolvePolicyContext });
    harness.storage.chatSessionMeta.patch("session-a", { workspaceId: "workspace-a" });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      sessionId: "session-a",
      workspaceId: "workspace-a",
      requestedOutputIntent: "Exercise workspace scoping.",
    });

    expect(run.workspaceId).toBe("workspace-a");
    expect(run.permissionProfileId).toBe("profile-workspace-a");
    expect(resolvePolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        workspaceId: "workspace-a",
        runId: run.runId,
      }),
    );

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        sessionId: "session-a",
        workspaceId: "workspace-b",
        requestedOutputIntent: "Try to borrow another workspace policy.",
      }),
    ).rejects.toThrow("does not match session session-a workspace workspace-a");
  });

  it("fails closed when a stored Code Mode policy snapshot only retains profile ids", async () => {
    const frozenProfile: PermissionProfileRecord = {
      profileId: "profile-safe",
      label: "Safe",
      builtin: true,
      status: "active",
      scope: "global",
      approvalMode: "approve_all",
      legacyToolProfile: "danger",
      toolPatterns: ["tool.safe_read"],
      allow: [],
      deny: [],
      createdBy: "system",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
    };
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      resolvePolicyContext: vi.fn(
        (): ToolPolicyActorContext => ({
          operatorId: "operator-1",
          workspaceId: "workspace-1",
          surface: "code",
          permissionProfileId: "profile-safe",
          permissionProfile: frozenProfile,
        }),
      ),
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "const result = await capabilities.tool.safe_read({ path: 'README.md' }); return { result };",
      originSurface: "code",
      operatorId: "operator-1",
      workspaceId: "workspace-1",
      permissionProfileId: "profile-safe",
    });
    const policyPath = path.resolve(harness.rootDir, run.policySnapshotArtifact.relPath);
    const tamperedPolicy = JSON.parse(await fs.readFile(policyPath, "utf8")) as Record<string, unknown>;
    if (
      typeof tamperedPolicy.codeModePermissionContext === "object" &&
      tamperedPolicy.codeModePermissionContext !== null
    ) {
      delete (tamperedPolicy.codeModePermissionContext as Record<string, unknown>).permissionProfile;
    }
    const tamperedContent = JSON.stringify(tamperedPolicy, null, 2);
    await fs.writeFile(policyPath, tamperedContent, "utf8");
    harness.storage.codeModeRuns.upsert({
      ...run,
      policySnapshotHash: sha256Text(JSON.stringify(tamperedPolicy)),
      policySnapshotArtifact: {
        ...run.policySnapshotArtifact,
        sha256: sha256Text(tamperedContent),
        bytes: Buffer.byteLength(tamperedContent, "utf8"),
      },
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      error: "STATE_CONFLICT: Code Mode permission profile snapshot is missing profile profile-safe.",
    });
    expect(harness.invokeTool).not.toHaveBeenCalled();
  });

  it("fails closed when a Code Mode Local Operator Override is revoked before execution", async () => {
    let overrideActive = true;
    const resolvePolicyContext = vi.fn(
      (): ToolPolicyActorContext => ({
        operatorId: "operator-1",
        workspaceId: "workspace-1",
        surface: "code",
        localOperatorOverrideId: overrideActive ? "override-at-create" : undefined,
        localOperatorOverride: overrideActive
          ? {
              overrideId: "override-at-create",
              operatorId: "operator-1",
              scope: "run",
              scopeRef: "code-run-placeholder",
              reason: "test revoked override",
              status: "active",
              createdBy: "operator-1",
              createdAt: "2026-04-10T00:00:00.000Z",
              expiresAt: "2999-01-01T00:00:00.000Z",
            }
          : undefined,
      }),
    );
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      resolvePolicyContext,
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      operatorId: "operator-1",
      workspaceId: "workspace-1",
      localOperatorOverrideId: "override-at-create",
    });
    overrideActive = false;

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      error: "STATE_CONFLICT: Code Mode local operator override override-at-create is no longer active for this run.",
    });
    expect(resolvePolicyContext).toHaveBeenCalledTimes(2);
    expect(harness.invokeTool).not.toHaveBeenCalled();
  });

  it("fails Code Mode run creation closed when an explicit override cannot resolve", async () => {
    const resolvePolicyContext = vi.fn(() => {
      throw new Error("override override-stale is expired or outside this run");
    });
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      resolvePolicyContext,
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
        operatorId: "operator-1",
        workspaceId: "workspace-1",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-stale",
      }),
    ).rejects.toThrow("override override-stale is expired or outside this run");
    expect(resolvePolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "operator-1",
        workspaceId: "workspace-1",
        surface: "code",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-stale",
      }),
    );
    expect(harness.storage.codeModeRuns.list()).toEqual([]);
  });

  it("does not silently drop an explicit Code Mode override when policy resolution omits it", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      resolvePolicyContext: vi.fn(
        (): ToolPolicyActorContext => ({
          operatorId: "operator-1",
          workspaceId: "workspace-1",
          surface: "code",
          permissionProfileId: "profile-safe",
        }),
      ),
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
        operatorId: "operator-1",
        workspaceId: "workspace-1",
        localOperatorOverrideId: "override-1",
      }),
    ).rejects.toThrow("Local Operator Override override-1 is not active for this Code Mode run");
    expect(harness.storage.codeModeRuns.list()).toEqual([]);
  });

  it("does not silently swap an explicit Code Mode permission profile during policy resolution", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      resolvePolicyContext: vi.fn(
        (): ToolPolicyActorContext => ({
          operatorId: "operator-1",
          workspaceId: "workspace-1",
          surface: "code",
          permissionProfileId: "profile-other",
        }),
      ),
    });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
        operatorId: "operator-1",
        workspaceId: "workspace-1",
        permissionProfileId: "profile-safe",
      }),
    ).rejects.toThrow("Permission profile profile-safe is not active for this Code Mode run");
    expect(harness.storage.codeModeRuns.list()).toEqual([]);
  });

  it("fails closed when the stored Code Mode run profile diverges from the frozen policy context", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
      resolvePolicyContext: vi.fn(
        (): ToolPolicyActorContext => ({
          operatorId: "operator-1",
          workspaceId: "workspace-1",
          surface: "code",
          permissionProfileId: "profile-safe",
        }),
      ),
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      operatorId: "operator-1",
      workspaceId: "workspace-1",
      permissionProfileId: "profile-safe",
    });
    harness.storage.codeModeRuns.upsert({
      ...harness.storage.codeModeRuns.get(run.runId),
      permissionProfileId: "profile-other",
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
      error: "STATE_CONFLICT: Code Mode permission profile mismatch; expected profile-other.",
      errorCode: "STATE_CONFLICT",
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        error: "STATE_CONFLICT: Code Mode permission profile mismatch; expected profile-other.",
        errorCode: "STATE_CONFLICT",
      }),
    );
  });

  it("keeps Code Mode origin surface in the run ledger without approval-linkage hydration", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
      workspaceId: "workspace-code",
      sessionId: "session-code",
    });
    harness.storage.codeModeRuns.upsert({ ...run, approvalId: undefined });

    expect(harness.service.getCodeModeRun(run.runId)).toMatchObject({
      runId: run.runId,
      originSurface: "code",
      approvalId: undefined,
    });
    expect(harness.service.listCodeModeRuns({ sessionId: "session-code", limit: 5 })).toEqual([
      expect.objectContaining({
        runId: run.runId,
        originSurface: "code",
        approvalId: undefined,
      }),
    ]);
  });

  it("fails before child execution when persisted Code Mode artifacts no longer match their hashes", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });
    await fs.writeFile(path.resolve(harness.rootDir, run.codeArtifact.relPath), "return { ok: false };", "utf8");

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        error: expect.stringContaining("Code Mode source artifact hash mismatch"),
      }),
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Code Mode source artifact hash mismatch"),
    });
    expect(harness.invokeTool).not.toHaveBeenCalled();
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        runId: run.runId,
        error: expect.stringContaining("Code Mode source artifact hash mismatch"),
      }),
    );
  });

  it.each([
    {
      label: "wrapper manifest",
      artifact: (run: CodeModeRunRecord) => run.wrapperManifestArtifact,
      tamperedContent: '{"wrappers":[]}\n',
      expectedError: "Code Mode wrapper manifest artifact hash mismatch",
    },
    {
      label: "policy snapshot",
      artifact: (run: CodeModeRunRecord) => run.policySnapshotArtifact,
      tamperedContent: '{"toolPolicy":{"tampered":true}}\n',
      expectedError: "Code Mode policy snapshot artifact hash mismatch",
    },
  ])(
    "fails before child execution when persisted Code Mode $label artifact no longer matches its hash",
    async (caseItem) => {
      const harness = await createHarness({
        sandboxConfig: {
          required: false,
          bestEffortHostEnabled: false,
        },
      });

      const run = await harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
        requestedOutputIntent: "Return a JSON object.",
        saveCandidateOnSuccess: false,
      });
      await fs.writeFile(
        path.resolve(harness.rootDir, caseItem.artifact(run).relPath),
        caseItem.tamperedContent,
        "utf8",
      );

      const result = await harness.service.executeApprovedCodeModeRun("approval-1");
      const storedRun = harness.storage.codeModeRuns.get(run.runId);

      expect(result).toMatchObject({
        outcome: "executed",
        result: expect.objectContaining({
          runId: run.runId,
          status: "failed",
          error: expect.stringContaining(caseItem.expectedError),
        }),
      });
      expect(storedRun).toMatchObject({
        status: "failed",
        error: expect.stringContaining(caseItem.expectedError),
      });
      expect(harness.invokeTool).not.toHaveBeenCalled();
    },
  );

  it("fails before child execution when the frozen Code Mode input hash no longer matches", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      input: { marker: "approved" },
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });
    const policyPath = path.resolve(harness.rootDir, run.policySnapshotArtifact.relPath);
    const tamperedPolicy = JSON.parse(await fs.readFile(policyPath, "utf8")) as Record<string, unknown>;
    tamperedPolicy.codeModeInput = { marker: "tampered" };
    const tamperedContent = JSON.stringify(tamperedPolicy, null, 2);
    await fs.writeFile(policyPath, tamperedContent, "utf8");
    harness.storage.codeModeRuns.upsert({
      ...run,
      policySnapshotHash: sha256Text(JSON.stringify(tamperedPolicy)),
      policySnapshotArtifact: {
        ...run.policySnapshotArtifact,
        sha256: sha256Text(tamperedContent),
        bytes: Buffer.byteLength(tamperedContent, "utf8"),
      },
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        error: expect.stringContaining("Code Mode input snapshot hash mismatch"),
      }),
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Code Mode input snapshot hash mismatch"),
    });
    expect(harness.invokeTool).not.toHaveBeenCalled();
  });

  it("fails before child execution when the stored Code Mode input hash no longer matches", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      input: { marker: "approved" },
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });
    harness.storage.codeModeRuns.upsert({
      ...run,
      codeModeInputHash: sha256Text(JSON.stringify({ marker: "tampered" })),
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        error: expect.stringContaining("Code Mode stored input hash mismatch"),
      }),
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Code Mode stored input hash mismatch"),
    });
    expect(harness.invokeTool).not.toHaveBeenCalled();
  });

  it("stages a candidate bundle after approval and execution when candidate save is enabled", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, bundle: 'candidate' };",
      requestedOutputIntent: "Generate a reusable helper skill.",
      saveCandidateOnSuccess: true,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    const candidates = harness.storage.candidateSkillVersions.list(10);
    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "completed",
      }),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceKind: "code_mode_generated",
      lineageStatus: "governed",
      workspaceId: "default",
      sourceFingerprint: run.codeHash,
      createdByActorId: "system:code-mode",
      originatingRunId: run.runId,
      lifecycleState: "candidate",
    });
    const candidateDetail = harness.service.getCandidateDetail(candidates[0]!.candidateId);
    expect(candidateDetail.revision).toBe(1);
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "candidate_skill_staged",
      "capabilities",
      expect.objectContaining({
        originatingRunId: run.runId,
        revision: 1,
      }),
    );
  });

  it("rolls back the first candidate aggregate revision when Code Mode candidate insertion fails", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    vi.spyOn(harness.storage.candidateSkillVersions, "upsert").mockImplementationOnce(() => {
      throw new Error("candidate insert failed");
    });
    const input = {
      capabilityProposal: { candidateId: "candidate-revision-rollback" },
    };

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, bundle: 'rollback' };",
      requestedOutputIntent: "Generate a rollback probe skill.",
      saveCandidateOnSuccess: true,
      input,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        errorCode: "candidate_stage_failed",
        error: "candidate insert failed",
      }),
    });
    expect(harness.storage.candidateSkillVersions.list(10)).toEqual([]);
    expect(
      harness.storage.skillAggregateRevisions.get("candidate_skill", "candidate-revision-rollback"),
    ).toBeUndefined();
    expect(
      harness.service
        .listCatalog("inspectable")
        .some((entry) => entry.kind === "candidate_skill" && entry.candidateId === "candidate-revision-rollback"),
    ).toBe(false);
    expect(
      harness.service
        .listCatalog("callable")
        .some((entry) => entry.kind === "candidate_skill" && entry.candidateId === "candidate-revision-rollback"),
    ).toBe(false);

    const failedRun = harness.storage.codeModeRuns.get(run.runId);
    const source = await fs.readFile(path.resolve(harness.rootDir, failedRun.codeArtifact.relPath), "utf8");
    const wrapperManifest = JSON.parse(
      await fs.readFile(path.resolve(harness.rootDir, failedRun.wrapperManifestArtifact.relPath), "utf8"),
    ) as Record<string, unknown>;
    const stageCandidateBundle = Reflect.get(harness.service, "stageCandidateBundle") as (
      runRecord: CodeModeRunRecord,
      sourceText: string,
      wrapper: Record<string, unknown>,
      sampleInput: Record<string, unknown>,
    ) => Promise<void>;
    const versionId = `version-${sha256Text(`code-mode-candidate\u0000${run.runId}`).slice(0, 32)}`;
    const instructionPath = path.resolve(
      harness.rootDir,
      "data",
      "capability-candidates",
      "candidate-revision-rollback",
      versionId,
      "SKILL.md",
    );
    const orphanInstruction = await fs.readFile(instructionPath, "utf8");
    await fs.writeFile(instructionPath, `${orphanInstruction}\nTampered orphan bytes.`, "utf8");

    await expect(stageCandidateBundle.call(harness.service, failedRun, source, wrapperManifest, input)).rejects.toThrow(
      "does not match the deterministic candidate bytes",
    );
    expect(harness.storage.candidateSkillVersions.list(10)).toEqual([]);
    expect(
      harness.storage.skillAggregateRevisions.get("candidate_skill", "candidate-revision-rollback"),
    ).toBeUndefined();

    await fs.writeFile(instructionPath, orphanInstruction, "utf8");
    await stageCandidateBundle.call(harness.service, failedRun, source, wrapperManifest, input);
    expect(harness.storage.candidateSkillVersions.list(10)).toHaveLength(1);
    expect(harness.service.getCandidateDetail("candidate-revision-rollback").revision).toBe(1);
  });

  it("treats an exact Code Mode candidate stage replay as an immutable no-op", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const input = {
      capabilityProposal: { candidateId: "candidate-exact-replay" },
    };
    const run = await harness.service.createCodeModeRun({
      language: "javascript",
      source: "return { ok: true, bundle: 'replay' };",
      requestedOutputIntent: "Generate an exact replay probe skill.",
      saveCandidateOnSuccess: true,
      input,
    });
    await harness.service.executeApprovedCodeModeRun("approval-1");
    const completedRun = harness.storage.codeModeRuns.get(run.runId);
    const source = await fs.readFile(path.resolve(harness.rootDir, completedRun.codeArtifact.relPath), "utf8");
    const wrapperManifest = JSON.parse(
      await fs.readFile(path.resolve(harness.rootDir, completedRun.wrapperManifestArtifact.relPath), "utf8"),
    ) as Record<string, unknown>;
    const stageCandidateBundle = Reflect.get(harness.service, "stageCandidateBundle") as (
      runRecord: CodeModeRunRecord,
      sourceText: string,
      wrapper: Record<string, unknown>,
      sampleInput: Record<string, unknown>,
    ) => Promise<void>;
    const stagedEventsBeforeReplay = harness.publishRealtime.mock.calls.filter(
      ([eventType]) => eventType === "candidate_skill_staged",
    ).length;

    await stageCandidateBundle.call(harness.service, completedRun, source, wrapperManifest, input);

    expect(harness.storage.candidateSkillVersions.list(10)).toHaveLength(1);
    expect(harness.service.getCandidateDetail("candidate-exact-replay").revision).toBe(1);
    expect(
      harness.publishRealtime.mock.calls.filter(([eventType]) => eventType === "candidate_skill_staged"),
    ).toHaveLength(stagedEventsBeforeReplay);
  });

  it("advances an existing Code Mode candidate from revision one to two for a second version", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const candidateId = "candidate-code-mode-second-version";
    const firstRun = await harness.service.createCodeModeRun({
      language: "javascript",
      source: "return { ok: true, version: 1 };",
      requestedOutputIntent: "Generate the first candidate version.",
      saveCandidateOnSuccess: true,
      input: { capabilityProposal: { candidateId } },
    });
    await harness.service.executeApprovedCodeModeRun("approval-1");
    const secondRun = await harness.service.createCodeModeRun({
      language: "javascript",
      source: "return { ok: true, version: 2 };",
      requestedOutputIntent: "Generate the second candidate version.",
      saveCandidateOnSuccess: true,
      input: { capabilityProposal: { candidateId } },
    });
    await harness.service.executeApprovedCodeModeRun("approval-1");

    const detail = harness.service.getCandidateDetail(candidateId);
    expect(detail.revision).toBe(2);
    expect(detail.versions).toHaveLength(2);
    expect(new Set(detail.versions.map((version) => version.originatingRunId))).toEqual(
      new Set([firstRun.runId, secondRun.runId]),
    );
    expect(
      harness.publishRealtime.mock.calls
        .filter(([eventType]) => eventType === "candidate_skill_staged")
        .map(([, , payload]) => payload.revision),
    ).toEqual([1, 2]);
  });

  it("never stages a candidate after a successful child result is terminalized as interrupted", async () => {
    const controller = new AbortController();
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, bundle: 'must-not-stage' };",
      requestedOutputIntent: "Generate a reusable helper skill.",
      saveCandidateOnSuccess: true,
    });
    const approval = harness.approvals.get("approval-1");
    harness.approvals.set("approval-1", {
      ...approval!,
      status: "approved",
      resolvedAt: "2026-04-10T00:00:00.000Z",
    });
    const recordOutput = harness.storage.codeModeRuns.recordExecutionOutput.bind(harness.storage.codeModeRuns);
    vi.spyOn(harness.storage.codeModeRuns, "recordExecutionOutput").mockImplementationOnce((input) => {
      const recorded = recordOutput(input);
      controller.abort(new Error("worker lease ownership moved after successful child output"));
      return recorded;
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1", controller.signal);

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        errorCode: "execution_interrupted_after_boundary",
      }),
    });
    expect(harness.storage.codeModeRuns.get(run.runId).executionRecovery.disposition).toBe("manual_reconciliation");
    expect(harness.storage.candidateSkillVersions.list(10)).toEqual([]);
    expect(harness.publishRealtime).not.toHaveBeenCalledWith(
      "candidate_skill_staged",
      "capabilities",
      expect.anything(),
    );
  });

  it("links Code Mode candidate bundles to capability proposals and validates SKILL.md content", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });
    const skillMarkdown = [
      "---",
      'name: "lesson-worksheet-helper"',
      'description: "Creates reusable worksheet workflows from lesson notes."',
      "---",
      "",
      "# Lesson Worksheet Helper",
      "",
      "## When to use",
      "Use after approval for worksheet pack requests based on lesson notes.",
      "",
      "## Workflow",
      "- Gather the lesson notes.",
      "- Produce a concise worksheet plan.",
      "- Report validation and any missing inputs.",
    ].join("\n");
    harness.storage.chatTurnTraces.create({
      turnId: "turn-1",
      sessionId: "session-1",
      durable: { runId: "durable-1" },
    });

    const run = await harness.service.createCodeModeRun({
      language: "javascript",
      source: "return { candidateSkillMarkdown: input.candidateSkillMarkdown, ok: true };",
      requestedOutputIntent: "Turn lesson notes into worksheet pack workflows.",
      saveCandidateOnSuccess: true,
      sessionId: "session-1",
      turnId: "turn-1",
      input: {
        capabilityProposal: {
          proposalId: "proposal-1",
          candidateId: "candidate-lesson-worksheet",
          title: "Lesson Worksheet Helper",
          summary: "Create worksheet pack workflows from lesson notes.",
          sourceSessionId: "session-1",
          sourceTurnId: "turn-1",
        },
        candidateSkillMarkdown: skillMarkdown,
        requiredPermissions: [],
        validationExpectation: "The candidate SKILL.md must pass content validation.",
        rollbackPosture: "Rollback restores the previous approved skill version.",
      },
    });

    await harness.service.executeApprovedCodeModeRun("approval-1");

    const candidates = harness.storage.candidateSkillVersions.list(10);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      candidateId: "candidate-lesson-worksheet",
      title: "Lesson Worksheet Helper",
      lifecycleState: "candidate",
      lineageStatus: "governed",
      workspaceId: "default",
      sourceFingerprint: run.codeHash,
      createdByActorId: "system:code-mode",
      originatingRunId: run.runId,
    });
    const proof = JSON.parse(
      await fs.readFile(path.resolve(harness.rootDir, candidates[0]!.proofArtifact.relPath), "utf8"),
    );
    expect(proof).toMatchObject({
      proposalId: "proposal-1",
      candidateId: "candidate-lesson-worksheet",
      sourceSessionId: "session-1",
      sourceTurnId: "turn-1",
      lineageStatus: "governed",
      workspaceId: "default",
      sourceFingerprint: run.codeHash,
      createdByActorId: "system:code-mode",
      skillContentValidation: {
        valid: true,
        inferredSkillName: "lesson-worksheet-helper",
      },
    });
  });

  it("fails closed when Code Mode candidate SKILL.md validation fails", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "javascript",
      source: "return { candidateSkillMarkdown: '# Missing frontmatter\\n\\nThis should not stage.' };",
      requestedOutputIntent: "Generate an invalid reusable helper skill.",
      saveCandidateOnSuccess: true,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        errorCode: "candidate_stage_failed",
      }),
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      errorCode: "candidate_stage_failed",
      error: expect.stringContaining("Generated candidate skill failed validation"),
    });
    expect(harness.storage.candidateSkillVersions.list(10)).toEqual([]);
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "candidate_skill_stage_failed",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        error: expect.stringContaining("Generated candidate skill failed validation"),
      }),
    );
  });

  it("persists truncation markers when stdout/stderr exceed the capture budget", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: `
        for (let index = 0; index < 8000; index += 1) {
          console.log("x".repeat(16));
          console.error("y".repeat(16));
        }
        return { ok: true };
      `,
      requestedOutputIntent: "Exercise bounded output capture.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);
    const stdoutArtifactPath = path.resolve(harness.rootDir, storedRun.stdoutArtifact!.relPath);
    const stderrArtifactPath = path.resolve(harness.rootDir, storedRun.stderrArtifact!.relPath);
    const stdout = await fs.readFile(stdoutArtifactPath, "utf8");
    const stderr = await fs.readFile(stderrArtifactPath, "utf8");

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "completed",
      }),
    });
    expect(storedRun.stdoutTruncated).toBe(true);
    expect(storedRun.stderrTruncated).toBe(true);
    expect(stdout).toContain("...[truncated]");
    expect(stderr).toContain("...[truncated]");
    expect(storedRun.stdoutPreview).toContain("...[truncated]");
    expect(storedRun.stderrPreview).toContain("...[truncated]");
  });
});

// HX-402 P2: governed capability lifecycle — the recovered effect ladder,
// the one-transaction review-only proposal, and the branded fail-safe revoke.
describe("CapabilitySystemService governed lifecycle (HX-402 P2)", () => {
  async function seedCandidate(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
    harness.storage.candidateSkillVersions.upsert(
      await createCandidateVersion(harness.rootDir, {
        candidateId: "candidate-gov",
        versionId: "version-a",
        lifecycleState: "candidate",
        originatingRunId: undefined,
        updatedAt: "2026-04-10T00:01:00.000Z",
      }),
    );
    harness.storage.candidateSkillVersions.upsert(
      await createCandidateVersion(harness.rootDir, {
        candidateId: "candidate-gov",
        versionId: "version-b",
        lifecycleState: "candidate",
        originatingRunId: undefined,
        updatedAt: "2026-04-10T00:02:00.000Z",
      }),
    );
  }

  function countGoverned(harness: Awaited<ReturnType<typeof createHarness>>): number {
    const row = harness.storage.gatewaySql
      .prepare(`SELECT COUNT(*) AS count FROM governed_lifecycle_events WHERE domain = 'capability_state'`)
      .get() as { count: number };
    return Number(row.count);
  }

  it("denial and expiry are zero-delta; unknown and foreign approvals are terminal", async () => {
    const harness = await createHarness();
    await seedCandidate(harness);
    const detail = harness.service.getCandidateDetail("candidate-gov");
    const request = harness.service.promoteCandidate("candidate-gov", detail.revision, "version-b");
    if (!request.pendingApproval) throw new Error("expected pending approval");

    // Pending approvals never execute.
    expect(() =>
      harness.service.executeApprovedCapabilityLifecycleMutation({ approvalId: request.pendingApproval!.approvalId }),
    ).toThrow(/missing, foreign, malformed, or not approved/);

    harness.storage.approvals.resolve(request.pendingApproval.approvalId, {
      decision: "reject",
      resolvedBy: "operator-resolver",
    });
    expect(() =>
      harness.service.executeApprovedCapabilityLifecycleMutation({ approvalId: request.pendingApproval!.approvalId }),
    ).toThrow(/missing, foreign, malformed, or not approved/);
    // Zero delta: no lifecycle state changed, no governed claim was minted.
    expect(harness.service.getCandidateDetail("candidate-gov").revision).toBe(detail.revision);
    expect(countGoverned(harness)).toBe(0);
    expect(() =>
      harness.service.executeApprovedCapabilityLifecycleMutation({ approvalId: "capability-missing" }),
    ).toThrow(/missing, foreign, malformed, or not approved/);
  });

  it("replays the original approval identity for byte-exact requests and converges effect replays", async () => {
    const harness = await createHarness();
    await seedCandidate(harness);
    const detail = harness.service.getCandidateDetail("candidate-gov");
    const first = harness.service.promoteCandidate("candidate-gov", detail.revision, "version-b");
    const replayed = harness.service.promoteCandidate("candidate-gov", detail.revision, "version-b");
    if (!first.pendingApproval || !replayed.pendingApproval) throw new Error("expected pending approvals");
    expect(replayed.pendingApproval.approvalId).toBe(first.pendingApproval.approvalId);
    expect(replayed.pendingApproval.replayed).toBe(true);

    harness.storage.approvals.resolve(first.pendingApproval.approvalId, {
      decision: "approve",
      resolvedBy: "operator-resolver",
    });
    const applied = harness.service.executeApprovedCapabilityLifecycleMutation({
      approvalId: first.pendingApproval.approvalId,
    });
    expect(applied.changedVersionIds).toEqual(["version-b"]);
    // Exact effect replay converges on committed evidence without re-mutating.
    const replayApply = harness.service.executeApprovedCapabilityLifecycleMutation({
      approvalId: first.pendingApproval.approvalId,
    });
    expect(replayApply.candidateId).toBe("candidate-gov");
    expect(countGoverned(harness)).toBe(1);
    expect(harness.service.getCandidateDetail("candidate-gov").revision).toBe(applied.revision);
  });

  it("conflicts terminally when the candidate version set drifts from the reviewed material", async () => {
    const harness = await createHarness();
    await seedCandidate(harness);
    const detail = harness.service.getCandidateDetail("candidate-gov");
    const request = harness.service.promoteCandidate("candidate-gov", detail.revision, "version-b");
    if (!request.pendingApproval) throw new Error("expected pending approval");
    harness.storage.approvals.resolve(request.pendingApproval.approvalId, {
      decision: "approve",
      resolvedBy: "operator-resolver",
    });
    // Drift the reviewed version set through the branded fail-safe revoke.
    harness.service.systemRevokeCandidate("candidate-gov", "integrity_quarantine");
    expect(() =>
      harness.service.executeApprovedCapabilityLifecycleMutation({ approvalId: request.pendingApproval!.approvalId }),
    ).toThrow(/drifted from the exact reviewed material/);
  });

  it("commits review-only proposals with source and Journey in one transaction and keeps them non-callable", async () => {
    const harness = await createHarness();
    const proposal = harness.service.createProposal(
      {
        proposalKind: "skill",
        title: "Review-only proposal",
        summary: "Stays non-callable",
        payload: {},
      },
      "operator-one",
    );
    const governed = harness.storage.gatewaySql
      .prepare(
        `SELECT operation, source_required AS sourceRequired, approval_required AS approvalRequired, approval_id AS approvalId
         FROM governed_lifecycle_events WHERE target_id = @proposalId`,
      )
      .get({ proposalId: proposal.proposalId }) as
      | { operation: string; sourceRequired: number; approvalRequired: number; approvalId: string | null }
      | undefined;
    expect(governed).toMatchObject({ operation: "proposal_created", approvalId: null });
    expect(Number(governed!.sourceRequired)).toBe(1);
    expect(Number(governed!.approvalRequired)).toBe(0);
    // Non-callable pin: proposals never reach the callable catalog.
    expect(
      harness.service
        .listCatalog("callable")
        .some((entry) => entry.skillId === proposal.proposalId || entry.toolName === proposal.proposalId),
    ).toBe(false);
    const journeyRow = harness.storage.gatewaySql
      .prepare(
        `SELECT COUNT(*) AS count FROM governance_journey_events WHERE subject_id = @proposalId AND action = 'proposal_created'`,
      )
      .get({ proposalId: proposal.proposalId }) as { count: number };
    expect(Number(journeyRow.count)).toBe(1);
  });

  it("rolls the proposal row back when a later coupled write fails (one transaction)", async () => {
    const harness = await createHarness();
    const before = harness.storage.capabilityProposals.list(10).length;
    // Poison the source-history write that runs AFTER the proposal upsert and
    // BEFORE the governed evidence: the shared immediate transaction must
    // roll the already-written proposal row back.
    const spy = vi.spyOn(harness.storage.capabilityProposalEvents, "append").mockImplementationOnce(() => {
      throw new Error("simulated proposal-source outage");
    });
    expect(() =>
      harness.service.createProposal(
        { proposalKind: "skill", title: "Atomic proposal", summary: "Must roll back", payload: {} },
        "operator-one",
      ),
    ).toThrow(/simulated proposal-source outage/);
    spy.mockRestore();
    expect(harness.storage.capabilityProposals.list(10).length).toBe(before);
    expect(countGoverned(harness)).toBe(0);
  });

  it("fail-safe system revoke writes canonical state, governed system event, and Journey without approval", async () => {
    const harness = await createHarness();
    await seedCandidate(harness);
    const revoked = harness.service.systemRevokeCandidate("candidate-gov", "integrity_quarantine");
    expect(revoked.changedVersionIds).toEqual(["version-a", "version-b"]);
    expect(harness.service.getCandidateDetail("candidate-gov").activationBlocked).toBe(true);
    const governed = harness.storage.gatewaySql
      .prepare(
        `SELECT operation, actor_type AS actorType, approval_id AS approvalId FROM governed_lifecycle_events WHERE domain = 'capability_state'`,
      )
      .all() as Array<{ operation: string; actorType: string; approvalId: string | null }>;
    expect(governed).toEqual([
      expect.objectContaining({ operation: "system_revoked", actorType: "system", approvalId: null }),
    ]);
    // Idempotent repeat is a no-op with no second governed claim.
    const repeat = harness.service.systemRevokeCandidate("candidate-gov", "integrity_quarantine");
    expect(repeat.changedVersionIds).toEqual([]);
    expect(countGoverned(harness)).toBe(1);
  });
});

async function createHarness(input?: {
  toolCatalog?: ToolCatalogEntry[];
  sandboxConfig?: {
    required?: boolean;
    bestEffortHostEnabled?: boolean;
  };
  resolvePolicyContext?: (input: {
    operatorId?: string;
    workspaceId?: string;
    sessionId?: string;
    taskId?: string;
    runId?: string;
    surface?: "chat" | "cowork" | "code";
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  }) => ToolPolicyActorContext;
  resolveSandboxMetadata?: (config: CapabilityRuntimeConfig["codeModeSandbox"]) => CodeModeSandboxMetadata;
  dockerBackend?: CapabilityRuntimeConfig["codeModeDockerBackend"];
  aiderAdapter?: CapabilityRuntimeConfig["codeModeAiderAdapter"];
  invokeTool?: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
  reserveApprovalWaitRun?: boolean;
  spawnCodeModeChild?: ConstructorParameters<typeof CapabilitySystemService>[0]["spawnCodeModeChild"];
  loadedSkills?: LoadedSkill[];
  meshCatalogEntries?: CapabilityCatalogEntry[];
}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-capability-system-"));
  tempRoots.push(rootDir);
  const approvals = new Map<string, ApprovalRequest>();
  const storage = createFakeStorage(approvals);
  const publishRealtime = vi.fn();
  const invokeTool = vi.fn(
    input?.invokeTool ??
      (async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "executed",
        auditEventId: "audit-1",
        result: { ok: true },
      })),
  );
  const createApproval = vi.fn(async (request: ApprovalCreateInput): Promise<ApprovalRequest> => {
    const approval: ApprovalRequest = {
      approvalId: "approval-1",
      kind: request.kind,
      riskLevel: request.riskLevel,
      status: "approved",
      payload: request.payload,
      preview: request.preview,
      linkage: {
        ...request.linkage,
        ...(input?.reserveApprovalWaitRun ? { durableRunId: "approval-wait-1" } : {}),
      },
      createdAt: "2026-04-10T00:00:00.000Z",
      expiresAt: request.expiresAt ?? undefined,
      explanationStatus: "not_requested",
    };
    approvals.set(approval.approvalId, approval);
    return approval;
  });
  const canonicalResolutionEvents: string[] = [];
  const canonicalResolutionEffects: string[] = [];
  const requestRunProcessing = vi.fn();
  const resolveApproval = vi.fn(async (approvalId: string, request: ApprovalResolveInput) => {
    const approval = storage.approvals.resolve(approvalId, request);
    storage.approvalEvents.append({
      approvalId,
      eventType: "resolved",
      actorId: request.resolvedBy,
      payload: { decision: request.decision, status: approval.status },
    });
    canonicalResolutionEvents.push("resolved");
    canonicalResolutionEffects.push("approval_wait_wake", "approval_resolution_signal", "approval_observability");
    if (approval.linkage?.durableRunId) {
      requestRunProcessing(approval.linkage.durableRunId);
    }
    return {
      approval,
      effects: [],
      replay: { approval, events: [], effects: [] },
      durableRunId: approval.linkage?.durableRunId,
    };
  });

  const service = new CapabilitySystemService({
    rootDir,
    runtimeConfig: {
      candidateRoot: "./data/capability-candidates",
      codeModeArtifactRoot: "./data/code-mode-artifacts",
      tempRoot: "./data/code-mode-temp",
      codeModeSandbox: {
        mode: "best_effort_host",
        required: input?.sandboxConfig?.required ?? true,
        bestEffortHostEnabled: input?.sandboxConfig?.bestEffortHostEnabled ?? false,
      },
      codeModeDockerBackend: input?.dockerBackend ?? {
        enabled: false,
      },
      codeModeAiderAdapter: input?.aiderAdapter ?? {
        enabled: false,
      },
    },
    storage: storage as never,
    readFeatureFlags: () => ({
      codeModeV1Enabled: true,
    }),
    listToolCatalog: () => input?.toolCatalog ?? [createTool("tool.safe_read")],
    ...(input?.meshCatalogEntries === undefined
      ? {}
      : { listMeshCapabilityCatalogEntries: () => input.meshCatalogEntries as CapabilityCatalogEntry[] }),
    listLoadedSkills: () => input?.loadedSkills ?? [],
    readSkillStates: () => new Map(),
    invokeTool,
    createApproval,
    resolveApproval,
    publishRealtime,
    readPolicySnapshot: () => ({ mode: "test" }),
    resolvePolicyContext: input?.resolvePolicyContext,
    resolveSandboxMetadata: input?.resolveSandboxMetadata,
    spawnCodeModeChild: input?.spawnCodeModeChild,
  });

  return {
    rootDir,
    storage,
    service,
    approvals,
    createApproval,
    resolveApproval,
    publishRealtime,
    invokeTool,
    canonicalResolutionEvents,
    canonicalResolutionEffects,
    requestRunProcessing,
  };
}

function fakeCodeModeDispatchChild(input: {
  connected: boolean;
  asynchronousSendError?: Error;
  responseBeforeAsynchronousSendError?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    connected: boolean;
    killed: boolean;
    exitCode: number | null;
    send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
    kill: () => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.connected = input.connected;
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.send = (message, callback) => {
    const request = message as { id?: unknown; method?: unknown };
    if (
      input.responseBeforeAsynchronousSendError &&
      request.method === "run.execute" &&
      typeof request.id === "string"
    ) {
      child.emit("message", {
        jsonrpc: "2.0",
        id: request.id,
        error: input.responseBeforeAsynchronousSendError,
      });
    }
    if (input.asynchronousSendError) {
      setImmediate(() => {
        callback?.(input.asynchronousSendError!);
        child.connected = false;
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
    }
    return true;
  };
  if (!input.connected) {
    setImmediate(() => {
      child.exitCode = 1;
      child.emit("close", 1, null);
    });
  }
  return child;
}

function createFakeStorage(approvalsById = new Map<string, ApprovalRequest>()) {
  // HX-402 P2: the governed lifecycle owner, approvals, and Journey are REAL
  // storage — the approval-first candidate lifecycle and one-transaction
  // proposal evidence run against the trigger-protected schema, while
  // unrelated collaborators stay lightweight fakes.
  const realStorage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  storageCleanups.push(() => realStorage.close());
  const snapshots = new Map<string, CapabilityCatalogSnapshotRecord>();
  const codeModeRuns = new Map<string, CodeModeRunRecord>();
  const runtimeDecisionRecords: RuntimeDecisionTraceRecord[] = [];
  const candidateVersions = new Map<string, CandidateSkillVersionRecord>();
  const pendingActions = new Map<string, PendingApprovalAction>();
  const systemSettings = new Map<string, { key: string; value: unknown; updatedAt: string }>();
  const sessionMeta = new Map<string, { sessionId: string; workspaceId?: string }>();
  const skillLifecycles = new Map<string, SkillLifecycleRecord>();
  const turnTraces = new Map<string, { turnId: string; sessionId: string; durable?: { runId?: string } }>();
  const sessions = new Map<string, { sessionId: string; sessionKey: string }>();
  const chatMessages = new Map<string, ChatMessageRecord>();
  const transcriptOutbox = new Map<string, { eventId: string; event: TranscriptEvent; enqueuedAt: string }>();
  const skillAggregateRevisions = new Map<string, number>();

  return {
    sessions: {
      upsert(input: { sessionId: string; sessionKey: string }) {
        const record = { sessionId: input.sessionId, sessionKey: input.sessionKey };
        sessions.set(input.sessionId, record);
        return record;
      },
      getBySessionId(sessionId: string) {
        const session = sessions.get(sessionId);
        if (!session) {
          throw new Error(`Missing session ${sessionId}`);
        }
        return session;
      },
    },
    chatMessages: {
      upsert(message: ChatMessageRecord) {
        chatMessages.set(message.messageId, message);
        return message;
      },
      get(messageId: string) {
        return chatMessages.get(messageId);
      },
    },
    transcriptOutbox: {
      enqueue(event: TranscriptEvent, enqueuedAt = event.timestamp) {
        if (!transcriptOutbox.has(event.eventId)) {
          transcriptOutbox.set(event.eventId, { eventId: event.eventId, event, enqueuedAt });
        }
        return transcriptOutbox.get(event.eventId);
      },
      get(eventId: string) {
        return transcriptOutbox.get(eventId);
      },
      listPending() {
        return [...transcriptOutbox.values()];
      },
    },
    systemSettings: {
      get: vi.fn((key: string) => systemSettings.get(key)),
      set: vi.fn((key: string, value: unknown, now = "2026-04-10T00:00:00.000Z") => {
        const record = { key, value, updatedAt: now };
        systemSettings.set(key, record);
        return record;
      }),
    },
    capabilityCatalogSnapshots: {
      create(snapshot: CapabilityCatalogSnapshotRecord) {
        snapshots.set(snapshot.snapshotId, snapshot);
        return snapshot;
      },
      get(snapshotId: string) {
        const snapshot = snapshots.get(snapshotId);
        if (!snapshot) {
          throw new Error(`Missing snapshot ${snapshotId}`);
        }
        return snapshot;
      },
    },
    skillLifecycle: {
      find: (skillId: string) => skillLifecycles.get(skillId),
      upsert: vi.fn((record: SkillLifecycleRecord) => {
        skillLifecycles.set(record.skillId, record);
        return record;
      }),
    },
    skillAggregateRevisions: {
      get(aggregateKind: string, aggregateId: string) {
        const key = `${aggregateKind}\u0000${aggregateId}`;
        const revision = skillAggregateRevisions.get(key);
        return revision === undefined
          ? undefined
          : {
              aggregateKind,
              aggregateId,
              revision,
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
            };
      },
      ensure(aggregateKind: string, aggregateId: string, now = "2026-04-10T00:00:00.000Z") {
        const key = `${aggregateKind}\u0000${aggregateId}`;
        const revision = skillAggregateRevisions.get(key) ?? 1;
        skillAggregateRevisions.set(key, revision);
        return { aggregateKind, aggregateId, revision, createdAt: now, updatedAt: now };
      },
      runWithRevision<T>(
        aggregateKind: string,
        aggregateId: string,
        expectedRevision: number,
        mutation: () => { value: T; changed: boolean },
        now = "2026-04-10T00:00:00.000Z",
      ) {
        const key = `${aggregateKind}\u0000${aggregateId}`;
        const currentRevision = skillAggregateRevisions.get(key) ?? 1;
        skillAggregateRevisions.set(key, currentRevision);
        if (currentRevision !== expectedRevision) {
          throw new ConflictError({
            code: "WRITE_CONFLICT",
            message: `${aggregateKind} ${aggregateId} changed since revision ${expectedRevision}`,
            details: {
              resourceKind: aggregateKind,
              resourceId: aggregateId,
              expectedRevision,
              currentRevision,
            },
          });
        }
        const result = mutation();
        const revision = result.changed ? currentRevision + 1 : currentRevision;
        skillAggregateRevisions.set(key, revision);
        return { ...result, revision, updatedAt: now };
      },
      createWithInitialRevision<T>(
        aggregateKind: string,
        aggregateId: string,
        mutation: () => { value: T; changed: boolean },
        now = "2026-04-10T00:00:00.000Z",
      ) {
        const key = `${aggregateKind}\u0000${aggregateId}`;
        const currentRevision = skillAggregateRevisions.get(key);
        if (currentRevision !== undefined) {
          throw new ConflictError({
            code: "WRITE_CONFLICT",
            message: `${aggregateKind} ${aggregateId} already exists at revision ${currentRevision}`,
            details: {
              resourceKind: aggregateKind,
              resourceId: aggregateId,
              expectedState: "absent",
              currentRevision,
            },
          });
        }
        const result = mutation();
        if (!result.changed) {
          throw new TypeError("initial skill aggregate revision mutation must report changed: true");
        }
        skillAggregateRevisions.set(key, 1);
        return { ...result, revision: 1, updatedAt: now };
      },
    },
    // HX-402 P2: proposal rows and their event history are REAL storage so
    // the one-transaction proposal/source/Journey coupling is provable.
    capabilityProposals: realStorage.capabilityProposals,
    capabilityProposalEvents: realStorage.capabilityProposalEvents,
    approvals: {
      // HX-402 P2: deterministic detached lifecycle approvals live in REAL
      // storage; pre-seeded fake approvals (code mode fixtures) stay in the
      // map and win on lookup.
      createDeterministicDetachedWithTtlDuration: (
        input: Parameters<Storage["approvals"]["createDeterministicDetachedWithTtlDuration"]>[0],
        ttlMs: number,
      ) => realStorage.approvals.createDeterministicDetachedWithTtlDuration(input, ttlMs),
      get: vi.fn((approvalId: string) => {
        const approval = approvalsById.get(approvalId);
        if (approval) {
          return approval;
        }
        return realStorage.approvals.get(approvalId);
      }),
      resolve: vi.fn((approvalId: string, input: { decision: "approve" | "reject" | "edit"; resolvedBy: string }) => {
        const approval = approvalsById.get(approvalId);
        if (!approval) {
          return realStorage.approvals.resolve(approvalId, input as never);
        }
        const status = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "edited";
        const next = {
          ...approval,
          status,
          resolvedBy: input.resolvedBy,
          resolvedAt: "2026-04-10T00:01:00.000Z",
        } satisfies ApprovalRequest;
        approvalsById.set(approvalId, next);
        return next;
      }),
    },
    // NOTE: approvalEvents deliberately stays the vi.fn() spy declared further
    // down this literal rather than realStorage.approvalEvents — see the comment
    // on that stub before wiring it to real storage.
    governanceJourneyEvents: realStorage.governanceJourneyEvents,
    gatewaySql: realStorage.gatewaySql,
    runImmediateTransaction: <T>(callback: () => T): T => realStorage.runImmediateTransaction(callback),
    codeModeRuns: {
      upsert(record: CodeModeRunRecord) {
        codeModeRuns.set(record.runId, record);
        return record;
      },
      get(runId: string) {
        const run = codeModeRuns.get(runId);
        if (!run) {
          throw new Error(`Missing run ${runId}`);
        }
        return run;
      },
      find(runId: string) {
        return codeModeRuns.get(runId);
      },
      list(limit = 100) {
        return [...codeModeRuns.values()].slice(0, limit);
      },
      listFilteredForStatusHydration(options: {
        limit?: number;
        workspaceId?: string;
        sessionId?: string;
        turnId?: string;
        status: CodeModeRunRecord["status"];
      }) {
        const limit =
          typeof options.limit === "number" && Number.isFinite(options.limit)
            ? Math.max(1, Math.min(500, Math.floor(options.limit)))
            : 100;
        const scanLimit = Math.min(Math.max(limit * 4, limit), 1000);
        const includeApprovalPending =
          options.status === "expired" ||
          options.status === "approval_pending" ||
          options.status === "failed" ||
          options.status === "rejected";
        return [...codeModeRuns.values()]
          .filter((run) => (options.workspaceId ? run.workspaceId === options.workspaceId : true))
          .filter((run) => (options.sessionId ? run.sessionId === options.sessionId : true))
          .filter((run) => (options.turnId ? run.turnId === options.turnId : true))
          .filter(
            (run) => run.status === options.status || (includeApprovalPending && run.status === "approval_pending"),
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId))
          .slice(0, scanLimit);
      },
      claimForExecution(input: {
        runId: string;
        approvalId: string;
        sandbox?: CodeModeRunRecord["sandbox"];
        startedAt: string;
      }) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.approvalId !== input.approvalId ||
          run.status !== "approval_pending" ||
          run.executionRecovery.phase !== "not_started"
        ) {
          return undefined;
        }
        const next = {
          ...run,
          status: "running",
          sandbox: input.sandbox,
          startedAt: input.startedAt,
          finishedAt: undefined,
          error: undefined,
          errorCode: undefined,
          errorDetails: undefined,
          executionRecovery: {
            ...run.executionRecovery,
            generation: run.executionRecovery.generation + 1,
            phase: "claimed",
            disposition: "none",
            boundaryCrossedAt: undefined,
            interruptedAt: undefined,
            interruptionReason: undefined,
          },
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
      releaseExecutionClaim(input: {
        runId: string;
        approvalId: string;
        startedAt: string;
        executionGeneration: number;
        interruptedAt: string;
        interruptionReason: string;
        sandbox?: CodeModeRunRecord["sandbox"];
      }) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.approvalId !== input.approvalId ||
          run.status !== "running" ||
          run.startedAt !== input.startedAt ||
          run.executionRecovery.generation !== input.executionGeneration ||
          run.executionRecovery.phase !== "claimed"
        ) {
          return undefined;
        }
        const next = {
          ...run,
          status: "approval_pending",
          sandbox: input.sandbox,
          startedAt: undefined,
          finishedAt: undefined,
          error: undefined,
          errorCode: undefined,
          errorDetails: undefined,
          executionRecovery: {
            ...run.executionRecovery,
            phase: "not_started",
            disposition: "retryable",
            interruptedAt: input.interruptedAt,
            interruptionReason: input.interruptionReason,
          },
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
      markExecutionBoundaryCrossed(input: {
        runId: string;
        approvalId: string;
        startedAt: string;
        executionGeneration: number;
        boundaryCrossedAt: string;
      }) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.approvalId !== input.approvalId ||
          run.status !== "running" ||
          run.startedAt !== input.startedAt ||
          run.executionRecovery.generation !== input.executionGeneration ||
          run.executionRecovery.phase !== "claimed"
        ) {
          return undefined;
        }
        const next = {
          ...run,
          executionRecovery: {
            ...run.executionRecovery,
            phase: "boundary_crossed",
            boundaryCrossedAt: input.boundaryCrossedAt,
          },
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
      resetExecutionBoundaryBeforeDispatch(input: {
        runId: string;
        approvalId: string;
        startedAt: string;
        executionGeneration: number;
      }) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.approvalId !== input.approvalId ||
          run.status !== "running" ||
          run.startedAt !== input.startedAt ||
          run.executionRecovery.generation !== input.executionGeneration ||
          run.executionRecovery.phase !== "boundary_crossed"
        ) {
          return undefined;
        }
        const next = {
          ...run,
          executionRecovery: {
            ...run.executionRecovery,
            phase: "claimed",
            boundaryCrossedAt: undefined,
          },
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
      recordExecutionOutput(
        input: CodeModeRunRecord & {
          approvalId: string;
          startedAt: string;
          executionGeneration: number;
          executionPhase: "output_captured_completed" | "output_captured_failed";
        },
      ) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.approvalId !== input.approvalId ||
          run.status !== "running" ||
          run.startedAt !== input.startedAt ||
          run.executionRecovery.generation !== input.executionGeneration ||
          run.executionRecovery.phase !== "boundary_crossed"
        ) {
          return undefined;
        }
        const next = {
          ...run,
          stdoutArtifact: input.stdoutArtifact,
          stderrArtifact: input.stderrArtifact,
          stdoutPreview: input.stdoutPreview,
          stderrPreview: input.stderrPreview,
          stdoutTruncated: input.stdoutTruncated,
          stderrTruncated: input.stderrTruncated,
          trustedCodeWriteVerification: input.trustedCodeWriteVerification,
          result: input.result,
          error: input.error,
          errorCode: input.errorCode,
          errorDetails: input.errorDetails,
          executionRecovery: { ...run.executionRecovery, phase: input.executionPhase },
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
      markExecutionInterrupted(input: {
        runId: string;
        approvalId: string;
        startedAt?: string;
        executionGeneration: number;
        interruptedAt: string;
        interruptionReason: string;
        errorDetails?: Record<string, unknown>;
      }) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.approvalId !== input.approvalId ||
          run.status !== "running" ||
          (input.startedAt !== undefined && run.startedAt !== input.startedAt) ||
          run.executionRecovery.generation !== input.executionGeneration
        ) {
          return undefined;
        }
        const next = {
          ...run,
          status: "failed",
          error: `Code Mode execution was interrupted after its mutation boundary: ${input.interruptionReason}`,
          errorCode: "execution_interrupted_after_boundary",
          errorDetails: { manualReconciliationRequired: true, ...(input.errorDetails ?? {}) },
          finishedAt: input.interruptedAt,
          executionRecovery: {
            ...run.executionRecovery,
            phase: "terminal",
            disposition: "manual_reconciliation",
            interruptedAt: input.interruptedAt,
            interruptionReason: input.interruptionReason,
          },
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
      failExecutionClaimBeforeDispatch(input: {
        runId: string;
        approvalId: string;
        startedAt: string;
        executionGeneration: number;
        finishedAt: string;
        error: string;
        errorCode?: string;
        errorDetails?: Record<string, unknown>;
      }) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.approvalId !== input.approvalId ||
          run.status !== "running" ||
          run.startedAt !== input.startedAt ||
          run.executionRecovery.generation !== input.executionGeneration ||
          run.executionRecovery.phase !== "claimed"
        ) {
          return undefined;
        }
        const next = {
          ...run,
          status: "failed",
          error: input.error,
          errorCode: input.errorCode,
          errorDetails: input.errorDetails,
          finishedAt: input.finishedAt,
          executionRecovery: {
            ...run.executionRecovery,
            phase: "terminal",
            disposition: "terminal",
          },
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
      finishExecutionClaim(
        input: CodeModeRunRecord & {
          approvalId: string;
          status: "completed" | "failed";
          startedAt: string;
          finishedAt: string;
        },
      ) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.approvalId !== input.approvalId ||
          run.status !== "running" ||
          run.startedAt !== input.startedAt ||
          run.executionRecovery.generation !== input.executionRecovery.generation ||
          (input.status === "completed" && run.executionRecovery.phase !== "output_captured_completed") ||
          (input.status === "failed" && run.executionRecovery.phase !== "output_captured_failed")
        ) {
          return undefined;
        }
        const next = {
          ...run,
          status: input.status,
          sandbox: input.sandbox,
          stdoutArtifact: input.stdoutArtifact,
          stderrArtifact: input.stderrArtifact,
          stdoutPreview: input.stdoutPreview,
          stderrPreview: input.stderrPreview,
          stdoutTruncated: input.stdoutTruncated,
          stderrTruncated: input.stderrTruncated,
          trustedCodeWriteVerification: input.trustedCodeWriteVerification,
          verification: input.verification,
          result: input.result,
          error: input.error,
          errorCode: input.errorCode,
          errorDetails: input.errorDetails,
          finishedAt: input.finishedAt,
          executionRecovery: {
            ...input.executionRecovery,
            phase: "terminal",
            disposition:
              input.executionRecovery.disposition === "manual_reconciliation" ? "manual_reconciliation" : "terminal",
          },
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
      listPendingFinalTranscriptDelivery(limit = 100) {
        return [...codeModeRuns.values()]
          .filter(
            (run) =>
              Boolean(run.sessionId) &&
              (run.status === "completed" || run.status === "failed") &&
              Boolean(run.executionRecovery.finalTranscriptEventId) &&
              !run.executionRecovery.finalTranscriptEnqueuedAt,
          )
          .sort((left, right) =>
            `${left.finishedAt ?? left.createdAt}\u0000${left.runId}`.localeCompare(
              `${right.finishedAt ?? right.createdAt}\u0000${right.runId}`,
            ),
          )
          .slice(0, limit);
      },
      listPendingFinalTranscriptDeliveryPage(
        input: {
          afterFinishedAt?: string;
          afterRunId?: string;
          limit?: number;
        } = {},
      ) {
        const pending = this.listPendingFinalTranscriptDelivery(Number.MAX_SAFE_INTEGER);
        return pending
          .filter((run) => {
            if (!input.afterFinishedAt || !input.afterRunId) {
              return true;
            }
            const sortAt = run.finishedAt ?? run.createdAt;
            return sortAt > input.afterFinishedAt || (sortAt === input.afterFinishedAt && run.runId > input.afterRunId);
          })
          .slice(0, input.limit ?? 100);
      },
      markFinalTranscriptEnqueued(input: {
        runId: string;
        executionGeneration: number;
        eventId: string;
        enqueuedAt: string;
      }) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.executionRecovery.generation !== input.executionGeneration ||
          run.executionRecovery.finalTranscriptEventId !== input.eventId
        ) {
          return undefined;
        }
        const next = {
          ...run,
          executionRecovery: { ...run.executionRecovery, finalTranscriptEnqueuedAt: input.enqueuedAt },
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
    },
    runtimeDecisionTraces: {
      append: vi.fn((input: RuntimeDecisionTraceAppendInput): RuntimeDecisionTraceRecord => {
        const record: RuntimeDecisionTraceRecord = {
          decisionId: input.decisionId ?? `decision-${runtimeDecisionRecords.length + 1}`,
          kind: input.kind,
          scope: input.scope,
          selected: input.selected,
          rationale: input.rationale,
          alternatives: input.alternatives ?? [],
          signals: input.signals ?? [],
          evidenceRefs: input.evidenceRefs ?? [],
          previousDecisionId: input.previousDecisionId,
          planRevision: input.planRevision,
          latencyMs: input.latencyMs,
          createdAt: input.createdAt ?? "2026-04-10T00:00:00.000Z",
        };
        runtimeDecisionRecords.push(record);
        return record;
      }),
      list: vi.fn((query: RuntimeDecisionTraceQuery = {}) => {
        const limit =
          typeof query.limit === "number" && Number.isFinite(query.limit)
            ? Math.max(1, Math.min(500, Math.floor(query.limit)))
            : 100;
        return runtimeDecisionRecords
          .filter((record) => (query.workspaceId ? record.scope.workspaceId === query.workspaceId : true))
          .filter((record) => (query.sessionId ? record.scope.sessionId === query.sessionId : true))
          .filter((record) => (query.turnId ? record.scope.turnId === query.turnId : true))
          .filter((record) => (query.runId ? record.scope.runId === query.runId : true))
          .filter((record) => (query.approvalId ? record.scope.approvalId === query.approvalId : true))
          .slice(0, limit);
      }),
    },
    candidateSkillVersions: {
      upsert(record: CandidateSkillVersionRecord) {
        candidateVersions.set(record.versionId, record);
        return record;
      },
      get(versionId: string) {
        const version = candidateVersions.get(versionId);
        if (!version) {
          throw new Error(`Missing candidate version ${versionId}`);
        }
        return version;
      },
      find(versionId: string) {
        return candidateVersions.get(versionId);
      },
      list(limit = 100) {
        return [...candidateVersions.values()].slice(0, limit);
      },
      listByCandidateId(candidateId: string, limit = 100) {
        return [...candidateVersions.values()]
          .filter((version) => version.candidateId === candidateId)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, limit);
      },
      findLatestByCandidateId(candidateId: string) {
        return this.listByCandidateId(candidateId, 1)[0];
      },
      updateLifecycleState(
        versionId: string,
        lifecycleState: CandidateSkillVersionRecord["lifecycleState"],
        updatedAt: string,
      ) {
        const current = this.get(versionId);
        const next = {
          ...current,
          lifecycleState,
          updatedAt,
        };
        candidateVersions.set(versionId, next);
        return next;
      },
    },
    pendingApprovalActions: {
      upsertPending(input: PendingApprovalAction) {
        pendingActions.set(input.approvalId, {
          ...input,
          resolutionStatus: "pending",
        });
      },
      find(approvalId: string) {
        return pendingActions.get(approvalId);
      },
      markResolved: vi.fn(),
    },
    // Deliberately a spy rather than realStorage.approvalEvents: every
    // approval-event assertion in this file goes through
    // toHaveBeenCalledWith(...) or injects failure via mockImplementationOnce(...),
    // and no test reads approval_event rows back. A real repository satisfies
    // neither (it is not a mock, and cannot be made to throw on demand).
    approvalEvents: {
      append: vi.fn(),
    },
    chatExecutionPlans: {
      listBySession: vi.fn(() => []),
    },
    chatInlineApprovals: {
      upsert: vi.fn(),
      listBySession: vi.fn(() => []),
    },
    chatSessionMeta: {
      get: vi.fn((sessionId: string) => sessionMeta.get(sessionId) ?? { sessionId }),
      patch(sessionId: string, input: { workspaceId?: string }) {
        const record = {
          sessionId,
          workspaceId: input.workspaceId,
        };
        sessionMeta.set(sessionId, record);
        return record;
      },
    },
    chatTurnTraces: {
      create(input: { turnId: string; sessionId: string; durable?: { runId?: string } }) {
        turnTraces.set(input.turnId, input);
        return input;
      },
      get(turnId: string) {
        const trace = turnTraces.get(turnId);
        if (!trace) {
          throw new Error(`Missing turn trace ${turnId}`);
        }
        return trace;
      },
      listBySession: vi.fn((sessionId: string) =>
        [...turnTraces.values()].filter((trace) => trace.sessionId === sessionId),
      ),
    },
  };
}

function createPermissionProfileRecord(profileId: string): PermissionProfileRecord {
  return {
    profileId,
    label: profileId,
    builtin: false,
    status: "active",
    scope: "workspace",
    approvalMode: "approve_all",
    toolPatterns: ["tool.safe_read"],
    allow: [],
    deny: [],
    createdBy: "test",
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
  };
}

function createTool(toolName: string, overrides?: Partial<ToolCatalogEntry>): ToolCatalogEntry {
  return {
    toolName,
    category: overrides?.category ?? "fs",
    riskLevel: overrides?.riskLevel ?? "safe",
    requiresApproval: overrides?.requiresApproval ?? false,
    description: overrides?.description ?? `${toolName} description`,
    argSchema: overrides?.argSchema ?? { type: "object" },
    examples: overrides?.examples ?? [],
    pack: overrides?.pack ?? "core",
    readOnly: overrides?.readOnly ?? true,
    deterministic: overrides?.deterministic ?? true,
    codeModeAllowed: overrides?.codeModeAllowed ?? true,
  };
}

function createArtifact(filename: string): CapabilityArtifactRecord {
  return {
    artifactId: `artifact-${filename}`,
    relPath: `data/${filename}`,
    sha256: `sha-${filename}`,
    bytes: 32,
    mimeType: "application/json",
    createdAt: "2026-04-10T00:00:00.000Z",
  };
}

async function createCandidateVersion(
  rootDir: string,
  input: Pick<CandidateSkillVersionRecord, "candidateId" | "versionId" | "lifecycleState" | "originatingRunId"> & {
    updatedAt: string;
  },
): Promise<CandidateSkillVersionRecord> {
  const bundleRoot = `data/capability-candidates/${input.candidateId}/${input.versionId}`;
  const manifestArtifact = await createManagedArtifact(rootDir, bundleRoot, "manifest.json", { id: input.versionId });
  const instructionArtifact = await createManagedArtifact(
    rootDir,
    bundleRoot,
    "SKILL.md",
    `# ${input.versionId}\n\nTest skill.`,
    "text/markdown",
  );
  const proofArtifact = await createManagedArtifact(rootDir, bundleRoot, "proof.json", { ok: true });
  const programArtifact = await createManagedArtifact(
    rootDir,
    bundleRoot,
    "program.ts",
    "export const ok = true;\n",
    "text/typescript",
  );
  const schemaArtifact = await createManagedArtifact(rootDir, bundleRoot, "schemas.json", { input: {} });
  return {
    candidateId: input.candidateId,
    versionId: input.versionId,
    sourceKind: "code_mode_generated",
    title: input.versionId,
    summary: `${input.versionId} summary`,
    bundleRoot,
    originatingRunId: input.originatingRunId,
    wrapperManifestHash: "wrap-hash",
    lifecycleState: input.lifecycleState,
    manifestArtifact,
    instructionArtifact,
    proofArtifact,
    programArtifact,
    schemaArtifact,
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: input.updatedAt,
    lastSuccessfulExecutionAt: "2026-04-10T00:00:00.000Z",
  };
}

async function createManagedArtifact(
  rootDir: string,
  bundleRoot: string,
  filename: string,
  value: Record<string, unknown> | string,
  mimeType = "application/json",
): Promise<CapabilityArtifactRecord> {
  const relPath = `${bundleRoot}/${filename}`;
  const absPath = path.resolve(rootDir, relPath);
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, "utf8");
  return {
    artifactId: `artifact-${filename}`,
    relPath,
    sha256: sha256Text(content),
    bytes: Buffer.byteLength(content),
    mimeType,
    createdAt: "2026-04-10T00:00:00.000Z",
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
