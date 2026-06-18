import { z } from "zod";

// ---------------------------------------------------------------------------
// Channel inbound access control
// ---------------------------------------------------------------------------
//
// A per-connection sender allowlist for inbound channel messages (Slack,
// WhatsApp, LINE, Nextcloud Talk, Telegram, Discord, ...). New connections
// should set `inboundAccessMode: "allowlist"`, where an empty allowlist denies
// inbound messages. Existing installs that do not have the mode keep the
// legacy-open posture so upgrades do not strand operators, but callers get a
// diagnostic warning they can surface in Settings/Ops.
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
     * Explicit inbound trust posture for the connection. `allowlist` is the
     * safe default for new connections. `open_legacy` preserves the old
     * default-open behavior and should be shown as migration debt.
     */
    inboundAccessMode: z.enum(["allowlist", "open_legacy"]).optional(),
    /**
     * Opt-in allowlist of sender identities permitted to open/continue a
     * session on this connection. Entries are matched against the inbound
     * `actorId` (trimmed, case-insensitive).
     */
    allowedSenders: z.array(z.string()).optional(),
  })
  .passthrough();

export type ChannelInboundAccessConfig = z.infer<typeof ChannelInboundAccessConfigSchema>;
export type ChannelInboundAccessMode = NonNullable<ChannelInboundAccessConfig["inboundAccessMode"]>;
export type ChannelInboundAccessReason =
  | "invalid_config"
  | "allowlist_match"
  | "allowlist_empty"
  | "sender_not_allowlisted"
  | "missing_actor"
  | "legacy_open_unset"
  | "legacy_open_explicit";

export interface ChannelInboundAccessDecision {
  allowed: boolean;
  mode: ChannelInboundAccessMode;
  reason: ChannelInboundAccessReason;
  allowedSenders: readonly string[];
  legacyWarning?: string;
}

/**
 * Normalize a raw `allowedSenders` value (from an untrusted connection config
 * bag) into a clean, comparable allowlist: trims each entry, lowercases it,
 * drops blanks, and de-duplicates. Non-array / non-string-bearing inputs yield
 * an empty list; the full evaluator decides whether that means legacy-open or
 * an explicitly empty allowlist.
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

/**
 * Resolve the full inbound trust decision for a channel message. This is the
 * migration-aware gate new callers should use instead of `isSenderAllowed`.
 */
export function evaluateChannelInboundAccess(input: {
  config?: Record<string, unknown>;
  actorId?: string;
  allowedSenders?: readonly string[];
}): ChannelInboundAccessDecision {
  const rawConfig = input.config ?? {};
  const parsed = ChannelInboundAccessConfigSchema.safeParse(rawConfig);
  const config = parsed.success ? parsed.data : rawConfig;
  const allowedSenders = input.allowedSenders ?? resolveAllowedSenders(config);
  const candidate = input.actorId?.trim().toLowerCase();
  const configuredMode = readInboundAccessMode(config);

  if (!parsed.success && hasInboundAccessFields(rawConfig)) {
    return {
      allowed: false,
      mode: "allowlist",
      reason: "invalid_config",
      allowedSenders,
    };
  }

  if (configuredMode === "open_legacy") {
    return {
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_explicit",
      allowedSenders,
      legacyWarning: "Connection explicitly permits all inbound senders through open_legacy mode.",
    };
  }

  if (!configuredMode && allowedSenders.length === 0) {
    return {
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_unset",
      allowedSenders,
      legacyWarning:
        "Connection has no inboundAccessMode and no allowedSenders, so it is using legacy default-open inbound access.",
    };
  }

  if (allowedSenders.length === 0) {
    return {
      allowed: false,
      mode: "allowlist",
      reason: "allowlist_empty",
      allowedSenders,
    };
  }

  if (!candidate) {
    return {
      allowed: false,
      mode: "allowlist",
      reason: "missing_actor",
      allowedSenders,
    };
  }

  const allowed = allowedSenders.includes(candidate);
  return {
    allowed,
    mode: "allowlist",
    reason: allowed ? "allowlist_match" : "sender_not_allowlisted",
    allowedSenders,
  };
}

function readInboundAccessMode(config: Record<string, unknown>): ChannelInboundAccessMode | undefined {
  const value = config.inboundAccessMode;
  return value === "allowlist" || value === "open_legacy" ? value : undefined;
}

function hasInboundAccessFields(config: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(config, "inboundAccessMode") ||
    Object.prototype.hasOwnProperty.call(config, "allowedSenders")
  );
}
