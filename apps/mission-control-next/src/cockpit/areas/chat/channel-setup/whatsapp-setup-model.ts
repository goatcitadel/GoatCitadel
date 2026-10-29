import type { WhatsAppSetupCodeSender } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { createSetupCode } from "./setup-code";

/** The words of WhatsApp's setup page, and the pure helpers that build what it saves, that need no state. */

export const WHATSAPP_CATALOG_ID = "channel.whatsapp";

/**
 * The one sentence a failed check comes to when GoatCitadel has no better one: Meta could not be asked, or something
 * went wrong on the way. What a failure carried is never shown, because it can quote the request the token travelled in.
 */
export const WHATSAPP_CHECK_FAILED = "GoatCitadel couldn't check those details with Meta.";

export const WHATSAPP_ADDRESS_WAITING = "Waiting for Meta to check your address…";
export const WHATSAPP_ADDRESS_CHECKED = "Meta checked your address just now.";
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

/** The longest sentence of GoatCitadel's own that is passed on. Anything longer is not one of its fixed sentences. */
const LONGEST_SENTENCE = 300;

/**
 * Why a check or a subscribe failed, as one sentence to show. A 400 carries one of GoatCitadel's own fixed sentences
 * about the details ("Meta didn't accept the access token."), which is said as it is. Every other failure, and a 400
 * that carries no such sentence, says the fixed one: what a failure carried is never shown, because it can quote the
 * request the token travelled in.
 */
export function whatsAppFailure(error: unknown): string {
  if (!isApiRequestError(error) || error.status !== 400) return WHATSAPP_CHECK_FAILED;
  const body: unknown = error.body;
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const said = textOf(fields.error) || textOf(fields.message);
  return said.length <= LONGEST_SENTENCE && said.endsWith(".") ? said : WHATSAPP_CHECK_FAILED;
}
