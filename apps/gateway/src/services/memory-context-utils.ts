import type { ChatCompletionResponse } from "@goatcitadel/contracts";
import { parseDistillerJson, type ParsedDistillation } from "@goatcitadel/memory-core";

export function parseDistillerResponse(response: ChatCompletionResponse): ParsedDistillation {
  const content = extractMessageContent(response);
  if (!content.trim()) {
    throw new Error("memory distiller returned empty content");
  }
  return parseDistillerJson(content);
}

function extractMessageContent(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message;
  if (!message) {
    return "";
  }

  const raw = (message as Record<string, unknown>).content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") {
          return text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return "";
}

export function throwIfMemoryContextAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toMemoryContextAbortError(signal);
  }
}

function toMemoryContextAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("memory context composition aborted");
  error.name = "AbortError";
  return error;
}

export function isMemoryContextAbort(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  if (error === signal.reason) return true;
  const record = error as { name?: unknown; message?: unknown };
  return (
    record.name === "AbortError" ||
    String(record.message ?? "")
      .toLowerCase()
      .includes("abort")
  );
}

export function calculateSavings(originalTokens: number, distilledTokens: number): number {
  if (originalTokens <= 0) {
    return 0;
  }
  return Number((((originalTokens - distilledTokens) / originalTokens) * 100).toFixed(2));
}

export function reserveMemoryContextBudget(maxContextTokens: number): number {
  if (maxContextTokens <= 160) {
    return maxContextTokens;
  }
  const reserved = Math.max(96, Math.ceil(maxContextTokens * 0.12));
  return Math.max(128, maxContextTokens - reserved);
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}
