import assert from "node:assert/strict";

export function assertPermissionProfileWrite({ before, request, receipt, owner, workspaceId }) {
  assert.deepEqual(receipt, owner, "The independent profile owner did not confirm the receipt.");
  assert.match(receipt.revision, /^[a-f0-9]{64}$/);
  assert.equal(receipt.builtin, false);
  assert.equal(receipt.status, "active");
  assert.equal(receipt.scope, "workspace");
  assert.equal(receipt.scopeRef, workspaceId);
  assert.ok(receipt.profileId && receipt.createdBy);
  assert.ok(Number.isFinite(Date.parse(receipt.createdAt)) && Number.isFinite(Date.parse(receipt.updatedAt)));
  assert.equal(request.expectedSelectionRevision, undefined, "This proof must not select policy defaults.");
  for (const field of ["label", "description", "approvalMode", "toolPatterns", "allow", "deny", "readAccessMode", "defaultForSurfaces"])
    assert.deepEqual(receipt[field] ?? (field === "defaultForSurfaces" ? [] : undefined), request[field]);
  assert.equal(receipt.approvalMode, "approve_all");
  assert.deepEqual(receipt.defaultForSurfaces ?? [], []);
  assert.deepEqual(Object.keys(request).sort(), ["label", "description", "approvalMode", "toolPatterns", "allow", "deny", "readAccessMode", "defaultForSurfaces",
    ...(before ? ["expectedRevision"] : ["scope", "scopeRef"])].sort());
  if (before) {
    assert.equal(request.expectedRevision, before.revision);
    assert.notEqual(receipt.revision, before.revision);
    for (const field of ["profileId", "scope", "scopeRef", "createdAt", "createdBy"]) assert.deepEqual(receipt[field], before[field]);
  } else {
    assert.equal(request.scope, "workspace"); assert.equal(request.scopeRef, workspaceId);
  }
}

export function assertPermissionProfileArchive({ before, request, receipt, owner }) {
  assert.deepEqual(request, { expectedRevision: before.revision });
  assert.deepEqual(receipt, { archived: true, profileId: before.profileId });
  assert.equal(owner.status, "archived"); assert.ok(Number.isFinite(Date.parse(owner.archivedAt)));
  assert.notEqual(owner.revision, before.revision);
  const stable = ({ revision: _r, status: _s, archivedAt: _a, updatedAt: _u, ...record }) => record;
  assert.deepEqual(stable(owner), stable(before));
}

export function assertTemporaryOverrideWrite({ request, receipt, owner, workspaceId, priorIds }) {
  assert.deepEqual(Object.keys(request).sort(), ["reason", "scope", "scopeRef", "ttlSeconds"]);
  assert.equal(request.scope, "workspace"); assert.equal(request.scopeRef, workspaceId); assert.equal(request.ttlSeconds, 600);
  assert.deepEqual(receipt, owner); assert.ok(receipt.overrideId && !priorIds.includes(receipt.overrideId));
  for (const key of ["scope", "scopeRef", "reason"]) assert.equal(receipt[key], request[key]);
  assert.equal(receipt.status, "active"); assert.ok(receipt.operatorId && receipt.createdBy);
  assert.ok(Math.abs(Date.parse(receipt.expiresAt) - Date.parse(receipt.createdAt) - 600_000) <= 1);
}

export function assertTemporaryOverrideEnded({ before, request, receipt, active }) {
  assert.deepEqual(request, {}); assert.equal(receipt.revoked, true); assert.equal(receipt.overrideId, before.overrideId);
  assert.equal(receipt.status, "revoked"); assert.equal(receipt.revokedBy, before.operatorId);
  assert.equal(receipt.override?.overrideId, before.overrideId); assert.equal(receipt.override?.status, "revoked");
  for (const field of ["operatorId", "scope", "scopeRef", "reason", "createdBy", "createdAt", "expiresAt"])
    assert.equal(receipt.override[field], before[field]);
  assert.ok(Number.isFinite(Date.parse(receipt.revokedAt))); assert.equal(receipt.override.revokedAt, receipt.revokedAt);
  assert.equal(active.some(item => item.overrideId === before.overrideId), false);
}
