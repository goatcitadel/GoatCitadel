import { NotFoundError, type ChannelSetupDraft, type WhatsAppSetupCodeSender } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { hydrateChannelSetupDraftSecrets } from "./channel-setup-draft-security.js";
import { channelSecretOwnerForDraft } from "./channel-secret-resolution.js";
import { buildEphemeralChannelConnection } from "./channel-setup-helpers.js";
import { asRecord, asString, timingSafeStringEqual } from "./webhook-json-helpers.js";
import { verifyWhatsAppWebhookConnectionBinding, verifyWhatsAppWebhookSignature } from "./whatsapp-webhook.js";

const log = logger.child("whatsapp-setup-listener");

/** How long what was heard is kept, counted from the last thing noted for that draft. */
export const WHATSAPP_SETUP_LISTEN_MS = 15 * 60_000;
/** How many setup drafts are listened for at once. Past it, the draft that was noted longest ago is forgotten. */
export const WHATSAPP_SETUP_LISTEN_MAX_DRAFTS = 32;

const WHATSAPP_CATALOG_ID = "channel.whatsapp";
const MESSAGING_SETUP_PAGE = "messaging";
const WHATSAPP_WEBHOOK_OBJECT = "whatsapp_business_account";
/** WhatsApp numbers are short digit strings. A profile name is at most a few dozen characters. */
const MAX_ACTOR_ID_CHARS = 128;
const MAX_DISPLAY_NAME_CHARS = 100;

/** What has been heard for one setup draft. Never message text: only that Meta reached us, the code and who sent it. */
export interface WhatsAppSetupHeard {
  addressCheckedAt?: string;
  code?: string;
  codeSender?: WhatsAppSetupCodeSender;
}

export type WhatsAppSetupCheckAnswer = { status: 200; challenge: string } | { status: 400 | 401 | 404 };
export type WhatsAppSetupDeliveryAnswer = { status: 200 | 400 | 401 | 403 | 404 };

export interface WhatsAppSetupListener {
  /** Meta's address check for a Chat-made setup draft: the challenge to send back, or the status to refuse with. */
  answerCheck(
    draftId: string,
    query: { mode?: string; verifyToken?: string; challenge?: string },
  ): Promise<WhatsAppSetupCheckAnswer>;
  /** A delivery for a Chat-made setup draft: listens for the draft's code and nothing else. */
  hearDelivery(draftId: string, rawBody: string, signature: string | undefined): Promise<WhatsAppSetupDeliveryAnswer>;
  /** What has been heard for the draft in the last 15 minutes. */
  heard(draftId: string): WhatsAppSetupHeard;
}

type Noted = WhatsAppSetupHeard & { touchedAt: number };
type ListenedSecret = "appSecret" | "webhookVerifyToken";

/**
 * Listens on behalf of a WhatsApp setup draft that was made on the Messaging setup page and is not a connection yet, so
 * that Meta's address check can be answered and the setup code heard before Turn on.
 *
 * It trusts nothing it is told: a check must carry the draft's verify token and a delivery must be signed with the
 * draft's app secret and name the draft's phone number ID. It hears one thing, a text message that is the draft's setup
 * code and nothing else, and keeps no message text, only the time of Meta's check, the code and who sent it, in memory,
 * for 15 minutes. It reaches nobody (not Meta, not the chat) and never starts a conversation.
 *
 * Every answer is a status. Nothing it reads, the draft's keys least of all, reaches a thrown message, a response or a log.
 */
export function createWhatsAppSetupListener(
  host: ChannelSetupHost,
  now: () => Date = () => new Date(),
): WhatsAppSetupListener {
  const noted = new Map<string, Noted>();

  const forgetOlderThan = (at: number): void => {
    for (const [draftId, entry] of noted) {
      if (at - entry.touchedAt >= WHATSAPP_SETUP_LISTEN_MS) noted.delete(draftId);
    }
  };

  const note = (draftId: string, change: WhatsAppSetupHeard): void => {
    const at = now().getTime();
    forgetOlderThan(at);
    const current = noted.get(draftId);
    // Set again at the end, so the map stays in the order the drafts were last noted.
    noted.delete(draftId);
    noted.set(draftId, { ...current, ...change, touchedAt: at });
    while (noted.size > WHATSAPP_SETUP_LISTEN_MAX_DRAFTS) {
      let oldest: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of noted) {
        if (entry.touchedAt < oldestAt) {
          oldest = id;
          oldestAt = entry.touchedAt;
        }
      }
      if (oldest === undefined) break;
      noted.delete(oldest);
    }
  };

  /** The draft, when it is one this listener may listen for; undefined when it is missing or is anything else. */
  const loadDraft = async (draftId: string): Promise<ChannelSetupDraft | undefined> => {
    let draft: ChannelSetupDraft;
    try {
      draft = await host.storage.channelSetupDrafts.get(draftId);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
    return qualifies(draft) ? draft : undefined;
  };

  /**
   * One of the draft's own saved keys. Only that key is taken out of secure storage: the access token is never read,
   * and a check that is going to be refused does not read the other key either.
   */
  const secretOf = async (draft: ChannelSetupDraft, directKey: ListenedSecret): Promise<string | undefined> => {
    const ownKey = Object.fromEntries(Object.entries(draft.secretState ?? {}).filter(([field]) => field === directKey));
    const connection = await buildEphemeralChannelConnection(
      host,
      hydrateChannelSetupDraftSecrets(host, { ...draft, secretState: ownKey }),
    );
    const secret = host.resolveConnectionSecret?.(
      connection.config,
      directKey,
      `${directKey}Env`,
      WHATSAPP_CATALOG_ID,
      channelSecretOwnerForDraft(draft),
    );
    return secret && secret.length > 0 ? secret : undefined;
  };

  return {
    answerCheck: (draftId, query) =>
      guarded<WhatsAppSetupCheckAnswer>({ status: 404 }, async () => {
        const draft = await loadDraft(draftId);
        if (!draft) return { status: 404 };
        const challenge = query.challenge;
        if (query.mode !== "subscribe" || !challenge) return { status: 400 };
        const verifyToken = await secretOf(draft, "webhookVerifyToken");
        if (!verifyToken || !sameSecret(query.verifyToken, verifyToken)) return { status: 401 };
        note(draftId, { addressCheckedAt: now().toISOString() });
        return { status: 200, challenge };
      }),

    hearDelivery: (draftId, rawBody, signature) =>
      guarded<WhatsAppSetupDeliveryAnswer>({ status: 404 }, async () => {
        const draft = await loadDraft(draftId);
        if (!draft) return { status: 404 };
        if (!signature) return { status: 401 };
        const appSecret = await secretOf(draft, "appSecret");
        if (!appSecret || !verifyWhatsAppWebhookSignature(signature, Buffer.from(rawBody, "utf8"), appSecret)) {
          return { status: 401 };
        }
        const payload = parseJson(rawBody);
        if (payload === undefined) return { status: 400 };
        const binding = verifyWhatsAppWebhookConnectionBinding({
          payload,
          expectedPhoneNumberId: asString(draft.draft.phoneNumberId),
        });
        if (!binding.ok) return { status: binding.reason === "missing_connection_identity" ? 400 : 403 };
        const code = asString(draft.draft.setupCode);
        const codeSender = code ? senderOfCode(payload, code) : undefined;
        if (code && codeSender) note(draftId, { code, codeSender });
        return { status: 200 };
      }),

    heard: (draftId) => {
      const entry = noted.get(draftId);
      if (!entry) return {};
      if (now().getTime() - entry.touchedAt >= WHATSAPP_SETUP_LISTEN_MS) {
        noted.delete(draftId);
        return {};
      }
      return {
        ...(entry.addressCheckedAt ? { addressCheckedAt: entry.addressCheckedAt } : {}),
        ...(entry.code ? { code: entry.code } : {}),
        ...(entry.codeSender ? { codeSender: { ...entry.codeSender } } : {}),
      };
    },
  };
}

/**
 * Runs one answer. A failure the listener did not expect (the draft store or secure storage failing) answers
 * `fallback`, and is logged by its kind only: what such an error says may hold a key.
 */
async function guarded<T>(fallback: T, answer: () => Promise<T>): Promise<T> {
  try {
    return await answer();
  } catch (error) {
    log.warn("The WhatsApp setup listener could not answer for a setup draft.", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return fallback;
  }
}

/** Only a new draft that the Messaging setup page made for WhatsApp is listened for. */
function qualifies(draft: ChannelSetupDraft): boolean {
  return (
    draft.catalogId === WHATSAPP_CATALOG_ID &&
    draft.lifecycleMode === "create" &&
    asRecord(draft.draft).setupPage === MESSAGING_SETUP_PAGE
  );
}

/** Constant-time, and false (never a throw) for a value that is not the key, whatever characters it uses. */
function sameSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  try {
    return timingSafeStringEqual(provided, expected);
  } catch {
    // Strings of one length can still differ in bytes, which `timingSafeEqual` refuses to compare.
    return false;
  }
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Who sent `code` by itself in a text message: the newest message in the delivery whose whole text is the code. An image
 * with the code as its caption, a message that has more in it, another case and a delivery status all say nothing.
 */
function senderOfCode(payload: unknown, code: string): WhatsAppSetupCodeSender | undefined {
  const root = asRecord(payload);
  if (asString(root.object) !== WHATSAPP_WEBHOOK_OBJECT) return undefined;
  let sender: WhatsAppSetupCodeSender | undefined;
  for (const entry of recordsOf(root.entry)) {
    for (const change of recordsOf(entry.changes)) {
      const value = asRecord(change.value);
      const contacts = recordsOf(value.contacts);
      for (const message of recordsOf(value.messages)) {
        const text = asRecord(message.text).body;
        if (message.type !== "text" || typeof text !== "string" || text.trim() !== code) continue;
        const actorId = asString(message.from);
        if (!actorId || actorId.length > MAX_ACTOR_ID_CHARS) continue;
        const displayName = nameOf(actorId, contacts);
        sender = { actorId, ...(displayName ? { displayName } : {}) };
      }
    }
  }
  return sender;
}

/**
 * The name on the sender's profile: the contact whose `wa_id` is the sender's number, or else the only contact the
 * delivery carries, even when its `wa_id` differs from the sender's `from`. With several contacts and none of them the
 * sender's, there is no name.
 */
function nameOf(actorId: string, contacts: Array<Record<string, unknown>>): string | undefined {
  const own =
    contacts.find((contact) => asString(contact.wa_id) === actorId) ??
    (contacts.length === 1 ? contacts[0] : undefined);
  return asString(asRecord(own?.profile).name)?.slice(0, MAX_DISPLAY_NAME_CHARS);
}

function recordsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}
