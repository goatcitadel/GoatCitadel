import { extractPrimaryUserTaskContent } from "./chat-agent-prompt-lab-contract.js";

export type LocalBusinessVerificationStatus = "verified" | "partial" | "unverified";

export interface LocalBusinessEvidenceRef {
  url: string;
  title?: string;
  snippet?: string;
  evidenceKind: "identity" | "address" | "website" | "email" | "contact_name" | "listing" | "blocked";
  confidence: "high" | "medium" | "low";
}

export interface LocalBusinessContactVerification {
  storeName: string;
  address?: string;
  distanceMiles?: number;
  category: string;
  website?: string;
  email?: string;
  contactName?: string;
  contactRole?: string;
  sourceUrls: string[];
  confidence: "high" | "medium" | "low";
  verificationStatus: LocalBusinessVerificationStatus;
  blockers: string[];
  evidence: LocalBusinessEvidenceRef[];
}

export interface LocalBusinessResearchPlan {
  location: string;
  radiusMiles?: number;
  categories: string[];
  requireEmail: boolean;
  requireContactName: boolean;
  primaryQuery: string;
  alternateQueries: string[];
  evidenceRequirements: string[];
  optionalProviders: string[];
}

export interface LocalBusinessResearchAnnotation {
  kind: "local_business_contact_research";
  plan: LocalBusinessResearchPlan;
  candidates: LocalBusinessContactVerification[];
  excluded: Array<{ reason: string; sourceUrl?: string; title?: string }>;
  blockers: string[];
  verificationNote: string;
}

const ZIP_AREA_HINTS: Record<string, string[]> = {
  "91303": ["Canoga Park", "Woodland Hills", "Winnetka"],
};

const LOCAL_BUSINESS_CATEGORY_HINTS = [
  {
    category: "board game and tabletop game store",
    pattern: /\b(board\s*games?|boardgame|tabletop|table\s*top|card\s*games?|tcg|rpg|warhammer|miniatures?)\b/i,
    terms: ["board game store", "tabletop game store", "card game shop", "hobby game store"],
  },
  {
    category: "restaurant",
    pattern: /\brestaurants?\b/i,
    terms: ["restaurant"],
  },
  {
    category: "local business",
    pattern: /\b(stores?|shops?|business(?:es)?|vendors?)\b/i,
    terms: ["local business"],
  },
];

const BLOCKED_SOURCE_HOSTS = [/(\.|^)yelp\.com$/i, /(\.|^)facebook\.com$/i, /(\.|^)instagram\.com$/i];

export function detectLocalBusinessContactIntent(content: string): boolean {
  return Boolean(buildLocalBusinessResearchPlan(content));
}

export function buildLocalBusinessResearchPlan(content: string): LocalBusinessResearchPlan | undefined {
  const task = cleanResearchTaskText(content);
  const normalized = task.toLowerCase();
  const hasLocalBusinessSignal =
    /\b(within|radius|near|nearby|local|around|in)\b/.test(normalized) &&
    /\b(stores?|shops?|business(?:es)?|vendors?)\b/.test(normalized);
  const wantsContact =
    /\b(email(?:s| addresses?)?|contact|owner|manager|address(?:ed)?|who\s+(?:can|should)\s+i\s+address)\b/i.test(task);
  const zip = task.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]?.slice(0, 5);
  const categories = resolveLocalBusinessCategories(task);
  if (!hasLocalBusinessSignal || !wantsContact || !zip || categories.length === 0) {
    return undefined;
  }
  const radiusMiles = parseRadiusMiles(task);
  const locationTerms = [zip, ...(ZIP_AREA_HINTS[zip] ?? [])].join(" ");
  const primaryCategory = categories[0] ?? "local business";
  const requireEmail = /\bemail(?:s| addresses?)?\b/i.test(task);
  const requireContactName =
    /\b(owner|manager|contact name|who\s+(?:can|should)\s+i\s+address|address\s+in\s+them)\b/i.test(task);
  const primaryQuery = sanitizeLocalBusinessQuery(
    [
      primaryCategory,
      locationTerms,
      radiusMiles ? `${radiusMiles} miles` : undefined,
      requireEmail ? "official contact email" : "official website contact",
    ]
      .filter(Boolean)
      .join(" "),
  );
  const categoryTerms = categorySearchTerms(task);
  const alternateQueries = [
    `${categoryTerms[0] ?? primaryCategory} ${zip} official website contact email`,
    `${categoryTerms[1] ?? primaryCategory} near ${zip} store locator`,
    `Wizards Store Locator ${zip} tabletop game store`,
    `Warhammer store locator ${zip} game store`,
    `${primaryCategory} ${ZIP_AREA_HINTS[zip]?.join(" ") ?? zip} owner manager email`,
  ]
    .map(sanitizeLocalBusinessQuery)
    .filter((query, index, items) => query.length > 0 && items.indexOf(query) === index)
    .slice(0, 5);
  return {
    location: zip,
    radiusMiles,
    categories,
    requireEmail,
    requireContactName,
    primaryQuery,
    alternateQueries,
    evidenceRequirements: [
      "Verify business identity and address from an official site, official store locator, or accessible reputable listing.",
      "Verify email and named contacts only from public business pages, contact/about pages, or official profile pages.",
      "Label entries partial when identity is found but public email/contact-name evidence is missing.",
      "Treat blocked listing sites as blockers or secondary leads, not verified contact evidence.",
    ],
    optionalProviders: ["google_places", "bing_local", "yelp_fusion"],
  };
}

export function resolveLocalBusinessSearchQuery(content: string, rawQuery?: string): string | undefined {
  const plan = buildLocalBusinessResearchPlan(content);
  if (!plan) {
    return undefined;
  }
  const sanitizedRaw = rawQuery ? sanitizeLocalBusinessQuery(rawQuery) : "";
  if (
    !sanitizedRaw ||
    looksLikeDelegationWrapperQuery(sanitizedRaw) ||
    !hasUsefulLocalBusinessQueryTerms(sanitizedRaw)
  ) {
    return plan.primaryQuery;
  }
  const quoteBalanced = balanceLooseQuotes(sanitizedRaw);
  return quoteBalanced.length >= 3 ? quoteBalanced.slice(0, 240) : plan.primaryQuery;
}

export function annotateLocalBusinessBrowserResult(input: {
  toolName: string;
  args: Record<string, unknown>;
  userContent: string;
  result: Record<string, unknown>;
}): Record<string, unknown> {
  const plan = buildLocalBusinessResearchPlan(input.userContent);
  if (!plan || input.toolName !== "browser.search") {
    return input.result;
  }
  const annotation = buildLocalBusinessResearchAnnotation(plan, input.result);
  return {
    ...input.result,
    localBusinessResearch: annotation,
  };
}

function buildLocalBusinessResearchAnnotation(
  plan: LocalBusinessResearchPlan,
  result: Record<string, unknown>,
): LocalBusinessResearchAnnotation {
  const candidates: LocalBusinessContactVerification[] = [];
  const excluded: LocalBusinessResearchAnnotation["excluded"] = [];
  const results = Array.isArray(result.results) ? result.results : [];
  for (const item of results) {
    const record = isRecord(item) ? item : {};
    const url = readString(record.url);
    const title = readString(record.title);
    const snippet = readString(record.snippet) ?? readString(record.textSnippet);
    if (!url) {
      continue;
    }
    const host = readHost(url);
    if (host && BLOCKED_SOURCE_HOSTS.some((pattern) => pattern.test(host))) {
      excluded.push({ reason: "blocked_or_secondary_listing_source", sourceUrl: url, title });
      continue;
    }
    const storeName = inferStoreName(title, snippet);
    if (!storeName) {
      excluded.push({ reason: "no_business_identity_in_result", sourceUrl: url, title });
      continue;
    }
    const hasAddressSignal = Boolean(
      snippet && /\b(?:ca|california|zip|91303|canoga park|woodland hills|winnetka)\b/i.test(snippet),
    );
    const evidence: LocalBusinessEvidenceRef[] = [
      {
        url,
        title,
        snippet,
        evidenceKind: "identity",
        confidence: title ? "medium" : "low",
      },
    ];
    if (hasAddressSignal) {
      evidence.push({
        url,
        title,
        snippet,
        evidenceKind: "address",
        confidence: "medium",
      });
    }
    candidates.push({
      storeName,
      category: plan.categories[0] ?? "local business",
      website: isLikelyOfficialBusinessUrl(url) ? url : undefined,
      sourceUrls: [url],
      confidence: hasAddressSignal ? "medium" : "low",
      verificationStatus: hasAddressSignal ? "partial" : "unverified",
      blockers: [
        ...(plan.requireEmail ? ["email_not_verified_from_search_result"] : []),
        ...(plan.requireContactName ? ["contact_name_not_verified_from_search_result"] : []),
      ],
      evidence,
    });
  }
  const blockers = readFallbackBlockers(result);
  return {
    kind: "local_business_contact_research",
    plan,
    candidates,
    excluded,
    blockers,
    verificationNote:
      "Search-result snippets are leads only. Mark email/contact names verified only after navigating official/contact pages or configured local-business provider evidence.",
  };
}

function cleanResearchTaskText(content: string): string {
  const primary = extractPrimaryUserTaskContent(content) || content;
  const objective = readLabeledMultiline(primary, "Objective") ?? readLabeledMultiline(primary, "Parent objective");
  const currentStep = readLabeledMultiline(primary, "Current step objective");
  const task = [objective, currentStep].filter(Boolean).join(" ") || primary;
  return task
    .replace(/\bSuggested tools:\s*[^.\n]+/gi, " ")
    .replace(/\bReturn concise,\s*high-signal output\b[\s\S]*$/i, " ")
    .replace(/\bExecute the main workstream\b[^.?!\n]*[.?!]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readLabeledMultiline(content: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(`(?:^|\\n)${escaped}:\\s*([\\s\\S]*?)(?:\\n[A-Z][A-Za-z ]{2,40}:|\\n\\n|$)`, "i"),
  );
  const value = match?.[1]?.replace(/\s+/g, " ").trim();
  return value && value.length >= 3 ? value : undefined;
}

function resolveLocalBusinessCategories(task: string): string[] {
  const categories = LOCAL_BUSINESS_CATEGORY_HINTS.filter((hint) => hint.pattern.test(task)).map(
    (hint) => hint.category,
  );
  return categories.length > 0 ? categories.filter((category, index, items) => items.indexOf(category) === index) : [];
}

function categorySearchTerms(task: string): string[] {
  return LOCAL_BUSINESS_CATEGORY_HINTS.filter((hint) => hint.pattern.test(task)).flatMap((hint) => hint.terms);
}

function parseRadiusMiles(task: string): number | undefined {
  const match = task.match(/\bwithin\s+(?:a\s+)?(\d{1,3})(?:\.\d+)?\s*-?\s*miles?\b/i);
  const value = match?.[1] ? Number.parseInt(match[1], 10) : undefined;
  return value && Number.isFinite(value) ? Math.max(1, Math.min(value, 250)) : undefined;
}

function sanitizeLocalBusinessQuery(value: string): string {
  return balanceLooseQuotes(
    value
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\b(?:Delegated role|Parent objective|Current step objective|Plan summary|Suggested tools):/gi, " ")
      .replace(/\bExecute the main workstream\b[^.?!\n]*[.?!]?/gi, " ")
      .replace(/\bReturn concise,\s*high-signal output\b[\s\S]*$/i, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function looksLikeDelegationWrapperQuery(value: string): boolean {
  return /\b(?:Delegated role|Parent objective|Current step objective|Plan summary|Suggested tools|Execute the main workstream)\b/i.test(
    value,
  );
}

function hasUsefulLocalBusinessQueryTerms(value: string): boolean {
  return /\b(?:store|shop|business|board\s*game|tabletop|contact|email|official|locator|91303|canoga|woodland|winnetka)\b/i.test(
    value,
  );
}

function balanceLooseQuotes(value: string): string {
  const withoutCurly = value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const doubleCount = (withoutCurly.match(/"/g) ?? []).length;
  const singleCount = (withoutCurly.match(/'/g) ?? []).length;
  return withoutCurly
    .replace(doubleCount % 2 === 1 ? /"/g : /a^/, "")
    .replace(singleCount % 2 === 1 ? /'/g : /a^/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferStoreName(title?: string, snippet?: string): string | undefined {
  const source = title ?? snippet;
  if (!source) {
    return undefined;
  }
  const cleaned = source
    .split(/\s[-|–—]\s|\s:\s/)
    .map((part) => part.trim())
    .find((part) => part.length >= 3 && !/^(yelp|facebook|instagram|google maps|bing maps)$/i.test(part));
  return cleaned?.replace(/\b(?:official site|website|contact us)\b/gi, "").trim() || undefined;
}

function isLikelyOfficialBusinessUrl(url: string): boolean {
  const host = readHost(url);
  if (!host) {
    return false;
  }
  return !/(\.|^)(google|bing|duckduckgo|yelp|facebook|instagram|yellowpages|mapquest)\./i.test(host);
}

function readFallbackBlockers(result: Record<string, unknown>): string[] {
  const fallbackChain = Array.isArray(result.fallbackChain) ? result.fallbackChain : [];
  return fallbackChain
    .map((entry) => (isRecord(entry) ? readString(entry.error) : undefined))
    .filter((value): value is string => Boolean(value && /blocked|403|captcha|rate/i.test(value)))
    .slice(0, 5);
}

function readHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
