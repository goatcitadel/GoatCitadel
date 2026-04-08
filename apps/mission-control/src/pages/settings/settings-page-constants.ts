/**
 * Constants extracted from SettingsPage.tsx as part of Step 10
 * (page decomposition). Pure data only — no React/DOM dependencies.
 */

import type { RuntimeSettingsResponse } from "../../api/client";
import type { SelectOption } from "../../components/SelectOrCustom";

export const TOOL_PROFILE_OPTIONS: SelectOption[] = [
  { value: "minimal", label: "minimal (safest)" },
  { value: "standard", label: "standard" },
  { value: "coding", label: "coding" },
  { value: "ops", label: "ops" },
  { value: "research", label: "research" },
  { value: "danger", label: "danger (high risk)" },
];

export const READ_ACCESS_MODE_OPTIONS: SelectOption[] = [
  { value: "roots_only", label: "trusted roots only" },
  { value: "approval_required", label: "ask before outside-root reads" },
  { value: "full_disk", label: "full disk read access" },
];

export const FIRECRAWL_DEFAULT_READ_BACKEND_OPTIONS: SelectOption[] = [
  { value: "native", label: "Native browser tools" },
  { value: "firecrawl", label: "Firecrawl for read tools" },
];

export const CHAT_PROMPT_PRESETS: Array<{ id: string; label: string; prompt: string }> = [
  { id: "hello", label: "Hello smoke test", prompt: "Say hello from GoatCitadel's native-first provider routing." },
  {
    id: "plan",
    label: "Planning response",
    prompt: "In 5 bullets, propose a safe implementation plan for a new feature.",
  },
  {
    id: "safety",
    label: "Safety check",
    prompt: "Summarize one policy risk and one mitigation for executing a risky shell command.",
  },
];

export const SETTINGS_SECTIONS = [
  {
    id: "settings-overview",
    label: "Overview",
    description: "Environment and general defaults.",
  },
  {
    id: "settings-access",
    label: "Access",
    description: "Auth mode, loopback behavior, and credential storage.",
  },
  {
    id: "settings-voice",
    label: "Voice",
    description: "Talk mode, wake runtime, and local transcription.",
  },
  {
    id: "settings-runtime",
    label: "Runtime",
    description: "Tool profile, budgets, and outbound allowlist.",
  },
  {
    id: "settings-models",
    label: "Models",
    description: "Providers, active model selection, and secure keys.",
  },
  {
    id: "settings-tests",
    label: "Test",
    description: "Run a direct provider smoke test before wider use.",
  },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export type ProviderApiStyle = RuntimeSettingsResponse["llm"]["providers"][number]["apiStyle"];

export type NormalizedRuntimeSettingsResponse = RuntimeSettingsResponse & {
  web: {
    firecrawl: {
      enabled: boolean;
      baseUrl: string;
      apiKeyEnv?: string;
      timeoutMs: number;
      defaultReadBackend: "native" | "firecrawl";
      fallbackToNative: boolean;
    };
  };
};

export const PROVIDER_API_STYLE_OPTIONS: Array<{ value: ProviderApiStyle; label: string }> = [
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" },
];

export function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}
