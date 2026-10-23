import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { repoRoot } from "../shared.mjs";
import { CLAUDE_CLI_USABILITY_TASKS, validateUsabilityTasks } from "./claude-cli-usability-tasks.mjs";

test("catalog ids are unique and well-formed", () => {
  const ids = CLAUDE_CLI_USABILITY_TASKS.map((task) => task.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[CRDKPME]-\d{2}$/);
  assert.equal(ids.length, 22);
});

test("catalog validates against the manual QA plan", () => {
  const qaPlan = fs.readFileSync(path.join(repoRoot, "docs", "QA_MANUAL_TEST_PLAN.md"), "utf8");
  assert.deepEqual(validateUsabilityTasks(CLAUDE_CLI_USABILITY_TASKS, qaPlan), []);
});

test("exactly the eight live-lane tasks are automatable and each one states an expected status", () => {
  const auto = CLAUDE_CLI_USABILITY_TASKS.filter((task) => task.automatable).map((task) => task.id);
  assert.deepEqual(auto, ["C-01", "C-02", "C-03", "R-01", "D-01", "K-01", "K-02", "K-03"]);
  for (const task of CLAUDE_CLI_USABILITY_TASKS.filter((t) => t.automatable)) assert.ok(task.expect.status.length > 0);
});

test("the catalog and every task in it are frozen", () => {
  assert.ok(Object.isFrozen(CLAUDE_CLI_USABILITY_TASKS));
  for (const task of CLAUDE_CLI_USABILITY_TASKS) assert.ok(Object.isFrozen(task), task.id);
});

test("validateUsabilityTasks reports unknown QA ids, bad enums, dangling dependsOn and personal data", () => {
  const bad = [
    {
      ...CLAUDE_CLI_USABILITY_TASKS[0],
      id: "C-99",
      qaIds: ["NOPE-01"],
      dependsOn: "X-01",
      prefs: { ...CLAUDE_CLI_USABILITY_TASKS[0].prefs, webMode: "turbo" },
      prompt: "mail me@x.test at C:\\Users\\me",
    },
  ];
  const problems = validateUsabilityTasks(bad, "### CHAT-01 Basic\n").join("\n");
  for (const fragment of ["NOPE-01", "webMode", "X-01", "personal"]) assert.match(problems, new RegExp(fragment));
});
