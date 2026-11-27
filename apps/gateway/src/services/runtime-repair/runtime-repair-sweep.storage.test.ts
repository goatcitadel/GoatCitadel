import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { RUNTIME_REPAIR_AUDIT_STREAM } from "@goatcitadel/contracts";
import { createRuntimeRepairAuditPort, createRuntimeRepairReadPort } from "./runtime-repair-composition.js";
import { RuntimeRepairSweepService } from "./runtime-repair-sweep-service.js";

let root: string;
let storage: Storage;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-runtime-repair-"));
  storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
}, 60_000);

afterAll(() => {
  storage?.close();
  if (root) {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-runtime-repair-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sweepAt(nowMs: number): RuntimeRepairSweepService {
  return new RuntimeRepairSweepService({
    reads: createRuntimeRepairReadPort(storage),
    audit: createRuntimeRepairAuditPort(storage),
    now: () => nowMs,
    newId: randomUUID,
  });
}

describe("runtime repair sweep against real SQLite storage", () => {
  it("finds real stuck state, records it in the audit stream, and leaves every owner unchanged", async () => {
    const orphanedWait = storage.durableRuns.createRun({
      workflowKey: "approval.wait",
      status: "waiting",
      payload: { version: "approval.wait.v1", approvalId: "approval-that-was-never-created" },
    });
    const crashLooped = storage.durableRuns.createRun({
      workflowKey: "chat.turn.execute",
      status: "failed",
      lastError:
        "The run was restarted 8 times after its worker stopped without finishing, so it was stopped instead of being restarted again. Review the run before retrying it.",
    });
    const hidden = storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "medium",
      payload: {},
      preview: {},
      linkage: { durableRunId: "run-without-workspace" },
    });
    const visible = storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "medium",
      payload: {},
      preview: {},
      linkage: { workspaceId: "default" },
    });
    const before = {
      orphanedWait: storage.durableRuns.getRun(orphanedWait.runId),
      crashLooped: storage.durableRuns.getRun(crashLooped.runId),
      hidden: storage.approvals.get(hidden.approvalId),
      visible: storage.approvals.get(visible.approvalId),
    };

    const sweep = sweepAt(Date.now() + 10 * 60_000);
    await sweep.runTick();

    const open = sweep.snapshot().open;
    expect(open.map((finding) => [finding.detectorId, finding.subject]).sort()).toEqual(
      [
        ["approval.no-inbox", { approvalId: hidden.approvalId, runId: "run-without-workspace" }],
        ["approval.wait-orphaned", { approvalId: "approval-that-was-never-created", runId: orphanedWait.runId }],
        ["durable.reclaim-exhausted", { runId: crashLooped.runId }],
      ].sort(),
    );
    expect(sweep.snapshot().detectors.every((detector) => detector.lastError === undefined)).toBe(true);

    const logged = await storage.audit.list(RUNTIME_REPAIR_AUDIT_STREAM);
    expect(logged.map((record) => record.event)).toEqual(["finding_observed", "finding_observed", "finding_observed"]);

    // Detect-only: nothing the sweep looked at changed.
    expect(storage.durableRuns.getRun(orphanedWait.runId)).toEqual(before.orphanedWait);
    expect(storage.durableRuns.getRun(crashLooped.runId)).toEqual(before.crashLooped);
    expect(storage.approvals.get(hidden.approvalId)).toEqual(before.hidden);
    expect(storage.approvals.get(visible.approvalId)).toEqual(before.visible);
  });

  it("rebuilds from the real audit stream after a restart and logs nothing new", async () => {
    const restarted = sweepAt(Date.now() + 15 * 60_000);
    await restarted.runTick();
    expect(restarted.snapshot().open).toHaveLength(3);
    expect(await storage.audit.list(RUNTIME_REPAIR_AUDIT_STREAM)).toHaveLength(3);
  });
});
