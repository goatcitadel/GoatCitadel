import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { MCP_SETTINGS_LINK, type ConnectorNextLink } from "./connector-links";

type Refusal = { readonly words: string; readonly link?: ConnectorNextLink };
/** The install route's 409 refusals, by the field it names (R69); words that send the operator somewhere link there. */
const REFUSED = new Map<string, Refusal>([
  ["needsApiKey", { words: "This app needs an API key. Set it up in Advanced setup.", link: MCP_SETTINGS_LINK }],
  ["needsSignInSetup", { words: "Sign-in isn't set up for this app yet." }],
  ["alreadyInstalled", { words: "This app is already saved. Reload to see it." }],
  ["templateId", { words: "This app can't be installed from here." }],
]);
/** The install route's 503 when Change Plans are off (M5), which every Install on this install would hit. */
const SWITCHED_OFF: Refusal = {
  words:
    "Installing from here is switched off on this install, so nothing was changed. You can add it yourself in " +
    "Advanced setup.",
  link: MCP_SETTINGS_LINK,
};
/** An install the route refused before it changed anything, by the field or reason its answer names. */
export function refusalOf(error: unknown): Refusal | undefined {
  if (!isApiRequestError(error) || !error.body || typeof error.body !== "object") return undefined;
  const details = (error.body as { details?: { field?: unknown; reason?: unknown } }).details;
  if (error.status === 503 && details?.reason === "change_plans_off") return SWITCHED_OFF;
  return error.status === 409 && typeof details?.field === "string" ? REFUSED.get(details.field) : undefined;
}

export function connectorStoppedWords(name: string, enabled: boolean | undefined) {
  return enabled
    ? `Stopped. ${name} is switched on but may not be connected. Reload to check.`
    : `Stopped. ${name} is saved but switched off.`;
}
