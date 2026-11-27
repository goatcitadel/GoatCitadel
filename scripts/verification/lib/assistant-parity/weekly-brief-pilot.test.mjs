import assert from "node:assert/strict";
import test from "node:test";
import { gradeBriefPair, gradeWeeklyBrief, weeklyBriefCases } from "./weekly-brief-pilot.mjs";

test("grades section placement and flags a newly invented deadline despite matching overall facts", () => {
  const task = weeklyBriefCases[0];
  const disabled = gradeWeeklyBrief(
    "Ready for staging. Stale permissions; Asha will rerun the access audit on Tuesday.",
    task,
  );
  const enabled = gradeWeeklyBrief(
    "## Status\nStaging\n## Risks\nStale permissions\n## Next steps\nAsha reruns the access audit on Tuesday and Friday.",
    task,
  );
  assert.equal(disabled.ownerAndDateInNextSteps, false);
  assert.equal(enabled.ownerAndDateInNextSteps, true);
  assert.deepEqual(enabled.unsupportedDates, ["Friday"]);
  assert.deepEqual(gradeBriefPair(disabled, enabled), { improved: false, regression: true });
});

test("rejects a higher-scoring brief that reverses the recorded project status", () => {
  const task = weeklyBriefCases.find(({ id }) => id === "migration");
  const disabled = gradeWeeklyBrief("No tools are available for the task.", task);
  const enabled = gradeWeeklyBrief(
    "Status: Not started\nRisks: Duplicate addresses may affect delivery\nNext steps: Lena will review the exceptions on Thursday.",
    task,
  );

  assert.ok(enabled.score > disabled.score);
  assert.deepEqual(gradeBriefPair(disabled, enabled), { improved: false, regression: true });
});

test("flags an invented calendar date even if it uses the right weekday", () => {
  const task = weeklyBriefCases.find(({ id }) => id === "archives");
  const answer = "Status: The archive restore passed.\nRisks: Backup retention.\nNext steps: Niko verifies retention on Friday.";
  const disabled = gradeWeeklyBrief(answer, task);
  const enabled = gradeWeeklyBrief(answer.replace("Friday", "Friday, November 27, 2026"), task);

  assert.deepEqual(gradeBriefPair(disabled, enabled), { improved: false, regression: true });
});

test("flags a false risk dismissal even when the rest of the brief preserves the facts", () => {
  const task = weeklyBriefCases.find(({ id }) => id === "warehouse");
  const answer = "Status: The pilot reached the depot.\nRisks: Unstable barcode readers.\nNext steps: Omar will replace the readers on Monday.";
  const disabled = gradeWeeklyBrief(answer, task);
  const enabled = gradeWeeklyBrief(answer.replace("Unstable barcode readers.", "No significant risks from unstable barcode readers."), task);

  assert.deepEqual(gradeBriefPair(disabled, enabled), { improved: false, regression: true });
});
