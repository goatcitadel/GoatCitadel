import {
  ConflictError,
  ValidationError,
  type ChannelSetupConnectionReviewInput,
  type ChannelSetupDraft,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import {
  assertDraftRevision,
  custodyInitialDraftSecrets,
  sanitizeChannelSetupHydration,
} from "./channel-setup-draft-security.js";

interface ChannelConnectionReviewHost {
  readonly storage: { channelSetupDrafts: Pick<ChannelSetupHost["storage"]["channelSetupDrafts"], "get" | "update"> };
  readonly recentChannelSetupTests: ChannelSetupHost["recentChannelSetupTests"];
  readonly channelSecrets?: ChannelSetupHost["channelSecrets"];
  getIntegrationConnection(connectionId: string): Promise<IntegrationConnection>;
}

export async function requireReviewedChannelConnection(
  host: { getIntegrationConnection(connectionId: string): Promise<IntegrationConnection> },
  draft: ChannelSetupDraft,
): Promise<IntegrationConnection | undefined> {
  if (!draft.connectionId) return undefined;
  const connection = await host.getIntegrationConnection(draft.connectionId);
  if (!/^[a-f0-9]{64}$/u.test(draft.connectionRevision ?? "") || connection.revision !== draft.connectionRevision) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message:
        "The channel connection changed. Your draft is retained. Review the current connection before testing or finalizing.",
      details: { reason: "CHANNEL_CONNECTION_REVIEW_REQUIRED", connectionId: draft.connectionId },
    });
  }
  return connection;
}

/** Accept the current connection while retaining deliberate operator edits. */
export async function reviewChannelSetupConnection(
  host: ChannelConnectionReviewHost,
  draftId: string,
  input: ChannelSetupConnectionReviewInput,
): Promise<ChannelSetupDraft> {
  const current = await host.storage.channelSetupDrafts.get(draftId);
  assertDraftRevision(current, input.expectedRevision);
  if (!current.connectionId || !/^[a-f0-9]{64}$/u.test(input.expectedConnectionRevision)) {
    throw new ValidationError({ message: "A current connection review is required for this draft." });
  }
  const connection = await requireReviewedChannelConnection(host, {
    ...current,
    connectionRevision: input.expectedConnectionRevision,
  });
  if (!connection) throw new ValidationError({ message: "The draft has no connection to review." });
  const runtime = requireChannelSetupDefinition(current.catalogId);
  const inherited = runtime.hydrate(connection);
  const replacementKeys = new Set(
    Object.entries(current.secretState ?? {})
      .filter(([, state]) => state.source === "operator")
      .map(([key]) => key),
  );
  const inheritedValues = { ...inherited.draft };
  for (const key of replacementKeys) delete inheritedValues[key];
  const secured = custodyInitialDraftSecrets(
    host,
    draftId,
    inheritedValues,
    runtime.definition.adapter.secretFieldKeys,
  );
  const secretState = { ...secured.secretState };
  for (const key of replacementKeys) secretState[key] = current.secretState[key]!;
  let committed = false;
  try {
    const updated = await host.storage.channelSetupDrafts.update(draftId, {
      expectedRevision: current.revision,
      connectionRevision: connection.revision,
      secretState,
      hydration: sanitizeChannelSetupHydration(inherited.hydration),
    });
    committed = true;
    host.recentChannelSetupTests.delete(draftId);
    for (const [key, state] of Object.entries(current.secretState ?? {})) {
      if (!replacementKeys.has(key) && state.custody === "temporary" && state.secretRef)
        host.channelSecrets?.deleteTemporary(state.secretRef);
    }
    return updated;
  } catch (cause) {
    if (committed)
      throw Object.assign(new Error("The channel review was saved. Reload the draft before retrying.", { cause }), {
        mutationCommitted: true,
      });
    for (const state of Object.values(secured.secretState)) {
      if (state.custody === "temporary" && state.secretRef) host.channelSecrets?.deleteTemporary(state.secretRef);
    }
    throw cause;
  }
}
