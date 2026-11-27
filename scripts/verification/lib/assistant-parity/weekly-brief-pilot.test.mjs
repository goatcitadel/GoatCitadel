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
