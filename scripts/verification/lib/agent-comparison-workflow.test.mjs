import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import { advanceComparisonWorkflow } from "./agent-comparison-workflow.mjs";
import { verifyComparisonEvidence } from "./agent-comparison-verifiers.mjs";
import {
  EXECUTION_BINDING_FIELDS,
  PERMISSION_REVIEW_FILE,
  PERMISSION_REVIEW_VERSION,
} from "./agent-comparison-permissions.mjs";

async function fixture(t, taskId) {
  const root = await mkdtemp(path.join(tmpdir(), "goat-comparison-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = path.join(root, "evidence"),
    workspace = path.join(root, "workspace");
  await mkdir(evidence);
  await mkdir(workspace);
  const binding = {
    executionId: "execution-1",
    manifestSha256: "a".repeat(64),
    cellId: `goatcitadel:${taskId}:1`,
    revision: "b".repeat(40),
    effectiveConfigSha256: "c".repeat(64),
    fixtureSha256: "d".repeat(64),
  };
  await writeFile(
    path.join(evidence, "session-start.json"),
    JSON.stringify({ ...binding, taskId, product: "goatcitadel" }),
  );
  for (const [name, content] of Object.entries(COMPARISON_TASKS.find((task) => task.id === taskId).files)) {
    await mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await writeFile(path.join(workspace, name), content);
  }
  const receipt = async (name, extra) => {
    const bytes = JSON.stringify({ source: "controlled_fixture", name, extra });
    const file = `native-${name}.json`;
    await writeFile(path.join(evidence, file), bytes);
    return { ...binding, source: "controlled_fixture", nativeReceipt: { path: file, sha256: sha256(bytes) }, ...extra };
  };
  return {
    root,
    workspace,
    evidence,
    receipt,
    advance: (action, receipt, instructions) =>
      advanceComparisonWorkflow({ cellDirectory: root, action, receipt, instructions }),
  };
}

it("releases held-out input only after exact native review and supports exact interrupted-command replay", async (t) => {
  const f = await fixture(t, "workflow_capture_reuse");
  const sourceText =
    "# What changed\nMissing attachment name\n# Evidence\nattachment-name regression test passed\n# Unverified\nevery attachment format works\n";
  await writeFile(path.join(f.workspace, "source-release.md"), sourceText);
  const source = await f.receipt("source", {
    phase: {
      id: "source_workflow",
      status: "completed",
      sessionId: "s1",
      turnId: "t1",
      sourceArtifactSha256: sha256(sourceText),
    },
  });
  assert.equal((await f.advance("source", source)).next, "capture_review");
  await f.advance("source", source);
  await assert.rejects(readFile(path.join(f.workspace, "input/changes.json")), { code: "ENOENT" });
  const instructions =
    "# Inputs\nChanges JSON.\n# Instructions\nCreate What changed, Evidence and Unverified sections.\n# Failure\nKeep unsupported claims Unverified.\n# Verification\nCheck all facts.\n";
  const digest = sha256(instructions);
  const review = await f.receipt("review", {
    phase: {
      id: "capture_review",
      sessionId: "s1",
      turnId: "t2",
      sourceSessionId: "s1",
      sourceTurnId: "t1",
      sourceArtifactSha256: sha256(sourceText),
      instructionsSha256: digest,
      reviewedInstructionsSha256: digest,
      reviewDecision: "approved",
      skillVersionId: "skill-v1",
    },
    activationEvents: [{ skillVersionId: "skill-v1", instructionsSha256: digest }],
  });
  await assert.rejects(
    f.advance("review", { ...review, phase: { ...review.phase, reviewDecision: "pending" } }, instructions),
    /must approve/,
  );
  await assert.rejects(f.advance("review", review, instructions + "changed"), /must approve/);
  await assert.rejects(readFile(path.join(f.workspace, "input/changes.json")), { code: "ENOENT" });
  assert.equal((await f.advance("review", review, instructions)).newSession, true);
  await f.advance("review", review, instructions);
  assert.match(await readFile(path.join(f.workspace, "input/changes.json"), "utf8"), /Duplicate reminder/);
  await writeFile(
    path.join(f.workspace, "release.md"),
    "# What changed\nDuplicate reminder after reconnect\n# Evidence\nreconnect regression test passed\n# Unverified\nall providers are faster\n",
  );
  const reuse = await f.receipt("reuse", {
    phase: { id: "reuse", sessionId: "s2", turnId: "t3", loadedInstructionsSha256: digest, skillVersionId: "skill-v1" },
  });
  const permissionReview = {
    schemaVersion: PERMISSION_REVIEW_VERSION,
    ...Object.fromEntries(EXECUTION_BINDING_FIELDS.map((key) => [key, reuse[key]])),
    policy: { files: "workspace_only", terminal: "disabled", skills: "review_before_activation", schedule: "disabled" },
    reviewedBy: "Controlled test fixture",
    reviewedAt: "2026-09-11T00:00:00.000Z",
    sourceReceipts: [source.nativeReceipt, review.nativeReceipt, reuse.nativeReceipt],
  };
  const reviewBytes = JSON.stringify(permissionReview);
  await writeFile(path.join(f.evidence, PERMISSION_REVIEW_FILE), reviewBytes);
  reuse.permissionReview = { path: PERMISSION_REVIEW_FILE, sha256: sha256(reviewBytes) };
  await assert.rejects(
    f.advance("reuse", { ...reuse, permissionReview: { ...reuse.permissionReview, sha256: sha256("changed") } }),
    /exact native permission/,
  );
  await assert.rejects(
    f.advance("reuse", { ...reuse, permissionReview: { ...reuse.permissionReview, path: "../outside.json" } }),
    /exact native permission/,
  );
  assert.equal((await f.advance("reuse", reuse)).taskOutcome, "unverified");
  const verified = await verifyComparisonEvidence({
    taskId: "workflow_capture_reuse",
    workspaceRoot: f.workspace,
    evidenceRoot: f.evidence,
  });
  assert.equal(verified.evidenceKind, "controlled");
  assert.equal(verified.outcome, "passed");
  assert.deepEqual(verified.permissionEvidence.policy, permissionReview.policy);
});

it("rejects changed source, native bytes, and another cell before releasing new input", async (t) => {
  const f = await fixture(t, "workflow_capture_reuse");
  const receipt = await f.receipt("source", {
    phase: {
      id: "source_workflow",
      status: "completed",
      sessionId: "s1",
      turnId: "t1",
      sourceArtifactSha256: sha256("stale"),
    },
  });
  await assert.rejects(f.advance("source", { ...receipt, executionId: "different" }), /does not belong/);
  await writeFile(path.join(f.workspace, "source-release.md"), "Changed artifact");
  await assert.rejects(f.advance("source", receipt), /does not match/);
  await writeFile(path.join(f.evidence, receipt.nativeReceipt.path), "changed");
  await assert.rejects(f.advance("source", receipt), /bytes changed/);
});

it("retains native schedule/reconnect receipts and lets the independent verifier reject duplicate delivery", async (t) => {
  const f = await fixture(t, "scheduled_delivery");
  const delivery = {
    scheduleId: "schedule-1",
    scheduledFor: "2030-01-01T12:00:00.000Z",
    schedulePersisted: true,
    authorizedDestination: "telegram:test",
  };
  const scheduled = await f.receipt("schedule", { delivery });
  await f.advance("schedule", scheduled);
  const acknowledgement = {
    providerMessageId: "m1",
    message: "HARBOR PILOT CHECK",
    destination: delivery.authorizedDestination,
    acknowledgedAt: "2030-01-01T12:00:01.000Z",
  };
  const reconnected = await f.receipt("reconnect", {
    delivery: {
      ...delivery,
      receipts: [acknowledgement, { ...acknowledgement, providerMessageId: "m2" }],
      reconnectedAt: "2030-01-01T12:00:02.000Z",
      observedUntil: "2030-01-01T12:00:33.000Z",
      pendingDeliveries: 0,
    },
  });
  await assert.rejects(
    f.advance("reconnect", {
      ...reconnected,
      delivery: { ...reconnected.delivery, authorizedDestination: "telegram:other" },
    }),
    /changed/,
  );
  await f.advance("reconnect", reconnected);
  const verified = await verifyComparisonEvidence({
    taskId: "scheduled_delivery",
    workspaceRoot: f.workspace,
    evidenceRoot: f.evidence,
  });
  assert.equal(verified.outcome, "failed");
  assert.equal(verified.checks.no_duplicate_after_reconnect.passed, false);
});
