import type { ChatCompletionResponse } from "@goatcitadel/contracts";
import { redactSecretText } from "@goatcitadel/contracts";

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

export function redactSensitivePayload(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return redactSecretText(value, { env, redactEmailAddresses: true }).value;
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
