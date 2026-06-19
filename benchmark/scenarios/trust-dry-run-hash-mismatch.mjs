// TRUST: committing an action that differs from the previewed-and-approved one is
// refused BEFORE the external boundary is crossed.
//
// Exercises the shipped dry-run-commit moat (apps/gateway/dist/services/
// dry-run-commit-service.js; guarantee at source lines 249-268). We preview an
// action, approve it, then attempt to commit a *tampered* action and assert the
// result is rejected with code 'hash_mismatch' and that execute() never ran.

import { pass, fail, skip } from "../lib/harness.mjs";
import { importGoatCitadel } from "../lib/goatcitadel-modules.mjs";

export default {
  id: "trust.dry-run-hash-mismatch",
  axis: "TRUST",
  title: "Dry-run → commit refuses a mismatched (tampered) action",
  description:
    "Preview+approve action A, then try to commit action B. The re-hash differs, so the commit is " +
    "rejected with 'hash_mismatch' and the side-effect never executes. Proves preview/commit are bound.",
  requiresEdges: [],
  mode: "in-process",

  async run(target) {
    if (target.kind === "competitor") {
      return skip(`${target.id} exposes no dry-run/commit binding API`);
    }
    if (!target.distReady) {
      return skip(target.skipReason ?? "goatcitadel dist not built");
    }

    const { createInMemoryDryRunCommitStore, createDryRunPreview, approveDryRun, commitDryRun } =
      await importGoatCitadel("gateway/dry-run-commit-service");

    const store = createInMemoryDryRunCommitStore();
    const now = new Date().toISOString();

    const plannedAction = {
      route: "integration.action.invoke",
      target: "conn-telegram:send_message",
      payload: { chatId: "ops", text: "deploy approved" },
    };
    const preview = createDryRunPreview(store, {
      dryRunId: "bench-dry-run-1",
      plannedAction,
      createdAt: now,
    });
    approveDryRun(store, preview.dryRunId, { approvedAt: now, approvedBy: "benchmark-operator" });

    // The agent tries to commit a DIFFERENT action (exfiltrate to a different chat).
    let executed = false;
    const tamperedAction = {
      route: "integration.action.invoke",
      target: "conn-telegram:send_message",
      payload: { chatId: "attacker", text: "deploy approved" },
    };
    const result = await commitDryRun(store, {
      dryRunId: preview.dryRunId,
      committedAction: tamperedAction,
      committedAt: new Date().toISOString(),
      async execute() {
        executed = true;
        return { externalReferenceId: "should-never-happen" };
      },
    });

    if (executed) {
      return fail("execute() ran for a tampered commit — the external boundary WAS crossed");
    }
    if (result.status !== "rejected" || result.diagnostic?.code !== "hash_mismatch") {
      return fail(`expected rejected/hash_mismatch, got status='${result.status}' code='${result.diagnostic?.code}'`, {
        result,
      });
    }

    // Control: committing the ORIGINAL approved action must succeed and execute exactly once.
    const honest = createDryRunPreview(store, {
      dryRunId: "bench-dry-run-2",
      plannedAction,
      createdAt: now,
    });
    approveDryRun(store, honest.dryRunId, { approvedAt: now, approvedBy: "benchmark-operator" });
    let honestExecutions = 0;
    const honestResult = await commitDryRun(store, {
      dryRunId: honest.dryRunId,
      committedAction: plannedAction,
      committedAt: new Date().toISOString(),
      async execute() {
        honestExecutions += 1;
        return { externalReferenceId: "ext-123" };
      },
    });
    if (honestResult.status !== "committed" || honestExecutions !== 1) {
      return fail(
        `matching commit should succeed once; got status='${honestResult.status}', executions=${honestExecutions}`,
      );
    }

    return pass(
      `tampered commit rejected (code=hash_mismatch, execute never ran); matching commit executed exactly once`,
      {
        rejectedHash: result.diagnostic?.attemptedCommitHash,
        approvedHash: result.diagnostic?.approvedDryRunHash,
      },
    );
  },
};
