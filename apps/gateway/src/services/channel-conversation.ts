import type { ChatChannelConversation } from "@goatcitadel/contracts";

/**
 * Builds the direct-or-group details a channel binding remembers. Blank values
 * are left out, and only a direct conversation carries the other person's id.
 */
export function buildChannelConversation(input: {
  kind: ChatChannelConversation["kind"];
  counterpartActorId?: string | null;
  title?: string | null;
}): ChatChannelConversation {
  const counterpartActorId = input.kind === "direct" ? input.counterpartActorId?.trim() : undefined;
  const title = input.title?.trim();
  return {
    kind: input.kind,
    ...(counterpartActorId ? { counterpartActorId } : {}),
    ...(title ? { title } : {}),
  };
}

/** Reads conversation details from untrusted JSON; anything off-contract yields undefined. */
export function readChannelConversation(value: unknown): ChatChannelConversation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "direct" && record.kind !== "group") {
    return undefined;
  }
  return buildChannelConversation({
    kind: record.kind,
    counterpartActorId: typeof record.counterpartActorId === "string" ? record.counterpartActorId : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
  });
}
