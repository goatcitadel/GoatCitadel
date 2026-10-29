import {
  ValidationError,
  type ChannelSetupCheckDraftRef,
  type ChannelSetupDraft,
  type WhatsAppSetupCheckInput,
  type WhatsAppSetupCheckResult,
  type WhatsAppSetupSubscribeResult,
} from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { assertDraftRevision, hydrateChannelSetupDraftSecrets } from "./channel-setup-draft-security.js";
import { channelSecretOwnerForDraft } from "./channel-secret-resolution.js";
import { buildEphemeralChannelConnection } from "./channel-setup-helpers.js";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
import type { WhatsAppSetupListener } from "./whatsapp-setup-listener.js";

/** Fixed sentences: an error here never carries a key, an address or anything Meta said. */
export const WHATSAPP_TOKEN_REJECTED = "Meta didn't accept the access token.";
export const WHATSAPP_NUMBER_NOT_FOUND = "Meta couldn't find that phone number ID for this access token.";
export const WHATSAPP_APP_REJECTED = "Meta didn't accept that App ID and App secret together.";
export const WHATSAPP_OTHER_APP = "That access token was made for a different Meta app.";
export const WHATSAPP_ACCOUNT_NOT_FOUND = "Meta couldn't find that WhatsApp Business Account for this access token.";
export const WHATSAPP_NUMBER_NOT_IN_ACCOUNT = "That phone number isn't in that WhatsApp Business Account.";
export const WHATSAPP_SUBSCRIBE_REFUSED =
  "Meta didn't let this app receive the account's messages. Check that the access token can manage the account.";
export const WHATSAPP_UNREACHABLE = "GoatCitadel couldn't reach Meta.";
export const WHATSAPP_DETAILS_MISSING = "Paste all five WhatsApp details first.";
export const WHATSAPP_DRAFT_ONLY = "Choose a WhatsApp setup draft to check.";

const GRAPH_API = "https://graph.facebook.com/v23.0";
const WHATSAPP_CATALOG_ID = "channel.whatsapp";
/** The largest answer is a page of a hundred numbers' ids. */
const MAX_ANSWER_BYTES = 256 * 1024;
/** Meta's IDs are digits. Only digits are ever put in an address, so an ID can never become a path or a query of its own. */
const META_ID = /^\d{6,30}$/;
/** Meta's error code for an object that doesn't exist, or that the token can't see. */
const GRAPH_NO_SUCH_OBJECT = 100;
/**
 * Graph's access-token error: Meta's own answer to a token it won't take (an expired temporary token is the usual
 * one). It comes with whatever HTTP status Meta chose, so it is read from the body, never from the status.
 */
const GRAPH_ACCESS_TOKEN_ERROR = 190;

type Graph = Record<string, unknown>;
interface GraphRequest {
  /** After the version: an ID, or `debug_token`, and what follows. Built only from digits and fixed words. */
  path: string;
  query?: string;
  /** The bearer: the access token, or the app token (`<app id>|<app secret>`) for `debug_token`. */
  credential: string;
  /**
   * The bearer is the app token, not the access token. A code 190 on such a call is about the App ID and secret, which
   * the caller reads as its own refusal, so it is not taken to mean the access token was refused.
   */
  appToken?: true;
  /** The one write: `subscribed_apps`, a POST with no body. */
  post?: true;
}
interface GraphAnswer {
  status: number;
  ok: boolean;
  /** Meta's JSON when it was a record, whatever the status; undefined when it was anything else. */
  body: Graph | undefined;
}
type AskMeta = (request: GraphRequest) => Promise<GraphAnswer>;

const fail = (message: string): ValidationError => new ValidationError({ message });
const unreachable = (): never => {
  throw fail(WHATSAPP_UNREACHABLE);
};

/**
 * Asks Meta about a WhatsApp setup draft with its saved access token and app secret, and answers with names and
 * facts: the business number as Meta shows it, when the token stops working, and whether the app gets the account's
 * messages. It also reports what the listener heard for the draft: when Meta checked the web address and who sent
 * `setupCode`. It only reads. Without `askMeta` nothing is asked of Meta and no key is read.
 *
 * Every failure is a fixed sentence. What Meta says on a refusal is decided on and dropped, never quoted, and no key
 * or address reaches a thrown message.
 */
export async function checkWhatsAppSetup(
  host: ChannelSetupHost,
  listener: Pick<WhatsAppSetupListener, "heard">,
  input: WhatsAppSetupCheckInput,
): Promise<WhatsAppSetupCheckResult> {
  const draft = await loadWhatsAppDraft(host, input);
  const heard = listener.heard(draft.draftId);
  const fromListener: WhatsAppSetupCheckResult = {
    ...(heard.addressCheckedAt ? { addressCheckedAt: heard.addressCheckedAt } : {}),
    ...(input.setupCode && heard.code === input.setupCode && heard.codeSender
      ? { codeSender: { ...heard.codeSender } }
      : {}),
  };
  if (!input.askMeta) return fromListener;

  const meta = await openMeta(host, draft, ["accessToken", "appSecret"]);
  const { accessToken, phoneNumberId, businessAccountId, appId } = meta.details;
  const appSecret = meta.secret("appSecret", "appSecretEnv");
  if (!accessToken || !appSecret || !phoneNumberId || !businessAccountId || !appId) {
    throw fail(WHATSAPP_DETAILS_MISSING);
  }

  const number = await numberOf(meta.ask, accessToken, phoneNumberId);
  const token = await tokenState(meta.ask, accessToken, appId, appSecret);
  await requireNumberInAccount(meta.ask, accessToken, businessAccountId, phoneNumberId);
  const appSubscribed = await isAppSubscribed(meta.ask, accessToken, businessAccountId, appId);

  return {
    number,
    ...(token.expiresAt ? { tokenExpiresAt: token.expiresAt } : {}),
    appSubscribed,
    ...fromListener,
  };
}

/**
 * Subscribes the access token's app to the account's messages: the one write this setup makes to Meta, and only when
 * asked. Meta's answer is `{success:true}`; anything else that is a refusal reads as one sentence.
 */
export async function subscribeWhatsAppSetupApp(
  host: ChannelSetupHost,
  input: ChannelSetupCheckDraftRef,
): Promise<WhatsAppSetupSubscribeResult> {
  const draft = await loadWhatsAppDraft(host, input);
  const meta = await openMeta(host, draft, ["accessToken"]);
  const { accessToken, businessAccountId } = meta.details;
  if (!accessToken || !businessAccountId) throw fail(WHATSAPP_DETAILS_MISSING);

  const answer = await meta.ask({
    path: `${businessAccountId}/subscribed_apps`,
    credential: accessToken,
    post: true,
  });
  if (!answer.ok) {
    throw fail(
      answer.status === 400 || answer.status === 401 || answer.status === 403
        ? WHATSAPP_SUBSCRIBE_REFUSED
        : WHATSAPP_UNREACHABLE,
    );
  }
  if (!answer.body) return unreachable();
  if (answer.body.success !== true) throw fail(WHATSAPP_SUBSCRIBE_REFUSED);
  return { appSubscribed: true };
}

/** The WhatsApp draft at the revision the operator is looking at. Create, edit and rotate drafts all qualify. */
async function loadWhatsAppDraft(host: ChannelSetupHost, input: ChannelSetupCheckDraftRef): Promise<ChannelSetupDraft> {
  const draft = await host.storage.channelSetupDrafts.get(input.draftId);
  if (draft.catalogId !== WHATSAPP_CATALOG_ID) throw fail(WHATSAPP_DRAFT_ONLY);
  assertDraftRevision(draft, input.expectedRevision);
  return draft;
}

/**
 * What a call to Meta needs from a draft: Meta, an ID reader and a key reader. A draft reads as the connection it will
 * have and as itself. Only the `keys` named are taken out of secure storage (the verify token never is), and an ID
 * that isn't digits reads as missing, so it cannot reach an address.
 */
async function openMeta(host: ChannelSetupHost, draft: ChannelSetupDraft, keys: readonly string[]) {
  const ownKeys = Object.fromEntries(Object.entries(draft.secretState ?? {}).filter(([field]) => keys.includes(field)));
  const connection = await buildEphemeralChannelConnection(
    host,
    hydrateChannelSetupDraftSecrets(host, { ...draft, secretState: ownKeys }),
  );
  const fetchWithTimeout = host.fetchWithTimeout;
  const resolveConnectionSecret = host.resolveConnectionSecret;
  if (!fetchWithTimeout || !resolveConnectionSecret) return unreachable();
  const owner = channelSecretOwnerForDraft(draft);
  const secret = (directKey: string, envKey: string): string | undefined =>
    resolveConnectionSecret(connection.config, directKey, envKey, connection.catalogId, owner);
  const idOf = (key: string): string | undefined => {
    const value = connection.config[key];
    return typeof value === "string" && META_ID.test(value.trim()) ? value.trim() : undefined;
  };
  const ask: AskMeta = (request) => askMeta(fetchWithTimeout, request);
  return {
    ask,
    secret,
    details: {
      accessToken: secret("accessToken", "accessTokenEnv"),
      phoneNumberId: idOf("phoneNumberId"),
      businessAccountId: idOf("businessAccountId"),
      appId: idOf("appId"),
    },
  };
}

/**
 * One Graph call. The answer is returned whatever its status, with Meta's JSON when it was a record. A call that never
 * answered, and an answer that cannot be read as a record, are not told apart from each other, and neither carries
 * anything Meta or the network said. The caller decides what a status means; no status text is ever quoted.
 */
async function askMeta(
  fetchWithTimeout: NonNullable<ChannelSetupHost["fetchWithTimeout"]>,
  request: GraphRequest,
): Promise<GraphAnswer> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${GRAPH_API}/${request.path}${request.query ? `?${request.query}` : ""}`, {
      method: request.post ? "POST" : "GET",
      headers: { Authorization: `Bearer ${request.credential}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return unreachable();
  }
  let body: Graph | undefined;
  try {
    const answer: unknown = await readBoundedResponseJson(response, {
      maxBytes: MAX_ANSWER_BYTES,
      timeoutMs: 5_000,
      label: "WhatsApp setup check",
    });
    body = isRecord(answer) ? answer : undefined;
  } catch {
    body = undefined;
  }
  // Every call that sends the access token reads Graph's access-token error (190) as the token being refused, whatever
  // the call and the status. Only the code is read; nothing Meta wrote is kept.
  if (!request.appToken && errorCodeOf(body) === GRAPH_ACCESS_TOKEN_ERROR) throw fail(WHATSAPP_TOKEN_REJECTED);
  return { status: response.status, ok: response.ok, body };
}

/** The business number as Meta shows it, and the name Meta verified. */
async function numberOf(
  ask: AskMeta,
  accessToken: string,
  phoneNumberId: string,
): Promise<{ displayNumber: string; verifiedName: string }> {
  const answer = await ask({
    path: phoneNumberId,
    query: "fields=display_phone_number,verified_name",
    credential: accessToken,
  });
  if (answer.status === 401) throw fail(WHATSAPP_TOKEN_REJECTED);
  if (answer.status === 400 && errorCodeOf(answer.body) === GRAPH_NO_SUCH_OBJECT) {
    throw fail(WHATSAPP_NUMBER_NOT_FOUND);
  }
  const body = readable(answer);
  const displayNumber = filled(body.display_phone_number);
  const verifiedName = filled(body.verified_name);
  if (!displayNumber || !verifiedName) return unreachable();
  return { displayNumber, verifiedName };
}

/**
 * Whether Meta accepts the token for this app, and when it stops working. The token is the thing asked about; the app
 * token is the credential that asks. `expires_at` is Unix seconds, and 0 is a token that never expires.
 */
async function tokenState(
  ask: AskMeta,
  accessToken: string,
  appId: string,
  appSecret: string,
): Promise<{ expiresAt?: string }> {
  const answer = await ask({
    path: "debug_token",
    query: `input_token=${encodeURIComponent(accessToken)}`,
    credential: `${appId}|${appSecret}`,
    appToken: true,
  });
  if (answer.status === 400) throw fail(WHATSAPP_APP_REJECTED);
  const data = recordOf(readable(answer).data);
  if (data.is_valid === false) throw fail(WHATSAPP_TOKEN_REJECTED);
  if (data.is_valid !== true) return unreachable();
  const madeFor = idString(data.app_id);
  if (!madeFor) return unreachable();
  if (madeFor !== appId) throw fail(WHATSAPP_OTHER_APP);
  const expiresAt = data.expires_at;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt < 0) return unreachable();
  if (expiresAt === 0) return {};
  const date = new Date(expiresAt * 1000);
  return Number.isNaN(date.getTime()) ? unreachable() : { expiresAt: date.toISOString() };
}

/** The number must be one of the account's numbers (Meta's first hundred), or the two IDs were pasted from different places. */
async function requireNumberInAccount(
  ask: AskMeta,
  accessToken: string,
  businessAccountId: string,
  phoneNumberId: string,
): Promise<void> {
  const answer = await ask({
    path: `${businessAccountId}/phone_numbers`,
    query: "fields=id&limit=100",
    credential: accessToken,
  });
  if (answer.status === 400) throw fail(WHATSAPP_ACCOUNT_NOT_FOUND);
  const ids = listOf(readable(answer).data).map((item) => idString(recordOf(item).id));
  if (!ids.includes(phoneNumberId)) throw fail(WHATSAPP_NUMBER_NOT_IN_ACCOUNT);
}

/** Whether the app gets the account's messages: it is among the apps subscribed to the account. */
async function isAppSubscribed(
  ask: AskMeta,
  accessToken: string,
  businessAccountId: string,
  appId: string,
): Promise<boolean> {
  const answer = await ask({ path: `${businessAccountId}/subscribed_apps`, credential: accessToken });
  return listOf(readable(answer).data).some(
    (item) => idString(recordOf(recordOf(item).whatsapp_business_api_data).id) === appId,
  );
}

/** Meta's `error.code`, which is all that is ever read from a refusal. */
function errorCodeOf(body: Graph | undefined): number | undefined {
  const code = recordOf(body?.error).code;
  return typeof code === "number" ? code : undefined;
}

/** Meta's JSON for an answer that said yes; anything else is a Meta that cannot be used. */
function readable(answer: GraphAnswer): Graph {
  return answer.ok && answer.body ? answer.body : unreachable();
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : unreachable();
}

/** A record, or an empty one: a field that is missing or the wrong shape then reads as missing. */
function recordOf(value: unknown): Graph {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Graph {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function filled(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** An ID as Meta writes it: a string of digits. */
function idString(value: unknown): string | undefined {
  return typeof value === "string" && META_ID.test(value.trim()) ? value.trim() : undefined;
}
