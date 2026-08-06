import type { ChatSessionPrefsRecord } from "@goatcitadel/contracts";

const LIVE_DATA_KEYWORD_REGEX = /\b(latest|today|news|weather|coming out|opening|releasing|release schedule)\b/i;

const RIGHT_NOW_EVENT_REGEX =
  /\b(right now)\b.{0,30}\b(news|weather|forecast|temperature|price|prices|stock|stocks|market|markets|headlines?|score|scores|conditions?|traffic|events?|releases?|games?|shows?|movies?)\b|\b(news|weather|forecast|temperature|price|prices|stock|stocks|market|markets|headlines?|score|scores|conditions?|traffic|events?|releases?|games?|shows?|movies?)\b.{0,30}\b(right now)\b/i;

const RECENCY_EVENT_REGEX =
  /\b(recent|recently|lately)\b.{0,30}\b(news|headlines?|events?|weather|forecast|release(?:s| schedule)?|price|prices|stock|stocks|market|markets|score|scores|traffic|deals?|sales?|benchmarks?|comparisons?)\b|\b(news|headlines?|events?|weather|forecast|release(?:s| schedule)?|price|prices|stock|stocks|market|markets|score|scores|traffic|deals?|sales?|benchmarks?|comparisons?)\b.{0,30}\b(recent|recently|lately)\b/i;

const PRICE_LOOKUP_REGEX =
  /\b(price of|stock price|share price|market price|crypto price|bitcoin price|btc price|eth price|gas price|oil price|latest price|current price)\b/i;

const LOCAL_RESEARCH_LOCATION_REGEX =
  /\b(?:near\s+me|nearby|within\s+\d+(?:\.\d+)?\s*(?:mi|mile|miles|km|kilometers?)|around\s+(?:zip\s+)?\d{5}(?:-\d{4})?|(?:zip|postal)\s+code\s+\d{5}(?:-\d{4})?|\b\d{5}(?:-\d{4})?\b)\b/i;

const LOCAL_RESEARCH_ENTITY_REGEX =
  /\b(?:stores?|shops?|retailers?|restaurants?|cafes?|coffee\s+shops?|bars?|venues?|locations?|business(?:es)?|clinics?|offices?|dealers?|tabletop|board\s*games?|game\s+stores?)\b/i;

const LOCAL_RESEARCH_DETAIL_REGEX =
  /\b(?:addresses?|hours?|open\s+hours?|email(?:\s+addresses?)?|phone(?:\s+numbers?)?|websites?|official\s+sites?|contact(?:\s+info(?:rmation)?)?)\b/i;

const LOCAL_RESEARCH_LIST_REGEX =
  /\b(?:find|list|directory|put\s+(?:a\s+)?list\s+together|near|nearby|within|around|closest|local)\b/i;

// Temporal phrases like "this week" only indicate live-data intent when
// paired with event/schedule context — "events this weekend" should match,
// but "I was busy this week" should not.
const TEMPORAL_EVENT_REGEX =
  /\b(happening|events?|schedule[ds]?|showing|playing|releases?|forecast|weather|deals?|sales?|openings?|concerts?|games?|movies?|shows?)\b.{0,30}\b(this week|this weekend|this month)\b|\b(this week|this weekend|this month)\b.{0,30}\b(happening|events?|schedule[ds]?|showing|playing|releases?|forecast|weather|deals?|sales?|openings?|concerts?|games?|movies?|shows?)\b/i;

const CURRENT_EVENT_REGEX =
  /\bcurrent\s+(news|events|weather|forecast|temperature|price|prices|stock|stocks|market|markets|headlines?|score|scores|conditions?|traffic)\b/i;

const EXPLICIT_WEB_PHRASES = [
  "look online",
  "search online",
  "search the web",
  "search the internet",
  "browse the web",
  "web search",
  "use internet",
  "use the internet",
  "search web",
  "browser.search",
  "browser.navigate",
  "http.get",
  "http.post",
];

const EXTERNAL_RESEARCH_ACTION_REGEX =
  /\b(?:(?:do|conduct|perform|undertake|carry\s+out)\s+(?:some\s+|independent\s+|external\s+)?research\s+(?:on|about|into|regarding)\s+|research\s+(?=(?:whether|which|what|who|where|when|why|how|the|a|an)\b))([^\n]+)/iu;

const RESEARCH_DELIVERY_SUFFIX_REGEX =
  /\s+(?:and(?:\s+then)?|then)\s+(?:put\s+together|create|make|build|produce|draft|generate|present\s+(?:it|that|them|this|the\s+(?:findings|results|research))\s+(?:in|as)|turn\s+(?:it|that)\s+into)\b[\s\S]*$/iu;

export { EXPLICIT_WEB_PHRASES };

export function hasLiveDataKeywords(objective: string): boolean {
  const normalized = objective.toLowerCase();
  return (
    LIVE_DATA_KEYWORD_REGEX.test(objective) ||
    RIGHT_NOW_EVENT_REGEX.test(objective) ||
    RECENCY_EVENT_REGEX.test(objective) ||
    PRICE_LOOKUP_REGEX.test(objective) ||
    CURRENT_EVENT_REGEX.test(objective) ||
    TEMPORAL_EVENT_REGEX.test(objective) ||
    hasResearchListIntent(objective) ||
    EXPLICIT_WEB_PHRASES.some((phrase) => normalized.includes(phrase)) ||
    normalized.includes("what's going on with") ||
    normalized.includes("whats going on with")
  );
}

export function hasResearchListIntent(objective: string): boolean {
  const normalized = objective.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  const hasLocation = LOCAL_RESEARCH_LOCATION_REGEX.test(normalized);
  const hasEntity = LOCAL_RESEARCH_ENTITY_REGEX.test(normalized);
  const hasDetailFields = LOCAL_RESEARCH_DETAIL_REGEX.test(normalized);
  const hasListShape = LOCAL_RESEARCH_LIST_REGEX.test(normalized);
  return hasLocation && hasEntity && (hasDetailFields || hasListShape);
}

export function extractExternalResearchSubject(objective: string): string | undefined {
  const delegatedText = extractDelegatedLiveDataText(objective).replace(/\s+/gu, " ").trim();
  const match = delegatedText.match(EXTERNAL_RESEARCH_ACTION_REGEX);
  const subject = match?.[1]
    ?.replace(RESEARCH_DELIVERY_SUFFIX_REGEX, "")
    .replace(/[,;:.!?]+$/gu, "")
    .trim();
  return subject && subject.length >= 3 ? subject.slice(0, 240) : undefined;
}

export function hasExternalResearchIntent(objective: string): boolean {
  const delegatedText = extractDelegatedLiveDataText(objective);
  return Boolean(
    extractExternalResearchSubject(delegatedText) ||
    (delegatedText !== objective.trim() ? extractExternalResearchSubject(objective) : undefined),
  );
}

export function extractDelegatedLiveDataText(objective: string): string {
  const normalized = objective.trim();
  if (!/^\s*Delegated role:/i.test(normalized)) {
    return normalized;
  }
  const pieces = ["Parent objective", "Current step objective", "Success criteria", "Expected output"]
    .map((label) => {
      const match = normalized.match(new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]+)`, "i"));
      return match?.[1]?.trim();
    })
    .filter((value): value is string => Boolean(value));
  return pieces.length > 0 ? pieces.join(" ") : normalized;
}

export function hasLiveDataIntent(objective: string): boolean {
  const delegatedText = extractDelegatedLiveDataText(objective);
  return (
    hasLiveDataKeywords(delegatedText) || (delegatedText !== objective.trim() ? hasLiveDataKeywords(objective) : false)
  );
}

export function shouldPreferToolBackedChatPath(
  objective: string,
  prefs: Pick<ChatSessionPrefsRecord, "webMode">,
): boolean {
  if (prefs.webMode === "off") {
    return false;
  }
  return hasLiveDataIntent(objective);
}
