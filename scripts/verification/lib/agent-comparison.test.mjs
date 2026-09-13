import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPARISON_VERSION,
  PRODUCTS,
  COMPARISON_TASKS,
  ComparisonDispatchBudget,
  prepareComparison,
  summarizeComparison,
  sha256,
} from "./agent-comparison.mjs";
import { PERMISSION_REVIEW_VERSION } from "./agent-comparison-permissions.mjs";

function config() {
  return {
    schemaVersion: COMPARISON_VERSION,
    trials: 3,
    maxRequests: 150,
    maxCostUsd: 10,
    products: Object.fromEntries(
      PRODUCTS.map((product) => [
        product,
        {
          revision: "a".repeat(40),
          provider: "fixture",
          model: "fixture-model",
          tools: ["files", "terminal", "skills", "schedule"],
          grants: ["test-workspace"],
          reasoning: "medium",
          contextTokens: 32000,
          outputTokens: 4096,
          maxTaskMs: 600000,
        },
      ]),
    ),
  };
}
function receipt(manifest, cell, evidenceKind = "live") {
  const task = COMPARISON_TASKS.find((task) => task.id === cell.task);
  return {
    ...cell,
    manifestSha256: manifest.manifestSha256,
    revision: manifest.products[cell.product].revision,
    evidenceKind,
    outcome: "passed",
    requests: 1,
    costUsd: 0.01,
    durationMs: 1000,
    manualInterventions: 0,
    permissionEvidence: {
      schemaVersion: PERMISSION_REVIEW_VERSION,
      policy: {
        files: "workspace_only",
        terminal: "per_command_approval",
        skills: "review_before_activation",
        schedule: "authorized_destination",
      },
      evidenceSha256: sha256("controlled review fixture"),
    },
    verifier: "fixture-independent-verifier",
    verifierSha256: sha256("test verifier"),
    checks: Object.fromEntries(
      task.criteria.map((criterion) => [criterion, { passed: true, evidenceSha256: sha256(criterion) }]),
    ),
  };
}
describe("comparison outcome evidence", () => {
  it("withholds comparability for missing, unknown, or different native permissions despite matching tool labels", () => {
    const manifest = prepareComparison(config());
    const receipts = manifest.cells.map((cell) => receipt(manifest, cell));
    assert.equal(summarizeComparison(manifest, receipts).permissionEquivalence, "reviewed_equivalent");
    const missing = receipts.map(({ permissionEvidence, ...entry }) => {
      void permissionEvidence;
      return entry;
    });
    assert.equal(summarizeComparison(manifest, missing).status, "incomplete_or_not_comparable");
    assert.equal(summarizeComparison(manifest, missing).permissionEquivalence, "missing_or_unknown");
    const different = structuredClone(receipts);
    for (const entry of different.filter((item) => item.product === "hermes")) {
      entry.permissionEvidence.policy.files = "host_user";
      entry.permissionEvidence.policy.terminal = "risk_based_approval";
    }
    const report = summarizeComparison(manifest, different);
    assert.equal(report.declaredConfigurationComparable, true);
    assert.equal(report.permissionEquivalence, "different");
    assert.equal(report.comparable, false);
    assert.equal(report.status, "incomplete_or_not_comparable");
    const unknown = receipts.map((entry) => ({
      ...entry,
      permissionEvidence: {
        ...entry.permissionEvidence,
        policy: { ...entry.permissionEvidence.policy, terminal: "unknown" },
      },
    }));
    assert.equal(summarizeComparison(manifest, unknown).comparable, false);
    const invalid = structuredClone(receipts[0]);
    invalid.permissionEvidence.policy.terminal = "disabled";
    assert.throws(() => summarizeComparison(manifest, [invalid]), /declared tools/);
    invalid.permissionEvidence.policy.terminal = "invented";
    assert.throws(() => summarizeComparison(manifest, [invalid]), /permission policy/);
  });
  it("requires capture and review before new-session reuse without preinstalling the answer", () => {
    const task = COMPARISON_TASKS.find((item) => item.id === "workflow_capture_reuse");
    assert.deepEqual(
      task.phases.map((phase) => phase.id),
      ["source_workflow", "capture_review", "reuse"],
    );
    assert.equal(task.phases[2].newSession, true);
    assert.ok(task.phases[1].operatorAction);
    assert.ok(!Object.keys(task.files).some((name) => name.endsWith("SKILL.md")));
    assert.ok(!Object.hasOwn(task.files, "input/changes.json"));
    assert.ok(Object.hasOwn(task.phases[2].files, "input/changes.json"));
  });
  it("prepares 45 cells with rotated order, frozen fixtures, and no passing results", () => {
    const manifest = prepareComparison(config());
    assert.equal(manifest.cells.length, 45);
    assert.deepEqual(
      manifest.cells.slice(0, 3).map((cell) => cell.product),
      PRODUCTS,
    );
    assert.equal(manifest.cells[3].product, "openclaw");
    const report = summarizeComparison(manifest, []);
    assert.equal(report.status, "incomplete_or_not_comparable");
    assert.equal(report.requests, 0);
    assert.equal(report.unknownCostCells, 45);
  });
  it("rejects changed inputs, duplicate receipts, unpinned revisions, and model self-grading", () => {
    assert.throws(() => prepareComparison({ ...config(), trials: 1 }), /trials/);
    const manifest = prepareComparison(config());
    const first = receipt(manifest, manifest.cells[0]);
    assert.throws(() => summarizeComparison(manifest, [first, first]), /duplicate/);
    assert.throws(() => summarizeComparison(manifest, [{ ...first, revision: "b".repeat(40) }]), /pinned/);
    assert.throws(() => summarizeComparison(manifest, [{ ...first, verifier: "model_self_grade" }]), /independent/);
    assert.throws(() => summarizeComparison(manifest, [{ ...first, checks: {} }]), /criterion/);
    assert.throws(() => summarizeComparison({ ...manifest, maxRequests: 1000 }, []), /manifest/);
    const { manifestSha256, ...reduced } = structuredClone(manifest);
    void manifestSha256;
    reduced.cells.pop();
    assert.throws(() => summarizeComparison({ ...reduced, manifestSha256: sha256(reduced) }, []), /manifest/);
    const secretConfig = config();
    secretConfig.products.hermes.apiKey = "must-not-be-retained";
    assert.throws(() => prepareComparison(secretConfig), /unsupported fields/);
  });
  it("reports repeated observed outcomes without treating exclusions or unknown costs as zero", () => {
    const manifest = prepareComparison(config());
    const selected = manifest.cells.filter((cell) => cell.product === "goatcitadel" && cell.task === "cited_research");
    const report = summarizeComparison(manifest, [
      { ...receipt(manifest, selected[0]), durationMs: 100, unexpectedSecret: "must-not-be-retained" },
      { ...receipt(manifest, selected[1]), outcome: "failed", durationMs: 300, costUsd: null, manualInterventions: 2 },
      { ...receipt(manifest, selected[2]), evidenceKind: "controlled", durationMs: 1 },
    ]);
    assert.deepEqual(report.outcomes[0], {
      product: "goatcitadel",
      task: "cited_research",
      trials: 3,
      observed: 2,
      excluded: 1,
      passed: 1,
      failed: 1,
      successRate: 0.5,
      durationMs: { min: 100, median: 200, max: 300 },
      costUsd: null,
      manualInterventions: { min: 0, median: 1, max: 2 },
      timeToUsefulOutputMs: null,
      inputTokens: null,
      outputTokens: null,
      repeatedCorrections: null,
    });
    assert.equal(JSON.stringify(report).includes("must-not-be-retained"), false);
    assert.equal(report.outcomes.at(-1).successRate, null);
  });
  it("retains useful-output, token, and correction measurements without inventing missing values", () => {
    const manifest = prepareComparison(config());
    const selected = manifest.cells.filter((cell) => cell.product === "goatcitadel" && cell.task === "cited_research");
    const observed = selected.map((cell, index) => ({
      ...receipt(manifest, cell),
      timeToUsefulOutputMs: 100 + index * 50,
      inputTokens: 200 + index * 10,
      outputTokens: 30,
      repeatedCorrections: index,
      manualInterventions: index,
    }));
    const report = summarizeComparison(manifest, observed);
    assert.deepEqual(report.outcomes[0].timeToUsefulOutputMs, { min: 100, median: 150, max: 200 });
    assert.deepEqual(report.outcomes[0].inputTokens, { min: 200, median: 210, max: 220 });
    assert.deepEqual(report.outcomes[0].repeatedCorrections, { min: 0, median: 1, max: 2 });
    assert.equal(summarizeComparison(manifest, [{ ...observed[0], inputTokens: null }]).outcomes[0].inputTokens, null);
    assert.throws(
      () => summarizeComparison(manifest, [{ ...observed[0], timeToUsefulOutputMs: 1001 }]),
      /timeToUseful/,
    );
    assert.throws(() => summarizeComparison(manifest, [{ ...observed[0], inputTokens: -1 }]), /inputTokens/);
    assert.throws(() => summarizeComparison(manifest, [{ ...observed[0], outputTokens: 0.5 }]), /outputTokens/);
    assert.throws(() => summarizeComparison(manifest, [{ ...observed[0], repeatedCorrections: 1 }]), /corrections/);
  });

  it("never promotes controlled evidence, missing cost, or mismatched capabilities into comparable live results", () => {
    const manifest = prepareComparison(config());
    assert.equal(
      summarizeComparison(
        manifest,
        manifest.cells.map((cell) => receipt(manifest, cell, "controlled")),
      ).status,
      "incomplete_or_not_comparable",
    );
    assert.equal(
      summarizeComparison(
        manifest,
        manifest.cells.map((cell) => receipt(manifest, cell)),
      ).status,
      "comparable_live_results",
    );
    const different = config();
    different.products.hermes.outputTokens = 2048;
    const mismatch = prepareComparison(different);
    assert.equal(
      summarizeComparison(
        mismatch,
        mismatch.cells.map((cell) => receipt(mismatch, cell)),
      ).status,
      "incomplete_or_not_comparable",
    );
    assert.throws(
      () => summarizeComparison(manifest, [{ ...receipt(manifest, manifest.cells[0]), costUsd: null }]),
      /cost/,
    );
  });
});
describe("comparison dispatch budget", () => {
  it("recovers reservations after restart and rejects incomplete or conflicting journals", async () => {
    const events = [];
    const budget = new ComparisonDispatchBudget({
      maxRequests: 2,
      maxCostUsd: 1,
      persist: async (event) => events.push(event),
    });
    await budget.dispatch({ cellId: "one", role: "primary", maximumCostUsd: 0.5 }, async () => ({ costUsd: 0.2 }));
    await assert.rejects(
      budget.dispatch({ cellId: "two", role: "child", maximumCostUsd: 0.5 }, async () => {
        throw new Error("interrupted");
      }),
    );
    const restored = new ComparisonDispatchBudget({ maxRequests: 2, maxCostUsd: 1, persist: async () => {}, events });
    assert.deepEqual(restored.snapshot(), budget.snapshot());
    await assert.rejects(
      restored.dispatch({ cellId: "three", role: "retry", maximumCostUsd: 0.1 }, async () => ({ costUsd: 0 })),
      /exhausted/,
    );
    assert.throws(
      () =>
        new ComparisonDispatchBudget({
          maxRequests: 2,
          maxCostUsd: 1,
          persist: async () => {},
          events: events.slice(1),
        }),
      /incomplete/,
    );
    assert.throws(
      () =>
        new ComparisonDispatchBudget({
          maxRequests: 2,
          maxCostUsd: 1,
          persist: async () => {},
          events: [events[0], { ...events[1], cellId: "changed" }],
        }),
      /changed/,
    );
  });
  it("reserves durably before concurrent primary, retry, and child dispatches", async () => {
    const persisted = [];
    const calls = [];
    const budget = new ComparisonDispatchBudget({
      maxRequests: 2,
      maxCostUsd: 2,
      persist: async (receipt) => persisted.push(receipt),
    });
    const invoke = (role) =>
      budget.dispatch({ cellId: "cell-1", role, maximumCostUsd: 1 }, async () => {
        assert.ok(persisted.some((receipt) => receipt.role === role && receipt.state === "reserved"));
        calls.push(role);
        return { costUsd: 0.5 };
      });
    const results = await Promise.allSettled([invoke("primary"), invoke("child"), invoke("retry")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    assert.equal(calls.length, 2);
    assert.equal(budget.snapshot().requests, 2);
  });
  it("retains ambiguous costs and dispatches nothing when durable reservation fails", async () => {
    let called = false;
    const failedSink = new ComparisonDispatchBudget({
      maxRequests: 1,
      maxCostUsd: 1,
      persist: async () => {
        throw new Error("disk full");
      },
    });
    await assert.rejects(
      failedSink.dispatch({ cellId: "1", role: "primary", maximumCostUsd: 1 }, async () => {
        called = true;
      }),
      /disk full/,
    );
    assert.equal(called, false);
    const budget = new ComparisonDispatchBudget({ maxRequests: 3, maxCostUsd: 1, persist: async () => {} });
    await assert.rejects(
      budget.dispatch({ cellId: "1", role: "primary", maximumCostUsd: 1 }, async () => {
        throw new Error("connection lost");
      }),
      /connection lost/,
    );
    await assert.rejects(
      budget.dispatch({ cellId: "2", role: "retry", maximumCostUsd: 0.1 }, async () => ({ costUsd: 0 })),
      /exhausted/,
    );
    assert.equal(budget.snapshot().committedOrReservedUsd, 1);
  });
});
