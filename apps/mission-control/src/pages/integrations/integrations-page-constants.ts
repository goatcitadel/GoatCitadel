/**
 * Constants and small pure helpers extracted from IntegrationsPage.tsx
 * as part of Step 10 (page decomposition).
 */

import type { IntegrationCatalogEntry, IntegrationConnection } from "@goatcitadel/contracts";

export type IntegrationKind = IntegrationCatalogEntry["kind"] | "all";

export const INTEGRATIONS_UPLOAD_SESSION_ID = "session:operator:integrations";

export const KIND_OPTIONS: Array<{ value: IntegrationKind; label: string }> = [
  { value: "all", label: "All scopes" },
  { value: "channel", label: "Channels" },
  { value: "model_provider", label: "Model providers" },
  { value: "productivity", label: "Productivity apps" },
  { value: "automation", label: "Automation" },
  { value: "platform", label: "Platform integrations" },
];

export const STATUS_OPTIONS: Array<{
  value: IntegrationConnection["status"];
  label: string;
  description: string;
}> = [
  { value: "connected", label: "Connected (ready)", description: "Live and expected to work." },
  { value: "paused", label: "Paused", description: "Kept for later, not used right now." },
  { value: "disconnected", label: "Disconnected", description: "Configured but intentionally offline." },
  { value: "error", label: "Error", description: "Needs fix before use." },
];

export const KIND_DESCRIPTIONS: Record<Exclude<IntegrationKind, "all">, string> = {
  channel: "Routes messages to and from chat channels.",
  model_provider: "Adds an LLM provider endpoint and credentials.",
  productivity: "Connects docs, files, or office workflows.",
  automation: "Connects external automation systems.",
  platform: "Connects platform-level services and APIs.",
};

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
