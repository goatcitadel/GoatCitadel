/**
 * Pure normalizer helpers extracted from ChatPage.tsx.
 *
 * These are internal utilities with no UI or state dependencies — moving
 * them here reduces ChatPage.tsx size and keeps pure logic independently
 * testable.
 */

import type { ChatMessageRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import type { ChatMessagesResponse } from "@goatcitadel/mission-control-shared/api/client";

export function normalizeComparableAssistantContent(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeSpecialistFingerprint(input: { title?: string; role?: string }): string {
  const normalize = (value?: string) =>
    (value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `${normalize(input.role)}:${normalize(input.title)}`;
}

export function flattenThreadMessages(thread: ChatThreadResponse | null): ChatMessagesResponse["items"] {
  if (!thread) {
    return [];
  }
  return thread.turns.flatMap((turn) => {
    const items: ChatMessageRecord[] = [turn.userMessage];
    if (turn.assistantMessage) {
      items.push(turn.assistantMessage);
    }
    return items;
  });
}
