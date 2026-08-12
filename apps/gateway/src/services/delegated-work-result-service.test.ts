import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import {
  buildDelegatedFilesystemScopeControl,
  DelegatedWorkResultService,
  normalizeDelegatedScopeExpansionPaths,
} from "./delegated-work-result-service.js";
import { ApprovalEffectsService } from "./approval-resolution-effects-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("delegated filesystem scope expansion", () => {
  it("normalizes a narrow path while preserving the current scope hash authority", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scope-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "src"));
    const scope = buildDelegatedFilesystemScopeControl({
      rootPath: root,
      approvedPaths: ["src"],
      dispatchGeneration: "dispatch-1",
    });
    const result = normalizeDelegatedScopeExpansionPaths({
      rootPath: root,
      requestedPaths: ["tests/new"],
      currentApprovedPaths: scope.approvedPaths,
      writeJailRoots: [root],
    });
    expect(result.relativePaths).toEqual(["tests/new"]);
    expect(result.resolvedPaths[0]).toBe(path.join(root, "tests", "new"));
    expect(scope.scopeHash).toHaveLength(64);
  });

  it.each([["."], ["../outside"], ["**/*.ts"], ["C:/outside"]])(
    "rejects broad, escaping, globbed, or absolute paths",
    (requestedPath) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scope-"));
      roots.push(root);
      expect(() =>
        normalizeDelegatedScopeExpansionPaths({
          rootPath: root,
          requestedPaths: [requestedPath],
          currentApprovedPaths: ["src"],
          writeJailRoots: [root],
        }),
      ).toThrow();
    },
  );

  it("rejects duplicate requests instead of widening scope ambiguously", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scope-"));
    roots.push(root);
    expect(() =>
      normalizeDelegatedScopeExpansionPaths({
        rootPath: root,
        requestedPaths: ["tests", "tests"],
        currentApprovedPaths: ["src"],
        writeJailRoots: [root],
      }),
    ).toThrow(/duplicate/i);
  });

  it("offers only server-owned candidates and routes a selected id through the canonical approval wait", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scope-"));
    roots.push(root);
    for (const folder of ["src", "docs", "packages", ".git", "node_modules"]) {
      fs.mkdirSync(path.join(root, folder));
    }
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    vi.spyOn(storage.audit, "append").mockResolvedValue();
    storage.chatSessionMeta.ensure("parent-session", undefined, "workspace-1");
    storage.chatSessionMeta.ensure("child-session", undefined, "workspace-1");
    storage.chatDelegationRuns.create({
      runId: "delegation-chat-scope",
      sessionId: "parent-session",
      taskId: "task-chat-scope",
      objective: "Explore the workspace",
      roles: ["Workspace explorer", "Researcher"],
      mode: "sequential",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const scope = buildDelegatedFilesystemScopeControl({
      rootPath: root,
      approvedPaths: ["src"],
      dispatchGeneration: "dispatch-chat-scope",
    });
    storage.chatDelegationSteps.create({
      stepId: "step-chat-scope",
      runId: "delegation-chat-scope",
      role: "workspace-explorer",
      index: 0,
      status: "running",
      childSessionId: "child-session",
      durableRunId: "durable-child-scope",
      startedAt: new Date().toISOString(),
      scopeControl: scope,
    });
    storage.chatDelegationSteps.create({
      stepId: "step-mixed-research-scope",
      runId: "delegation-chat-scope",
      role: "Researcher",
      index: 1,
      status: "running",
      childSessionId: "child-session-mixed-research",
      startedAt: new Date().toISOString(),
      scopeControl: scope,
    });
    const createApproval = vi.fn(async (input: Parameters<typeof storage.approvals.create>[0]) =>
      storage.approvals.create(input),
    );
    const service = new DelegatedWorkResultService({
      storage,
      writeJailRoots: [root],
      isEnabled: () => true,
      createApproval,
    });

    await expect(
      service.assertToolRequestWithinApprovedScope({
        toolName: "fs.list",
        args: { path: "." },
        agentId: "workspace-explorer",
        sessionId: "child-session",
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.assertToolRequestWithinApprovedScope({
        toolName: "fs.read",
        args: { path: "../docs/outside.md" },
        agentId: "workspace-explorer",
        sessionId: "child-session",
      }),
    ).rejects.toThrow(/outside the approved scope/i);

    storage.chatDelegationRuns.create({
      runId: "delegation-research-scope",
      sessionId: "parent-session",
      taskId: "task-research-scope",
      objective: "Research only",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    storage.chatDelegationSteps.create({
      stepId: "step-research-scope",
      runId: "delegation-research-scope",
      role: "Researcher",
      index: 0,
      status: "running",
      childSessionId: "child-session-research",
      startedAt: new Date().toISOString(),
      scopeControl: scope,
    });
    await expect(
      service.listChatScopeExpansionCandidates({
        sessionId: "parent-session",
        runId: "delegation-research-scope",
        stepId: "step-research-scope",
      }),
    ).rejects.toThrow(/explorer or code/i);
    await expect(
      service.listChatScopeExpansionCandidates({
        sessionId: "parent-session",
        runId: "delegation-chat-scope",
        stepId: "step-mixed-research-scope",
      }),
    ).rejects.toThrow(/active step/i);

    const listed = await service.listChatScopeExpansionCandidates({
      sessionId: "parent-session",
      runId: "delegation-chat-scope",
      stepId: "step-chat-scope",
    });
    expect(listed.candidates.map((candidate) => candidate.label)).toEqual(["docs", "packages"]);
    expect(listed.candidates.every((candidate) => /^[a-f0-9]{64}$/u.test(candidate.candidateId))).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(root);
    expect(JSON.stringify(listed)).not.toContain("node_modules");

    await expect(
      service.requestChatScopeExpansion({
        sessionId: "parent-session",
        runId: "delegation-chat-scope",
        stepId: "step-chat-scope",
        candidateIds: ["f".repeat(64)],
      }),
    ).rejects.toThrow(/stale|not eligible/i);
    expect(createApproval).not.toHaveBeenCalled();

    const selected = listed.candidates.find((candidate) => candidate.label === "docs");
    if (!selected) throw new Error("Expected docs candidate.");
    const requested = await service.requestChatScopeExpansion({
      sessionId: "parent-session",
      runId: "delegation-chat-scope",
      stepId: "step-chat-scope",
      candidateIds: [selected.candidateId],
    });
    expect(requested).toMatchObject({
      runId: "delegation-chat-scope",
      stepId: "step-chat-scope",
      waitingForApproval: true,
    });
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "delegation_scope_expansion", riskLevel: "danger" }),
    );
    expect(storage.chatDelegationSteps.get("step-chat-scope").workResult?.scopeExpansion).toMatchObject({
      requestedPaths: ["docs"],
      scopeHash: scope.scopeHash,
      approvalId: requested.approvalId,
    });
    storage.close();
  });

  it("normalizes in-scope terminal evidence paths and rejects host-path disclosure inputs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-result-evidence-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gc-result-evidence-outside-"));
    roots.push(root, outsideRoot);
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "private"));
    const evidencePath = path.join(root, "src", "evidence.txt");
    const unapprovedPath = path.join(root, "private", "secret.txt");
    const outsidePath = path.join(outsideRoot, "secret.txt");
    fs.writeFileSync(evidencePath, "evidence", "utf8");
    fs.writeFileSync(unapprovedPath, "secret", "utf8");
    fs.writeFileSync(outsidePath, "secret", "utf8");

    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    vi.spyOn(storage.audit, "append").mockResolvedValue();
    storage.chatDelegationRuns.create({
      runId: "delegation-evidence",
      sessionId: "parent-session",
      taskId: "task-evidence",
      objective: "Collect scoped evidence",
      roles: ["workspace-explorer"],
      mode: "sequential",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const scope = buildDelegatedFilesystemScopeControl({
      rootPath: root,
      approvedPaths: ["src"],
      dispatchGeneration: "dispatch-evidence",
    });
    storage.chatDelegationSteps.create({
      stepId: "step-evidence",
      runId: "delegation-evidence",
      role: "workspace-explorer",
      index: 0,
      status: "running",
      childSessionId: "child-session",
      startedAt: new Date().toISOString(),
      scopeControl: scope,
    });
    const service = new DelegatedWorkResultService({
      storage,
      writeJailRoots: [root],
      isEnabled: () => true,
      createApproval: vi.fn(async (input) => storage.approvals.create(input)),
    });
    const submit = (evidenceRefs: string[]) =>
      service.execute({
        toolName: "submit_work_result",
        args: {
          disposition: "completed",
          summary: "Scoped exploration finished.",
          changedFiles: [],
          evidenceRefs,
        },
        agentId: "workspace-explorer",
        sessionId: "child-session",
      });

    await expect(submit([outsidePath])).rejects.toThrow(/escapes delegated workspace root/i);
    await expect(submit([unapprovedPath])).rejects.toThrow(/outside the approved scope/i);
    await expect(submit([`file:///${evidencePath.replaceAll("\\", "/")}`])).rejects.toThrow(/file URLs/i);
    await expect(submit([`src/evidence.txt\u0000hidden`])).rejects.toThrow(/control characters/i);
    await expect(submit(["x".repeat(1_001)])).rejects.toThrow(/1,000 characters/i);

    await expect(submit([evidencePath, "artifact:sha256:abc"])).resolves.toMatchObject({
      recorded: true,
      disposition: "completed",
    });
    expect(storage.chatDelegationSteps.get("step-evidence").workResult?.evidenceRefs).toEqual([
      "src/evidence.txt",
      "artifact:sha256:abc",
    ]);
    storage.close();
  });

  it("applies only a scope-hash-bound approved effect and retains approval lineage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scope-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "src"));
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    vi.spyOn(storage.audit, "append").mockResolvedValue();
    const scope = buildDelegatedFilesystemScopeControl({
      rootPath: root,
      approvedPaths: ["src"],
      dispatchGeneration: "dispatch-1",
    });
    const approval = storage.approvals.create({
      kind: "delegation_scope_expansion",
      riskLevel: "danger",
      payload: {},
      preview: {},
    });
    storage.chatDelegationSteps.create({
      stepId: "step-1",
      runId: "delegation-1",
      role: "Coder",
      index: 0,
      status: "running",
      startedAt: new Date().toISOString(),
      scopeControl: scope,
      workResult: {
        disposition: "scope_expansion",
        summary: "Tests are required.",
        changedFiles: [],
        evidenceRefs: [],
        scopeHash: scope.scopeHash,
        dispatchGeneration: scope.dispatchGeneration,
        scopeExpansion: {
          requestedPaths: ["tests"],
          resolvedPaths: [path.join(root, "tests")],
          reason: "Add focused regression coverage.",
          scopeHash: scope.scopeHash,
          approvalId: approval.approvalId,
          requestedAt: new Date().toISOString(),
        },
      },
    });
    const pending = storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "delegation_scope_expansion_apply",
      targetKind: "delegation_step",
      targetId: "step-1",
      payload: {
        stepId: "step-1",
        dispatchGeneration: scope.dispatchGeneration,
        scopeHash: scope.scopeHash,
        requestedPaths: ["tests"],
        decision: "approved",
      },
    });
    const asyncStorage = createSqliteAsyncStorage(storage);
    const service = new ApprovalEffectsService(
      { storage: asyncStorage, publishRealtime: () => undefined } as never,
      { backgroundTasks: new Set() } as never,
    );
    const workerId = (service as unknown as { workerId: string }).workerId;
    const claimed = await asyncStorage.approvalEffects.claimNextPendingEffect(
      workerId,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(claimed?.effectId).toBe(pending.effectId);
    if (!claimed) throw new Error("Expected scope approval effect claim.");
    await (
      service as unknown as { handleDelegationScopeExpansionApply(effect: typeof claimed): Promise<void> }
    ).handleDelegationScopeExpansionApply(claimed);
    const step = storage.chatDelegationSteps.get("step-1");
    expect(step.status).toBe("running");
    expect(step.scopeControl?.approvedPaths).toEqual(["src", "tests"]);
    expect(step.workResult?.scopeExpansion?.decision).toBe("approved");
    expect(storage.approvalEffects.listByApproval(approval.approvalId)[0]?.status).toBe("completed");
    await asyncStorage.close();
  });

  it("rolls back expanded authority when effect completion loses its CAS and applies it once on retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scope-atomic-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "src"));
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    vi.spyOn(storage.audit, "append").mockResolvedValue();
    const scope = buildDelegatedFilesystemScopeControl({
      rootPath: root,
      approvedPaths: ["src"],
      dispatchGeneration: "dispatch-atomic",
    });
    const approval = storage.approvals.create({
      kind: "delegation_scope_expansion",
      riskLevel: "danger",
      payload: {},
      preview: {},
    });
    storage.chatDelegationSteps.create({
      stepId: "step-atomic",
      runId: "delegation-atomic",
      role: "Coder",
      index: 0,
      status: "running",
      startedAt: new Date().toISOString(),
      scopeControl: scope,
      workResult: {
        disposition: "scope_expansion",
        summary: "Tests are required.",
        changedFiles: [],
        evidenceRefs: [],
        scopeHash: scope.scopeHash,
        dispatchGeneration: scope.dispatchGeneration,
        scopeExpansion: {
          requestedPaths: ["tests"],
          resolvedPaths: [path.join(root, "tests")],
          reason: "Add focused regression coverage.",
          scopeHash: scope.scopeHash,
          approvalId: approval.approvalId,
          requestedAt: new Date().toISOString(),
        },
      },
    });
    const pending = storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "delegation_scope_expansion_apply",
      targetKind: "delegation_step",
      targetId: "step-atomic",
      payload: {
        stepId: "step-atomic",
        dispatchGeneration: scope.dispatchGeneration,
        scopeHash: scope.scopeHash,
        requestedPaths: ["tests"],
        decision: "approved",
      },
    });
    const asyncStorage = createSqliteAsyncStorage(storage);
    const firstService = new ApprovalEffectsService(
      { storage: asyncStorage, publishRealtime: () => undefined } as never,
      { backgroundTasks: new Set() } as never,
    );
    const firstWorkerId = (firstService as unknown as { workerId: string }).workerId;
    const firstClaim = await asyncStorage.approvalEffects.claimNextPendingEffect(
      firstWorkerId,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    if (!firstClaim) throw new Error("Expected first scope approval effect claim.");
    const originalCompleteEffect = storage.approvalEffects.completeEffect.bind(storage.approvalEffects);
    const completion = vi
      .spyOn(storage.approvalEffects, "completeEffect")
      .mockImplementationOnce(() => undefined)
      .mockImplementation(originalCompleteEffect);

    await (
      firstService as unknown as { handleDelegationScopeExpansionApply(effect: typeof firstClaim): Promise<void> }
    ).handleDelegationScopeExpansionApply(firstClaim);

    const rolledBackStep = storage.chatDelegationSteps.get("step-atomic");
    expect(rolledBackStep.scopeControl).toEqual(scope);
    expect(rolledBackStep.workResult?.scopeExpansion?.decision).toBeUndefined();
    const deferredEffect = storage.approvalEffects.get(pending.effectId);
    expect(deferredEffect).toMatchObject({ status: "running", lastError: expect.stringMatching(/completion lease/) });

    storage.db
      .prepare("UPDATE approval_effects SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE effect_id = ?")
      .run(pending.effectId);
    const retryService = new ApprovalEffectsService(
      { storage: asyncStorage, publishRealtime: () => undefined } as never,
      { backgroundTasks: new Set() } as never,
    );
    const retryWorkerId = (retryService as unknown as { workerId: string }).workerId;
    const retryClaim = await asyncStorage.approvalEffects.claimNextPendingEffect(
      retryWorkerId,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    if (!retryClaim) throw new Error("Expected retry scope approval effect claim.");
    await (
      retryService as unknown as { handleDelegationScopeExpansionApply(effect: typeof retryClaim): Promise<void> }
    ).handleDelegationScopeExpansionApply(retryClaim);

    const appliedStep = storage.chatDelegationSteps.get("step-atomic");
    expect(appliedStep.scopeControl?.approvedPaths).toEqual(["src", "tests"]);
    expect(appliedStep.scopeControl?.approvedPaths.filter((item) => item === "tests")).toHaveLength(1);
    expect(appliedStep.workResult?.scopeExpansion?.decision).toBe("approved");
    expect(storage.approvalEffects.get(pending.effectId)).toMatchObject({
      status: "completed",
      result: { applied: true, decision: "approved", stepId: "step-atomic" },
    });
    expect(completion).toHaveBeenCalledTimes(2);
    completion.mockRestore();
    await asyncStorage.close();
  });

  it("blocks a stale approval when the current dispatch scope hash changed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scope-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "src"));
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    vi.spyOn(storage.audit, "append").mockResolvedValue();
    const approvedScope = buildDelegatedFilesystemScopeControl({
      rootPath: root,
      approvedPaths: ["src"],
      dispatchGeneration: "dispatch-1",
    });
    const currentScope = buildDelegatedFilesystemScopeControl({
      rootPath: root,
      approvedPaths: ["src"],
      dispatchGeneration: "dispatch-2",
    });
    const approval = storage.approvals.create({
      kind: "delegation_scope_expansion",
      riskLevel: "danger",
      payload: {},
      preview: {},
    });
    storage.chatDelegationSteps.create({
      stepId: "step-stale",
      runId: "delegation-stale",
      role: "Coder",
      index: 0,
      status: "running",
      startedAt: new Date().toISOString(),
      scopeControl: currentScope,
      workResult: {
        disposition: "scope_expansion",
        summary: "Need tests.",
        changedFiles: [],
        evidenceRefs: [],
        scopeHash: approvedScope.scopeHash,
        dispatchGeneration: approvedScope.dispatchGeneration,
        scopeExpansion: {
          requestedPaths: ["tests"],
          reason: "Need tests.",
          scopeHash: approvedScope.scopeHash,
          approvalId: approval.approvalId,
          requestedAt: new Date().toISOString(),
        },
      },
    });
    storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "delegation_scope_expansion_apply",
      targetKind: "delegation_step",
      targetId: "step-stale",
      payload: {
        stepId: "step-stale",
        dispatchGeneration: approvedScope.dispatchGeneration,
        scopeHash: approvedScope.scopeHash,
        requestedPaths: ["tests"],
        decision: "approved",
      },
    });
    const service = new ApprovalEffectsService(
      { storage, publishRealtime: () => undefined } as never,
      { backgroundTasks: new Set() } as never,
    );
    const workerId = (service as unknown as { workerId: string }).workerId;
    const claimed = storage.approvalEffects.claimNextPendingEffect(
      workerId,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    if (!claimed) throw new Error("Expected stale scope approval effect claim.");
    await (
      service as unknown as { handleDelegationScopeExpansionApply(effect: typeof claimed): Promise<void> }
    ).handleDelegationScopeExpansionApply(claimed);
    const step = storage.chatDelegationSteps.get("step-stale");
    expect(step.status).toBe("failed");
    expect(step.workResult?.disposition).toBe("blocked");
    expect(step.error).toMatch(/stale/i);
    storage.close();
  });

  it("retries an approved scope resume until the persisted delegation actually reacquires dispatch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scope-resume-"));
    roots.push(root);
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    const approval = storage.approvals.create({
      kind: "delegation_scope_expansion",
      riskLevel: "danger",
      payload: {},
      preview: {},
    });
    storage.durableRuns.createRun({
      runId: "durable-scope-child",
      workflowKey: "chat.turn.execute",
      status: "completed",
      payload: {},
      finishedAt: new Date().toISOString(),
    });
    storage.chatDelegationSteps.create({
      stepId: "step-resume",
      runId: "delegation-resume",
      role: "Coder",
      index: 0,
      status: "running",
      startedAt: new Date().toISOString(),
      durableRunId: "durable-scope-child",
      workResult: {
        disposition: "scope_expansion",
        summary: "Need tests.",
        changedFiles: [],
        evidenceRefs: [],
        scopeExpansion: {
          requestedPaths: ["tests"],
          reason: "Need tests.",
          scopeHash: "scope-resume",
          approvalId: approval.approvalId,
          requestedAt: new Date().toISOString(),
        },
      },
    });
    const apply = storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "delegation_scope_expansion_apply",
      targetKind: "delegation_step",
      targetId: "step-resume",
      payload: {},
    });
    const seedWorker = "scope-apply-seed";
    const applyClaim = storage.approvalEffects.claimNextPendingEffect(
      seedWorker,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    if (!applyClaim || applyClaim.effectId !== apply.effectId) throw new Error("Expected scope apply claim.");
    storage.approvalEffects.completeEffect(apply.effectId, seedWorker, applyClaim.version, {
      result: { applied: true },
    });
    const resumeEffect = storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "delegation_scope_expansion_resume",
      targetKind: "delegation_step",
      targetId: "step-resume",
      payload: {
        stepId: "step-resume",
        delegationRunId: "delegation-resume",
        durableRunId: "durable-scope-child",
      },
    });
    const resume = vi
      .fn()
      .mockResolvedValueOnce({
        runId: "delegation-resume",
        status: "running",
        reenteredPersistedStep: false,
      })
      .mockImplementationOnce(async () => {
        storage.chatDelegationSteps.patch("step-resume", {
          status: "completed",
          workResult: {
            disposition: "completed",
            summary: "Completed after scope approval.",
            changedFiles: [],
            evidenceRefs: ["tests/resume.test.ts"],
          },
        });
        return {
          runId: "delegation-resume",
          status: "completed" as const,
          reenteredPersistedStep: true,
        };
      });
    const firstService = new ApprovalEffectsService(
      { storage, publishRealtime: () => undefined } as never,
      { backgroundTasks: new Set(), resumeDelegatedScopeExpansion: resume } as never,
    );
    const firstWorker = (firstService as unknown as { workerId: string }).workerId;
    const firstClaim = storage.approvalEffects.claimNextPendingEffect(
      firstWorker,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    if (!firstClaim || firstClaim.effectId !== resumeEffect.effectId) throw new Error("Expected resume claim.");
    await (
      firstService as unknown as { handleDelegationScopeExpansionResume(effect: typeof firstClaim): Promise<void> }
    ).handleDelegationScopeExpansionResume(firstClaim);
    expect(storage.approvalEffects.get(resumeEffect.effectId)).toMatchObject({
      status: "running",
      result: { reason: "delegation_not_reentered", deliveryState: "retry_scheduled" },
    });

    storage.db
      .prepare("UPDATE approval_effects SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE effect_id = ?")
      .run(resumeEffect.effectId);
    const retryService = new ApprovalEffectsService(
      { storage, publishRealtime: () => undefined } as never,
      { backgroundTasks: new Set(), resumeDelegatedScopeExpansion: resume } as never,
    );
    const retryWorker = (retryService as unknown as { workerId: string }).workerId;
    const retryClaim = storage.approvalEffects.claimNextPendingEffect(
      retryWorker,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    if (!retryClaim || retryClaim.effectId !== resumeEffect.effectId) throw new Error("Expected resume retry claim.");
    await (
      retryService as unknown as { handleDelegationScopeExpansionResume(effect: typeof retryClaim): Promise<void> }
    ).handleDelegationScopeExpansionResume(retryClaim);
    expect(storage.approvalEffects.get(resumeEffect.effectId)).toMatchObject({
      status: "completed",
      result: {
        resumed: true,
        reenteredPersistedStep: true,
        delegationRunId: "delegation-resume",
        delegationStatus: "completed",
      },
    });
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenLastCalledWith({
      delegationRunId: "delegation-resume",
      stepId: "step-resume",
      durableRunId: "durable-scope-child",
    });
    storage.close();
  });

  it("never wakes or resumes a rejected delegated scope request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scope-reject-resume-"));
    roots.push(root);
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    const approval = storage.approvals.create({
      kind: "delegation_scope_expansion",
      riskLevel: "danger",
      payload: {},
      preview: {},
    });
    const apply = storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "delegation_scope_expansion_apply",
      targetKind: "delegation_step",
      targetId: "step-rejected",
      payload: {},
    });
    const seedWorker = "scope-reject-seed";
    const applyClaim = storage.approvalEffects.claimNextPendingEffect(
      seedWorker,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    if (!applyClaim || applyClaim.effectId !== apply.effectId) throw new Error("Expected rejected scope apply claim.");
    storage.approvalEffects.completeEffect(apply.effectId, seedWorker, applyClaim.version, {
      result: { applied: false, decision: "rejected" },
    });
    storage.durableRuns.createRun({
      runId: "durable-rejected",
      workflowKey: "chat.turn.execute",
      status: "waiting",
      payload: {},
    });
    const wakeEffect = storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "approval_wait_wake",
      targetKind: "durable_run",
      targetId: "durable-rejected",
      payload: {},
    });
    const resume = vi.fn();
    const wakeDurableRun = vi.fn();
    const asyncStorage = createSqliteAsyncStorage(storage);
    const service = new ApprovalEffectsService(
      { storage: asyncStorage, publishRealtime: () => undefined } as never,
      {
        backgroundTasks: new Set(),
        wakeDurableRun,
        requestRunProcessing: vi.fn(),
        resumeDelegatedScopeExpansion: resume,
      } as never,
    );
    const worker = (service as unknown as { workerId: string }).workerId;
    const claim = await asyncStorage.approvalEffects.claimNextPendingEffect(
      worker,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    if (!claim || claim.effectId !== wakeEffect.effectId) throw new Error("Expected rejected wake claim.");
    await (
      service as unknown as { handleWakeEffect(effect: typeof claim, resolveApprovalWait: boolean): Promise<void> }
    ).handleWakeEffect(claim, true);
    expect(storage.approvalEffects.get(wakeEffect.effectId)).toMatchObject({
      status: "skipped",
      result: { wakeOutcome: "skipped_scope_not_approved" },
    });
    expect(wakeDurableRun).not.toHaveBeenCalled();

    const resumeEffect = await asyncStorage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "delegation_scope_expansion_resume",
      targetKind: "delegation_step",
      targetId: "step-rejected",
      payload: {
        stepId: "step-rejected",
        delegationRunId: "delegation-rejected",
        durableRunId: "durable-rejected",
      },
    });
    const resumeClaim = await asyncStorage.approvalEffects.claimNextPendingEffect(
      worker,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    if (!resumeClaim || resumeClaim.effectId !== resumeEffect.effectId)
      throw new Error("Expected rejected resume claim.");
    await (
      service as unknown as { handleDelegationScopeExpansionResume(effect: typeof resumeClaim): Promise<void> }
    ).handleDelegationScopeExpansionResume(resumeClaim);
    expect(storage.approvalEffects.get(resumeEffect.effectId)).toMatchObject({
      status: "skipped",
      result: { resumed: false, reason: "scope_not_approved" },
    });
    expect(resume).not.toHaveBeenCalled();
    await asyncStorage.close();
  });
});
