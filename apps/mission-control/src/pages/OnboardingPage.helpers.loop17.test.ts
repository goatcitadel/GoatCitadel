import { describe, expect, it } from "vitest";
import {
  hasUnsavedOnboardingDraft,
  isAbortError,
  matchAllowlistPreset,
  parseMultiline,
  readOnboardingActiveProvider,
} from "./OnboardingPage";

function onboardingState(overrides: Record<string, unknown> = {}) {
  return {
    completed: false,
    settings: {
      auth: {
        mode: "none",
        allowLoopbackBypass: false,
      },
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5.4",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            apiStyle: "openai-responses",
            defaultModel: "gpt-5.4",
            apiKeySource: "env",
            apiKeyRef: "OPENAI_API_KEY",
          },
        ],
      },
      defaultToolProfile: "coding",
      budgetMode: "balanced",
      networkAllowlist: ["127.0.0.1", "localhost"],
      mesh: {
        enabled: false,
        mode: "lan",
        nodeId: "",
        mdns: true,
        staticPeers: [],
        requireMtls: true,
        tailnetEnabled: false,
      },
    },
    ...overrides,
  } as any;
}

function draftParams(overrides: Record<string, unknown> = {}) {
  return {
    state: onboardingState(),
    authMode: "none",
    allowLoopbackBypass: false,
    authToken: "",
    basicUsername: "",
    basicPassword: "",
    activeProviderId: "openai",
    activeModel: "gpt-5.4",
    providerLabel: "OpenAI",
    providerBaseUrl: "https://api.openai.com/v1",
    providerApiStyle: "openai-responses",
    providerDefaultModel: "gpt-5.4",
    providerApiKey: "",
    providerApiKeyEnv: "OPENAI_API_KEY",
    currentProviderTransportDraftJson: "{}",
    savedProviderTransportDraftJson: "{}",
    defaultToolProfile: "coding",
    budgetMode: "balanced",
    networkAllowlistText: "127.0.0.1\nlocalhost",
    meshEnabled: false,
    meshMode: "lan",
    meshNodeId: "",
    meshMdns: true,
    meshStaticPeers: "",
    meshRequireMtls: true,
    meshTailnetEnabled: false,
    markComplete: true,
    ...overrides,
  } as any;
}

describe("OnboardingPage helper branches loop 17", () => {
  it("recognizes abort errors, active providers, multiline lists, and allowlist presets", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError({ name: "TypeError" })).toBe(false);
    expect(readOnboardingActiveProvider(onboardingState(), "openai")?.label).toBe("OpenAI");
    expect(readOnboardingActiveProvider(null, "openai")).toBeUndefined();
    expect(parseMultiline("  one  \n\n two\n")).toEqual(["one", "two"]);
    expect(matchAllowlistPreset(["localhost", "127.0.0.1"])).toBe("local");
    expect(matchAllowlistPreset(["example.test"])).toBe("custom");
  });

  it("keeps an unchanged onboarding draft clean and flags provider, auth, and mesh edits", () => {
    expect(hasUnsavedOnboardingDraft(draftParams())).toBe(false);
    expect(hasUnsavedOnboardingDraft(draftParams({ state: null }))).toBe(true);
    expect(hasUnsavedOnboardingDraft(draftParams({ authToken: "new-token" }))).toBe(true);
    expect(hasUnsavedOnboardingDraft(draftParams({ providerApiKeyEnv: "ALT_KEY" }))).toBe(true);
    expect(hasUnsavedOnboardingDraft(draftParams({ meshStaticPeers: "https://peer.local" }))).toBe(true);
  });
});
