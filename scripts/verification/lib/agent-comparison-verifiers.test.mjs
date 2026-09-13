import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  COMPARISON_TASKS,
  COMPARISON_VERSION,
  ComparisonDispatchBudget,
  PRODUCTS,
  prepareComparison,
  sha256,
} from "./agent-comparison.mjs";
import { verifyComparisonEvidence } from "./agent-comparison-verifiers.mjs";
import { recordComparisonCell } from "./agent-comparison-record.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./agent-comparison-permissions.mjs";

async function fixture(t, taskId) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-comparison-verifier-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  const evidenceRoot = path.join(root, "evidence");
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(evidenceRoot);
  const write = async (base, name, value) => {
    const filename = path.join(base, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, typeof value === "string" ? value : JSON.stringify(value));
  };
  const native = "Controlled adapter receipt for a local verifier test; no live agent or provider.\n";
  await write(evidenceRoot, "native.json", native);
  const execution = {
    schemaVersion: "goatcitadel.agent-comparison.execution.v1",
    taskId,
    product: "goatcitadel",
    source: "controlled_fixture",
    nativeReceipts: [{ path: "native.json", sha256: sha256(native) }],
  };
  for (const [name, value] of Object.entries(COMPARISON_TASKS.find((task) => task.id === taskId).files))
    await write(workspaceRoot, name, value);
  return {
    root,
    workspaceRoot,
    evidenceRoot,
    execution,
    output: (name, value) => write(workspaceRoot, name, value),
    evidence: (name, value) => write(evidenceRoot, name, value),
    verify: async () => {
      await write(evidenceRoot, "execution.json", execution);
      return verifyComparisonEvidence({ taskId, workspaceRoot, evidenceRoot });
    },
  };
}
const research = () => ({
  plans: [
    { name: "Atlas", includedGb: 100, monthlyPriceUsd: 12, source: "sources/atlas.md" },
    { name: "Beacon", includedGb: 50, monthlyPriceUsd: 9, source: "sources/beacon.md" },
    { name: "Beacon", includedGb: 100, monthlyPriceUsd: 15, source: "sources/beacon.md" },
  ],
  recommendation: { name: "Atlas", requiredGb: 80, source: "sources/atlas.md" },
});
const release = (change, evidence, claim) =>
  `# Release\n## What changed\n${change}\n## Evidence\n${evidence}\n## Unverified\n${claim}\n`;

describe("independent comparison verifiers", () => {
  it("binds native permission reviews to the execution and exact configuration evidence", async (t) => {
    const f = await fixture(t, "cited_research");
    Object.assign(f.execution, {
      executionId: "fixture-execution",
      manifestSha256: sha256("manifest"),
      cellId: "goatcitadel:cited_research:1",
      revision: "a".repeat(40),
      effectiveConfigSha256: sha256("configuration"),
      fixtureSha256: sha256("fixture"),
    });
    await f.output("answer.json", research());
    assert.equal((await f.verify()).permissionEvidence, null);
    const review = {
      schemaVersion: PERMISSION_REVIEW_VERSION,
      ...Object.fromEntries(
        ["executionId", "manifestSha256", "cellId", "revision", "effectiveConfigSha256", "fixtureSha256"].map((key) => [
          key,
          f.execution[key],
        ]),
      ),
      policy: { files: "workspace_only", terminal: "disabled", skills: "disabled", schedule: "disabled" },
      reviewedBy: "Controlled test fixture",
      reviewedAt: "2026-09-11T00:00:00.000Z",
      sourceReceipts: [...f.execution.nativeReceipts],
    };
    const retain = async (value) => {
      await f.evidence(PERMISSION_REVIEW_FILE, value);
      f.execution.nativeReceipts = [
        f.execution.nativeReceipts[0],
        { path: PERMISSION_REVIEW_FILE, sha256: sha256(JSON.stringify(value)) },
      ];
    };
    await retain(review);
    const verified = await f.verify();
    assert.deepEqual(verified.permissionEvidence.policy, review.policy);
    assert.equal(verified.permissionEvidence.evidenceSha256, sha256(JSON.stringify(review)));
    assert.equal(verified.evidenceKind, "controlled");
    await retain({ ...review, effectiveConfigSha256: sha256("changed") });
    await assert.rejects(f.verify(), /Permission review must bind/);
    await retain({ ...review, reviewedBy: "" });
    await assert.rejects(f.verify(), /Permission review must bind/);
    await retain({ ...review, sourceReceipts: [{ path: "unretained.json", sha256: sha256("absent") }] });
    await assert.rejects(f.verify(), /Permission review must bind/);
    await retain({ ...review, policy: { ...review.policy, terminal: "unknown" } });
    assert.equal((await f.verify()).permissionEvidence.policy.terminal, "unknown");
    await retain(review);
    await f.evidence(PERMISSION_REVIEW_FILE, { ...review, reviewedBy: "changed" });
    await assert.rejects(f.verify(), /Native receipt bytes changed/);
  });
  it("records a cell from fresh verification and every primary, retry, and child reservation", async (t) => {
    const f = await fixture(t, "cited_research");
    const manifest = prepareComparison({
      schemaVersion: COMPARISON_VERSION,
      trials: 3,
      maxRequests: 10,
      maxCostUsd: 2,
      products: Object.fromEntries(
        PRODUCTS.map((product) => [
          product,
          {
            revision: "a".repeat(40),
            provider: "controlled",
            model: "controlled-model",
            tools: ["files"],
            grants: ["test-workspace"],
            reasoning: "medium",
            contextTokens: 8192,
            outputTokens: 1024,
            maxTaskMs: 60_000,
          },
        ]),
      ),
    });
    const cell = manifest.cells[0];
    const measurements = {
      executionId: "controlled-execution-1",
      manifestSha256: manifest.manifestSha256,
      cellId: `${cell.product}:${cell.task}:${cell.trial}`,
      revision: manifest.products[cell.product].revision,
      effectiveConfigSha256: cell.effectiveConfigSha256,
      fixtureSha256: cell.fixtureSha256,
      durationMs: 100,
      manualInterventions: 0,
    };
    Object.assign(f.execution, measurements);
    await f.output("answer.json", research());
    await f.verify();
    const events = [];
    const budget = new ComparisonDispatchBudget({
      maxRequests: 10,
      maxCostUsd: 2,
      persist: async (event) => events.push(event),
    });
    for (const role of ["primary", "retry", "child"])
      await budget.dispatch({ cellId: measurements.cellId, role, maximumCostUsd: 0.5 }, async () => ({ costUsd: 0.1 }));
    const input = {
      manifest,
      taskId: cell.task,
      trial: cell.trial,
      workspaceRoot: f.workspaceRoot,
      evidenceRoot: f.evidenceRoot,
      journal: { manifestSha256: manifest.manifestSha256, events },
      measurements,
    };
    const recorded = await recordComparisonCell(input);
    assert.equal(recorded.receipt.outcome, "passed");
    assert.equal(recorded.receipt.requests, 3);
    assert.equal(recorded.receipt.evidenceKind, "controlled");
    assert.equal(recorded.receipt.costUsd, 0.1 + 0.1 + 0.1);
    assert.deepEqual(recorded.budgetSequences, [1, 2, 3]);
    await assert.rejects(
      recordComparisonCell({ ...input, measurements: { ...measurements, executionId: "another-run" } }),
      /native execution binding/,
    );
    await assert.rejects(
      recordComparisonCell({ ...input, journal: { ...input.journal, manifestSha256: "changed" } }),
      /pinned campaign/,
    );
    await assert.rejects(
      budget.dispatch({ cellId: measurements.cellId, role: "retry", maximumCostUsd: 0.5 }, async () => {
        throw new Error("response lost");
      }),
    );
    const blocked = await recordComparisonCell(input);
    assert.equal(blocked.receipt.outcome, "blocked");
    assert.equal(blocked.receipt.requests, 4);
    assert.equal(blocked.receipt.costUsd, null);
    await f.output("answer.json", { ...research(), recommendation: { name: "Beacon" } });
    assert.equal((await recordComparisonCell(input)).receipt.outcome, "failed");
  });

  it("hashes retained bytes as SHA-256 rather than a JSON encoding of Buffer", () => {
    const bytes = Buffer.from([0, 1, 255, 97]);
    assert.equal(sha256(bytes), createHash("sha256").update(bytes).digest("hex"));
    assert.equal(sha256(Buffer.from("receipt")), sha256("receipt"));
  });

  it("checks every research tier and source without promoting controlled evidence", async (t) => {
    const f = await fixture(t, "cited_research");
    await f.output("answer.json", research());
    const result = await f.verify();
    assert.equal(result.outcome, "passed");
    assert.equal(result.evidenceKind, "controlled");
    assert.equal(result.evidence["evidence/native.json"], f.execution.nativeReceipts[0].sha256);
    const wrong = research();
    wrong.plans[2].monthlyPriceUsd = 9;
    wrong.plans[0].source = "model-memory";
    await f.output("answer.json", wrong);
    const failed = await f.verify();
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.checks.correct_prices.passed, false);
    assert.equal(failed.checks.claims_cited.passed, false);
  });

  it("rejects rewritten fixtures, changed native evidence, and self-referencing receipts", async (t) => {
    const f = await fixture(t, "cited_research");
    await f.output("answer.json", research());
    await f.output("sources/atlas.md", "Rewritten input");
    assert.equal((await f.verify()).fixturesPreserved, false);
    await f.evidence("native.json", "tampered");
    await assert.rejects(f.verify(), /receipt bytes changed/);
    f.execution.nativeReceipts[0].path = "execution.json";
    await assert.rejects(f.verify(), /distinct/);
  });

  it("runs independent arithmetic probes and retains the actual focused test result", async (t) => {
    const f = await fixture(t, "code_repair");
    await f.output(
      "src/total.mjs",
      `export function totalCents(items) {
      return items.reduce((sum, { unitCents, quantity }) => {
        if (![unitCents, quantity].every((value) => Number.isInteger(value) && value >= 0)) throw new Error('invalid');
        return sum + unitCents * quantity;
      }, 0);
    }`,
    );
    await f.output(
      "total.test.mjs",
      `import {test} from 'node:test';
      import assert from 'node:assert/strict';
      import {totalCents} from './src/total.mjs';
      test('empty', () => assert.equal(totalCents([]), 0));
      test('multiple', () => assert.equal(totalCents([{unitCents:7,quantity:2},{unitCents:3,quantity:4}]),26));
      test('invalid', () => assert.throws(() => totalCents([{unitCents:-1,quantity:2}])));`,
    );
    const result = await f.verify();
    assert.equal(result.outcome, "passed");
    assert.match(result.verificationRuns.focusedCodeTests.output, /multiple/);
    assert.equal(result.evidence["verifier/focused-code-tests"], sha256(result.verificationRuns.focusedCodeTests));
    await f.output("src/total.mjs", "export const totalCents = () => 0;\n");
    const failed = await f.verify();
    assert.equal(failed.checks.correct_totals.passed, false);
    assert.equal(failed.checks.invalid_input_rejected.passed, false);
    assert.equal(failed.checks.focused_tests_pass.passed, false);
  });

  it("preserves launch facts and requires a useful document with a missing-owner warning", async (t) => {
    const f = await fixture(t, "document_generation");
    const report =
      "# Harbor\n## Executive summary\nLaunch 2030-03-14 for 25 pilot users.\n## Checklist\n- [ ] Ari: verify backup by 2030-03-10.\n- [ ] Rollback owner unassigned; assign by 2030-03-12.\n## Risks\nRollback lacks an owner.\n## Recommendation\nAssign before launch.\n";
    await f.output("report.md", report);
    assert.equal((await f.verify()).outcome, "passed");
    await f.output("report.md", report.replace("25", "250"));
    // The fixture is semantic text: a standalone quantity must remain distinguishable.
    assert.equal((await f.verify()).checks.facts_preserved.passed, false);
  });

  it("requires capture provenance and review before exact skill reuse in a different session", async (t) => {
    const f = await fixture(t, "workflow_capture_reuse");
    const source = release(
      "Missing attachment name",
      "attachment-name regression test passed",
      "every attachment format works",
    );
    await f.output("source-release.md", source);
    await f.output(
      "release.md",
      release("Duplicate reminder after reconnect", "reconnect regression test passed", "all providers are faster"),
    );
    await f.output(
      "input/changes.json",
      COMPARISON_TASKS.find((task) => task.id === "workflow_capture_reuse").phases[2].files["input/changes.json"],
    );
    const instructions =
      "# Inputs\nChange evidence.\n# Instructions\nSeparate changed, evidence and unverified sections.\n# Failure\nMissing facts stay unknown.\n# Verification\nCompare output to input.\n";
    await f.evidence("reviewed-skill.md", instructions);
    const hash = sha256(instructions);
    f.execution.workflow = {
      phases: [
        { id: "source_workflow", sessionId: "source", turnId: "source-turn", status: "completed" },
        {
          id: "capture_review",
          sessionId: "source",
          turnId: "capture-turn",
          sourceSessionId: "source",
          sourceTurnId: "source-turn",
          sourceArtifactSha256: sha256(source),
          instructionsSha256: hash,
          reviewedInstructionsSha256: hash,
          reviewDecision: "approved",
          skillVersionId: "version-1",
        },
        {
          id: "reuse",
          sessionId: "new-session",
          turnId: "reuse-turn",
          loadedInstructionsSha256: hash,
          skillVersionId: "version-1",
        },
      ],
      activationEvents: [{ skillVersionId: "version-1", instructionsSha256: hash }],
    };
    assert.equal((await f.verify()).outcome, "passed");
    f.execution.workflow.phases[2].sessionId = "source";
    assert.equal((await f.verify()).checks.reviewed_skill_loaded_in_new_session.passed, false);
    f.execution.workflow.phases[1].reviewedInstructionsSha256 = sha256("previous version");
    assert.equal((await f.verify()).checks.skill_captured_from_source.passed, false);
    f.execution.workflow.activationEvents.push({ skillVersionId: "unrequested" });
    assert.equal((await f.verify()).checks.no_unrequested_activation.passed, false);
  });

  it("requires one provider acknowledgment and a reconnect observation window", async (t) => {
    const f = await fixture(t, "scheduled_delivery");
    f.execution.delivery = {
      scheduleId: "controlled-schedule",
      scheduledFor: "2030-03-10T00:00:00Z",
      schedulePersisted: true,
      authorizedDestination: "controlled-test-chat",
      receipts: [
        {
          destination: "controlled-test-chat",
          message: "HARBOR PILOT CHECK",
          providerMessageId: "controlled-ack",
          acknowledgedAt: "2030-03-10T00:00:01Z",
        },
      ],
      reconnectedAt: "2030-03-10T00:00:02Z",
      observedUntil: "2030-03-10T00:00:32Z",
      pendingDeliveries: 0,
    };
    assert.equal((await f.verify()).outcome, "passed");
    f.execution.delivery.receipts.push({ ...f.execution.delivery.receipts[0], providerMessageId: "duplicate" });
    assert.equal((await f.verify()).checks.no_duplicate_after_reconnect.passed, false);
    f.execution.delivery.receipts[0].destination = "other-chat";
    assert.equal((await f.verify()).checks.authorized_destination.passed, false);
  });

  it("rejects parent paths, linked evidence roots, and linked code files", async (t) => {
    const f = await fixture(t, "code_repair");
    f.execution.nativeReceipts[0].path = "../workspace/src/total.mjs";
    await assert.rejects(f.verify(), /relative path/);
    f.execution.nativeReceipts[0].path = "native.json";
    const link = path.join(f.root, "evidence-link");
    await fs.symlink(f.evidenceRoot, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      verifyComparisonEvidence({ taskId: "code_repair", workspaceRoot: f.workspaceRoot, evidenceRoot: link }),
      /links/,
    );
    await fs.symlink(
      f.evidenceRoot,
      path.join(f.workspaceRoot, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(f.verify(), /Linked code/);
  });
});
