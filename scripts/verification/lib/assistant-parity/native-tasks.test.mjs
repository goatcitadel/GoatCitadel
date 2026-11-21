import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildAssistantNativeTask, assistantIndependentTaskId, ASSISTANT_PARITY_SUITE } from "./native-tasks.mjs";
import { comparisonTasks } from "../agent-comparison.mjs";

test("every frozen case can select its real supervised action while numbered repetitions share an independent identity", async () => {
  const cases = JSON.parse(
    await fs.readFile(new URL("../../fixtures/assistant-parity/cases.json", import.meta.url), "utf8"),
  );
  assert.equal(cases.length, 144);
  const tasks = comparisonTasks({ suite: ASSISTANT_PARITY_SUITE });
  assert.equal(tasks.length, 144);
  for (const task of cases) {
    assert.ok(task.nativeTaskId);
    assert.equal(task.independentTaskId, assistantIndependentTaskId(task));
    const native = buildAssistantNativeTask(task);
    assert.equal(native.id, task.nativeTaskId);
    assert.equal(tasks.find((entry) => entry.id === task.nativeTaskId)?.assistantCase.id, task.id);
    assert.deepEqual(native.files, {});
    assert.deepEqual(native.phases, [{ id: "assistant_case", action: "run_assistant_case" }]);
  }
  assert.equal(new Set(cases.map((task) => task.nativeTaskId)).size, 144);
  for (const category of ["continuity", "procedural_learning", "proactiveness", "recovery", "smoothness"]) {
    const family = cases.filter((task) => task.category === category);
    assert.equal(
      new Set(family.map((task) => task.independentTaskId)).size,
      1,
      "Renumbered templates cannot manufacture independent tasks",
    );
  }
});
test("changing only a fixture marker or release number does not create another independent task", () => {
  const base = {
    id: "recall-01",
    category: "recall",
    prompt: "Find kestrelfixture001 on port 45433.",
    fixture: { kind: "corpus", query: "kestrelfixture001", fact: "kestrelfixture001 uses port 45433." },
  };
  assert.equal(
    assistantIndependentTaskId(base),
    assistantIndependentTaskId({
      ...base,
      id: "recall-99",
      prompt: "Find kestrelfixture099 on port 45499.",
      fixture: { ...base.fixture, query: "kestrelfixture099", fact: "kestrelfixture099 uses port 45499." },
    }),
  );
  assert.notEqual(
    assistantIndependentTaskId(base),
    assistantIndependentTaskId({ ...base, fixture: { ...base.fixture, forget: true } }),
  );
});
