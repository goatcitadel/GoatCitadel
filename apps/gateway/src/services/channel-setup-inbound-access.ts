import { ChannelInboundAccessConfigSchema, ValidationError, resolveAllowedSenders, type ChannelSetupDraft } from "@goatcitadel/contracts";

export const GUIDED_INBOUND_CHANNELS: ReadonlySet<string> = new Set(["slack", "telegram", "whatsapp", "line", "nextcloud-talk"]);

/** Keep sender policy in its shared owner rather than provider-specific normalizers. */
export function normalizeGuidedChannelInboundAccess(
  channelKey: string,
  draft: Pick<ChannelSetupDraft, "draft" | "connectionId">,
  saved: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!GUIDED_INBOUND_CHANNELS.has(channelKey)) return {};
  const candidate: Record<string, unknown> = {};
  for (const key of ["inboundAccessMode", "allowedSenders"] as const) {
    if (draft.draft[key] !== undefined) candidate[key] = draft.draft[key];
    else if (saved[key] !== undefined) candidate[key] = saved[key];
  }
  if (candidate.inboundAccessMode === undefined && !draft.connectionId) candidate.inboundAccessMode = "allowlist";
  const parsed = ChannelInboundAccessConfigSchema.safeParse(candidate);
  if (!parsed.success) throw new ValidationError({ message: "Choose a valid inbound access mode and sender list.", field: "allowedSenders" });
  return {
    ...(parsed.data.inboundAccessMode ? { inboundAccessMode: parsed.data.inboundAccessMode } : {}),
    ...(candidate.allowedSenders !== undefined ? { allowedSenders: [...resolveAllowedSenders(candidate)] } : {}),
  };
}

export function hydrateGuidedChannelInboundAccess(channelKey: string, saved: Record<string, unknown>): Record<string, unknown> {
  if (!GUIDED_INBOUND_CHANNELS.has(channelKey)) return {};
  return {
    inboundAccessMode: saved.inboundAccessMode ?? (resolveAllowedSenders(saved).length > 0 ? "allowlist" : "open_legacy"),
    ...(saved.allowedSenders !== undefined ? { allowedSenders: saved.allowedSenders } : {}),
  };
}
