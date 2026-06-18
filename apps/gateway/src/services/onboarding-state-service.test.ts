import { describe, expect, it, vi } from "vitest";
import { getOnboardingState, type OnboardingStateHost } from "./onboarding-state-service.js";

describe("onboarding-state-service", () => {
  it("adds Gateway-owned first-run checklist proof anchors to onboarding state", () => {
    const state = getOnboardingState(createHost());

    expect(state.firstRunChecklist?.map((item) => item.id)).toEqual([
      "provider_or_local_runtime",
      "first_chat",
      "first_cowork",
      "first_code",
      "run_detail",
    ]);
    expect(state.firstRunChecklist?.[0]).toEqual(
      expect.objectContaining({
        status: "complete",
        proofRefs: expect.arrayContaining([
          expect.objectContaining({ kind: "route", ref: "/settings/providers" }),
          expect.objectContaining({ kind: "verification_lane", ref: "scripts/verify-install.mjs" }),
        ]),
      }),
    );
    expect(state.firstRunChecklist?.find((item) => item.id === "first_code")).toEqual(
      expect.objectContaining({
        status: "needs_input",
        detail: expect.stringContaining("trusted-code execution"),
      }),
    );
  });
});

function createHost(): OnboardingStateHost {
  return {
    config: {
      assistant: {
        mesh: {
          enabled: false,
          mode: "lan",
          nodeId: "node-1",
          discovery: { mdns: true, staticPeers: [] },
          security: { requireMtls: false, tailnet: { enabled: false } },
        },
      },
      toolPolicy: {
        tools: { approvalMode: "approve_risky", profile: "standard" },
        sandbox: { networkAllowlist: [] },
      },
      budgets: { mode: "balanced" },
    } as never,
    llmService: {
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: "openai",
        activeModel: "gpt-5",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            apiStyle: "openai-responses",
            defaultModel: "gpt-5",
            hasApiKey: true,
            apiKeySource: "env",
          },
        ],
      })),
      getProviderSecretStatus: vi.fn(),
      resolveExecutionApiStyle: vi.fn(() => "openai-responses"),
    } as never,
    onboardingMarkerPath: "onboarding.json",
    onboardingMarker: {},
    getAuthRuntimeSettings: vi.fn(() => ({
      mode: "token",
      allowLoopbackBypass: false,
      tokenConfigured: true,
      basicConfigured: false,
    })),
    publishRealtime: vi.fn(),
    updateSettings: vi.fn(),
  };
}
