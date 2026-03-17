import type { ChatSessionPrefsRecord } from "@goatcitadel/contracts";

const LIVE_DATA_KEYWORD_REGEX =
  /\b(latest|today|right now|news|weather|recent|recently|lately|coming out|opening|releasing|release schedule)\b/;

const PRICE_LOOKUP_REGEX =
  /\b(price of|stock price|share price|market price|crypto price|bitcoin price|btc price|eth price|gas price|oil price|latest price|current price)\b/;

// Temporal phrases like "this week" only indicate live-data intent when
// paired with event/schedule context — "events this weekend" should match,
// but "I was busy this week" should not.
const TEMPORAL_EVENT_REGEX =
  /\b(happening|events?|schedule[ds]?|showing|playing|releases?|forecast|weather|deals?|sales?|openings?|concerts?|games?|movies?|shows?)\b.{0,30}\b(this week|this weekend|this month)\b|\b(this week|this weekend|this month)\b.{0,30}\b(happening|events?|schedule[ds]?|showing|playing|releases?|forecast|weather|deals?|sales?|openings?|concerts?|games?|movies?|shows?)\b/i;

const CURRENT_EVENT_REGEX =
  /\bcurrent\s+(news|events|weather|forecast|temperature|price|prices|stock|stocks|market|markets|headlines?|score|scores|conditions?|traffic)\b/;

const EXPLICIT_WEB_PHRASES = [
  "look online",
  "search online",
  "browse the web",
  "web search",
  "use internet",
  "search web",
  "browser.search",
  "browser.navigate",
  "http.get",
  "http.post",
];

export { EXPLICIT_WEB_PHRASES };

export function hasLiveDataKeywords(objective: string): boolean {
  return (
    LIVE_DATA_KEYWORD_REGEX.test(objective)
    || PRICE_LOOKUP_REGEX.test(objective)
    || CURRENT_EVENT_REGEX.test(objective)
    || TEMPORAL_EVENT_REGEX.test(objective)
    || EXPLICIT_WEB_PHRASES.some((phrase) => objective.includes(phrase))
    || objective.includes("what's going on with")
    || objective.includes("whats going on with")
  );
}

export function shouldPreferToolBackedChatPath(
  objective: string,
  prefs: Pick<ChatSessionPrefsRecord, "webMode">,
): boolean {
  if (prefs.webMode === "off") {
    return false;
  }
  return hasLiveDataKeywords(objective);
}
