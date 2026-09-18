import { ConflictError, ValidationError, type ChannelSetupDraft } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";

interface ChannelSetupSecretHost {
  readonly channelSecrets?: ChannelSetupHost["channelSecrets"];
}

export function assertDraftRevision(draft: ChannelSetupDraft, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || draft.revision !== expectedRevision) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Channel setup draft ${draft.draftId} changed after it was loaded (expected revision ${expectedRevision}, current revision ${draft.revision}).`,
      details: { reason: "CHANNEL_DRAFT_REVISION_CONFLICT", draftId: draft.draftId },
    });
  }
}

export function custodyInitialDraftSecrets(
  host: ChannelSetupSecretHost,
  draftId: string,
  rawDraft: Record<string, unknown>,
  secretFieldKeys: readonly string[],
): { draft: Record<string, unknown>; secretState: ChannelSetupDraft["secretState"] } {
  const draft = { ...rawDraft };
  const secretState: ChannelSetupDraft["secretState"] = {};
  for (const fieldKey of secretFieldKeys) {
    const value = draft[fieldKey];
    delete draft[fieldKey];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      throw new ValidationError({
        message: `Channel credential field ${fieldKey} must be submitted through secure input.`,
      });
    }
    const custody = requireChannelSecretCustody(host);
    const secretRef = custody.isChannelSecretRef(value) ? value : custody.storeTemporary(draftId, fieldKey, value);
    secretState[fieldKey] = {
      configured: true,
      custody: custody.custodyFor(secretRef),
      source: "inherited",
      secretRef,
    };
  }
  return { draft, secretState };
}

export function hydrateChannelSetupDraftSecrets(
  host: ChannelSetupSecretHost,
  draft: ChannelSetupDraft,
): ChannelSetupDraft {
  const next = { ...draft.draft };
  for (const [fieldKey, state] of Object.entries(draft.secretState ?? {})) {
    if (!state.configured || !state.secretRef) continue;
    const custody = requireChannelSecretCustody(host);
    custody.assertUsableForDraft(state.secretRef, {
      draftId: draft.draftId,
      connectionId: draft.connectionId,
      fieldKey,
    });
    next[fieldKey] = custody.resolve(state.secretRef);
  }
  return { ...draft, draft: next };
}

export function sanitizeChannelSetupHydration(
  hydration: ChannelSetupDraft["hydration"] | undefined,
): ChannelSetupDraft["hydration"] | undefined {
  if (!hydration) return undefined;
  const { rawLegacyConfig: _rawLegacyConfig, ...safeHydration } = hydration;
  return {
    ...safeHydration,
  };
}

export function requireChannelSecretCustody(
  host: ChannelSetupSecretHost,
): NonNullable<ChannelSetupSecretHost["channelSecrets"]> {
  if (!host.channelSecrets) {
    throw new ValidationError({ message: "Secure channel credential storage is unavailable." });
  }
  return host.channelSecrets;
}
