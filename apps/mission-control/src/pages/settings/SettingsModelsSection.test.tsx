import { act, create, type ReactTestInstance } from "react-test-renderer";
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

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll(
    (node) => node.type === "button" && collectText(node).replace(/\s+/g, " ").includes(label),
  )[0];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
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

  it("wires local provider presets, model refresh, save, and advanced toggle actions", async () => {
    const applyLocalProviderPreset = vi.fn();
    const onLoadModels = vi.fn();
    const onSaveActiveLlm = vi.fn();
    const onToggleAdvanced = vi.fn();
    const renderer = create(
      <SettingsModelsSection
        {...makeProps({
          applyLocalProviderPreset,
          loadingModels: true,
          models: [],
          onLoadModels,
          onSaveActiveLlm,
          onToggleAdvanced,
          showAdvanced: false,
        })}
      />,
    );

    expect(collectText(renderer.root)).toContain("Loading...");
    expect(collectText(renderer.root)).not.toContain("Add / Update Provider");

    await act(async () => {
      findButton(renderer.root, "Use LM Studio Preset").props.onClick();
      findButton(renderer.root, "Use Ollama Preset").props.onClick();
      findButton(renderer.root, "Use llama.cpp Preset").props.onClick();
      findButton(renderer.root, "Loading...").props.onClick();
      findButton(renderer.root, "Save Active Provider/Model").props.onClick();
      findButton(renderer.root, "Show advanced settings").props.onClick();
    });

    expect(applyLocalProviderPreset).toHaveBeenNthCalledWith(1, "lmstudio");
    expect(applyLocalProviderPreset).toHaveBeenNthCalledWith(2, "ollama");
    expect(applyLocalProviderPreset).toHaveBeenNthCalledWith(3, "llamacpp");
    expect(onLoadModels).toHaveBeenCalledTimes(1);
    expect(onSaveActiveLlm).toHaveBeenCalledTimes(1);
    expect(onToggleAdvanced).toHaveBeenCalledTimes(1);
  });

  it("shows API-key controls for non-OAuth providers and propagates credential actions", async () => {
    const onProviderApiKeyChange = vi.fn();
    const onSaveProviderKeyToSecureStore = vi.fn();
    const onDeleteProviderKeyFromSecureStore = vi.fn();
    const onSaveProvider = vi.fn();
    const renderer = create(
      <SettingsModelsSection
        {...makeProps({
          activeProviderId: "glm",
          providerId: "glm",
          providerLabel: "GLM",
          providerBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
          providerApiStyle: "openai-chat-completions",
          providerDefaultModel: "glm-5",
          providerApiKey: "secret",
          providerSecretStatus: { providerId: "glm", configured: true, source: "secure-store" } as any,
          codexOAuthStatus: null,
          onProviderApiKeyChange,
          onSaveProviderKeyToSecureStore,
          onDeleteProviderKeyFromSecureStore,
          onSaveProvider,
        })}
      />,
    );

    const text = collectText(renderer.root);
    expect(text).toContain("API Key (optional)");
    expect(text).toContain("Key source:");
    expect(text).toContain("secure-store");
    expect(text).not.toContain("OpenAI Codex uses ChatGPT OAuth");

    const apiKeyInput = renderer.root.findByProps({ id: "providerApiKey" });
    await act(async () => {
      apiKeyInput.props.onChange({ target: { value: "next-secret" } });
      findButton(renderer.root, "Save Key to Secure Store").props.onClick();
      findButton(renderer.root, "Remove Secure Key").props.onClick();
      findButton(renderer.root, "Save Provider Settings").props.onClick();
    });

    expect(onProviderApiKeyChange).toHaveBeenCalledWith("next-secret");
    expect(onSaveProviderKeyToSecureStore).toHaveBeenCalledTimes(1);
    expect(onDeleteProviderKeyFromSecureStore).toHaveBeenCalledTimes(1);
    expect(onSaveProvider).toHaveBeenCalledTimes(1);
  });

  it("renders OAuth device pairing detail and wires connect, poll, and disconnect controls", async () => {
    const onStartCodexOAuthDeviceFlow = vi.fn();
    const onPollCodexOAuthDeviceFlow = vi.fn();
    const onDisconnectCodexOAuth = vi.fn();
    const renderer = create(
      <SettingsModelsSection
        {...makeProps({
          codexOAuthStatus: {
            providerId: "openai-codex",
            available: true,
            connected: true,
            requiresReauth: false,
            accountLabel: "operator@example.test",
            expiresAt: "2026-05-14T12:00:00.000Z",
          },
          codexOAuthFlow: {
            providerId: "openai-codex",
            flowId: "flow-1",
            userCode: "USER-CODE",
            verificationUrl: "https://chatgpt.com/activate",
            expiresAt: "2026-05-14T12:00:00.000Z",
            pollAfterMs: 5_000,
          },
          onStartCodexOAuthDeviceFlow,
          onPollCodexOAuthDeviceFlow,
          onDisconnectCodexOAuth,
        })}
      />,
    );

    const text = collectText(renderer.root);
    expect(text).toContain("connected as operator@example.test");
    expect(text).toContain("https://chatgpt.com/activate");
    expect(text).toContain("USER-CODE");

    await act(async () => {
      findButton(renderer.root, "Reconnect ChatGPT OAuth").props.onClick();
      findButton(renderer.root, "Check Device Pairing").props.onClick();
      findButton(renderer.root, "Disconnect OAuth").props.onClick();
    });

    expect(onStartCodexOAuthDeviceFlow).toHaveBeenCalledTimes(1);
    expect(onPollCodexOAuthDeviceFlow).toHaveBeenCalledTimes(1);
    expect(onDisconnectCodexOAuth).toHaveBeenCalledTimes(1);
  });
});
