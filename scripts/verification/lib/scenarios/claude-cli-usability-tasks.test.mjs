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

test("validateUsabilityTasks rejects an expect.replyMatches pattern that does not compile", () => {
  const bad = [{ ...CLAUDE_CLI_USABILITY_TASKS[0], id: "C-98", expect: { status: ["completed"], replyMatches: "(" } }];
  assert.match(validateUsabilityTasks(bad, "### CHAT-01 Basic\n").join("\n"), /C-98: expect\.replyMatches/);
});

test("the write-and-run code tasks run on safe_auto, so they reach the bridged tool path", () => {
  for (const id of ["K-01", "K-04"]) {
    assert.equal(CLAUDE_CLI_USABILITY_TASKS.find((task) => task.id === id).prefs.toolAutonomy, "safe_auto", id);
  }
});

test("planning and memory tasks run on safe_auto, so they can reach the tools they test (#563)", () => {
  // Manual autonomy gives the model no tools: P-01 could not delegate, P-02 never raised its Inbox approval,
  // P-03 had no tools to report, and M-01..M-03 never reached the memory tools.
  for (const id of ["P-01", "P-02", "P-03", "M-01", "M-02", "M-03"]) {
    assert.equal(CLAUDE_CLI_USABILITY_TASKS.find((task) => task.id === id).prefs.toolAutonomy, "safe_auto", id);
  }
});

test("tasks that need the web run with safe_auto tool autonomy, because manual autonomy blocks web tools", () => {
  for (const id of ["R-01", "R-02", "E-02"]) {
    assert.equal(CLAUDE_CLI_USABILITY_TASKS.find((task) => task.id === id).prefs.toolAutonomy, "safe_auto", id);
  }
});

test("validateUsabilityTasks rejects automatable combinations the live lane cannot run, and allows them for manual tasks", () => {
  const qaPlan = "### CHAT-01 Basic\n### CHAT-03 Edit\n";
  const base = { ...CLAUDE_CLI_USABILITY_TASKS.find((task) => task.id === "C-01") };
  const manual = { ...base, id: "C-10", automatable: false };
  const problemsFor = (task, before = [base]) => validateUsabilityTasks([...before, task], qaPlan).join("\n");
  assert.match(
    problemsFor({ ...base, id: "C-11", followUp: { action: "edit", content: "x" } }),
    /C-11: .*edit.*dependsOn/,
  );
  assert.match(problemsFor({ ...base, id: "C-12", followUp: { action: "fork" } }), /C-12: .*fork/);
  assert.match(
    problemsFor({ ...base, id: "C-13", dependsOn: "C-10" }, [base, manual]),
    /C-13: .*C-10.*not automatable/,
  );
  assert.equal(problemsFor({ ...manual, id: "C-14", followUp: { action: "fork" } }), "");
  assert.equal(problemsFor({ ...base, id: "C-15", dependsOn: "C-01", followUp: { action: "edit", content: "x" } }), "");
});
