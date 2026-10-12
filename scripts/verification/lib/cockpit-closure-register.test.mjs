import assert from "node:assert/strict";
import test from "node:test";
import { buildCockpitClosureRegister, validateCockpitClosureRegister } from "./cockpit-closure-register.mjs";

const ledger = {
  findings: [
    {
      id: "CH-01",
      owner_task: 7,
      acceptance_criterion: "Cancel sends no decision",
      current_implementation_status: "pending",
      evidence_references: [],
    },
  ],
};
const inventory = {
  routes: [
    {
      id: "chat/root",
      legacy_url: "/chat",
      native_destination: "/chat",
      owner_task: 13,
      acceptance: { actions: "Send and stop" },
      parity_verified: false,
    },
  ],
  legacy_adapters: [{ id: "legacy-chat", owner_task: 2 }],
  shell_capabilities: [{ id: "shell-01", owner_task: 12 }],
};
test("preserves historical findings and inventories without claiming source presence as acceptance", () => {
  const original = structuredClone({ ledger, inventory });
  const register = buildCockpitClosureRegister({
    revision: "a".repeat(40),
    ciRevision: "b".repeat(40),
    sourceDigest: "c".repeat(64),
    ledger,
    inventory,
  });
  assert.deepEqual({ ledger, inventory }, original);
  assert.equal(register.findings.length, 1);
  assert.equal(register.findings[0].status, "pending_recheck");
  assert.equal(register.capabilities.length, 3);
  assert.equal(register.capabilities[0].parityVerified, false);
  assert.equal(register.retirement.ready, false);
  assert.deepEqual(validateCockpitClosureRegister(register), []);
});
test("rejects duplicate identifiers and acceptance without revision-bound evidence", () => {
  const register = {
    revision: "a".repeat(40),
    findings: [{ id: "CH-01", status: "pending_recheck", evidence: [] }],
    capabilities: [{ id: "chat/root", status: "pending_recheck", evidence: [] }],
  };
  register.findings.push(structuredClone(register.findings[0]));
  register.capabilities[0].status = "verified";
  register.capabilities[0].parityVerified = true;
  assert.ok(validateCockpitClosureRegister(register).some((error) => error.includes("duplicate")));
  assert.ok(validateCockpitClosureRegister(register).some((error) => error.includes("evidence")));
});

test("requires the actual source digest as well as the baseline SHA for dirty candidates", () => {
  const register = buildCockpitClosureRegister({
    revision: "a".repeat(40),
    ciRevision: "b".repeat(40),
    sourceDigest: "c".repeat(64),
    ledger,
    inventory,
  });
  const row = register.capabilities[0];
  row.status = "verified";
  row.parityVerified = true;
  row.evidence = [
    { revision: register.revision, sourceDigest: "d".repeat(64), outcome: "passed", artifact: "proof.json" },
  ];
  assert.ok(validateCockpitClosureRegister(register).some((error) => error.includes("candidate-bound")));
  row.evidence[0].sourceDigest = register.sourceDigest;
  assert.deepEqual(validateCockpitClosureRegister(register), []);
});
