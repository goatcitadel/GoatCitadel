import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFirstRunPreserved,
  isFirstRunOwnerWrite,
  onboardingBindingDifferences,
  onboardingStateReadsFromResponse,
} from "./cockpit-first-run-proof.mjs";
const fixture = () => ({ before: { completed: false, settings: { revision: 3 }, firstTask: { status: "not_observed" } },
  after: { completed: false, settings: { revision: 3 }, firstTask: { status: "not_observed" } },
  writes: [{ method: "POST", path: "/api/v1/onboarding/complete", body: { completedBy: "operator" } }], forwarded: 0 });
test("accepts exact intercepted completion and unchanged real owner", () => assert.doesNotThrow(() => assertFirstRunPreserved(fixture())));
test("rejects real marker/settings/inference changes or a forwarded completion", () => {
  for (const change of [{ after: { completed: true } }, { after: { ...fixture().after, settings: { revision: 4 } } },
    { after: { ...fixture().after, firstTask: { status: "verified" } } }, { forwarded: 1 }])
    assert.throws(() => assertFirstRunPreserved({ ...fixture(), ...change }));
});
test("rejects duplicate or changed completion payload and unrelated writes", () => {
  for (const writes of [[...fixture().writes, ...fixture().writes], [{ ...fixture().writes[0], body: { completedBy: "foreign" } }],
    [{ method: "PATCH", path: "/api/v1/settings", body: {} }]])
    assert.throws(() => assertFirstRunPreserved({ ...fixture(), writes }));
});
test("records owner mutations but not the shell's presence lease or event-bridge token", () => {
  for (const [method, pathname] of [["POST", "/api/v1/onboarding/complete"], ["PATCH", "/api/v1/settings"], ["PUT", "/api/v1/settings/x"], ["DELETE", "/api/v1/x"]])
    assert.equal(isFirstRunOwnerWrite(method, pathname), true, `${method} ${pathname}`);
  for (const [method, pathname] of [["PUT", "/api/v1/notifications/presence"], ["POST", "/api/v1/notifications/presence"],
    ["POST", "/api/v1/auth/sse-token"], ["GET", "/api/v1/onboarding/state"], ["POST", "/assets/app.js"]])
    assert.equal(isFirstRunOwnerWrite(method, pathname), false, `${method} ${pathname}`);
});

test("onboarding diagnostics read direct and batched onboarding-state bodies only", () => {
  const state = { completed: false, settings: { revision: 3 } };
  assert.deepEqual(onboardingStateReadsFromResponse("http://127.0.0.1:1/api/v1/onboarding/state", state), [
    { transport: "direct", body: state },
  ]);
  const reads = JSON.stringify([
    { path: "/api/v1/settings", correlationId: "a" },
    { path: "/api/v1/onboarding/state", correlationId: "b" },
    { path: "/api/v1/onboarding/state", correlationId: "c" },
  ]);
  const batch = `http://127.0.0.1:1/api/v1/startup-reads?${new URLSearchParams({ reads })}`;
  assert.deepEqual(
    onboardingStateReadsFromResponse(batch, {
      items: [
        { status: 200, bodyText: "{}", headers: {} },
        { status: 200, bodyText: JSON.stringify(state), headers: {} },
        { status: 409, bodyText: "", headers: {}, directReadRequired: true },
      ],
    }),
    [
      { transport: "batched", body: state },
      { transport: "batched", unanswered: true },
    ],
  );
  assert.deepEqual(onboardingStateReadsFromResponse("http://127.0.0.1:1/api/v1/settings", state), []);
  assert.deepEqual(onboardingStateReadsFromResponse("http://127.0.0.1:1/api/v1/startup-reads?reads=%7B", {}), []);
});

test("onboarding diagnostics name the binding fields that differ", () => {
  const provider = { id: "provider", status: "ready", value: "Stub / model" };
  const left = {
    completed: false,
    settings: { revision: 3, toolApprovalMode: "approve_all", llm: { providers: [{ id: "a", models: 1 }] } },
    setupReadiness: { items: [provider, { id: "first_run", status: "unknown" }] },
    firstTask: { status: "pending" },
  };
  const right = structuredClone(left);
  right.settings.llm.providers[0].models = 2;
  right.settings.features = { claudeCliWarmContinuationEnabled: true };
  right.setupReadiness.items[1].status = "ready";
  right.firstTask.status = "verified";
  assert.deepEqual(onboardingBindingDifferences(left, right), [
    "$.settings.llm.providers.0.models",
    "$.settings.features",
  ]);
  assert.deepEqual(onboardingBindingDifferences(left, structuredClone(left)), []);
});

test("first-run diagnostics mirror the contracts startup-read batch path", async () => {
  const { readFile } = await import("node:fs/promises");
  const contracts = await readFile(new URL("../../../../packages/contracts/src/gateway-startup-reads.ts", import.meta.url), "utf8");
  const proof = await readFile(new URL("./cockpit-first-run-proof.mjs", import.meta.url), "utf8");
  const owner = contracts.match(/STARTUP_READ_BATCH_PATH = "([^"]+)"/u)?.[1];
  assert.ok(owner);
  assert.ok(proof.includes(`const STARTUP_READ_BATCH_PATH = "${owner}";`));
});
