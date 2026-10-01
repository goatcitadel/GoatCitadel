import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { ProviderChangeStatus } from "./ProviderChangeStatus";

vi.mock("./ApprovedSettingsContinuation", () => ({ ApprovedSettingsContinuation: () => null }));
const checkpoint = {
  version: "provider_profile_checkpoint.v1" as const,
  providerId: "fixture",
  originalRevision: 7,
  appliedRevision: 8,
  intentHash: "a".repeat(64),
};
const plan: ChangePlanRecord = {
  schemaVersion: 1,
  planId: "plan",
  origin: { workspaceId: "default", surface: "settings" },
  adapter: { adapterId: "provider-connection", version: 3 },
  scope: "provider",
  revision: 3,
  kind: "provider_connection",
  status: "awaiting_input",
  phase: "input",
  title: "Create provider profile",
  summary: "Create profile",
  impact: "Adds the installation provider profile.",
  risk: "safe",
  request: { kind: "provider_connection", providerId: "fixture", profile: { label: "Fixture" } },
  intentHash: checkpoint.intentHash,
  target: { ownerId: "provider_connection", resourceId: "fixture", expectedRevision: 8 },
  result: { summary: "Profile saved; credential required", providerProfileCheckpoint: checkpoint },
  evidenceRefs: ["provider_profile:fixture:settings_revision:8"],
  approvalRefs: [],
  rollbackRefs: [],
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:01:00.000Z",
};
function markup(owner = plan) {
  return renderToStaticMarkup(
    <ProviderChangeStatus
      change={{
        receipt: { planId: "plan", revision: 3, status: "awaiting_input", risk: "safe", summary: "Create profile" },
        submitted: {},
        baseRevision: 7,
        blocking: true,
        message: "Create profile",
        plan: owner,
      }}
      onRefresh={async () => false}
    />,
  );
}
describe("provider partial-commit status", () => {
  it("distinguishes the saved profile from unfinished credential setup", () => {
    expect(markup()).toContain("Public profile saved at settings revision 8");
    expect(markup()).toContain("Credential setup is not confirmed");
  });
  it("withholds committed copy for foreign or unbound checkpoint evidence", () => {
    for (const owner of [
      { ...plan, evidenceRefs: [] },
      { ...plan, intentHash: "f".repeat(64) },
      { ...plan, target: { ...plan.target, resourceId: "foreign" } },
      { ...plan, result: { ...plan.result!, providerProfileCheckpoint: { ...checkpoint, originalRevision: 6 } } },
    ])
      expect(markup(owner)).not.toContain("Public profile saved");
  });
});
