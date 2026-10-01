import type { OnboardingState } from "@goatcitadel/contracts";
import { gatewayAuthSettingsFixture } from "./gateway-auth.test-support";

export function onboardingFixture(): OnboardingState {
  const settings = gatewayAuthSettingsFixture();
  const plan = settings.auth.plan;
  if (!plan) throw new Error("The onboarding fixture requires the Gateway auth readiness plan.");
  return {
    completed: false,
    checklist: [],
    settings: {
      revision: settings.revision,
      toolApprovalMode: settings.toolApprovalMode,
      budgetMode: settings.budgetMode,
      networkAllowlist: settings.networkAllowlist,
      auth: { ...settings.auth, plan },
      mesh: settings.mesh,
      llm: {
        activeProviderId: "provider-a",
        activeModel: "model-a",
        providers: [
          {
            providerId: "provider-a",
            label: "Provider A",
            baseUrl: "http://127.0.0.1:9999/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "model-a",
            hasApiKey: false,
            apiKeySource: "none",
          },
        ],
      },
    },
    firstTask: { status: "not_observed", checkedAt: "2026-09-30T00:00:00.000Z" },
    setupReadiness: {
      generatedAt: "2026-09-30T00:00:00.000Z",
      profile: {
        gatewayUrl: "http://127.0.0.1:8787",
        authMode: "token",
        deploymentPosture: "local_trusted",
        tailnetMode: "disabled",
      },
      summary: { ready: 1, needsInput: 0, blocked: 0, unknown: 0 },
      items: [
        { id: "provider", label: "Provider", status: "ready", value: "Provider A", detail: "Connection verified" },
      ],
    },
  };
}
