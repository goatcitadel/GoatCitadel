import { describe, expect, it } from "vitest";
import type { OnboardingState } from "@goatcitadel/contracts";
import { projectFirstRunState } from "./first-run-state";

const state = {
  completed: false,
  checklist: [],
  settings: { revision: 3, toolApprovalMode: "approve_all", budgetMode: "balanced", networkAllowlist: [],
    llm: { activeProviderId: "provider-a", activeModel: "model-a", providers: [] } },
  firstTask: { status: "verified", checkedAt: "2026-09-28T00:00:00.000Z", completedAt: "2026-09-28T00:00:00.000Z", sessionId: "s", turnId: "t", providerId: "provider-a", model: "model-a" },
  setupReadiness: { items: [{ id: "provider", status: "ready" }] },
} as unknown as OnboardingState;

describe("first-run evidence", () => {
  it("does not call an older verified response current readiness when the provider is stale", () => {
    expect(projectFirstRunState({ ...state, setupReadiness: undefined })).toMatchObject({ modelReady: false, firstResponseVerified: true, firstResponseLabel: "Verified before · recheck the connection" });
  });

  it("requires a selected model and does not present bypass as a safe posture", () => {
    expect(projectFirstRunState({ ...state, settings: { ...state.settings, llm: { ...state.settings.llm, activeModel: "" }, toolApprovalMode: "bypass" } })).toMatchObject({ modelReady: false, safeApprovalMode: false });
  });
});
