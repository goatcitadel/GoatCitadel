import type { LocalOperatorOverrideRecord, PermissionProfileSnapshotRecord } from "@goatcitadel/contracts";
import { createEmptyPermissionProfileDraft, permissionProfileDraftToMutation } from "./helpers/permission-helpers";
import type { PermissionManagementOperation } from "./permission-management-binding";

export const permissionProfileFixture: PermissionProfileSnapshotRecord = {
  profileId: "permission-a",
  revision: "a".repeat(64),
  label: "Review policy",
  builtin: false,
  status: "active",
  scope: "workspace",
  scopeRef: "work-a",
  approvalMode: "approve_all",
  toolPatterns: ["session.status", "memory.read"],
  allow: [],
  deny: [],
  createdBy: "operator-a",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};
export const permissionFieldsFixture = permissionProfileDraftToMutation({
  ...createEmptyPermissionProfileDraft(),
  label: "Review policy",
});
export const permissionCreateFixture: PermissionManagementOperation = {
  kind: "create",
  fields: permissionFieldsFixture,
};
export const permissionOverrideFixture: LocalOperatorOverrideRecord = {
  overrideId: "override-a",
  operatorId: "operator-a",
  createdBy: "operator-a",
  scope: "workspace",
  scopeRef: "work-a",
  reason: "Review temporary access",
  status: "active",
  createdAt: "2026-09-30T00:00:00.000Z",
  expiresAt: "2026-09-30T00:10:00.000Z",
};
export const permissionOverrideCreateFixture: PermissionManagementOperation = {
  kind: "override-create",
  input: { scope: "workspace", scopeRef: "work-a", reason: permissionOverrideFixture.reason, ttlSeconds: 600 },
};
