import { z } from "zod";

// ---------------------------------------------------------------------------
// Channel inbound access control
// ---------------------------------------------------------------------------
//
// A per-connection sender allowlist for inbound channel messages (Slack,
// WhatsApp, LINE, Nextcloud Talk, Telegram, Discord, ...). It is OPT-IN: an
// unset or empty `allowedSenders` list allows every sender, preserving the
// behavior of every existing install. When the list is non-empty, only the
// listed sender identities (the inbound `actorId`) may start or continue an
// agent session; all other senders are dropped before a session is bound or a
// turn is dispatched.
//
// Matching is intentionally forgiving: entries and the inbound actor id are
// trimmed and compared case-insensitively so operators do not have to worry
// about stray whitespace or casing differences across provider identifiers.

/**
 * Schema fragment describing the optional sender allowlist on a channel
 * connection's `config`. Uses `.passthrough()` so it can be parsed against a
 * full connection config object without stripping unrelated channel fields
 * (signing secrets, bot ids, personality selections, ...).
 */
export const ChannelInboundAccessConfigSchema = z
  .object({
    /**
     * Opt-in allowlist of sender identities permitted to open/continue a
     * session on this connection. Unset or empty means "allow all senders"
     * (default-allow). Entries are matched against the inbound `actorId`
     * (trimmed, case-insensitive).
     */
    allowedSenders: z.array(z.string()).optional(),
  })
  .passthrough();

export type ChannelInboundAccessConfig = z.infer<typeof ChannelInboundAccessConfigSchema>;

/**
 * Normalize a raw `allowedSenders` value (from an untrusted connection config
 * bag) into a clean, comparable allowlist: trims each entry, lowercases it,
 * drops blanks, and de-duplicates. Non-array / non-string-bearing inputs yield
 * an empty list, which the matcher treats as default-allow.
 */
export function resolveAllowedSenders(config: Record<string, unknown> | undefined): readonly string[] {
  const raw = config?.allowedSenders;
  if (!Array.isArray(raw)) {
    return [];
  }
  const normalized = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const cleaned = entry.trim().toLowerCase();
    if (cleaned.length > 0) {
      normalized.add(cleaned);
    }
  }
  return [...normalized];
}

/**
 * Decide whether an inbound sender is permitted by the resolved allowlist.
 *
 * Default-allow: an empty/unset allowlist permits everyone. When the allowlist
 * is non-empty, the sender's `actorId` must match a listed entry (trimmed,
 * case-insensitive). A blank/undefined actor id is rejected only when the
 * allowlist is active, since gating is explicitly requested in that case.
 */
export function isSenderAllowed(allowedSenders: readonly string[], actorId: string | undefined): boolean {
  if (allowedSenders.length === 0) {
    return true;
  }
  const candidate = actorId?.trim().toLowerCase();
  if (!candidate) {
    return false;
  }
  return allowedSenders.includes(candidate);
}
