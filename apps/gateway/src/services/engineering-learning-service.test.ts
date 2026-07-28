import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { EngineeringLearningService } from "./engineering-learning-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("engineering learning lifecycle", () => {
  it("creates one source-grounded proposal per run and excludes it from context until activation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-learning-"));
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    cleanups.push(
      () => storage.close(),
      () => fs.rmSync(root, { recursive: true, force: true }),
    );
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "fix.ts"), "export const fixed = true;\n", "utf8");
    const service = new EngineeringLearningService({
      storage,
      rootDir: root,
      isEnabled: () => true,
      createApproval: async (input) => storage.approvals.create(input),
      resolveSourceRoot: () => root,
    });
    const input = {
      workspaceId: "default",
      source: { runId: "code-run-1" },
      disposition: "completed" as const,
      changedFiles: ["src/fix.ts"],
      verificationEvidence: ["test:focused-pass token: qwerty1234"],
      title: "Keep the regression guard",
      problem: "The old branch skipped validation.",
      rootCause: "The mutation path had no invariant test.",
      resolution: "Added the invariant and a focused test.",
      prevention: "Run the focused proof before changing this path.",
    };
    const first = service.propose(input);
    const duplicate = service.propose(input);
    expect(duplicate.learningId).toBe(first.learningId);
    expect(first.status).toBe("proposed");
    expect(first.fileEvidence[0]?.sha256).toHaveLength(64);
    expect(first.verificationEvidence[0]).toContain("[REDACTED]");
    expect(first.verificationEvidence[0]).not.toContain("qwerty1234");
    expect(service.retrieveContext({ workspaceId: "default", paths: ["src/fix.ts"] }).items).toEqual([]);
    const approval = await service.requestAction(first.learningId, { action: "activate" });
    expect(service.retrieveContext({ workspaceId: "default", paths: ["src/fix.ts"] }).items).toEqual([]);
    storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator-1" });
    expect(service.applyApprovedAction(approval.approvalId).status).toBe("active");
    expect(service.retrieveContext({ workspaceId: "default", paths: ["src/fix.ts"] }).citations[0]).toEqual(
      expect.objectContaining({ learningId: first.learningId, sourceRunId: "code-run-1" }),
    );
  });

  it("marks proposals stale when recorded source evidence changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-learning-"));
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    cleanups.push(
      () => storage.close(),
      () => fs.rmSync(root, { recursive: true, force: true }),
    );
    fs.writeFileSync(path.join(root, "fix.ts"), "before\n", "utf8");
    const service = new EngineeringLearningService({
      storage,
      rootDir: root,
      isEnabled: () => true,
      createApproval: async () => ({ approvalId: "approval-1" }) as never,
      resolveSourceRoot: () => root,
    });
    const record = service.propose({
      workspaceId: "default",
      source: { runId: "code-run-2" },
      disposition: "completed",
      changedFiles: ["fix.ts"],
      verificationEvidence: ["test:pass"],
      title: "Freshness test",
      problem: "Evidence can drift.",
      rootCause: "Source files change after capture.",
      resolution: "Persist source hashes.",
      prevention: "Recheck hashes on read.",
    });
    fs.writeFileSync(path.join(root, "fix.ts"), "after\n", "utf8");
    const stale = service.get(record.learningId);
    expect(stale.status).toBe("stale");
    expect(stale.staleReasons).toContain("source_changed:fix.ts");
  });

  it("rejects an activation approval when source evidence becomes stale before apply", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-learning-"));
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    cleanups.push(
      () => storage.close(),
      () => fs.rmSync(root, { recursive: true, force: true }),
    );
    fs.writeFileSync(path.join(root, "fix.ts"), "before\n", "utf8");
    const service = new EngineeringLearningService({
      storage,
      rootDir: root,
      isEnabled: () => true,
      createApproval: async (input) => storage.approvals.create(input),
      resolveSourceRoot: () => root,
    });
    const learning = service.propose({
      workspaceId: "default",
      source: { runId: "code-run-stale-approval" },
      disposition: "completed",
      changedFiles: ["fix.ts"],
      verificationEvidence: ["test:pass"],
      title: "Activation freshness fence",
      problem: "Evidence may drift while approval is pending.",
      rootCause: "Approval and activation occur at different times.",
      resolution: "Recheck provenance when the approval effect applies.",
      prevention: "Reject stale activation approvals.",
    });
    const approval = await service.requestAction(learning.learningId, { action: "activate" });
    fs.writeFileSync(path.join(root, "fix.ts"), "after\n", "utf8");
    storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator-1" });

    expect(() => service.applyApprovedAction(approval.approvalId)).toThrow(/changed after approval|stale/i);
    expect(service.get(learning.learningId).status).toBe("stale");
  });

  it("rejects ineligible work before persistence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-learning-"));
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
    cleanups.push(
      () => storage.close(),
      () => fs.rmSync(root, { recursive: true, force: true }),
    );
    const service = new EngineeringLearningService({
      storage,
      rootDir: root,
      isEnabled: () => true,
      createApproval: async () => ({ approvalId: "approval-1" }) as never,
      resolveSourceRoot: () => root,
    });
    expect(() =>
      service.propose({
        workspaceId: "default",
        source: { runId: "failed-run" },
        disposition: "completed",
        changedFiles: ["missing.ts"],
        verificationEvidence: ["claim:failed"],
        failedClaimVerification: true,
        title: "Ineligible",
        problem: "p",
        rootCause: "r",
        resolution: "r",
        prevention: "p",
      }),
    ).toThrow(/verified evidence/i);
  });
});
