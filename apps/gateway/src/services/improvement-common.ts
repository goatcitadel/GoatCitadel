import type { ChatCompletionResponse } from "@goatcitadel/contracts";

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function clampProbability(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0.5;
  return Math.max(0, Math.min(1, num));
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function extractCompletionText(response: ChatCompletionResponse): string {
  if (!response?.choices?.length) return "";
  const choice = response.choices[0];
  return (choice as { message?: { content?: string } })?.message?.content ?? "";
}

export function parseLooseJsonRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end < 0) return undefined;
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function truncateForModelJudge(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "... [truncated]";
}

// SECURITY (codex finding #27): The weekly improvement replay job ships
// transcript excerpts and tool args/results to the configured LLM
// provider for a judge pass. Apply this redactor before any candidate
// payload is interpolated into the judge prompt so secrets that leaked
// into transcripts/tool runs (provider API keys, bot tokens, OAuth
// bearer values, env-resolved credentials) are not transmitted.
//
// The redactor is conservative — it replaces matches with stable
// `[REDACTED_*]` markers so the judge still sees the surrounding
// structure (helpful for grading correctness). It runs in O(n * patterns)
// time which is fine for ~5KB excerpts.
const SECRET_PATTERN_REDACTORS: Array<{ pattern: RegExp; replacement: string }> = [
  // OpenAI / Anthropic style keys: sk-..., sk-ant-..., sk-proj-...
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_LLM_KEY]" },
  // Telegram bot tokens: 1234567890:AAAAAA... (10+ digit id, colon, 35-char alphanumeric)
  { pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, replacement: "[REDACTED_TELEGRAM_BOT_TOKEN]" },
  // Authorization header values: "Bearer xyz..."
  { pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, replacement: "Bearer [REDACTED]" },
  // Basic auth header values: "Basic base64..."
  { pattern: /\bBasic\s+[A-Za-z0-9+/=]{16,}/gi, replacement: "Basic [REDACTED]" },
  // GitHub PATs: ghp_, gho_, ghu_, ghs_, ghr_
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  // AWS access keys: AKIA + 16 chars
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_ACCESS_KEY]" },
  // Email addresses (PII; the audit corpus often has user emails).
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[REDACTED_EMAIL]" },
];

export function redactSensitivePayload(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!value) return value;
  let redacted = value;
  // Pattern-based redaction first so the env-name version below can still
  // catch literal env values that didn't already match a pattern.
  for (const { pattern, replacement } of SECRET_PATTERN_REDACTORS) {
    redacted = redacted.replace(pattern, replacement);
  }
  // Env-value redaction: replace literal values of `process.env` entries
  // that look like secrets (>=12 chars, no whitespace) with a marker that
  // names the env var. This catches custom org-specific secret env vars
  // (FIRECRAWL_API_KEY, MATRIX_ACCESS_TOKEN, etc.) without us needing to
  // enumerate them.
  for (const [name, raw] of Object.entries(env)) {
    const trimmed = raw?.trim();
    if (!trimmed || trimmed.length < 12 || /\s/.test(trimmed)) {
      continue;
    }
    // Use a literal-string replace (no regex), case-sensitive.
    while (redacted.includes(trimmed)) {
      redacted = redacted.replace(trimmed, `[REDACTED_ENV:${name}]`);
    }
  }
  return redacted;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
