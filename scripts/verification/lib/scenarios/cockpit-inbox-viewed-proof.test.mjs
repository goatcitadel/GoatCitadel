import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertInboxDeliverableProjection,
  assertInboxOwnerUnchanged,
  finishInboxProof,
} from "./cockpit-inbox-viewed-proof.mjs";

function fixture() {
  const workspaceId = "workspace-a",
    task = { taskId: "task-a", workspaceId, title: "Task" };
  const deliverable = {
    deliverableId: "delivery-a",
    taskId: task.taskId,
    title: "Report",
    deliverableType: "artifact",
    createdAt: "2026-09-30T00:00:00Z",
  };
  const projection = {
    readStatus: { scope: "browser_local" },
    authority: "derived_projection",
    workspaceId,
    generatedAt: "2026-09-30T00:00:00Z",
    items: [
      {
        version: "a".repeat(64),
        id: "task_deliverable:delivery-a",
        kind: "task_deliverable",
        group: "updates",
        title: "Report",
        summary: "A artifact deliverable was recorded for Task. Open Kanban to inspect its current record.",
        createdAt: deliverable.createdAt,
        source: { workspaceId, taskId: task.taskId, deliverableId: deliverable.deliverableId },
        href: "/ops/kanban?shell=classic&taskId=task-a",
      },
    ],
    counts: { updates: { known: 1, complete: false } },
    coverage: [{ source: "background_updates", state: "partial" }],
  };
  return { workspaceId, task, deliverable, projection };
}
describe("Inbox viewed browser owner assertions", () => {
  it("retains primary failure evidence and attempts all owned cleanup while reporting failures", async () => {
    const outcome = { status: "failed", error: "Details failed", artifacts: { screenshots: ["failure.png"] } };
    let archived = false;
    const result = await finishInboxProof(outcome, [
      [
        "Delete task",
        async () => {
          throw new Error("Owner unavailable");
        },
      ],
      [
        "Archive workspace",
        async () => {
          archived = true;
        },
      ],
    ]);
    assert.equal(archived, true);
    assert.equal(result.status, "failed");
    assert.match(result.error, /Details failed/u);
    assert.match(result.error, /Delete task: Error: Owner unavailable/u);
    assert.equal(result.metrics.cleanupFailed, true);
    assert.deepEqual(result.artifacts, outcome.artifacts);
    const passed = { status: "passed", artifacts: { screenshots: ["proof.png"] } };
    assert.equal(await finishInboxProof(passed, []), passed);
    assert.equal(
      (
        await finishInboxProof(passed, [
          [
            "Cleanup",
            async () => {
              throw new Error("failed");
            },
          ],
        ])
      ).status,
      "failed",
    );
  });
  it("binds the exact deliverable and its current source title without inventing execution", () => {
    const value = fixture();
    assert.equal(assertInboxDeliverableProjection(value).id, "task_deliverable:delivery-a");
    value.task.title = "New title";
    assert.throws(() => assertInboxDeliverableProjection(value));
    value.projection.items[0].summary =
      "A artifact deliverable was recorded for New title. Open Kanban to inspect its current record.";
    assertInboxDeliverableProjection(value);
  });
  it("rejects foreign, duplicate, risky and mismatched owner evidence", () => {
    for (const mutate of [
      (value) => {
        value.projection.items[0].source.workspaceId = "foreign";
      },
      (value) => {
        value.projection.items.push(structuredClone(value.projection.items[0]));
      },
      (value) => {
        value.projection.items[0].riskLevel = "danger";
      },
      (value) => {
        value.deliverable.taskId = "other";
      },
      (value) => {
        value.projection.items[0].source.deliverableId = "other";
      },
      (value) => {
        value.projection.counts.updates.complete = true;
      },
    ]) {
      const value = fixture();
      mutate(value);
      assert.throws(() => assertInboxDeliverableProjection(value));
    }
  });
  it("permits only generation and rolling coverage warning timestamps to change during local viewing", () => {
    const before = fixture().projection;
    before.items.push({
      id: "spend_coverage:seven_days",
      kind: "spend_coverage",
      group: "needs_attention",
      title: "Spend coverage gap",
      summary: "Missing usage",
      createdAt: before.generatedAt,
      source: { workspaceId: before.workspaceId },
      href: "/system/spend",
    });
    const after = structuredClone(before);
    after.generatedAt = "2026-09-30T00:01:00Z";
    after.items[1].createdAt = after.generatedAt;
    assertInboxOwnerUnchanged(before, after);
    for (const mutate of [
      (value) => {
        value.items = [];
      },
      (value) => {
        value.counts.updates.known = 0;
      },
      (value) => {
        value.items[0].summary = "Viewed";
      },
      (value) => {
        value.coverage[0].state = "current";
      },
      (value) => {
        value.items[0].createdAt = after.generatedAt;
      },
      (value) => {
        value.items[1].createdAt = "invalid";
      },
      (value) => {
        value.items[1].summary = "Known cost";
      },
      (value) => {
        value.items[1].source.workspaceId = "foreign";
      },
    ]) {
      const changed = structuredClone(after);
      mutate(changed);
      assert.throws(() => assertInboxOwnerUnchanged(before, changed));
    }
  });
});
