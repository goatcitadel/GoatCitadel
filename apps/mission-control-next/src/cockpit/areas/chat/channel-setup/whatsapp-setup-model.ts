import type { WhatsAppSetupCodeSender } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { createSetupCode } from "./setup-code";
import { hostChange, type TurnOnWording } from "./TurnOnStep";

/** The words of WhatsApp's setup page, and the pure helpers that build what it saves, that need no state. */

export const WHATSAPP_CATALOG_ID = "channel.whatsapp";

/**
 * The one sentence a failed check comes to when GoatCitadel has no better one: Meta could not be asked, or something
 * went wrong on the way. What a failure carried is never shown, because it can quote the request the token travelled in.
 */
export const WHATSAPP_CHECK_FAILED = "GoatCitadel couldn't check those details with Meta.";

export const WHATSAPP_ADDRESS_WAITING = "Waiting for Meta to check your address…";
/** The moment a page session first sees Meta's check arrive: said once, by the status line, and nowhere it would stay. */
export const WHATSAPP_ADDRESS_CHECKED = "Meta checked your address just now.";
/** The same fact with no time in it, for what stays on screen and for a check noted on an earlier visit. */
export const WHATSAPP_ADDRESS_CHECKED_EARLIER = "Meta has checked your address.";
/** What the wait for Meta's check comes to when its ten minutes run out. */
export const WHATSAPP_ADDRESS_NOT_CHECKED =
  "Meta hasn't checked your address yet. Choose Verify and save in Meta, then check again.";
export const WHATSAPP_WAITING_FOR_HI = "Waiting for your message…";
export const WHATSAPP_CODE_EXPIRED = "The code ran out. Make a new one to try again.";

/**
 * How often the page asks whether Meta has checked the address, and whether the code has arrived. Both are the same
 * question, and the setup-check route allows 20 a minute: asking every 6 seconds is 10, which leaves the other 10 for
 * the checks that go on to Meta.
 */
export const WHATSAPP_LISTEN_POLL_MS = 6_000;

/** The five things the operator copies out of Meta's app dashboard. */
export interface WhatsAppDetails {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  appId: string;
  appSecret: string;
}

/** The details in the order the page asks for them, named as Meta (and the page) name them. */
const DETAIL_FIELDS: ReadonlyArray<{ key: keyof WhatsAppDetails; label: string; digitsOnly: boolean }> = [
  { key: "accessToken", label: "access token", digitsOnly: false },
  { key: "phoneNumberId", label: "Phone number ID", digitsOnly: true },
  { key: "businessAccountId", label: "WhatsApp Business Account ID", digitsOnly: true },
  { key: "appId", label: "App ID", digitsOnly: true },
  { key: "appSecret", label: "App secret", digitsOnly: false },
];

/** The details without the spaces and line breaks a paste brings along. */
export function trimmedWhatsAppDetails(details: WhatsAppDetails): WhatsAppDetails {
  return {
    accessToken: details.accessToken.trim(),
    phoneNumberId: details.phoneNumberId.trim(),
    businessAccountId: details.businessAccountId.trim(),
    appId: details.appId.trim(),
    appSecret: details.appSecret.trim(),
  };
}

/** The first detail that's missing or the wrong shape, as one sentence, or undefined. */
export function whatsAppDetailsProblem(details: WhatsAppDetails): string | undefined {
  for (const { key, label, digitsOnly } of DETAIL_FIELDS) {
    const value = details[key].trim();
    if (!value) return `Paste the ${label} first.`;
    if (digitsOnly && !/^\d+$/.test(value)) return `${label} is digits only.`;
  }
  return undefined;
}

const VERIFY_TOKEN_LENGTH = 32;

/**
 * A verify token for Meta's check of the address: 32 characters from the setup code's alphabet, all drawn from the
 * browser's secure random source with the bias thrown away, as the code's own are.
 */
export function createVerifyToken(): string {
  let token = "";
  while (token.length < VERIFY_TOKEN_LENGTH) token += createSetupCode();
  return token.slice(0, VERIFY_TOKEN_LENGTH);
}

/** The link that opens WhatsApp with the code ready to send: the number's digits only, as WhatsApp asks. */
export function waMeLink(displayNumber: string, code: string): string {
  return `https://wa.me/${displayNumber.replace(/\D/g, "")}?text=${encodeURIComponent(code)}`;
}

/**
 * The draft's values once someone has said hi: they alone may message the bot, they own the setup, and their WhatsApp is
 * where it posts. Anyone who said hi before is replaced. The values given are not changed.
 */
export function whatsAppDraftWithSender(
  values: Record<string, unknown>,
  sender: WhatsAppSetupCodeSender,
): Record<string, unknown> {
  return {
    ...values,
    allowedSenders: [sender.actorId],
    ownerActorIds: [sender.actorId],
    inboundAccessMode: "allowlist",
    defaultTarget: sender.actorId,
  };
}

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const textsOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(textOf).filter(Boolean) : []);

/**
 * Who said hi, as `whatsAppDraftWithSender` saved them: the setup's first owner, who is also allowed to message the bot
 * and is the one it posts to. Null before anyone has said hi, so a page coming back to the setup knows whether to ask
 * for a hi or to go straight on. WhatsApp keeps no name on the draft, so the sender comes back as their number alone.
 */
export function savedWhatsAppSender(values: Record<string, unknown>): WhatsAppSetupCodeSender | null {
  const actorId = textsOf(values.ownerActorIds)[0];
  if (!actorId) return null;
  if (!textsOf(values.allowedSenders).includes(actorId)) return null;
  if (values.inboundAccessMode !== "allowlist") return null;
  if (!textOf(values.defaultTarget)) return null;
  return { actorId };
}

/** When the page noted on the draft that Meta checked the address, so coming back goes on past that step. */
export function savedAddressCheckedAt(values: Record<string, unknown>): string | undefined {
  return textOf(values.webhookCheckedAt) || undefined;
}

/** Where the operator makes the Meta app: their list of apps, opened in a new tab. */
export const WHATSAPP_META_APPS_HREF = "https://developers.facebook.com/apps";

export const WHATSAPP_PUBLIC_ADDRESS_TEXT =
  "Meta delivers WhatsApp messages only to a public https:// address. Use your own domain, reverse proxy or tunnel; GoatCitadel doesn't provide one.";

/** Where each of the five details is found in Meta's dashboard, in the order the operator finds them. */
export const WHATSAPP_META_APP_STEPS = [
  'Open developers.facebook.com/apps and create an app for WhatsApp ("Connect with customers through WhatsApp").',
  "In API Setup, note the Phone number ID and the WhatsApp Business Account ID (Meta's test number is fine).",
  "In App settings › Basic, note the App ID and App secret.",
  "In Business Settings › System users, make a token for this app with whatsapp_business_messaging and whatsapp_business_management.",
] as const;

/** What the details that checked out say, naming the number and the name Meta verified for it. */
export const whatsAppWorks = (number: { displayNumber: string; verifiedName: string }) =>
  `Works. Your number is ${number.displayNumber} (${number.verifiedName}).`;

/**
 * The note on a token that stops working: this, the time it stops, then the advice. The details are done by then and
 * their fields are gone, and Start over would give Meta's Callback URL a new draft, so the advice sends the operator to
 * where a key is changed: the channel's page, once it is on.
 */
export const WHATSAPP_TOKEN_ENDS = "This token stops working";
export const WHATSAPP_TOKEN_ENDS_ADVICE =
  "Make a system user's token in Business Settings so WhatsApp keeps working, then change the key from WhatsApp's page once it's on.";

export const WHATSAPP_POINT_META_TEXT =
  "In your Meta app, open WhatsApp › Configuration. Paste these into Callback URL and Verify token, choose Verify and save, then subscribe to messages.";

/** Said where the verify token would be, when the page no longer holds the one it made. */
export const WHATSAPP_VERIFY_TOKEN_HIDDEN =
  "GoatCitadel doesn't show the verify token again after you leave this page. Make a new one to copy into Meta.";

/** Said beside the button that subscribes the app, when Meta says the app isn't. */
export const WHATSAPP_NOT_SUBSCRIBED = "Meta isn't set to send this number's messages to your app yet.";

export const WHATSAPP_SAY_HI_TEXT =
  "Open the link on your phone and send the message as it is. With Meta's test number, your phone may first need to be added under API Setup › To.";

/** The path Meta posts to: the draft's id stands for the connection's, because a new setup's connection keeps it. */
export const whatsAppCallbackPath = (draftId: string) => `/api/v1/integrations/connections/${draftId}/whatsapp/webhook`;

/** A sender by their name, else by their number. WhatsApp gives the number as digits, which are shown as a number. */
export function whatsAppSenderName(sender: WhatsAppSetupCodeSender): string {
  const named = sender.displayName?.trim();
  if (named) return named;
  const actor = sender.actorId.trim();
  return /^\d+$/.test(actor) ? `+${actor}` : actor;
}

export const whatsAppSaidHi = (name: string) => `${name} can message your bot.`;

/** The words of Turn on for WhatsApp. Its test message can't be taken back, so the cleanup sentence says where to delete it. */
export const WHATSAPP_TURN_ON_WORDING: TurnOnWording = {
  button: "Turn on WhatsApp",
  working: "Turning on WhatsApp…",
  done: "WhatsApp is on.",
  doneLink: "Open WhatsApp's page",
  cleanup: "GoatCitadel couldn't remove its test message. Delete it in WhatsApp if you like.",
};

/** What turning on will do, as plain lines. A host appears only when it is not yet allowed. */
export function whatsAppTurnOnChanges({
  name,
  missingHosts,
}: {
  name: string;
  missingHosts: readonly string[];
}): string[] {
  return [
    `Only ${name} can message your WhatsApp bot.`,
    `Replies go to ${name} on WhatsApp.`,
    `GoatCitadel sends ${name} a test message. WhatsApp can't remove it afterwards.`,
    ...missingHosts.map(hostChange),
  ];
}

/** The longest sentence of GoatCitadel's own that is passed on. Anything longer is not one of its fixed sentences. */
const LONGEST_SENTENCE = 300;

/** GoatCitadel's sentence when it has no secure storage for channel keys, whatever status it comes with. */
const NO_KEY_STORE_SAID = "Secure channel credential storage is unavailable.";

/**
 * What the page says for it: keys pasted here need secure storage, and the guide in Advanced channel setup takes
 * environment variables.
 */
export const WHATSAPP_NO_KEY_STORE =
  "This page stores your keys in this computer's secure storage, which isn't available here. Use WhatsApp's guide in Advanced channel setup with environment variables instead.";
/** The words of `WHATSAPP_NO_KEY_STORE` that link to WhatsApp's guide in Advanced channel setup. */
export const WHATSAPP_NO_KEY_STORE_LINK = "WhatsApp's guide in Advanced channel setup";

/** The sentence a GoatCitadel error carries, from its body; empty when it carries none. */
function saidBy(error: { body?: unknown }): string {
  const body: unknown = error.body;
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return textOf(fields.error) || textOf(fields.message);
}

/**
 * Why a check or a subscribe failed, as one sentence to show. A 400 carries one of GoatCitadel's own fixed sentences
 * about the details ("Meta didn't accept the access token."), which is said as it is. GoatCitadel's one sentence for
 * having no secure key storage is matched exactly, at any status, and said as `WHATSAPP_NO_KEY_STORE`. Every other
 * failure, and a 400 that carries no such sentence, says the fixed one: what a failure carried is never shown, because
 * it can quote the request the token travelled in.
 */
export function whatsAppFailure(error: unknown): string {
  if (!isApiRequestError(error)) return WHATSAPP_CHECK_FAILED;
  const said = saidBy(error);
  if (said === NO_KEY_STORE_SAID) return WHATSAPP_NO_KEY_STORE;
  if (error.status !== 400) return WHATSAPP_CHECK_FAILED;
  return said.length <= LONGEST_SENTENCE && said.endsWith(".") ? said : WHATSAPP_CHECK_FAILED;
}
