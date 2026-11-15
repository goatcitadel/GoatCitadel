import type { ApprovalRequest } from "@goatcitadel/contracts";
import { expect, it } from "vitest";
import { isInstallationSettingsApproval } from "./installation-settings-approval";

type Shape = Pick<ApprovalRequest, "kind" | "linkage" | "payload">;
const exact: Shape = {
  kind: "change_plan_effect",
  linkage: { workspaceId: "default", actionType: "change_plan_effect", operatorId: "operator" },
  payload: { planId: "plan-1", targetOwnerId: "runtime_settings" },
};

it("is true only for the exact install-wide Settings shape", () => {
  expect(isInstallationSettingsApproval(exact)).toBe(true);
});

it.each<[string, Shape]>([
  ["another kind", { ...exact, kind: "file.write" }],
  ["another workspace", { ...exact, linkage: { ...exact.linkage, workspaceId: "ws-b" } }],
  ["a session", { ...exact, linkage: { ...exact.linkage, sessionId: "s-1" } }],
  ["a turn", { ...exact, linkage: { ...exact.linkage, turnId: "t-1" } }],
  ["another target owner", { ...exact, payload: { ...exact.payload, targetOwnerId: "capability_plugins" } }],
  ["no target owner", { ...exact, payload: { planId: "plan-1" } }],
  ["no linkage", { ...exact, linkage: undefined }],
])("is false for %s", (_label, shape) => {
  expect(isInstallationSettingsApproval(shape)).toBe(false);
});
