import { describe, expect, it } from "vitest";
import type { OnboardingSetupReadinessItem } from "@goatcitadel/contracts";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { presentReadinessValue, presentSetupCenterItems } from "./setup-vocabulary";

const readiness = (id: OnboardingSetupReadinessItem["id"], value: string): OnboardingSetupReadinessItem => ({
  id,
  label: id,
  status: "ready",
  value,
  detail: "Detail.",
});

describe("presentReadinessValue", () => {
  it("labels enum readiness values and leaves free-form ones for technical details", () => {
    expect(presentReadinessValue(readiness("remote_posture", "local_trusted"))).toBe("Trusted local");
    expect(presentReadinessValue(readiness("tailnet", "not_required"))).toBe("Not needed");
    expect(presentReadinessValue(readiness("auth_mode", "token"))).toBe("Access token");
    expect(presentReadinessValue(readiness("tailnet", "something_new"))).toBe("Unknown");
    expect(presentReadinessValue(readiness("gateway_url", "http://127.0.0.1:8787"))).toBeUndefined();
  });
});

describe("presentSetupCenterItems", () => {
  it("restates the Gateway's raw runtime, auth and model values in plain words", () => {
    const state = onboardingFixture();
    state.checklist = [
      {
        id: "runtime",
        label: "Runtime defaults",
        status: "complete",
        detail: `Tool approvals approve_risky / budget balanced.`,
      },
    ];
    state.settings = {
      ...state.settings,
      toolApprovalMode: "approve_risky",
      budgetMode: "balanced",
      auth: { ...state.settings.auth, mode: "token" },
      llm: {
        ...state.settings.llm,
        providers: state.settings.llm.providers.map((provider) => ({ ...provider, hasApiKey: true })),
      },
    };
    const items = presentSetupCenterItems(state, "Model A · Provider A");
    const descriptionOf = (label: string) => items.find((item) => item.label === label)?.description;
    expect(descriptionOf("Local runtime")).toBe("Risky tool calls need approval · Balanced budget.");
    expect(descriptionOf("Access and auth")).toBe("Gateway sign-in: Access token.");
    expect(descriptionOf("Provider smoke")).toBe(
      "1 provider credential source available. Active model: Model A · Provider A.",
    );
    const text = items.map((item) => item.description).join(" ");
    for (const raw of ["approve_risky", "balanced", "token gateway", "model-a"]) expect(text).not.toContain(raw);
  });

  it("keeps the shared guidance when the runtime step is not complete", () => {
    const state = onboardingFixture();
    state.checklist = [
      { id: "runtime", label: "Runtime defaults", status: "needs_input", detail: "Choose a tool approval mode." },
    ];
    const runtime = presentSetupCenterItems(state, "Model A").find((item) => item.label === "Local runtime");
    expect(runtime?.description).toBe("Choose a tool approval mode.");
  });
});
