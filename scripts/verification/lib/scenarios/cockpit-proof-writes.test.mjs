import assert from "node:assert/strict";
import test from "node:test";
import { classifyCockpitProofWrite } from "./cockpit-proof-writes.mjs";

test("retains notification presence as evidence separate from owner mutations", () => {
  assert.equal(classifyCockpitProofWrite("PUT", "/api/v1/notifications/presence"), "presence");
});

for (const method of ["POST", "PATCH", "DELETE"]) {
  test(`${method} to the presence path remains an owner mutation`, () => {
    assert.equal(classifyCockpitProofWrite(method, "/api/v1/notifications/presence"), "owner");
  });
}

for (const pathname of [
  "/api/v1/notifications/presence/",
  "/api/v1/notifications/presence-extra",
  "/api/v1/notifications/settings",
  "/api/v1/notifications/Presence",
  "/api/v1/notifications/%70resence",
  "/api/v1/workspaces",
  "/api/v1/mcp/servers/test",
  "/api/v1/personalities/default",
]) {
  test(`PUT ${pathname} remains an owner mutation`, () => {
    assert.equal(classifyCockpitProofWrite("PUT", pathname), "owner");
  });
}

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} to other API owners remains visible`, () => {
    assert.equal(classifyCockpitProofWrite(method, "/api/v1/settings"), "owner");
    assert.equal(classifyCockpitProofWrite(method, "/other/presence"), undefined);
  });
}

for (const method of ["GET", "HEAD", "OPTIONS"]) {
  test(`${method} is not a mutation`, () => {
    assert.equal(classifyCockpitProofWrite(method, "/api/v1/notifications/presence"), undefined);
    assert.equal(classifyCockpitProofWrite(method, "/api/v1/settings"), undefined);
  });
}
