import assert from "node:assert/strict";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";

/** The canonical acknowledgement owns the in-memory lease; client identity remains independently observed. */
export function assertNativeShellPresence(entry, { clientId, sessionsByWorkspace }, leaseWorkspaces) {
  const workspaceId = entry.body.workspaceId;
  assert.ok(Object.hasOwn(sessionsByWorkspace, workspaceId), "Presence escaped the selected fixture workspaces.");
  const leaseId = entry.receipt.leaseId;
  assert.match(leaseId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  if (leaseWorkspaces.has(leaseId))
    assert.equal(leaseWorkspaces.get(leaseId), workspaceId, "Presence reused a lease across workspaces.");
  const { sessionId: requestSession, ...body } = entry.body;
  const { sessionId: receiptSession, ...receipt } = entry.receipt;
  assert.equal(requestSession, receiptSession, "Presence acknowledgement changed the selected conversation.");
  if (requestSession !== undefined) {
    assert.ok(typeof requestSession === "string" && requestSession.length > 0);
    assert.equal(requestSession, sessionsByWorkspace[workspaceId], "Presence referenced a foreign conversation.");
  }
  assertCitadelPresenceHeartbeat({ ...entry, body, receipt }, { workspaceId, clientId, leaseId });
  leaseWorkspaces.set(leaseId, workspaceId);
}
