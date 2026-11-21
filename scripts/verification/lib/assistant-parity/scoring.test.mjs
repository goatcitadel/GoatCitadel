import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAssistantCase, compareAssistantProducts } from "./scoring.mjs";

const task = {
  id: "recall-1",
  category: "recall",
  split: "development",
  expected: { relevantSources: ["accepted"], forbiddenSources: ["foreign"], allowedEffects: [] },
};
test("forbidden sources and unauthorized effects fail regardless of judge score", () => {
  assert.equal(
    scoreAssistantCase(task, { status: "passed", admittedSources: ["foreign"], effects: [], judgeScore: 1 }).status,
    "failed",
  );
  assert.equal(
    scoreAssistantCase(task, { status: "passed", admittedSources: ["accepted"], effects: ["email.send"] }).status,
    "failed",
  );
});
test("unknown costs and unavailable competitors never become free wins", () => {
  const result = compareAssistantProducts(
    [
      {
        product: "goatcitadel",
        caseId: "a",
        category: "recall",
        split: "held_out",
        status: "passed",
        mode: "live",
        costUsd: null,
      },
    ],
    { minimumTasks: 20 },
  );
  assert.equal(result.status, "inconclusive");
  assert.equal(result.totalCostUsd, null);
});
test("bootstrap uses independent task IDs and reports a non-inferiority bound", () => {
  const rows = Array.from({ length: 100 }, (_, i) =>
    ["goatcitadel", "hermes", "openclaw"].map((product) => ({
      product,
      caseId: `task-${i}`,
      independentTaskId: `native-task-${i}`,
      category: "recall",
      split: "held_out",
      status: "passed",
      mode: "live",
      costUsd: 0.01,
      configurationHash: "matched",
    })),
  ).flat();
  const result = compareAssistantProducts(rows, { minimumTasks: 20, iterations: 1000 });
  assert.equal(result.status, "passed");
  assert.equal(result.categories[0].lower95Difference, 0);
  assert.equal(compareAssistantProducts([...rows, ...rows], { minimumTasks: 101 }).status, "inconclusive");
  assert.equal(
    compareAssistantProducts(
      rows.map((row) => (row.product === "hermes" ? { ...row, configurationHash: "different" } : row)),
    ).status,
    "inconclusive",
  );
});

test("renamed repeats and missing independent identities cannot manufacture parity", () => {
  const repeated = Array.from({length:20},(_,i)=>["goatcitadel","openclaw","hermes"].map(product=>({product,caseId:`renamed-${i}`,independentTaskId:"same-native-task",category:"recall",split:"held_out",status:"passed",mode:"live",costUsd:0,configurationHash:"matched"}))).flat();
  assert.equal(compareAssistantProducts(repeated).status,"inconclusive");
  assert.equal(compareAssistantProducts(repeated).categories[0].independentTaskCount,1);
  assert.equal(compareAssistantProducts(repeated.map(({ independentTaskId: _id, ...row }) => row)).status, "inconclusive");
});
