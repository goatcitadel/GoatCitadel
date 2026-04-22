export interface ChatUiErrorDescriptor {
  summary: string;
  raw?: string;
}

export function describeChatUiError(value?: string | null): ChatUiErrorDescriptor | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  let summary = value;
  if (
    normalized.includes("organization must be verified") ||
    (normalized.includes("verify organization") && normalized.includes("gpt-image-2"))
  ) {
    summary =
      "OpenAI blocked image generation because this API organization is not verified for gpt-image-2. Verify the organization in OpenAI Platform Settings > Organization > General, then wait a bit and retry.";
  } else if (normalized.includes("approval")) {
    summary = "The run is waiting for approval before it can continue.";
  } else if (normalized.includes("user input")) {
    summary = "The run is waiting for operator input before it can continue.";
  } else if (
    normalized.includes("malformed sse") ||
    normalized.includes("incomplete event") ||
    normalized.includes("buffer limit")
  ) {
    summary = "The response stream interrupted before the run could finish updating.";
  } else if (normalized.startsWith("api error")) {
    summary = "The provider request failed before the current step could finish.";
  } else if (normalized.includes("no model provider")) {
    summary = "The run cannot start because no provider is configured.";
  } else if (normalized.includes("no model is selected")) {
    summary = "The run cannot start because no model is selected.";
  } else if (normalized.includes("run data")) {
    summary = "Run state refresh failed.";
  } else if (normalized.includes("checkpoint")) {
    summary = "Checkpoint refresh failed.";
  } else if (
    normalized.includes("econnrefused") ||
    normalized.includes("runtime could not be reached") ||
    normalized.includes("unreachable") ||
    normalized.includes("offline")
  ) {
    summary = "The selected runtime could not be reached.";
  }
  return {
    summary,
    raw: summary === value ? undefined : value,
  };
}

export function formatChatUiError(value?: string | null): string | null {
  return describeChatUiError(value)?.summary ?? null;
}
