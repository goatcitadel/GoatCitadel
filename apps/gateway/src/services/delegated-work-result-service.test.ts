import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import {
  buildDelegatedFilesystemScopeControl,
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

  it("applies only a scope-hash-bound approved effect and retains approval lineage", () => {
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
    expect(claimed?.effectId).toBe(pending.effectId);
    if (!claimed) throw new Error("Expected scope approval effect claim.");
    (
      service as unknown as { handleDelegationScopeExpansionApply(effect: typeof claimed): void }
    ).handleDelegationScopeExpansionApply(claimed);
    const step = storage.chatDelegationSteps.get("step-1");
    expect(step.status).toBe("running");
    expect(step.scopeControl?.approvedPaths).toEqual(["src", "tests"]);
    expect(step.workResult?.scopeExpansion?.decision).toBe("approved");
    expect(storage.approvalEffects.listByApproval(approval.approvalId)[0]?.status).toBe("completed");
    storage.close();
  });

  it("blocks a stale approval when the current dispatch scope hash changed", () => {
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
    (
      service as unknown as { handleDelegationScopeExpansionApply(effect: typeof claimed): void }
    ).handleDelegationScopeExpansionApply(claimed);
    const step = storage.chatDelegationSteps.get("step-stale");
    expect(step.status).toBe("failed");
    expect(step.workResult?.disposition).toBe("blocked");
    expect(step.error).toMatch(/stale/i);
    storage.close();
  });
});
