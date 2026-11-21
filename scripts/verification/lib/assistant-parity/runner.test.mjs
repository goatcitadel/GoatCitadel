import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAssistantParityReceipt, separateStageTimings } from "./runner.mjs";

const binding = {
  mode: "fixture",
  product: "goatcitadel",
  productRef: "a".repeat(40),
  configurationHash: "b".repeat(64),
  model: "fixture:no-provider",
  split: "development",
  caseId: "recall-1",
};
const receipt = {
  ...binding,
  source: "component_fixture",
  status: "passed",
  admittedSources: [],
  effects: [],
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  timings: { providerMs: 0, operatorMs: 30000, totalMs: 30005, localMs: 5 },
};
test("requires exact product/ref/config/model/source provenance", () => {
  for (const key of ["product", "productRef", "configurationHash", "model"])
    assert.throws(() => validateAssistantParityReceipt({ ...receipt, [key]: undefined }, binding));
  assert.throws(() => validateAssistantParityReceipt({ ...receipt, model: "another-model" }, binding));
  assert.throws(() => validateAssistantParityReceipt({ ...receipt, mode: "live" }, binding));
  assert.throws(() => validateAssistantParityReceipt({ ...receipt, source: "native_receipts" }, binding));
  assert.throws(() => validateAssistantParityReceipt({ ...receipt, split: "held_out" }, binding));
  assert.throws(() =>
    validateAssistantParityReceipt(
      { ...receipt, mode: "live", source: "native_receipts" },
      { ...binding, mode: "live" },
    ),
  );
});
test("human wait is never folded into provider latency", () => {
  assert.deepEqual(separateStageTimings(receipt.timings), {
    providerMs: 0,
    operatorMs: 30000,
    localMs: 5,
    totalMs: 30005,
  });
  assert.throws(() => separateStageTimings({ ...receipt.timings, providerMs: 30000 }));
});

test("native evidence needs a reviewed independent task identity", () => {
  const nativeBinding = { ...binding, mode: "live" };
  const native = { ...receipt, ...nativeBinding, source: "native_receipts" };
  assert.throws(() => validateAssistantParityReceipt(native, nativeBinding, { maxCostUsd: 1 }), /independent task/);
  const bound = { ...nativeBinding, independentTaskId: "reviewed-native-task" };
  assert.equal(
    validateAssistantParityReceipt({ ...native, ...bound }, bound, { maxCostUsd: 1 }).independentTaskId,
    bound.independentTaskId,
  );
  assert.throws(
    () =>
      validateAssistantParityReceipt({ ...native, ...bound, independentTaskId: "renamed-case" }, bound, {
        maxCostUsd: 1,
      }),
    /independent task/,
  );
});
