import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  extractUsefulVisitedBrowserUrl,
  isSearchPortalHost,
  normalizeToolNameForComparison,
} from "./chat-agent-browser-results.js";

export interface LocalReviewProfileEvidence {
  url: string;
  title: string;
  rating: number;
  reviewCount: number;
}

export interface LocalReviewSearchLead {
  url: string;
  title: string;
}

const REVIEW_RATING_PATTERNS = [
  /\b([1-5](?:\.\d{1,2})?)\s*\(\s*([\d,]+)\s+reviews?\s*\)/i,
  /\b([1-5](?:\.\d{1,2})?)\s*(?:\/\s*5|out of 5|stars?)\s*[-·,]?\s*([\d,]+)\s+reviews?\b/i,
];

function normalizePublicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!/^(?:http|https):$/.test(parsed.protocol) || isSearchPortalHost(parsed.hostname.toLowerCase())) {
      return undefined;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function safeTitle(value: unknown, fallbackUrl: string): string {
  const title = typeof value === "string" ? value : new URL(fallbackUrl).hostname;
  return title
    .replace(/[\r\n\t<>[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function readReviewSignal(text: string): { rating: number; reviewCount: number } | undefined {
  for (const pattern of REVIEW_RATING_PATTERNS) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }
    const rating = Number(match[1]);
    const reviewCount = Number(match[2]?.replace(/,/g, ""));
    if (rating >= 1 && rating <= 5 && Number.isInteger(reviewCount) && reviewCount > 0) {
      return { rating, reviewCount };
    }
  }
  return undefined;
}

export function isLocalReviewRankingTurn(content: string, researchListIntent: boolean): boolean {
  return (
    researchListIntent &&
    /\b(?:best|top|highest|most)\s+(?:(?:customer|online)\s+)?(?:reviewed|rated|reviews?)\b/i.test(content)
  );
}

export function collectLocalReviewProfileEvidence(toolRuns: ChatToolRunRecord[]): LocalReviewProfileEvidence[] {
  const profiles = new Map<string, LocalReviewProfileEvidence>();
  for (const run of toolRuns) {
    const toolName = normalizeToolNameForComparison(run.toolName);
    if (
      run.status !== "executed" ||
      (toolName !== "browser.navigate" && toolName !== "browser.extract" && toolName !== "http.get") ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const url = normalizePublicUrl(extractUsefulVisitedBrowserUrl(result));
    const httpStatus = Number(result.status);
    if (
      !url ||
      new URL(url).pathname === "/" ||
      profiles.has(url) ||
      (Number.isFinite(httpStatus) && httpStatus >= 400) ||
      typeof result.title !== "string" ||
      !result.title.trim()
    ) {
      continue;
    }
    const title = safeTitle(result.title, url);
    if (
      /\b(?:top\s+\d+|search results?|directory|best\s+(?:reviewed\s+)?(?:clowns?|performers?|businesses?))\b/i.test(
        title,
      )
    ) {
      continue;
    }
    const text = [result.contentText, result.content, result.text, result.bodySnippet, result.textSnippet]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    if (/\b(?:captcha|cloudflare ray id|you have been blocked|security verification)\b/i.test(text)) {
      continue;
    }
    const signal = readReviewSignal(text);
    if (!signal) {
      continue;
    }
    profiles.set(url, { url, title, ...signal });
  }
  return [...profiles.values()];
}

export function collectLocalReviewSearchLeads(toolRuns: ChatToolRunRecord[], limit = 3): LocalReviewSearchLead[] {
  const leads = new Map<string, LocalReviewSearchLead>();
  for (const run of toolRuns) {
    if (normalizeToolNameForComparison(run.toolName) !== "browser.search" || run.status !== "executed") {
      continue;
    }
    const results =
      run.result && typeof run.result === "object" ? (run.result as Record<string, unknown>).results : null;
    if (!Array.isArray(results)) {
      continue;
    }
    for (const item of results) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const result = item as Record<string, unknown>;
      const url = normalizePublicUrl(result.url);
      if (url && !leads.has(url)) {
        leads.set(url, { url, title: safeTitle(result.title, url) });
      }
      if (leads.size >= limit) {
        return [...leads.values()];
      }
    }
  }
  return [...leads.values()];
}

export function buildUnverifiedLocalReviewAnswer(toolRuns: ChatToolRunRecord[], userRequest: string): string {
  const profiles = collectLocalReviewProfileEvidence(toolRuns);
  const leads = collectLocalReviewSearchLeads(toolRuns).filter(
    (lead) => !profiles.some((profile) => profile.url === lead.url),
  );
  const lines = [
    profiles.length > 0 || leads.length > 0
      ? "I found possible local options, but I could not verify enough individual review profiles to rank them as best reviewed."
      : "I could not verify enough individual review profiles to rank local options as best reviewed.",
  ];
  if (profiles.length > 0) {
    lines.push("", "Review details verified on an opened listing:");
    for (const profile of profiles.slice(0, 2)) {
      lines.push(`- [${profile.title}](<${profile.url}>): ${profile.rating}/5 from ${profile.reviewCount} reviews.`);
    }
  }
  if (leads.length > 0) {
    lines.push("", "Unranked search leads (listing details not verified):");
    for (const lead of leads) {
      lines.push(`- [${lead.title}](<${lead.url}>)`);
    }
  }
  lines.push("", "A reliable comparison needs at least two directly opened listings with ratings and review counts.");
  if (/\b(?:funny|funniest|humor|humour)\b/i.test(userRequest)) {
    lines.push("Review comments are also needed to judge humor; ratings alone cannot establish who is funniest.");
  }
  return lines.join("\n");
}

export function buildVerifiedLocalReviewComparisonAnswer(toolRuns: ChatToolRunRecord[], userRequest: string): string {
  const profiles = collectLocalReviewProfileEvidence(toolRuns)
    .sort((left, right) => right.rating - left.rating || right.reviewCount - left.reviewCount)
    .slice(0, 5);
  const lines = [
    "Among the individual listings I could open, these have review scores and counts visible on their pages (ordered by rating, then review count):",
    "",
    ...profiles.map(
      (profile) => `- [${profile.title}](<${profile.url}>): ${profile.rating}/5 from ${profile.reviewCount} reviews.`,
    ),
    "",
    "This compares only the listings checked; it is not a ranking of every local option. Review dates and availability were not verified.",
  ];
  if (/\b(?:funny|funniest|humor|humour)\b/i.test(userRequest)) {
    lines.push(
      "Ratings alone cannot establish who is funniest; that needs humor-specific review comments or a sample performance.",
    );
  }
  return lines.join("\n");
}
