import type { ChannelSetupDraft, WhatsAppSetupCodeSender } from "@goatcitadel/contracts";
import {
  checkWhatsAppSetup,
  createChannelSetupDraft,
  submitChannelSetupDraftSecrets,
  updateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { latestDraft, markedChatSetupDraft } from "./setup-draft-session";
import { WHATSAPP_CATALOG_ID, type WhatsAppDetails } from "./whatsapp-setup-model";

/** How saving new values on the draft ended. */
export type WhatsAppSaveOutcome =
  | { kind: "saved"; draft: ChannelSetupDraft }
  /** `latest` is the draft as GoatCitadel has it now, when a save failed after the draft may have moved on. */
  | { kind: "failed"; error: string; latest: ChannelSetupDraft | null };

/**
 * Saves new values for the draft at the version it was read at. A write to a draft carries no secret, so the reason a
 * save failed is GoatCitadel's own plain sentence (a change made somewhere else, say).
 */
export async function saveWhatsAppDraft(
  draft: ChannelSetupDraft,
  values: Record<string, unknown>,
): Promise<WhatsAppSaveOutcome> {
  try {
    const saved = await updateChannelSetupDraft(draft.draftId, { expectedRevision: draft.revision, draft: values });
    return { kind: "saved", draft: saved };
  } catch (error) {
    return { kind: "failed", error: describeApiError(error).summary, latest: await latestDraft(draft.draftId) };
  }
}

const hasText = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/**
 * Whether the draft holds all five details: the access token and the app secret stored, and the three IDs saved. Only
 * then can a page coming back to the setup ask Meta about it again.
 */
export function hasWhatsAppDetails(draft: Pick<ChannelSetupDraft, "draft" | "secretState">): boolean {
  const { accessToken, appSecret } = draft.secretState ?? {};
  const values: Record<string, unknown> = draft.draft;
  return (
    accessToken?.configured === true &&
    appSecret?.configured === true &&
    hasText(values.phoneNumberId) &&
    hasText(values.businessAccountId) &&
    hasText(values.appId)
  );
}

/** What one look at what GoatCitadel has heard from Meta found. Nothing is sent to Meta to find it. */
export interface HeardFromMeta {
  /** When Meta last checked the draft's web address with its verify token, in the last 15 minutes. */
  addressCheckedAt?: string;
  /** Who sent `code`, once someone has. */
  sender: WhatsAppSetupCodeSender | null;
}

/**
 * Asks once what GoatCitadel has heard: whether Meta has checked the address and, when a code is given, whether anyone
 * has sent it. Without `askMeta` the check reads only what the setup listener keeps in memory, so it is the same
 * question for both waits. A question that fails throws.
 */
export async function askWhatHeard(draft: ChannelSetupDraft, code?: string): Promise<HeardFromMeta> {
  const heard = await checkWhatsAppSetup({
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    ...(code ? { setupCode: code } : {}),
  });
  return { addressCheckedAt: heard.addressCheckedAt, sender: heard.codeSender ?? null };
}

/** What the page holds as storing the details goes along, so a failure part-way leaves it with all that was done. */
export interface StoredSoFar {
  draft: ChannelSetupDraft;
  /** The verify token, once it is stored: the page keeps it in memory for the operator to copy, and nowhere else. */
  verifyToken?: string;
}

/**
 * Stores the details the operator pasted, in the order the page relies on. A new draft is made first, then marked as
 * made on this page before any secret is stored on it (so a draft that holds a token is always this page's, even when
 * the first check fails). Then one write holds the access token, the app secret and, only when `verifyToken` is given,
 * the verify token; then one write holds the three IDs, which are not secret. Every write carries the version the last
 * one returned, and `report` is told what is done after each, so a failure leaves the page with the draft as far as it
 * got. Returns the draft that is ready to check.
 */
export async function storeWhatsAppDetails(
  start: ChannelSetupDraft | null,
  details: WhatsAppDetails,
  verifyToken: string | null,
  report: (progress: StoredSoFar) => void,
): Promise<ChannelSetupDraft> {
  // Kept at once, so a try after a failure goes on with this draft instead of making another.
  let draft = start ?? (await createChannelSetupDraft({ catalogId: WHATSAPP_CATALOG_ID, lifecycleMode: "create" }));
  report({ draft });
  draft = await markedChatSetupDraft(draft);
  report({ draft });
  const stored = await submitChannelSetupDraftSecrets(draft.draftId, {
    expectedRevision: draft.revision,
    values: {
      accessToken: details.accessToken,
      appSecret: details.appSecret,
      ...(verifyToken ? { webhookVerifyToken: verifyToken } : {}),
    },
  });
  report({ draft: stored, ...(verifyToken ? { verifyToken } : {}) });
  const saved = await updateChannelSetupDraft(stored.draftId, {
    expectedRevision: stored.revision,
    draft: {
      ...stored.draft,
      phoneNumberId: details.phoneNumberId,
      businessAccountId: details.businessAccountId,
      appId: details.appId,
    },
  });
  report({ draft: saved });
  return saved;
}
