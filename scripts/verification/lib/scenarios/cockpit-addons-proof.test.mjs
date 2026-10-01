import assert from "node:assert/strict";
import { it } from "node:test";
import { assertAddonProofBoundary } from "./cockpit-addons-proof.mjs";
it("permits only cancelled or intercepted install attempts with unchanged owner evidence", () => {
  const before = { addon: { addonId: "arena" }, status: "not_installed" };
  const attempt = { method: "POST", pathname: "/api/v1/addons/arena/install", input: { confirmRepoDownload: true, actorId: "operator" }, forwarded: false };
  assert.doesNotThrow(() => assertAddonProofBoundary({ before, after: before, attempts: [], cancelled: true }));
  const input = { before, after: before, attempts: [attempt], cancelled: false };
  assert.doesNotThrow(() => assertAddonProofBoundary(input));
  for (const patch of [{ after: { ...before, status: "installed" } }, { attempts: [{ ...attempt, forwarded: true }] },
    { attempts: [attempt, attempt] }, { attempts: [{ ...attempt, pathname: "/api/v1/addons/arena/launch" }] }, { cancelled: true }])
    assert.throws(() => assertAddonProofBoundary({ ...input, ...patch }));
});
