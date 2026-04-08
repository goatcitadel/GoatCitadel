/**
 * Pure helpers extracted from ChatPage.tsx as part of Step 10
 * (page decomposition). These functions have no React, DOM, or
 * Stream dependencies and can be unit-tested in isolation.
 */

import type { ChatMessageRecord, ChatThreadResponse } from "@goatcitadel/contracts";

import type { ChatThreadNotice } from "../../components/chat/ChatThreadView";

export function dedupeStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function formatCommandResult(result: {
  ok: boolean;
  message: string;
  research?: { sources: Array<{ url: string }> };
}): string {
  const status = result.ok ? "Command completed" : "Command failed";
  if (!result.research) return `${status}: ${result.message}`;
  return `${status}: ${result.message}\nSources: ${result.research.sources.length}`;
}

export function deriveCoworkItems(
  messages: ChatMessageRecord[],
  notices: ChatThreadNotice[],
  orchestration?: ChatThreadResponse["turns"][number]["trace"]["orchestration"],
): Array<{ id: string; title: string; note?: string }> {
  if (orchestration) {
    return orchestration.steps.slice(0, 5).map((step) => ({
      id: step.stepId,
      title: `${step.role} · ${step.status}`,
      note: step.summary ?? step.error ?? [step.providerId, step.model].filter(Boolean).join(" · "),
    }));
  }
  const latestAssistant = [...messages].reverse().find((item) => item.role === "assistant");
  const latestUser = [...messages].reverse().find((item) => item.role === "user");
  const items: Array<{ id: string; title: string; note?: string }> = [];
  if (latestAssistant) {
    const lines = latestAssistant.content
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 4);
    lines.forEach((line, index) => items.push({ id: `assistant-${index}`, title: line.slice(0, 88) }));
  }
  if (items.length < 3 && latestUser) {
    items.push({ id: "user-goal", title: "Current operator request", note: latestUser.content.slice(0, 180) });
  }
  if (items.length < 5) {
    notices.slice(0, 2).forEach((notice, index) => {
      items.push({
        id: `notice-${notice.id}`,
        title: index === 0 ? "Latest system notice" : "Recent system notice",
        note: notice.content.slice(0, 180),
      });
    });
  }
  return items.slice(0, 5);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: string }).name === "AbortError";
}
