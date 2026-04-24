import { create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { createEmptyLlmTransportDraft } from "../../components/LlmTransportFields";
import { SettingsModelsSection, type SettingsModelsSectionProps } from "./SettingsModelsSection";

function makeProps(overrides: Partial<SettingsModelsSectionProps> = {}): SettingsModelsSectionProps {
  return {
    applyLocalProviderPreset: vi.fn(),
    activeProviderId: "openai-codex",
    onActiveProviderIdChange: vi.fn(),
    providerSelectOptions: [{ value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" }],
    activeModel: "openai-codex/gpt-5.5",
    onActiveModelChange: vi.fn(),
    activeModelOptions: [{ value: "openai-codex/gpt-5.5", label: "openai-codex/gpt-5.5" }],
    loadingModels: false,
    onLoadModels: vi.fn(),
    modelDiscoverySource: "fallback",
    modelDiscoveryWarning: null,
    models: [{ id: "gpt-5.5" }],
    onSaveActiveLlm: vi.fn(),
    blockSaves: false,
    showAdvanced: true,
    onToggleAdvanced: vi.fn(),
    providerId: "openai-codex",
    onProviderIdChange: vi.fn(),
    providerLabel: "OpenAI Codex (ChatGPT OAuth)",
    onProviderLabelChange: vi.fn(),
    providerLabelOptions: [{ value: "OpenAI Codex (ChatGPT OAuth)", label: "OpenAI Codex (ChatGPT OAuth)" }],
    providerBaseUrl: "https://chatgpt.com/backend-api/codex",
    onProviderBaseUrlChange: vi.fn(),
    providerTemplates: [
      {
        providerId: "openai-codex",
        label: "OpenAI Codex (ChatGPT OAuth)",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiStyle: "openai-codex-responses",
      },
    ],
    providerApiStyle: "openai-codex-responses",
    onProviderApiStyleChange: vi.fn(),
    providerApiStyleOptions: [{ value: "openai-codex-responses", label: "OpenAI Codex Responses" }],
    currentProviderRuntime: { resolvedApiStyle: "openai-codex-responses" },
    providerDefaultModel: "gpt-5.5",
    onProviderDefaultModelChange: vi.fn(),
    providerDefaultModelOptions: [{ value: "gpt-5.5", label: "gpt-5.5" }],
    providerApiKey: "",
    onProviderApiKeyChange: vi.fn(),
    providerSecretStatus: null,
    codexOAuthStatus: {
      providerId: "openai-codex",
      available: true,
      connected: false,
      requiresReauth: false,
    },
    codexOAuthFlow: null,
    codexOAuthBusy: false,
    onStartCodexOAuthDeviceFlow: vi.fn(),
    onPollCodexOAuthDeviceFlow: vi.fn(),
    onDisconnectCodexOAuth: vi.fn(),
    providerOptions: [
      {
        providerId: "openai-codex",
        label: "OpenAI Codex (ChatGPT OAuth)",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiStyle: "openai-codex-responses",
        resolvedApiStyle: "openai-codex-responses",
        defaultModel: "gpt-5.5",
        apiKeySource: "none",
      },
    ],
    onSaveProviderKeyToSecureStore: vi.fn(),
    onDeleteProviderKeyFromSecureStore: vi.fn(),
    providerApiKeyEnv: "",
    onProviderApiKeyEnvChange: vi.fn(),
    providerRequestDraft: createEmptyLlmTransportDraft(),
    onProviderRequestDraftChange: vi.fn(),
    providerRequestValidationError: null,
    onSaveProvider: vi.fn(),
    ...overrides,
  };
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      if (typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
}

describe("SettingsModelsSection", () => {
  it("shows ChatGPT OAuth controls for OpenAI Codex instead of API-key controls", () => {
    const renderer = create(<SettingsModelsSection {...makeProps()} />);
    const text = collectText(renderer.root);

    expect(text).toContain("OpenAI Codex uses ChatGPT OAuth");
    expect(text).toContain("ChatGPT/Codex plan");
    expect(text).toContain("Configured API style:");
    expect(text).toContain("openai-codex-responses");
    expect(text).toContain("Resolved execution style:");
    expect(text).toContain("Connect ChatGPT OAuth");
    expect(text).toContain("Check Device Pairing");
    expect(text).toContain("Disconnect OAuth");
    expect(text).not.toContain("API Key (optional)");
    expect(text).not.toContain("Save Key to Secure Store");
    expect(text).not.toContain("API Key Env (optional)");
  });
});
