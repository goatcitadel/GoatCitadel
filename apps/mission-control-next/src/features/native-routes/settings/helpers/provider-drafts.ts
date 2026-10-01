import { providerTemplates, type LlmProviderConfig } from "@goatcitadel/contracts";

export type ProviderEditorDraft = {
  providerId: string;
  label: string;
  baseUrl: string;
  apiStyle:
    | "openai-chat-completions"
    | "openai-responses"
    | "openai-codex-responses"
    | "anthropic-messages"
    | "bedrock-messages";
  defaultModel: string;
  authMode: NonNullable<LlmProviderConfig["authMode"]> | "";
  apiKeyEnv: string;
  googleProjectId: string;
  googleProjectIdEnv: string;
  googleLocation: string;
  googleLocationEnv: string;
  googleEndpointId: string;
};

export function createEmptyProviderEditorDraft(): ProviderEditorDraft {
  return {
    providerId: "",
    label: "",
    baseUrl: "",
    apiStyle: "openai-responses",
    defaultModel: "",
    authMode: "",
    apiKeyEnv: "",
    googleProjectId: "",
    googleProjectIdEnv: "",
    googleLocation: "",
    googleLocationEnv: "",
    googleEndpointId: "",
  };
}

export function buildProviderEditorDraft(
  provider?: {
    providerId: string;
    label: string;
    baseUrl: string;
    apiStyle?:
      | "openai-chat-completions"
      | "openai-responses"
      | "openai-codex-responses"
      | "anthropic-messages"
      | "bedrock-messages";
    defaultModel: string;
    authMode?: LlmProviderConfig["authMode"];
    googleCloud?: LlmProviderConfig["googleCloud"];
    apiKeySource?: string;
    apiKeyRef?: string;
    apiKeyEnv?: string;
  } | null,
): ProviderEditorDraft {
  return {
    providerId: provider?.providerId ?? "",
    label: provider?.label ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiStyle: provider?.apiStyle ?? "openai-responses",
    defaultModel: provider?.defaultModel ?? "",
    authMode: provider?.authMode ?? "",
    apiKeyEnv: provider?.apiKeyEnv ?? (provider?.apiKeySource === "env" ? (provider.apiKeyRef ?? "") : ""),
    googleProjectId: provider?.googleCloud?.projectId ?? "",
    googleProjectIdEnv: provider?.googleCloud?.projectIdEnv ?? "",
    googleLocation: provider?.googleCloud?.location ?? "",
    googleLocationEnv: provider?.googleCloud?.locationEnv ?? "",
    googleEndpointId: provider?.googleCloud?.endpointId ?? "",
  };
}

export function buildChatGptOAuthProviderDraft(): ProviderEditorDraft {
  const template = providerTemplates.find((item) => item.providerId === "openai-codex");
  return {
    providerId: template?.providerId ?? "openai-codex",
    label: template?.label ?? "OpenAI Codex (ChatGPT OAuth)",
    baseUrl: template?.baseUrl ?? "https://chatgpt.com/backend-api/codex",
    apiStyle: template?.apiStyle === "openai-codex-responses" ? template.apiStyle : "openai-codex-responses",
    defaultModel: template?.defaultModel ?? "gpt-5.5",
    authMode: "codex-oauth",
    apiKeyEnv: "",
    googleProjectId: "",
    googleProjectIdEnv: "",
    googleLocation: "",
    googleLocationEnv: "",
    googleEndpointId: "",
  };
}

export function getProviderApiStyleWarning(provider: {
  providerId?: string;
  apiStyle?: ProviderEditorDraft["apiStyle"];
}): string | null {
  if (provider.apiStyle === "openai-codex-responses" && provider.providerId !== "openai-codex") {
    return "Codex Responses is only executed for the built-in OpenAI Codex OAuth provider; other providers resolve to their supported execution API.";
  }
  return null;
}
