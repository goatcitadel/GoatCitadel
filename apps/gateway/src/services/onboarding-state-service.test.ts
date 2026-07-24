import { describe, expect, it, vi } from "vitest";
import { getOnboardingStartupState, getOnboardingState, type OnboardingStateHost } from "./onboarding-state-service.js";

describe("onboarding-state-service", () => {
  it("propagates the config-generation read fence instead of returning a mixed onboarding snapshot", () => {
    const host = createHost();
    const fence = new Error("settings generation is reconciling");
    host.readSettingsRevision = vi.fn(() => {
      throw fence;
    });

    expect(() => getOnboardingState(host)).toThrow(fence);
  });

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
    expect(state.setupReadiness).toEqual(
      expect.objectContaining({
        profile: expect.objectContaining({
          gatewayUrl: "http://127.0.0.1:8787",
          authMode: "token",
          deploymentPosture: "local_trusted",
        }),
        summary: expect.objectContaining({ unknown: 2 }),
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "desktop_credentials",
            status: "unknown",
            detail: expect.stringContaining("does not expose bearer tokens"),
          }),
          expect.objectContaining({
            id: "release_proof",
            status: "unknown",
            value: "exact-SHA certificate required",
          }),
        ]),
      }),
    );
  });

  it("projects remote profile setup blockers without probing heavyweight provider state", () => {
    const oldGatewayUrl = process.env.GOATCITADEL_GATEWAY_URL;
    const oldOrigins = process.env.GOATCITADEL_ALLOWED_ORIGINS;
    process.env.GOATCITADEL_GATEWAY_URL = "https://citadel.example.test";
    delete process.env.GOATCITADEL_ALLOWED_ORIGINS;

    try {
      const state = getOnboardingStartupState(
        createHost({
          deploymentProfile: "remote_hardened",
          authMode: "token",
          tokenConfigured: false,
          networkAllowlist: ["*"],
          meshMode: "tailnet",
          tailnetEnabled: false,
        }),
      );

      expect(state.setupReadiness).toEqual(
        expect.objectContaining({
          profile: expect.objectContaining({
            gatewayUrl: "https://citadel.example.test",
            authMode: "token",
            deploymentPosture: "remote_hardened",
            tailnetMode: "disabled",
          }),
          summary: expect.objectContaining({
            blocked: 2,
            needsInput: 1,
          }),
        }),
      );
    } finally {
      restoreEnv("GOATCITADEL_GATEWAY_URL", oldGatewayUrl);
      restoreEnv("GOATCITADEL_ALLOWED_ORIGINS", oldOrigins);
    }
  });
});

function createHost(
  options: {
    deploymentProfile?: "local_dev" | "trusted_local" | "remote_hardened";
    authMode?: "none" | "token" | "basic";
    tokenConfigured?: boolean;
    basicConfigured?: boolean;
    networkAllowlist?: string[];
    meshMode?: "lan" | "wan" | "tailnet";
    tailnetEnabled?: boolean;
  } = {},
): OnboardingStateHost {
  return {
    config: {
      rootDir: "C:\\goatcitadel",
      assistant: {
        deploymentProfile: options.deploymentProfile ?? "local_dev",
        dataDir: "data",
        mesh: {
          enabled: false,
          mode: options.meshMode ?? "lan",
          nodeId: "node-1",
          discovery: { mdns: true, staticPeers: [] },
          security: { requireMtls: false, tailnet: { enabled: options.tailnetEnabled ?? false } },
        },
      },
      toolPolicy: {
        tools: { approvalMode: "approve_risky", profile: "standard" },
        sandbox: { networkAllowlist: options.networkAllowlist ?? [] },
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
      mode: options.authMode ?? "token",
      allowLoopbackBypass: false,
      tokenConfigured: options.tokenConfigured ?? true,
      basicConfigured: options.basicConfigured ?? false,
    })),
    publishRealtime: vi.fn(),
    updateSettings: vi.fn(),
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
