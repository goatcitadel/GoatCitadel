/* eslint-disable max-lines */
import { extractPrimaryUserTaskContent } from "./chat-agent-prompt-lab-contract.js";

export type LocalBusinessVerificationStatus = "verified" | "partial" | "unverified";
export type LocalBusinessResearchStageName =
  | "query_plan"
  | "candidate_discovery"
  | "candidate_normalization"
  | "evidence_navigation"
  | "contact_extraction"
  | "verification_scoring"
  | "blockers";
export type LocalBusinessResearchStageStatus = "complete" | "partial" | "blocked";

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

export interface LocalBusinessResearchStage {
  name: LocalBusinessResearchStageName;
  status: LocalBusinessResearchStageStatus;
  summary: string;
  queries?: string[];
  resultCount?: number;
  candidateCount?: number;
  excludedCount?: number;
  sourceUrls?: string[];
  blockers?: string[];
}

export interface LocalBusinessResearchAnnotation {
  kind: "local_business_contact_research";
  workflow: "local_business.research";
  plan: LocalBusinessResearchPlan;
  stages: LocalBusinessResearchStage[];
  candidates: LocalBusinessContactVerification[];
  excluded: Array<{ reason: string; sourceUrl?: string; title?: string }>;
  blockers: string[];
  verificationNote: string;
}

export interface LocalBusinessResearchEvidenceCitation {
  title?: string;
  url: string;
  snippet?: string;
}

type LocalBusinessSourceKind = "official" | "profile" | "listing" | "secondary_blocked";

interface LocalBusinessLead {
  url: string;
  title?: string;
  snippet?: string;
  host?: string;
  sourceKind: LocalBusinessSourceKind;
  blockedReason?: string;
}

interface LocalBusinessProcessingStats {
  resultCount: number;
  blockedListingCount: number;
  weakExcludedCount: number;
  unlocatedExcludedCount: number;
  contactEvidenceUrls: string[];
  verifiedContactFieldCount: number;
  verifiedCandidateCount: number;
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
const LISTING_SOURCE_HOSTS = [
  /(\.|^)google\.com$/i,
  /(\.|^)bing\.com$/i,
  /(\.|^)duckduckgo\.com$/i,
  /(\.|^)yellowpages\.com$/i,
  /(\.|^)mapquest\.com$/i,
];
const OFFICIAL_PROFILE_HOSTS = [/(\.|^)wizards\.com$/i, /(\.|^)warhammer\.com$/i];
const GENERIC_LOCAL_BUSINESS_TITLE_PATTERN =
  /\b(?:best|top|near(?:by)?|stores?\s+near|shops?\s+near|local\s+business(?:es)?|board\s*game\s+stores?|tabletop\s+stores?|game\s+stores?|search\s+results?|store\s+locator)\b/i;

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
  const primaryCategory = categories[0] ?? "local business";
  const requireEmail = /\bemail(?:s| addresses?)?\b/i.test(task);
  const requireContactName =
    /\b(owner|manager|contact name|who\s+(?:can|should)\s+i\s+address|address\s+in\s+them)\b/i.test(task);
  const areaHints = ZIP_AREA_HINTS[zip] ?? [];
  const primaryCity = areaHints[0] ?? zip;
  const secondaryCity = areaHints[1] ?? primaryCity;
  const tertiaryCity = areaHints[2] ?? primaryCity;
  const radiusText = radiusMiles ? `${radiusMiles} mile radius` : undefined;
  const categoryTerms = categorySearchTerms(task);
  const primarySearchTerm = categoryTerms.includes("card game shop")
    ? "card game shop"
    : (categoryTerms[0] ?? primaryCategory);
  const primaryQueryParts =
    primarySearchTerm === "card game shop"
      ? [primaryCity, zip, "TCG", "contact", "game store", "official email", radiusText]
      : [
          `"${primarySearchTerm}"`,
          `"${primaryCity}"`,
          "CA",
          zip,
          radiusText,
          requireEmail ? "official contact email" : "official website contact",
        ];
  const primaryQuery = sanitizeLocalBusinessQuery(primaryQueryParts.filter(Boolean).join(" "));
  const groundedLocationTerms = [zip, ...areaHints, radiusText].filter(Boolean).join(" ");
  const alternateQueries = [
    `"${categoryTerms[1] ?? categoryTerms[0] ?? primaryCategory}" "${secondaryCity}" CA ${zip} ${radiusText ?? ""} official contact email`,
    `"game store" "${tertiaryCity}" "${primaryCity}" CA ${zip} ${radiusText ?? ""} contact email`,
    `Wizards Store Locator ${groundedLocationTerms} tabletop game store`,
    `Warhammer store locator ${groundedLocationTerms} game store`,
    `"Magic the Gathering" store ${primaryCity} ${secondaryCity} ${zip} ${radiusText ?? ""} contact email`,
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
  const rawLooksLikeDelegationWrapper = rawQuery ? looksLikeDelegationWrapperQuery(rawQuery) : false;
  if (!sanitizedRaw || rawLooksLikeDelegationWrapper || !hasUsefulLocalBusinessQueryTerms(sanitizedRaw)) {
    return plan.primaryQuery;
  }
  const quoteBalanced = balanceLooseQuotes(sanitizedRaw);
  if (quoteBalanced.length < 3) {
    return plan.primaryQuery;
  }
  return isGroundedLocalBusinessRawQuery(plan, quoteBalanced)
    ? quoteBalanced.slice(0, 240)
    : mergeLocalBusinessSearchQuery(plan, quoteBalanced);
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

export function buildLocalBusinessResearchAnnotationFromEvidence(input: {
  userContent: string;
  finalAnswer?: string;
  citations?: LocalBusinessResearchEvidenceCitation[];
}): LocalBusinessResearchAnnotation | undefined {
  const plan = buildLocalBusinessResearchPlan(input.userContent);
  if (!plan) {
    return undefined;
  }
  const citations = dedupeLocalBusinessCitations(input.citations ?? []);
  const citationResult = buildLocalBusinessResearchAnnotation(plan, {
    results: citations.map((citation) => ({
      title: citation.title,
      url: citation.url,
      snippet: citation.snippet,
    })),
    fallbackChain: extractFinalAnswerSourceBlockers(input.finalAnswer).map((error) => ({ error })),
  });
  const rowCandidates = buildCandidatesFromFinalAnswerRows(plan, input.finalAnswer, citations);
  const candidates = mergeLocalBusinessCandidates([...citationResult.candidates, ...rowCandidates]);
  const excluded = citationResult.excluded;
  const stats = buildEvidenceAnnotationStats(citations, candidates, excluded);
  const blockers = buildAnnotationBlockers(
    [
      ...citationResult.blockers,
      ...extractFinalAnswerSourceBlockers(input.finalAnswer),
      ...(candidates.length === 0 ? ["candidate_discovery_incomplete"] : []),
      ...(plan.requireEmail && candidates.some((candidate) => !candidate.email)
        ? ["research_evidence_incomplete: email evidence missing for at least one candidate"]
        : []),
      ...(plan.requireContactName && candidates.some((candidate) => !candidate.contactName)
        ? ["research_evidence_incomplete: contact-name evidence missing for at least one candidate"]
        : []),
    ],
    candidates,
    stats,
  );
  return {
    kind: "local_business_contact_research",
    workflow: "local_business.research",
    plan,
    stages: buildLocalBusinessResearchStages(plan, candidates, excluded, blockers, stats),
    candidates,
    excluded,
    blockers,
    verificationNote:
      "local_business.research retained source-backed evidence from browser/search traces, citations, and final synthesis. Emails or contact names remain partial unless retained public business source evidence supports them.",
  };
}

function buildLocalBusinessResearchAnnotation(
  plan: LocalBusinessResearchPlan,
  result: Record<string, unknown>,
): LocalBusinessResearchAnnotation {
  const candidates: LocalBusinessContactVerification[] = [];
  const excluded: LocalBusinessResearchAnnotation["excluded"] = [];
  const results = Array.isArray(result.results) ? result.results : [];
  const stats: LocalBusinessProcessingStats = {
    resultCount: results.length,
    blockedListingCount: 0,
    weakExcludedCount: 0,
    unlocatedExcludedCount: 0,
    contactEvidenceUrls: [],
    verifiedContactFieldCount: 0,
    verifiedCandidateCount: 0,
  };
  for (const item of results) {
    const record = isRecord(item) ? item : {};
    const lead = readLocalBusinessLead(record);
    if (!lead) {
      continue;
    }
    if (lead.sourceKind === "secondary_blocked") {
      stats.blockedListingCount += 1;
      excluded.push({
        reason: lead.blockedReason ?? "blocked_or_secondary_listing_source",
        sourceUrl: lead.url,
        title: lead.title,
      });
      continue;
    }
    const storeName = inferStoreName(lead.title, lead.snippet);
    if (!storeName) {
      excluded.push({ reason: "no_business_identity_in_result", sourceUrl: lead.url, title: lead.title });
      continue;
    }
    const hasLocationSignal = hasLocalBusinessLocationSignal(plan, [lead.title, lead.snippet, lead.url].join(" "));
    if (isWeakAmbiguousCandidate(storeName, lead, hasLocationSignal)) {
      stats.weakExcludedCount += 1;
      excluded.push({ reason: "weak_ambiguous_business_identity", sourceUrl: lead.url, title: lead.title });
      continue;
    }
    if (!hasLocationSignal) {
      stats.unlocatedExcludedCount += 1;
      excluded.push({ reason: "location_not_verified_from_search_result", sourceUrl: lead.url, title: lead.title });
      continue;
    }
    const contactEvidenceBacked = canVerifyContactFromSource(lead);
    if (contactEvidenceBacked) {
      stats.contactEvidenceUrls.push(lead.url);
    }
    const email = contactEvidenceBacked ? extractPrimaryEmail([lead.title, lead.snippet].join(" ")) : undefined;
    const contact = contactEvidenceBacked ? extractContactName([lead.title, lead.snippet].join(" ")) : undefined;
    stats.verifiedContactFieldCount += (email ? 1 : 0) + (contact?.name ? 1 : 0);
    const verificationStatus = scoreLocalBusinessVerification(plan, {
      hasLocationSignal,
      email,
      contactName: contact?.name,
    });
    if (verificationStatus === "verified") {
      stats.verifiedCandidateCount += 1;
    }
    const blockers = buildCandidateBlockers(plan, { hasLocationSignal, email, contactName: contact?.name });
    const evidence = buildCandidateEvidence(lead, {
      hasLocationSignal,
      email,
      contactName: contact?.name,
      contactRole: contact?.role,
    });
    candidates.push({
      storeName,
      category: plan.categories[0] ?? "local business",
      website: lead.sourceKind === "official" || lead.sourceKind === "profile" ? lead.url : undefined,
      email,
      contactName: contact?.name,
      contactRole: contact?.role,
      sourceUrls: [lead.url],
      confidence: scoreLocalBusinessConfidence(verificationStatus, hasLocationSignal, contactEvidenceBacked),
      verificationStatus,
      blockers,
      evidence,
    });
  }
  const blockers = buildAnnotationBlockers(readFallbackBlockers(result), candidates, stats);
  return {
    kind: "local_business_contact_research",
    workflow: "local_business.research",
    plan,
    stages: buildLocalBusinessResearchStages(plan, candidates, excluded, blockers, stats),
    candidates,
    excluded,
    blockers,
    verificationNote:
      "local_business.research stages are deterministic leads, not fabricated contacts. Verify emails/contact names only from source-backed public official, profile, contact, or about evidence; Yelp, Facebook, and Instagram remain secondary or blocked listing sources.",
  };
}

function dedupeLocalBusinessCitations(
  citations: LocalBusinessResearchEvidenceCitation[],
): LocalBusinessResearchEvidenceCitation[] {
  const seen = new Set<string>();
  const deduped: LocalBusinessResearchEvidenceCitation[] = [];
  for (const citation of citations) {
    if (!citation.url || !/^https?:\/\//i.test(citation.url)) {
      continue;
    }
    const key = citation.url.trim();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      title: citation.title,
      url: citation.url,
      snippet: citation.snippet,
    });
  }
  return deduped.slice(0, 40);
}

function buildCandidatesFromFinalAnswerRows(
  plan: LocalBusinessResearchPlan,
  finalAnswer: string | undefined,
  citations: LocalBusinessResearchEvidenceCitation[],
): LocalBusinessContactVerification[] {
  const rows = extractFinalAnswerBusinessRows(finalAnswer);
  const candidates: LocalBusinessContactVerification[] = [];
  for (const row of rows) {
    const matchedCitations = matchCitationsForBusiness(row.storeName, citations);
    const sourceUrls = [
      ...new Set(
        [...row.sourceUrls, ...matchedCitations.map((citation) => citation.url)].filter((url) =>
          /^https?:\/\//i.test(url),
        ),
      ),
    ].slice(0, 12);
    if (sourceUrls.length === 0) {
      continue;
    }
    const leads = matchedCitations
      .map((citation) =>
        readLocalBusinessLead({
          title: citation.title,
          url: citation.url,
          snippet: citation.snippet,
        }),
      )
      .filter((lead): lead is LocalBusinessLead => Boolean(lead));
    const publicEvidenceLead =
      leads.find(
        (lead) => (lead.sourceKind === "official" || lead.sourceKind === "profile") && canVerifyContactFromSource(lead),
      ) ??
      leads.find((lead) => lead.sourceKind === "official" || lead.sourceKind === "profile") ??
      leads[0];
    const hasSourceBackedIdentity = leads.some((lead) => lead.sourceKind !== "secondary_blocked");
    if (!hasSourceBackedIdentity || !publicEvidenceLead) {
      continue;
    }
    const hasLocationSignal = hasLocalBusinessLocationSignal(
      plan,
      [row.rawLine, ...matchedCitations.flatMap((citation) => [citation.title, citation.snippet, citation.url])].join(
        " ",
      ),
    );
    const emailSourceBacked = row.email ? hasSourceBackedEmailEvidence(leads, row.email) : false;
    const contactNameSourceBacked = row.contactName
      ? hasSourceBackedContactNameEvidence(leads, row.contactName)
      : false;
    const email = row.email && emailSourceBacked ? row.email : undefined;
    const contactName = row.contactName && contactNameSourceBacked ? row.contactName : undefined;
    const verificationStatus = scoreLocalBusinessVerification(plan, {
      hasLocationSignal,
      email,
      contactName,
    });
    const blockers = [
      ...buildCandidateBlockers(plan, {
        hasLocationSignal,
        email,
        contactName,
      }),
      row.email && !emailSourceBacked ? "email_not_verified_from_source_text" : undefined,
      row.contactName && !contactNameSourceBacked ? "contact_name_not_verified_from_source_text" : undefined,
    ].filter((value): value is string => Boolean(value));
    const evidence = buildCandidateEvidence(publicEvidenceLead, {
      hasLocationSignal,
      email,
      contactName,
      contactRole: row.contactRole,
    });
    candidates.push({
      storeName: row.storeName,
      category: plan.categories[0] ?? "local business",
      website:
        publicEvidenceLead.sourceKind === "official" || publicEvidenceLead.sourceKind === "profile"
          ? publicEvidenceLead.url
          : undefined,
      email,
      contactName,
      contactRole: contactName ? row.contactRole : undefined,
      sourceUrls,
      confidence: scoreLocalBusinessConfidence(verificationStatus, hasLocationSignal, Boolean(email || contactName)),
      verificationStatus,
      blockers,
      evidence,
    });
  }
  return candidates;
}

function extractFinalAnswerBusinessRows(finalAnswer: string | undefined): Array<{
  storeName: string;
  email?: string;
  contactName?: string;
  contactRole?: string;
  sourceUrls: string[];
  rawLine: string;
}> {
  if (!finalAnswer) {
    return [];
  }
  const rows: Array<{
    storeName: string;
    email?: string;
    contactName?: string;
    contactRole?: string;
    sourceUrls: string[];
    rawLine: string;
  }> = [];
  for (const rawLine of finalAnswer.split(/\r?\n/)) {
    const line = rawLine.replace(/`/g, "").replace(/\*\*/g, "").trim();
    if (!line || /^\|?\s*-{3,}/.test(line)) {
      continue;
    }
    const email = extractPrimaryEmail(line);
    const sourceUrls = [...line.matchAll(/https?:\/\/[^\s)>\]]+/gi)].map((match) => match[0].replace(/[.,;:]+$/g, ""));
    const maybeCandidateLine =
      email ||
      /\b(?:no public email|missing email|email not found|unverified|partial|blocked|403|human verification)\b/i.test(
        line,
      );
    if (!maybeCandidateLine) {
      continue;
    }
    const storeName = inferStoreNameFromFinalAnswerLine(line);
    if (!storeName) {
      continue;
    }
    const contact = extractContactName(line);
    rows.push({
      storeName,
      email,
      contactName: contact?.name,
      contactRole: contact?.role,
      sourceUrls,
      rawLine: line,
    });
  }
  return rows;
}

function inferStoreNameFromFinalAnswerLine(line: string): string | undefined {
  const tableCells = line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  const rawName =
    tableCells.length >= 2
      ? tableCells[0]
      : line
          .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
          .split(/\s[—–-]\s|\s:\s/)
          .at(0);
  if (!rawName || /\b(?:store|business|email|contact|source|status|candidate)\b/i.test(rawName)) {
    return undefined;
  }
  return cleanPotentialStoreName(rawName.replace(/\([^)]*\)/g, "").trim());
}

function matchCitationsForBusiness(
  storeName: string,
  citations: LocalBusinessResearchEvidenceCitation[],
): LocalBusinessResearchEvidenceCitation[] {
  const normalizedName = normalizeSearchQueryForComparison(storeName);
  const tokens = normalizedName.split(/\s+/).filter((token) => token.length >= 3 && token !== "the");
  if (tokens.length === 0) {
    return [];
  }
  return citations
    .filter((citation) => {
      const haystack = normalizeSearchQueryForComparison([citation.title, citation.snippet, citation.url].join(" "));
      if (!haystack) {
        return false;
      }
      if (haystack.includes(normalizedName)) {
        return true;
      }
      const hits = tokens.filter((token) => haystack.includes(token)).length;
      return hits >= Math.min(2, tokens.length);
    })
    .slice(0, 8);
}

function hasSourceBackedEmailEvidence(leads: LocalBusinessLead[], email: string): boolean {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return false;
  }
  return leads.some((lead) => {
    if (lead.sourceKind !== "official" && lead.sourceKind !== "profile") {
      return false;
    }
    return extractEmailsFromSourceText(lead).some((sourceEmail) => normalizeEmail(sourceEmail) === normalizedEmail);
  });
}

function hasSourceBackedContactNameEvidence(leads: LocalBusinessLead[], contactName: string): boolean {
  const normalizedName = normalizeSearchQueryForComparison(contactName);
  if (!normalizedName || normalizedName.split(/\s+/).filter(Boolean).length < 2) {
    return false;
  }
  return leads.some((lead) => {
    if (lead.sourceKind !== "official" && lead.sourceKind !== "profile") {
      return false;
    }
    const sourceText = [lead.title, lead.snippet].filter(Boolean).join(" ");
    return (
      hasPublicContactEvidenceSignal([lead.url, sourceText].join(" ")) && containsSearchTerm(sourceText, normalizedName)
    );
  });
}

function extractEmailsFromSourceText(lead: LocalBusinessLead): string[] {
  return [...new Set([lead.title, lead.snippet, lead.url].flatMap((value) => extractEmails(value ?? "")))];
}

function mergeLocalBusinessCandidates(
  candidates: LocalBusinessContactVerification[],
): LocalBusinessContactVerification[] {
  const byKey = new Map<string, LocalBusinessContactVerification>();
  for (const candidate of candidates) {
    const key = normalizeSearchQueryForComparison(
      candidate.storeName || candidate.website || candidate.sourceUrls[0] || "",
    );
    if (!key) {
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    byKey.set(key, {
      ...existing,
      ...candidate,
      email: existing.email ?? candidate.email,
      contactName: existing.contactName ?? candidate.contactName,
      contactRole: existing.contactRole ?? candidate.contactRole,
      sourceUrls: [...new Set([...existing.sourceUrls, ...candidate.sourceUrls])].slice(0, 12),
      blockers: [...new Set([...existing.blockers, ...candidate.blockers])],
      evidence: [...existing.evidence, ...candidate.evidence].slice(0, 16),
      verificationStatus: strongerVerificationStatus(existing.verificationStatus, candidate.verificationStatus),
      confidence: strongerConfidence(existing.confidence, candidate.confidence),
    });
  }
  return [...byKey.values()].slice(0, 30);
}

function strongerVerificationStatus(
  left: LocalBusinessVerificationStatus,
  right: LocalBusinessVerificationStatus,
): LocalBusinessVerificationStatus {
  const rank: Record<LocalBusinessVerificationStatus, number> = { unverified: 0, partial: 1, verified: 2 };
  return rank[right] > rank[left] ? right : left;
}

function strongerConfidence(
  left: "high" | "medium" | "low",
  right: "high" | "medium" | "low",
): "high" | "medium" | "low" {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return rank[right] > rank[left] ? right : left;
}

function buildEvidenceAnnotationStats(
  citations: LocalBusinessResearchEvidenceCitation[],
  candidates: LocalBusinessContactVerification[],
  excluded: LocalBusinessResearchAnnotation["excluded"],
): LocalBusinessProcessingStats {
  return {
    resultCount: citations.length,
    blockedListingCount: excluded.filter((entry) => /\b(?:blocked|secondary)\b/i.test(entry.reason)).length,
    weakExcludedCount: excluded.filter((entry) => /\bweak\b/i.test(entry.reason)).length,
    unlocatedExcludedCount: excluded.filter((entry) => /\blocation_not_verified\b/i.test(entry.reason)).length,
    contactEvidenceUrls: [
      ...new Set(
        candidates.flatMap((candidate) =>
          candidate.evidence
            .filter((evidence) => evidence.evidenceKind === "email" || evidence.evidenceKind === "contact_name")
            .map((evidence) => evidence.url),
        ),
      ),
    ],
    verifiedContactFieldCount: candidates.reduce(
      (count, candidate) => count + (candidate.email ? 1 : 0) + (candidate.contactName ? 1 : 0),
      0,
    ),
    verifiedCandidateCount: candidates.filter((candidate) => candidate.verificationStatus === "verified").length,
  };
}

function extractFinalAnswerSourceBlockers(finalAnswer: string | undefined): string[] {
  if (!finalAnswer) {
    return [];
  }
  return finalAnswer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\b(?:blocked|403|captcha|human verification|access denied|not accessible)\b/i.test(line))
    .map((line) => `source_access_blocked: ${line.slice(0, 180)}`)
    .slice(0, 10);
}

function readLocalBusinessLead(record: Record<string, unknown>): LocalBusinessLead | undefined {
  const url = readString(record.url);
  if (!url) {
    return undefined;
  }
  const title = readString(record.title);
  const snippet = readString(record.snippet) ?? readString(record.textSnippet);
  const host = readHost(url);
  const source = classifyLocalBusinessSource(url, host);
  return {
    url,
    title,
    snippet,
    host,
    sourceKind: source.sourceKind,
    blockedReason: source.blockedReason,
  };
}

function classifyLocalBusinessSource(
  url: string,
  host?: string,
): { sourceKind: LocalBusinessSourceKind; blockedReason?: string } {
  if (host && BLOCKED_SOURCE_HOSTS.some((pattern) => pattern.test(host))) {
    return { sourceKind: "secondary_blocked", blockedReason: "blocked_or_secondary_listing_source" };
  }
  if (host && LISTING_SOURCE_HOSTS.some((pattern) => pattern.test(host))) {
    return { sourceKind: "listing" };
  }
  if (!(host && OFFICIAL_PROFILE_HOSTS.some((pattern) => pattern.test(host))) && hasDirectoryPathSignal(url)) {
    return { sourceKind: "listing" };
  }
  if ((host && OFFICIAL_PROFILE_HOSTS.some((pattern) => pattern.test(host))) || hasProfilePathSignal(url)) {
    return { sourceKind: "profile" };
  }
  return isLikelyOfficialBusinessUrl(url) ? { sourceKind: "official" } : { sourceKind: "listing" };
}

function hasLocalBusinessLocationSignal(plan: LocalBusinessResearchPlan, value: string): boolean {
  return [plan.location, ...(ZIP_AREA_HINTS[plan.location] ?? []), "CA", "California"].some((term) =>
    containsSearchTerm(value, term),
  );
}

function isWeakAmbiguousCandidate(storeName: string, lead: LocalBusinessLead, hasLocationSignal: boolean): boolean {
  const normalizedName = normalizeSearchQueryForComparison(storeName);
  const evidenceText = [storeName, lead.title, lead.snippet, lead.url].filter(Boolean).join(" ");
  if (!normalizedName || GENERIC_LOCAL_BUSINESS_TITLE_PATTERN.test(storeName)) {
    return true;
  }
  if (GENERIC_LOCAL_BUSINESS_TITLE_PATTERN.test(lead.title ?? "")) {
    return true;
  }
  const tokenCount = normalizedName.split(/\s+/).filter(Boolean).length;
  if (tokenCount !== 1) {
    return false;
  }
  if (lead.sourceKind !== "official" && lead.sourceKind !== "profile") {
    return true;
  }
  return !(
    hasLocationSignal && /\b(?:official|contact|about|store|games?|hobby|cards?|tabletop|comics)\b/i.test(evidenceText)
  );
}

function canVerifyContactFromSource(lead: LocalBusinessLead): boolean {
  if (lead.sourceKind !== "official" && lead.sourceKind !== "profile") {
    return false;
  }
  const text = [lead.url, lead.title, lead.snippet].filter(Boolean).join(" ");
  return hasPublicContactEvidenceSignal(text);
}

function hasPublicContactEvidenceSignal(value: string): boolean {
  return (
    /\b(?:contact|about|profile|staff|team|owner|manager|directory)\b/i.test(value) ||
    extractPrimaryEmail(value) !== undefined
  );
}

function hasProfilePathSignal(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\b(?:profile|contact|about|staff|team)\b/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function hasDirectoryPathSignal(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\b(?:directory|listing|finder|nearby|search|results)\b/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function extractPrimaryEmail(value: string): string | undefined {
  return extractEmails(value)[0];
}

function extractEmails(value: string): string[] {
  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return matches
    .map(normalizeEmail)
    .filter((match, index, items) => match.length >= 6 && items.indexOf(match) === index);
}

function normalizeEmail(value: string): string {
  return value.replace(/[).,;:]+$/g, "").toLowerCase();
}

function extractContactName(value: string): { name: string; role: string } | undefined {
  const roleFirst = value.match(
    /\b(owner|store manager|general manager|manager|contact)\s*(?:name)?\s*[:-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/i,
  );
  if (roleFirst?.[1] && roleFirst[2]) {
    const name = cleanContactName(roleFirst[2]);
    return name ? { name, role: normalizeContactRole(roleFirst[1]) } : undefined;
  }
  const nameFirst = value.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*(?:,|-)?\s*(owner|store manager|general manager|manager)\b/i,
  );
  if (nameFirst?.[1] && nameFirst[2]) {
    const name = cleanContactName(nameFirst[1]);
    return name ? { name, role: normalizeContactRole(nameFirst[2]) } : undefined;
  }
  return undefined;
}

function cleanContactName(value: string): string | undefined {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (
    cleaned.length < 5 ||
    /\b(?:Canoga Park|Woodland Hills|Winnetka|California|Contact Us|About Us)\b/i.test(cleaned)
  ) {
    return undefined;
  }
  return cleaned;
}

function normalizeContactRole(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "_");
}

function buildCandidateEvidence(
  lead: LocalBusinessLead,
  input: {
    hasLocationSignal: boolean;
    email?: string;
    contactName?: string;
    contactRole?: string;
  },
): LocalBusinessEvidenceRef[] {
  const identityKind = lead.sourceKind === "listing" ? "listing" : "identity";
  const evidence: LocalBusinessEvidenceRef[] = [
    {
      url: lead.url,
      title: lead.title,
      snippet: lead.snippet,
      evidenceKind: identityKind,
      confidence: lead.title ? "medium" : "low",
    },
  ];
  if (lead.sourceKind === "official" || lead.sourceKind === "profile") {
    evidence.push({
      url: lead.url,
      title: lead.title,
      snippet: lead.snippet,
      evidenceKind: "website",
      confidence: "medium",
    });
  }
  if (input.hasLocationSignal) {
    evidence.push({
      url: lead.url,
      title: lead.title,
      snippet: lead.snippet,
      evidenceKind: "address",
      confidence: "medium",
    });
  }
  if (input.email) {
    evidence.push({
      url: lead.url,
      title: lead.title,
      snippet: lead.snippet,
      evidenceKind: "email",
      confidence: "high",
    });
  }
  if (input.contactName) {
    evidence.push({
      url: lead.url,
      title: lead.title,
      snippet: input.contactRole ? `${lead.snippet ?? ""} Role: ${input.contactRole}`.trim() : lead.snippet,
      evidenceKind: "contact_name",
      confidence: "high",
    });
  }
  return evidence;
}

function buildCandidateBlockers(
  plan: LocalBusinessResearchPlan,
  input: { hasLocationSignal: boolean; email?: string; contactName?: string },
): string[] {
  return [
    plan.requireEmail && !input.email ? "email_not_verified_from_search_result" : undefined,
    plan.requireContactName && !input.contactName ? "contact_name_not_verified_from_search_result" : undefined,
    !input.hasLocationSignal ? "location_not_verified_from_search_result" : undefined,
  ].filter((value): value is string => Boolean(value));
}

function scoreLocalBusinessVerification(
  plan: LocalBusinessResearchPlan,
  input: { hasLocationSignal: boolean; email?: string; contactName?: string },
): LocalBusinessVerificationStatus {
  const emailVerified = !plan.requireEmail || Boolean(input.email);
  const contactVerified = !plan.requireContactName || Boolean(input.contactName);
  if (input.hasLocationSignal && emailVerified && contactVerified) {
    return "verified";
  }
  return input.hasLocationSignal || Boolean(input.email) || Boolean(input.contactName) ? "partial" : "unverified";
}

function scoreLocalBusinessConfidence(
  verificationStatus: LocalBusinessVerificationStatus,
  hasLocationSignal: boolean,
  contactEvidenceBacked: boolean,
): "high" | "medium" | "low" {
  if (verificationStatus === "verified") {
    return "high";
  }
  return hasLocationSignal || contactEvidenceBacked ? "medium" : "low";
}

function buildAnnotationBlockers(
  fallbackBlockers: string[],
  candidates: LocalBusinessContactVerification[],
  stats: LocalBusinessProcessingStats,
): string[] {
  const blockers = [...fallbackBlockers];
  if (candidates.length === 0 && stats.blockedListingCount > 0) {
    blockers.push("blocked_or_secondary_listing_sources_only");
  }
  if (candidates.length === 0 && stats.weakExcludedCount > 0) {
    blockers.push("weak_ambiguous_business_identities_only");
  }
  if (candidates.length === 0 && stats.unlocatedExcludedCount > 0) {
    blockers.push("candidate_discovery_incomplete");
  }
  return blockers.filter((blocker, index, items) => items.indexOf(blocker) === index);
}

function buildLocalBusinessResearchStages(
  plan: LocalBusinessResearchPlan,
  candidates: LocalBusinessContactVerification[],
  excluded: LocalBusinessResearchAnnotation["excluded"],
  blockers: string[],
  stats: LocalBusinessProcessingStats,
): LocalBusinessResearchStage[] {
  const querySet = [plan.primaryQuery, ...plan.alternateQueries].filter(
    (query, index, items) => query.length > 0 && items.indexOf(query) === index,
  );
  return [
    {
      name: "query_plan",
      status: "complete",
      summary: `Grounded ${plan.categories[0] ?? "local business"} research to ${formatLocalBusinessLocation(plan)}.`,
      queries: querySet,
    },
    {
      name: "candidate_discovery",
      status: stats.resultCount > 0 ? "complete" : "blocked",
      summary: `Read ${stats.resultCount} browser.search result${stats.resultCount === 1 ? "" : "s"} as leads.`,
      resultCount: stats.resultCount,
    },
    {
      name: "candidate_normalization",
      status: candidates.length > 0 ? "complete" : excluded.length > 0 ? "blocked" : "partial",
      summary: `Normalized ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} and excluded ${excluded.length} weak or blocked lead${excluded.length === 1 ? "" : "s"}.`,
      candidateCount: candidates.length,
      excludedCount: excluded.length,
    },
    {
      name: "evidence_navigation",
      status: stats.contactEvidenceUrls.length > 0 ? "complete" : candidates.length > 0 ? "partial" : "blocked",
      summary:
        "Official, profile, contact, or about URLs are eligible for contact verification; Yelp, Facebook, and Instagram are secondary or blocked only.",
      sourceUrls: stats.contactEvidenceUrls,
    },
    {
      name: "contact_extraction",
      status: resolveContactExtractionStageStatus(plan, candidates, stats),
      summary: `Verified ${stats.verifiedContactFieldCount} contact field${stats.verifiedContactFieldCount === 1 ? "" : "s"} from source-backed public evidence.`,
    },
    {
      name: "verification_scoring",
      status: stats.verifiedCandidateCount > 0 ? "complete" : candidates.length > 0 ? "partial" : "blocked",
      summary: `Scored ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}; ${stats.verifiedCandidateCount} fully verified.`,
      candidateCount: candidates.length,
    },
    {
      name: "blockers",
      status: blockers.length > 0 ? "blocked" : "complete",
      summary: blockers.length > 0 ? "Research blockers are present." : "No local-business research blockers detected.",
      blockers,
    },
  ];
}

function resolveContactExtractionStageStatus(
  plan: LocalBusinessResearchPlan,
  candidates: LocalBusinessContactVerification[],
  stats: LocalBusinessProcessingStats,
): LocalBusinessResearchStageStatus {
  if (!plan.requireEmail && !plan.requireContactName) {
    return "complete";
  }
  if (stats.verifiedCandidateCount > 0) {
    return "complete";
  }
  if (stats.verifiedContactFieldCount > 0 || candidates.length > 0) {
    return "partial";
  }
  return "blocked";
}

function formatLocalBusinessLocation(plan: LocalBusinessResearchPlan): string {
  return [
    plan.location,
    ...(ZIP_AREA_HINTS[plan.location] ?? []),
    plan.radiusMiles ? `${plan.radiusMiles} miles` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
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

function isGroundedLocalBusinessRawQuery(plan: LocalBusinessResearchPlan, value: string): boolean {
  return hasPlannedLocationTerm(plan, value) && hasPlannedCategoryTerm(plan, value);
}

function hasPlannedLocationTerm(plan: LocalBusinessResearchPlan, value: string): boolean {
  const locationTerms = [plan.location, ...(ZIP_AREA_HINTS[plan.location] ?? [])];
  return locationTerms.some((term) => containsSearchTerm(value, term));
}

function hasPlannedCategoryTerm(plan: LocalBusinessResearchPlan, value: string): boolean {
  return LOCAL_BUSINESS_CATEGORY_HINTS.some(
    (hint) =>
      plan.categories.includes(hint.category) &&
      (hint.pattern.test(value) || hint.terms.some((term) => containsSearchTerm(value, term))),
  );
}

function mergeLocalBusinessSearchQuery(plan: LocalBusinessResearchPlan, rawQuery: string): string {
  const normalizedPlan = normalizeSearchQueryForComparison(plan.primaryQuery);
  const normalizedRaw = normalizeSearchQueryForComparison(rawQuery);
  const supplemental = normalizedRaw && !normalizedPlan.includes(normalizedRaw) ? rawQuery : undefined;
  return balanceLooseQuotes([plan.primaryQuery, supplemental].filter(Boolean).join(" ")).slice(0, 240);
}

function containsSearchTerm(value: string, term: string): boolean {
  const escapedWords = term.trim().split(/\s+/).filter(Boolean).map(escapeRegExp).join("\\s+");
  return escapedWords.length > 0 ? new RegExp(`\\b${escapedWords}\\b`, "i").test(value) : false;
}

function normalizeSearchQueryForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const candidates = source
    .split(/\s[-|–—]\s|\s:\s/)
    .map((part) => part.trim())
    .map(cleanPotentialStoreName)
    .filter((part): part is string => Boolean(part));
  return candidates.find((part) => !GENERIC_LOCAL_BUSINESS_TITLE_PATTERN.test(part));
}

function cleanPotentialStoreName(value: string): string | undefined {
  const cleaned = value
    .replace(/\b(?:official site|official website|website|contact us|about us|profile|store locator)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    cleaned.length < 3 ||
    /^(?:yelp|facebook|instagram|google maps|bing maps|yellow pages|mapquest)$/i.test(cleaned) ||
    GENERIC_LOCAL_BUSINESS_TITLE_PATTERN.test(cleaned)
  ) {
    return undefined;
  }
  return cleaned;
}

function isLikelyOfficialBusinessUrl(url: string): boolean {
  const host = readHost(url);
  if (!host) {
    return false;
  }
  return (
    !/(\.|^)(google|bing|duckduckgo|yelp|facebook|instagram|yellowpages|mapquest)\./i.test(host) &&
    !/\b(?:directory|finder|nearby|search|listing)\b/i.test(host)
  );
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
