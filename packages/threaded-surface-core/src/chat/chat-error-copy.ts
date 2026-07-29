export interface ChatUiErrorDescriptor {
  summary: string;
  raw?: string;
}

export type ChatErrorSource =
  | "send"
  | "edit"
  | "image_generate"
  | "image_edit"
  | "approval"
  | "user_input"
  | "branch_select"
  | "refresh"
  | "other";

const RETRY_NOTE = " Your prompt was kept in the composer so you can edit and resend it.";

function cleanProviderMessage(value: string): string {
  return value
    .replace(/\\\\n/g, " ")
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProviderMessage(value: string): string | null {
  const patterns = [/\\"message\\"\s*:\s*\\"([^"]+)\\"/i, /"message"\s*:\s*"([^"]+)"/i, /'message'\s*:\s*'([^']+)'/i];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) {
      return cleanProviderMessage(match[1]);
    }
  }
  return null;
}

function extractTypedExternalServiceError(value: string): { message: string; reason?: string } | null {
  const jsonStart = value.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const payload = JSON.parse(value.slice(jsonStart)) as {
      code?: unknown;
      error?: unknown;
      details?: { reason?: unknown };
    };
    if (payload.code !== "EXTERNAL_SERVICE_FAILED" || typeof payload.error !== "string") {
      return null;
    }
    return {
      message: cleanProviderMessage(payload.error),
      ...(typeof payload.details?.reason === "string" ? { reason: payload.details.reason } : {}),
    };
  } catch {
    return null;
  }
}

function looksLikePolicyRejection(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("policy") ||
    normalized.includes("safety") ||
    normalized.includes("copyright") ||
    normalized.includes("copyrighted") ||
    normalized.includes("disallowed") ||
    normalized.includes("not allowed") ||
    normalized.includes("violat") ||
    normalized.includes("moderation") ||
    normalized.includes("refused")
  );
}

function shouldIncludeRetryNote(source: ChatErrorSource | null | undefined): boolean {
  return source === "send" || source === "edit" || source === "image_generate" || source === "image_edit";
}

export function describeChatUiError(
  value?: string | null,
  source: ChatErrorSource | null = "other",
): ChatUiErrorDescriptor | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  const retryNote = shouldIncludeRetryNote(source) ? RETRY_NOTE : "";
  const externalServiceError = extractTypedExternalServiceError(value);
  let summary = value;
  if (
    normalized.includes("organization must be verified") ||
    (normalized.includes("verify organization") && normalized.includes("gpt-image-2"))
  ) {
    summary =
      "OpenAI blocked image generation because this API organization is not verified for gpt-image-2. Verify the organization in OpenAI Platform Settings > Organization > General, then wait a bit and retry.";
  } else if (externalServiceError?.reason === "response_body_timeout" && source === "image_generate") {
    summary = `Image generation timed out before the provider finished sending the response.${retryNote}`;
  } else if (externalServiceError) {
    summary = `${externalServiceError.message}${retryNote}`;
  } else if (normalized.startsWith("api error")) {
    const providerMessage = extractProviderMessage(value);
    if (providerMessage && looksLikePolicyRejection(providerMessage)) {
      summary =
        "The image prompt was rejected by the provider's policy checks. Try a more original description instead of naming a copyrighted character or exact likeness." +
        retryNote;
    } else if (providerMessage) {
      summary = `${providerMessage}${retryNote}`;
    } else {
      summary = `The provider request failed before the current step could finish.${retryNote}`;
    }
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

export function formatChatUiError(value?: string | null, source: ChatErrorSource | null = "other"): string | null {
  return describeChatUiError(value, source)?.summary ?? null;
}
