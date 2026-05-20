import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  CapabilityArtifactRecord,
  CapabilityCatalogSnapshotRecord,
  CapabilityProposalEventRecord,
  CapabilityProposalRecord,
  CandidateSkillVersionRecord,
  CodeModeSandboxMetadata,
  CodeModeRunRecord,
  PendingApprovalAction,
  PermissionProfileRecord,
  ToolPolicyActorContext,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { CapabilitySystemService, __internal } from "./capability-system-service.js";
import type { CapabilityRuntimeConfig } from "../config.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("CapabilitySystemService", () => {
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
    expect(run.sandbox?.checksFailed).toContain("best_effort_host_disabled");
    expect(harness.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          originSurface: "code",
          sandbox: expect.objectContaining({
            available: false,
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
    const harness = await createHarness();
    harness.createApproval.mockRejectedValueOnce(
      Object.assign(new Error("approval audit unavailable"), {
        approvalId: "approval-1",
      }),
    );

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
    expect(harness.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "reject",
        resolvedBy: "system",
        resolutionNote: expect.stringContaining("approval audit unavailable"),
      }),
    );
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
    const harness = await createHarness();
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
    expect(harness.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "reject",
        resolvedBy: "system",
      }),
    );
    expect(harness.storage.approvals.get("approval-1")).toMatchObject({ status: "rejected" });
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
      }),
    });
    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "completed",
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

  it("releases Code Mode execution claims when interrupted after child execution starts", async () => {
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
      source: "return await capabilities.tool.safe_read();",
    });
    const approval = harness.approvals.get("approval-1");
    harness.approvals.set("approval-1", {
      ...approval!,
      status: "approved",
      resolvedAt: "2026-04-10T00:00:00.000Z",
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1", controller.signal);

    expect(result).toBeUndefined();
    const storedRun = harness.storage.codeModeRuns.get(run.runId);
    expect(storedRun).toMatchObject({ status: "approval_pending" });
    expect(storedRun.startedAt).toBeUndefined();
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
      harness.storage.codeModeRuns.releaseExecutionClaim({
        runId: input.runId,
        approvalId: input.approvalId,
        startedAt: input.startedAt,
      });
      harness.storage.codeModeRuns.claimForExecution({
        runId: input.runId,
        approvalId: input.approvalId,
        sandbox: input.sandbox,
        startedAt: reclaimedStartedAt,
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

  it("stages the Code Mode harness inside the per-run temp root before launch", async () => {
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
    const runHarnessPath = path.join(harness.rootDir, "data", "code-mode-temp", run.runId, "code-mode-harness.mjs");
    await expect(fs.stat(runHarnessPath)).resolves.toBeTruthy();
  });

  it("records launch-time sandbox failure metadata when required host isolation becomes unavailable", async () => {
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
    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        sandbox: expect.objectContaining({
          available: false,
          checksFailed: expect.arrayContaining(["launch_preparation_failed"]),
          failClosedReason: expect.stringContaining("launch preparation failed"),
        }),
      }),
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      sandbox: expect.objectContaining({
        available: false,
        checksFailed: expect.arrayContaining(["launch_preparation_failed"]),
        failClosedReason: expect.stringContaining("launch preparation failed"),
      }),
    });
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

    expect(harness.service.getCandidateDetail("candidate-demo")).toMatchObject({
      candidateId: "candidate-demo",
      activationBlocked: true,
      originatingRun: expect.objectContaining({ runId: "code-run-existing" }),
    });

    const promoted = harness.service.promoteCandidate("candidate-demo", "version-b");
    expect(promoted.detail.activeVersion?.versionId).toBe("version-b");
    expect(promoted.detail.activationBlocked).toBe(false);

    const rolledBack = harness.service.rollbackCandidate("candidate-demo", "version-a");
    expect(rolledBack.detail.activeVersion?.versionId).toBe("version-a");

    const revoked = harness.service.revokeCandidate("candidate-demo", "version-a");
    expect(revoked.detail.activationBlocked).toBe(true);

    const proposalDetail = harness.service.getProposalDetail(proposal.proposalId);
    expect(proposalDetail).toMatchObject({
      proposal: expect.objectContaining({ proposalId: proposal.proposalId }),
      candidate: expect.objectContaining({ candidateId: "candidate-demo" }),
    });
    expect(proposalDetail.events).toHaveLength(1);
    expect(proposalDetail.events[0]?.eventType).toBe("created");
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
    vi.mocked(harness.storage.chatInlineApprovals.listBySession).mockReturnValue([
      {
        approvalId: "approval-live",
        sessionId: "session-1",
        turnId: "turn-1",
        status: "pending",
        createdAt: "2026-04-10T00:00:01.000Z",
        details: {},
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

    expect(harness.service.listChatPendingApprovals("session-1")).toEqual([
      expect.objectContaining({
        approvalId: "approval-live",
        toolName: "fs.write",
        reason: "Write the generated candidate.",
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

    await expect(harness.service.executeApprovedCodeModeRun("approval-1")).rejects.toThrow(
      "only approval_pending runs can execute",
    );

    expect(harness.storage.codeModeRuns.get(run.runId)).toMatchObject({
      status: "completed",
      result: { ok: true },
    });
    expect(harness.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        runId: run.runId,
        reason: expect.stringContaining("only approval_pending runs can execute"),
      }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_refused",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        status: "completed",
        errorCode: "INVALID_RUN_STATE",
      }),
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
    expect(String(result?.result?.error)).toContain("Code Mode wrapper deadline exceeded");
    expect(storedRun).toMatchObject({
      status: "failed",
    });
    const wrapperSignal = invokeTool.mock.calls[0]?.[0].signal;
    expect(wrapperSignal?.aborted).toBe(true);
  }, 25_000);

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

  it("records unavailable sandbox metadata when launch preparation fails after an available probe", async () => {
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

    expect(result?.result).toMatchObject({
      runId: run.runId,
      status: "failed",
    });
    expect(storedRun.sandbox).toMatchObject({
      available: false,
      required: true,
      checksFailed: expect.arrayContaining(["launch_preparation_failed"]),
    });
    expect(storedRun.sandbox?.failClosedReason).toContain("launch preparation failed");
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
      originatingRunId: run.runId,
      lifecycleState: "candidate",
    });
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "candidate_skill_staged",
      "capabilities",
      expect.objectContaining({
        originatingRunId: run.runId,
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
        console.log("x".repeat(70000));
        console.error("y".repeat(70000));
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
  invokeTool?: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
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
      linkage: request.linkage,
      createdAt: "2026-04-10T00:00:00.000Z",
      expiresAt: request.expiresAt ?? undefined,
      explanationStatus: "not_requested",
    };
    approvals.set(approval.approvalId, approval);
    return approval;
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
    },
    storage: storage as never,
    readFeatureFlags: () => ({
      codeModeV1Enabled: true,
    }),
    listToolCatalog: () => input?.toolCatalog ?? [createTool("tool.safe_read")],
    listLoadedSkills: () => [],
    readSkillStates: () => new Map(),
    invokeTool,
    createApproval,
    publishRealtime,
    readPolicySnapshot: () => ({ mode: "test" }),
    resolvePolicyContext: input?.resolvePolicyContext,
    resolveSandboxMetadata: input?.resolveSandboxMetadata,
  });

  return {
    rootDir,
    storage,
    service,
    approvals,
    createApproval,
    publishRealtime,
    invokeTool,
  };
}

function createFakeStorage(approvalsById = new Map<string, ApprovalRequest>()) {
  const snapshots = new Map<string, CapabilityCatalogSnapshotRecord>();
  const proposals = new Map<string, CapabilityProposalRecord>();
  const proposalEvents = new Map<string, CapabilityProposalEventRecord[]>();
  const codeModeRuns = new Map<string, CodeModeRunRecord>();
  const candidateVersions = new Map<string, CandidateSkillVersionRecord>();
  const pendingActions = new Map<string, PendingApprovalAction>();
  const sessionMeta = new Map<string, { sessionId: string; workspaceId?: string }>();
  const turnTraces = new Map<string, { turnId: string; sessionId: string; durable?: { runId?: string } }>();

  return {
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
      find: () => undefined,
      upsert: vi.fn(),
    },
    capabilityProposals: {
      upsert(record: CapabilityProposalRecord) {
        proposals.set(record.proposalId, record);
        return record;
      },
      list(limit = 100) {
        return [...proposals.values()].slice(0, limit);
      },
      get(proposalId: string) {
        const proposal = proposals.get(proposalId);
        if (!proposal) {
          throw new Error(`Missing proposal ${proposalId}`);
        }
        return proposal;
      },
    },
    capabilityProposalEvents: {
      append(record: CapabilityProposalEventRecord) {
        const items = proposalEvents.get(record.proposalId) ?? [];
        items.push(record);
        proposalEvents.set(record.proposalId, items);
        return record;
      },
      listByProposalId(proposalId: string) {
        return proposalEvents.get(proposalId) ?? [];
      },
    },
    approvals: {
      get: vi.fn((approvalId: string) => {
        const approval = approvalsById.get(approvalId);
        if (!approval) {
          throw new Error(`Missing approval ${approvalId}`);
        }
        return approval;
      }),
      resolve: vi.fn((approvalId: string, input: { decision: "approve" | "reject" | "edit"; resolvedBy: string }) => {
        const approval = approvalsById.get(approvalId);
        if (!approval) {
          throw new Error(`Missing approval ${approvalId}`);
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
      claimForExecution(input: {
        runId: string;
        approvalId: string;
        sandbox?: CodeModeRunRecord["sandbox"];
        startedAt: string;
      }) {
        const run = codeModeRuns.get(input.runId);
        if (!run || run.approvalId !== input.approvalId || run.status !== "approval_pending") {
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
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
      releaseExecutionClaim(input: { runId: string; approvalId: string; startedAt?: string }) {
        const run = codeModeRuns.get(input.runId);
        if (
          !run ||
          run.approvalId !== input.approvalId ||
          run.status !== "running" ||
          (input.startedAt && run.startedAt !== input.startedAt)
        ) {
          return undefined;
        }
        const next = {
          ...run,
          status: "approval_pending",
          startedAt: undefined,
          finishedAt: undefined,
          error: undefined,
          errorCode: undefined,
          errorDetails: undefined,
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
          run.startedAt !== input.startedAt
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
          result: input.result,
          error: input.error,
          errorCode: input.errorCode,
          errorDetails: input.errorDetails,
          finishedAt: input.finishedAt,
        } satisfies CodeModeRunRecord;
        codeModeRuns.set(input.runId, next);
        return next;
      },
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
    approvalEvents: {
      append: vi.fn(),
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
    },
    runImmediateTransaction<T>(callback: () => T): T {
      return callback();
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

function createTool(
  toolName: string,
  overrides?: Partial<Pick<ToolCatalogEntry, "readOnly" | "deterministic" | "codeModeAllowed">>,
): ToolCatalogEntry {
  return {
    toolName,
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: `${toolName} description`,
    argSchema: { type: "object" },
    examples: [],
    pack: "core",
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
