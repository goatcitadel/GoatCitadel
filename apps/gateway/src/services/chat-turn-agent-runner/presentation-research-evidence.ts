/* eslint-disable max-lines -- Research presentation evidence canonicalization, source authority, and cross-claim coverage remain one auditable fail-closed boundary. */
import { createHash } from "node:crypto";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";

const PRESENTATION_RESEARCH_TOOL_NAMES = new Set(["browser.search", "browser.navigate", "browser.extract", "http.get"]);

const SOURCE_ROLES = new Set(["official", "independent", "retailer", "marketplace", "financial", "event", "other"]);

const INDEPENDENT_SOURCE_ROLES = new Set(["independent", "retailer", "marketplace", "financial", "event"]);
const CLAIM_KINDS = new Set(["fact", "analysis", "recommendation"]);
const UNIVERSAL_COMPARISON_PATTERN =
  /\b(?:best|better\s+than|most|largest|deepest|strongest|widest|broadest|leading|dominates?|number\s+one|#\s*1|owns)\b/iu;
const RANKING_COMPARISON_PATTERN =
  /(?:#\s*\d+|\b(?:rank(?:ed)?\s+(?:#?\s*\d+|first|second|third|fourth|fifth)|rank\s+(?:rose|fell|improved|declined)|top\s+\d+|bottom\s+\d+|outside\s+(?:the\s+)?top\s+\d+)\b)/iu;
const RANKING_METRIC_PATTERN = /\b(?:rank|ranking|position)\b/iu;
const CONDITIONAL_COMPARISON_PATTERN = /\b(?:for|when|if|seeking|needs?|audience|player|retailer|store)\b/iu;
const CLEAR_RECOMMENDATION_PATTERN =
  /\b(?:best\s+for|better\s+for|recommend(?:ed|ation)?|choose|consider|prioriti[sz]e|watch|avoid|should|fit\s+for)\b/iu;
const NUMERIC_CLAIM_PATTERN = /(?:[$€£¥]\s*\d|\b\d[\d,.]*(?:%|\b))/u;
const HEADING_ASSERTION_PATTERN =
  /\b(?:is|are|has|have|grew|grows?|declined?|drives?|leads?|dominates?|outperforms?|supports?|offers?|shows?|remains?|increase(?:d|s)?|decrease(?:d|s)?|rose|fell|surged?|expanded?|contracted?)\b/iu;
const NEUTRAL_COMPARISON_HEADING_PATTERN =
  /(?:\?|\b(?:which|what|how|why)\b|\bbest\s+fits?\s+for\b|\b(?:guide|matrix|rubric|methodology|scope|criteria|overview|watchlist|appendix|sources?)\b)/iu;
const EXPLICIT_RETRIEVAL_OBSERVATION_PATTERN =
  /\b(?:as\s+of|observed(?:\s+(?:on|at))?|retrieved(?:\s+(?:on|at))?|accessed(?:\s+(?:on|at))?|checked(?:\s+(?:on|at))?)\s+(?:retrieval|access|\d{4}-\d{2}-\d{2}|[a-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/iu;
const CATEGORY_LEVEL_CONCLUSION_PATTERN =
  /\b(?:category|industry|landscape|market|marketplace|portfolio|across|overall|ecosystem|segment|shared|compared\s+games?|retail\s+signals?|positioning|ranking)\b/iu;
const RESEARCH_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "browse",
  "current",
  "evidence",
  "find",
  "for",
  "latest",
  "lookup",
  "of",
  "online",
  "please",
  "research",
  "search",
  "source",
  "sources",
  "the",
  "web",
]);
const MIN_RESEARCH_QUERY_FAMILIES = 2;
const MIN_CCG_RESEARCH_QUERY_FAMILIES = 4;
const PRESENTATION_REQUEST_PATTERN = /\b(?:power\s?point|pptx?|presentation|slide\s+deck|slides?)\b/iu;
const RESEARCH_REQUEST_PATTERN =
  /\b(?:research|market\s+research|competitive\s+landscape|compare|comparison|competitors?|evidence-backed)\b/iu;
const CONTEXTUAL_PRESENTATION_REFERENCE_PATTERN =
  /\b(?:all\s+that|that|this|it|above|earlier|previous|findings?|results?|research|information)\b/iu;

interface EvidenceSemanticFamily {
  label: string;
  claimPattern: RegExp;
  evidencePattern: RegExp;
}

const NUMERIC_METRIC_FAMILIES: readonly EvidenceSemanticFamily[] = [
  {
    label: "price or cost",
    claimPattern:
      /(?:[$€£¥]|\b(?:price|priced|pricing|cost|msrp|starter|booster|entry[- ]product|ready[- ]to[- ]play)\b)/iu,
    evidencePattern: /\b(?:price|priced|pricing|cost|msrp|product|starter|booster|deck|sell\s*sheet|catalog)\b/iu,
  },
  {
    label: "rank or market activity",
    claimPattern:
      /(?:#\s*\d+|\b(?:rank(?:ed|ing)?|top\s+\d+|bottom\s+\d+|gmv|best[- ]selling|market\s+share|marketplace\s+position)\b)/iu,
    evidencePattern: /\b(?:rank|ranking|best[- ]selling|gmv|market|marketplace|sales?|seller|position)\b/iu,
  },
  {
    label: "financial performance",
    claimPattern: /\b(?:revenue|profit|earnings|financial|sales?\s+(?:grew|growth|declined?|rose|fell))\b/iu,
    evidencePattern: /\b(?:revenue|profit|earnings|financial|investor|annual\s+report|sales?)\b/iu,
  },
  {
    label: "event or participation scale",
    claimPattern: /\b(?:attendees?|attendance|participants?|registrations?|events?|tournaments?|championships?)\b/iu,
    evidencePattern: /\b(?:attendees?|attendance|participants?|registrations?|events?|tournaments?|championships?)\b/iu,
  },
  {
    label: "gameplay player count",
    claimPattern: /(?:\bplayers?\b|\bfor\s+\d+\s+(?:to|-)\s*\d+\b)/iu,
    evidencePattern: /\b(?:players?|rules?|how\s+to\s+play|gameplay|play\s+guide)\b/iu,
  },
  {
    label: "release or inventory cadence",
    claimPattern:
      /\b(?:releases?|sets?|skus?|cadence|reprints?|allocation|inventory|supply|sell[- ]through|restock)\b/iu,
    evidencePattern:
      /\b(?:releases?|sets?|skus?|roadmap|cadence|reprints?|allocation|inventory|supply|products?|catalog)\b/iu,
  },
  {
    label: "product or catalog count",
    claimPattern: /\b(?:products?|cards?|formats?|countries|languages|stores?|locations?)\b/iu,
    evidencePattern: /\b(?:products?|cards?|formats?|countries|languages|stores?|locations?|catalog)\b/iu,
  },
] as const;

const COMPARISON_CRITERION_FAMILIES: readonly EvidenceSemanticFamily[] = [
  {
    label: "mechanics or player benefit",
    claimPattern: /\b(?:mechanics?|gameplay|player\s+(?:benefit|experience)|style|choice|tempo|mastery)\b/iu,
    evidencePattern: /\b(?:mechanics?|gameplay|rules?|how\s+to\s+play|player|tempo|mastery)\b/iu,
  },
  {
    label: "learning curve or strategic depth",
    claimPattern: /\b(?:learning|accessible|moderate|steep|strategic|depth|scope|complexity|onboarding)\b/iu,
    evidencePattern: /\b(?:learning|rules?|how\s+to\s+play|strategic|depth|complexity|onboarding|guide)\b/iu,
  },
  {
    label: "cost",
    claimPattern: /(?:[$€£¥]|\b(?:cost|price|msrp|entry[- ]product|starter|booster)\b)/iu,
    evidencePattern: /\b(?:cost|price|msrp|product|starter|booster|deck|sell\s*sheet)\b/iu,
  },
  {
    label: "IP or collectibility",
    claimPattern: /\b(?:ip|intellectual\s+property|franchise|brand|collectib|character|licensed)\w*\b/iu,
    evidencePattern: /\b(?:ip|intellectual\s+property|franchise|brand|collectib|character|licensed)\w*\b/iu,
  },
  {
    label: "format or organized play",
    claimPattern: /\b(?:formats?|organized\s+play|tournaments?|events?|leagues?|championships?)\b/iu,
    evidencePattern: /\b(?:formats?|organized\s+play|tournaments?|events?|leagues?|championships?|play)\b/iu,
  },
  {
    label: "local or digital access",
    claimPattern: /\b(?:local|store\s+play|digital|client|app|online|remote|access)\b/iu,
    evidencePattern: /\b(?:local|stores?|retailers?|digital|client|app|online|remote|play)\b/iu,
  },
  {
    label: "retail demand or community",
    claimPattern: /\b(?:retail|demand|market|marketplace|gmv|sales?|best[- ]selling|rank|activity|community)\b/iu,
    evidencePattern:
      /\b(?:retail|demand|market|marketplace|gmv|sales?|seller|best[- ]selling|rank|activity|community)\b/iu,
  },
  {
    label: "inventory or release risk",
    claimPattern:
      /\b(?:release|sku|catalog|singles?|liquidity|inventory|allocation|supply|risk|cadence|reprint)\w*\b/iu,
    evidencePattern:
      /\b(?:release|sku|catalog|singles?|liquidity|inventory|allocation|supply|risk|cadence|reprint|product)\w*\b/iu,
  },
  {
    label: "fit or trade-off",
    claimPattern: /\b(?:fit|trade[- ]?off|watch[- ]?out|caveat|conditional|profile)\b/iu,
    evidencePattern: /\b(?:fit|trade[- ]?off|watch[- ]?out|caveat|profile|comparison|guide)\b/iu,
  },
] as const;

const CCG_REQUIRED_FIELD_DEFINITIONS = [
  {
    label: "signature mechanics and resulting player benefit",
    headerPattern: /\b(?:mechanic(?:s)?(?:\s+to|\s*\/)?\s*benefit|mechanics?|player\s+experience)\b/iu,
    bulletLabelPattern: /\bmechanics?\s*\/\s*player\s+benefit\s*:/iu,
    patterns: [
      /\b(?:mechanics?|gameplay|mana|stack|evolution|energy|summon|chain|leader|ink|lore|hero|pitch|combat|battlefield|rune|unit|pilot|shield|digivolution|memory\s+gauge|awakening)\b/iu,
      /\b(?:benefit|experience|choice|style|accessible|expression|identity|tempo|mastery|responsive|control|team\s+building|momentum|objective)\b/iu,
    ],
  },
  {
    label: "learning curve and strategic depth",
    headerPattern: /\b(?:learning(?:\s*\/|\s+and)?\s*(?:scope|depth|curve)?|strategic\s+(?:scope|depth))\b/iu,
    bulletLabelPattern: /\blearning\s+curve\s*\/\s*strategic\s+depth\s*:/iu,
    patterns: [
      /\b(?:learning|curve|accessible|moderate|steep|onboarding|teaching)\b/iu,
      /\b(?:strategic|depth|scope|broad|focused|mastery|complexity|newer)\b/iu,
    ],
  },
  {
    label: "dated entry-product and ongoing cost, or explicit not measured",
    headerPattern: /\b(?:dated\s+entry|entry(?:-product)?|ongoing[- ]cost|cost\s+signal|price)\b/iu,
    bulletLabelPattern: /\bentry[- ]product\s+and\s+ongoing\s+cost\s*:/iu,
    patterns: [
      /\b(?:entry|starter|booster|msrp|price|cost|ready[- ]to[- ]play|product)\b/iu,
      /(?:\b(?:as\s+of|dated|published|retrieved|observed|not\s+(?:measured|found|available)|no\s+comparable|unknown)\b|\b(?:19|20)\d{2}\b)/iu,
    ],
  },
  {
    label: "IP and collectibility appeal",
    headerPattern: /\b(?:ip|collectib|brand|franchise)\w*\b/iu,
    bulletLabelPattern: /\bip\s*\/\s*collectibility\s+appeal\s*:/iu,
    patterns: [/\b(?:ip|intellectual\s+property|franchise|brand|collectib|character|anime|licensed|fantasy)\w*\b/iu],
  },
  {
    label: "format and organized-play support",
    headerPattern: /\b(?:formats?|organized\s+play|local\s+play|play\s+support)\b/iu,
    bulletLabelPattern: /\bformat\s*\/\s*organized\s+play\s*:/iu,
    patterns: [
      /\b(?:formats?|organized\s+play|\bop\b|tournaments?|events?|leagues?|championships?|armory|wpn|local\s+play|store\s+play|play\s+support|play\s+roadmap)\b/iu,
    ],
  },
  {
    label: "local-play and digital access",
    headerPattern: /\b(?:local\s+play|digital\s+access|digital.*local|local.*digital)\b/iu,
    bulletLabelPattern: /\blocal\s+play\s*\/\s*digital\s+access\s*:/iu,
    patterns: [
      /\b(?:local|tabletop|in[- ]store|stores?|leagues?|armory|events?|organized\s+play)\b/iu,
      /\b(?:digital|client|app|online|remote|arena|master\s+duel|tcg\s+live|no\s+full\s+client)\b/iu,
    ],
  },
  {
    label: "retail demand and community-building potential",
    headerPattern: /\b(?:retail.*community|demand|activity.*community|community)\b/iu,
    bulletLabelPattern: /\bretail\s+demand\s*\/\s*community\s+building\s*:/iu,
    patterns: [
      /\b(?:retail|demand|market|marketplace|gmv|rank|sales?|activity|sell[- ]through|stores?)\b/iu,
      /\b(?:community|organized\s+play|events?|leagues?|armory|stores?|play\s+support|schedule|championships?)\b/iu,
    ],
  },
  {
    label: "release or SKU burden, singles liquidity, and inventory risk",
    headerPattern: /\b(?:burden.*risk|release|sku|inventory|operational\s+unknown)\b/iu,
    bulletLabelPattern: /\brelease\s*\/\s*sku\s+burden,?\s+singles\s+liquidity,?\s+and\s+inventory\s+risk\s*:/iu,
    patterns: [
      /\b(?:release|sku|catalog|cadence|product|availability|burden|load|reprint|rotation|transition|active|current|young)\w*\b/iu,
      /\b(?:singles?|liquidity|secondary\s+market|not\s+measured|unknown)\b/iu,
      /\b(?:inventory|allocation|availability|shelf|velocity|volatility|supply|risk|uncertainty|retention|store\s+economics|not\s+measured|unknown)\b/iu,
    ],
  },
  {
    label: "best-fit profile and major trade-off",
    headerPattern: /\b(?:best[- ]?fit|conditional\s+fit|fit.*trade[- ]?off|burden.*fit)\b/iu,
    bulletLabelPattern: /\bbest\s+fit\b[^:;]*[;:].*\btrade[- ]?off\s*:/iu,
    patterns: [
      /\b(?:best[- ]?fit|fit\s*:|fit\s+for|player\s+profile|store\s+profile|retailer\s+profile|conditional\s+fit)\b/iu,
      /\b(?:trade[- ]?off|watch[- ]?out|caveat|downside|risk|burden|uncertainty|complexity|dependence)\b/iu,
    ],
  },
] as const;

const CLAIM_SUBJECT_STOPWORDS = new Set([
  "about",
  "after",
  "among",
  "and",
  "are",
  "as",
  "at",
  "before",
  "between",
  "by",
  "compared",
  "current",
  "during",
  "for",
  "from",
  "grew",
  "has",
  "have",
  "into",
  "its",
  "lists",
  "more",
  "of",
  "on",
  "over",
  "reported",
  "shows",
  "than",
  "that",
  "the",
  "their",
  "this",
  "through",
  "to",
  "was",
  "were",
  "with",
]);

const CCG_CORE_COMPETITORS = [
  {
    label: "Magic: The Gathering",
    aliases: ["magic", "magic the gathering", "mtg"],
    authoritativeDomains: ["magic.wizards.com", "wpn.wizards.com"],
  },
  { label: "Pokémon", aliases: ["pokemon"], authoritativeDomains: ["pokemon.com"] },
  { label: "Yu-Gi-Oh!", aliases: ["yugioh", "yu gi oh"], authoritativeDomains: ["yugioh-card.com"] },
  {
    label: "One Piece",
    aliases: ["one piece", "onepiece"],
    authoritativeDomains: ["onepiece-cardgame.com"],
  },
  {
    label: "Disney Lorcana",
    aliases: ["lorcana", "disney lorcana"],
    authoritativeDomains: ["disneylorcana.com"],
  },
  {
    label: "Flesh and Blood",
    aliases: ["flesh and blood", "fab", "fabtcg"],
    authoritativeDomains: ["fabtcg.com"],
  },
  {
    label: "Star Wars: Unlimited",
    aliases: ["star wars unlimited", "starwarsunlimited"],
    authoritativeDomains: ["starwarsunlimited.com"],
  },
  {
    label: "Riftbound",
    aliases: ["riftbound"],
    authoritativeDomains: ["riftbound.leagueoflegends.com"],
  },
  { label: "Gundam", aliases: ["gundam"], authoritativeDomains: ["gundam-gcg.com"] },
] as const;

const CCG_ADDITIONAL_AUTHORITATIVE_COMPETITORS = [
  { label: "Digimon", aliases: ["digimon"], authoritativeDomains: ["digimoncard.com"] },
  {
    label: "Dragon Ball Super Card Game: Fusion World",
    aliases: ["fusion world", "dragon ball super fusion world"],
    authoritativeDomains: ["dbs-cardgame.com"],
  },
  { label: "Union Arena", aliases: ["union arena"], authoritativeDomains: ["unionarena-tcg.com"] },
] as const;

const CCG_AUTHORITATIVE_COMPETITORS = [...CCG_CORE_COMPETITORS, ...CCG_ADDITIONAL_AUTHORITATIVE_COMPETITORS] as const;

export interface PresentationEvidenceSource {
  id: string;
  title: string;
  url: string;
  publisher: string;
  domain: string;
  snippet?: string;
  publishedAt?: string;
  retrievedAt: string;
  confidence: number;
  toolRunId: string;
  toolName: string;
  query?: string;
}

export interface PresentationResearchGroundingReport {
  required: boolean;
  ccgBenchmark: boolean;
  passed: boolean;
  findings: string[];
  evidenceSourceCount: number;
  declaredSourceCount: number;
  matchedSourceCount: number;
  domainCount: number;
  materialClaimCount: number;
  citedMaterialClaimCount: number;
}

interface PresentationResearchHistoryMessage {
  role?: string;
  content?: unknown;
}

export function buildPresentationEvidencePacket(
  toolRuns: readonly ChatToolRunRecord[] | undefined,
): PresentationEvidenceSource[] {
  const byUrl = new Map<string, PresentationEvidenceSource>();
  for (const run of toolRuns ?? []) {
    if (run.status !== "executed" || !run.result || !PRESENTATION_RESEARCH_TOOL_NAMES.has(run.toolName)) {
      continue;
    }
    const result = toRecord(run.result);
    if (!result) continue;
    const candidates = collectEvidenceCandidates(run, result);
    for (const candidate of candidates) {
      const url = canonicalizePresentationSourceUrl(candidate.url);
      if (!url) continue;
      const parsed = new URL(url);
      const confidence = readConfidence(candidate.record.confidence, directEvidenceConfidence(run.toolName));
      const source: PresentationEvidenceSource = {
        id: presentationSourceId(url),
        title:
          readString(candidate.record.title, candidate.record.name, result.title) ??
          parsed.hostname.replace(/^www\./u, ""),
        url,
        publisher:
          readString(
            candidate.record.publisher,
            candidate.record.siteName,
            candidate.record.source,
            result.publisher,
            result.siteName,
          ) ?? parsed.hostname.replace(/^www\./u, ""),
        domain: parsed.hostname.replace(/^www\./u, ""),
        ...(readString(
          candidate.record.snippet,
          candidate.record.excerpt,
          candidate.record.description,
          candidate.record.content,
          candidate.record.text,
          result.snippet,
          result.excerpt,
        )
          ? {
              snippet: readString(
                candidate.record.snippet,
                candidate.record.excerpt,
                candidate.record.description,
                candidate.record.content,
                candidate.record.text,
                result.snippet,
                result.excerpt,
              ),
            }
          : {}),
        ...(readString(
          candidate.record.publishedAt,
          candidate.record.published,
          candidate.record.date,
          result.publishedAt,
          result.published,
          result.date,
        )
          ? {
              publishedAt: readString(
                candidate.record.publishedAt,
                candidate.record.published,
                candidate.record.date,
                result.publishedAt,
                result.published,
                result.date,
              ),
            }
          : {}),
        retrievedAt: run.finishedAt ?? run.startedAt,
        confidence,
        toolRunId: run.toolRunId,
        toolName: run.toolName,
        ...(typeof run.args?.query === "string" && run.args.query.trim() ? { query: run.args.query.trim() } : {}),
      };
      const existing = byUrl.get(url);
      if (!existing || source.confidence > existing.confidence) {
        byUrl.set(url, source);
      }
    }
  }
  return [...byUrl.values()];
}

export function groundResearchPresentationArgs(input: {
  args: Record<string, unknown>;
  userContent: string;
  priorToolRuns?: readonly ChatToolRunRecord[];
  historyMessages?: readonly PresentationResearchHistoryMessage[];
}): { args: Record<string, unknown>; report: PresentationResearchGroundingReport } {
  const historyResearchContext = collectPriorResearchContext(input.userContent, input.historyMessages);
  const required =
    looksLikeDirectResearchPresentationRequest(input.userContent) ||
    looksLikeContextDependentResearchPresentationRequest(input.userContent, historyResearchContext);
  const ccgBenchmark = required && looksLikeCcgMarketResearchRequest(`${historyResearchContext} ${input.userContent}`);
  const evidence = buildPresentationEvidencePacket(input.priorToolRuns);
  if (!required) {
    return {
      args: input.args,
      report: emptyGroundingReport(false, false, evidence.length),
    };
  }

  const findings: string[] = [];
  const research = toRecord(input.args.research);
  validateResearchMetadata(research, ccgBenchmark, findings);
  validateResearchQueryCoverage(input.priorToolRuns, ccgBenchmark, findings);

  const evidenceByUrl = new Map(evidence.map((source) => [source.url, source]));
  const evidenceById = new Map(evidence.map((source) => [source.id, source]));
  const aliases = new Map<string, string>();
  const groundedSources: Array<Record<string, unknown>> = [];
  const groundedSourceById = new Map<string, Record<string, unknown>>();
  const rawSources = Array.isArray(input.args.sources) ? input.args.sources : [];

  if (evidence.length === 0) {
    findings.push("No successful canonical browser or HTTP evidence is available for this research deck.");
  }
  if (rawSources.length === 0) {
    findings.push("Research decks must declare a structured sources registry.");
  }

  for (const rawSource of rawSources) {
    const declared = toRecord(rawSource);
    if (!declared) {
      findings.push("Every research source must be a structured source object.");
      continue;
    }
    const declaredId = readString(declared.id);
    const declaredUrl = canonicalizePresentationSourceUrl(declared.url);
    const canonical =
      (declaredUrl ? evidenceByUrl.get(declaredUrl) : undefined) ??
      (declaredId ? evidenceById.get(declaredId) : undefined);
    if (!canonical) {
      findings.push(
        `Source ${declaredId ? `\`${declaredId}\`` : declaredUrl ? `\`${declaredUrl}\`` : "without an id or URL"} is not present in canonical tool evidence.`,
      );
      continue;
    }
    if (declaredId) aliases.set(declaredId, canonical.id);
    if (declaredUrl) aliases.set(declaredUrl, canonical.id);
    const rawDeclaredUrl = readString(declared.url);
    if (rawDeclaredUrl) aliases.set(rawDeclaredUrl, canonical.id);
    aliases.set(canonical.id, canonical.id);
    const role = readString(declared.role)?.toLowerCase();
    if (!role || !SOURCE_ROLES.has(role)) {
      findings.push(`Source \`${declaredId ?? canonical.id}\` is missing a valid declared source role.`);
      continue;
    }
    if (groundedSourceById.has(canonical.id)) continue;
    const grounded = {
      ...canonical,
      role,
    };
    groundedSources.push(grounded);
    groundedSourceById.set(canonical.id, grounded);
  }

  const slides = rewritePresentationSourceAliases(input.args.slides, aliases, groundedSourceById, findings);
  const groundedArgs: Record<string, unknown> = {
    ...input.args,
    sources: groundedSources,
    ...(slides !== undefined ? { slides } : {}),
  };
  const claimCoverage = validateResearchSlideClaims({
    slides,
    research,
    sources: groundedSources,
    ccgBenchmark,
    findings,
  });
  validateSourceCoverage({ research, sources: groundedSources, ccgBenchmark, findings, slides });

  const domains = new Set(groundedSources.map((source) => readString(source.domain)).filter(Boolean));
  return {
    args: groundedArgs,
    report: {
      required,
      ccgBenchmark,
      passed: findings.length === 0,
      findings: [...new Set(findings)],
      evidenceSourceCount: evidence.length,
      declaredSourceCount: rawSources.length,
      matchedSourceCount: groundedSources.length,
      domainCount: domains.size,
      materialClaimCount: claimCoverage.material,
      citedMaterialClaimCount: claimCoverage.cited,
    },
  };
}

export function canonicalizePresentationSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("...") || trimmed.includes("…")) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.port === "443") parsed.port = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|msclkid)$/iu.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function presentationSourceId(canonicalUrl: string): string {
  return `src_${createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 12)}`;
}

export function looksLikeDirectResearchPresentationRequest(content: string): boolean {
  return PRESENTATION_REQUEST_PATTERN.test(content) && RESEARCH_REQUEST_PATTERN.test(content);
}

function looksLikeContextDependentResearchPresentationRequest(content: string, priorContext: string): boolean {
  return (
    PRESENTATION_REQUEST_PATTERN.test(content) &&
    CONTEXTUAL_PRESENTATION_REFERENCE_PATTERN.test(content) &&
    RESEARCH_REQUEST_PATTERN.test(priorContext)
  );
}

function collectPriorResearchContext(
  currentContent: string,
  historyMessages: readonly PresentationResearchHistoryMessage[] | undefined,
): string {
  const normalizedCurrent = normalizeComparisonText(currentContent);
  return (historyMessages ?? [])
    .filter((message) => message.role?.toLowerCase() === "user")
    .map((message) => readHistoryMessageText(message.content))
    .filter((content) => content && normalizeComparisonText(content) !== normalizedCurrent)
    .join(" ");
}

function readHistoryMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = toRecord(block);
      return readString(record?.text) ?? "";
    })
    .filter(Boolean)
    .join(" ");
}

function looksLikeCcgMarketResearchRequest(content: string): boolean {
  return (
    /\b(?:ccgs?|tcgs?|collectible\s+card\s+games?|trading\s+card\s+games?)\b/iu.test(content) &&
    /\b(?:market|competitive|competition|compare|better)\b/iu.test(content)
  );
}

function collectEvidenceCandidates(
  run: ChatToolRunRecord,
  result: Record<string, unknown>,
): Array<{ url: unknown; record: Record<string, unknown> }> {
  const candidates: Array<{ url: unknown; record: Record<string, unknown> }> = [];
  if (Array.isArray(result.results)) {
    for (const value of result.results) {
      const record = toRecord(value);
      if (!record) continue;
      candidates.push({ url: record.url ?? record.link ?? record.href, record });
    }
  }
  if (run.toolName !== "browser.search") {
    candidates.push({
      url: result.url ?? result.finalUrl ?? result.canonicalUrl ?? run.args?.url,
      record: result,
    });
  }
  return candidates;
}

function validateResearchQueryCoverage(
  toolRuns: readonly ChatToolRunRecord[] | undefined,
  ccgBenchmark: boolean,
  findings: string[],
): void {
  const families: string[][] = [];
  for (const run of toolRuns ?? []) {
    if (!hasUsableResearchSearchResult(run)) continue;
    const family = normalizeResearchQueryFamily(run.args?.query);
    if (!family || families.some((existing) => areEquivalentResearchQueryFamilies(existing, family))) continue;
    families.push(family);
  }
  const required = ccgBenchmark ? MIN_CCG_RESEARCH_QUERY_FAMILIES : MIN_RESEARCH_QUERY_FAMILIES;
  if (families.length >= required) return;
  findings.push(
    ccgBenchmark
      ? `The CCG benchmark requires at least ${required} materially distinct successful browser.search query families; ${families.length} were available.`
      : `Direct research decks require at least ${required} materially distinct successful browser.search query families; ${families.length} were available.`,
  );
}

function hasUsableResearchSearchResult(run: ChatToolRunRecord): boolean {
  if (run.toolName !== "browser.search" || run.status !== "executed" || !run.result) return false;
  const result = toRecord(run.result);
  return Boolean(
    result &&
    Array.isArray(result.results) &&
    result.results.some((item) => {
      const record = toRecord(item);
      return Boolean(record && canonicalizePresentationSourceUrl(record.url ?? record.link ?? record.href));
    }),
  );
}

function normalizeResearchQueryFamily(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const tokens = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .filter((token) => !RESEARCH_QUERY_STOPWORDS.has(token) && !/^\d+$/u.test(token))
    .map(normalizeResearchQueryToken);
  const family = [...new Set(tokens)].sort();
  return family.length > 0 ? family : undefined;
}

function normalizeResearchQueryToken(token: string): string {
  if (token === "ccgs" || token === "tcgs") return token.slice(0, -1);
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function areEquivalentResearchQueryFamilies(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  if (union === 0) return true;
  if (intersection / union >= 0.8) return true;
  const smaller = Math.min(leftSet.size, rightSet.size);
  const larger = Math.max(leftSet.size, rightSet.size);
  return intersection === smaller && larger - smaller <= 1;
}

function directEvidenceConfidence(toolName: string): number {
  return toolName === "browser.search" ? 0.7 : 0.9;
}

function readConfidence(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function validateResearchMetadata(
  research: Record<string, unknown> | undefined,
  ccgBenchmark: boolean,
  findings: string[],
): void {
  if (!research) {
    findings.push("Research decks must include structured research metadata.");
    return;
  }
  const asOfDate = readString(research.asOfDate);
  if (!asOfDate || !isValidIsoDate(asOfDate)) {
    findings.push("Research metadata must include an as-of date in YYYY-MM-DD form.");
  }
  for (const field of ["geography", "physicalDigitalBoundary"] as const) {
    if (!readString(research[field])) {
      findings.push(`Research metadata is missing \`${field}\`.`);
    }
  }
  if (ccgBenchmark) {
    const geography = readString(research.geography) ?? "";
    const boundary = readString(research.physicalDigitalBoundary) ?? "";
    if (!/\bnorth\s+america\b/iu.test(geography)) {
      findings.push("The CCG benchmark geography must explicitly cover North America.");
    }
    if (!/\bglobal\b/iu.test(geography)) {
      findings.push("The CCG benchmark geography must identify its global scale context.");
    }
    if (!/\bphysical\b/iu.test(boundary) || !/\bdigital\b/iu.test(boundary)) {
      findings.push("The CCG benchmark must explicitly separate physical and digital games.");
    }
  }
  for (const field of [
    "inclusionCriteria",
    "exclusions",
    "methodology",
    "limitations",
    "competitors",
    "comparisonCriteria",
  ] as const) {
    if (!Array.isArray(research[field])) {
      findings.push(`Research metadata must declare \`${field}\` as an array.`);
      continue;
    }
    const values = readStringArray(research[field]);
    if (field !== "exclusions" && values.length === 0) {
      findings.push(`Research metadata must include at least one \`${field}\` entry.`);
    }
    if (ccgBenchmark && values.length === 0) {
      findings.push(`The CCG benchmark requires at least one \`${field}\` entry.`);
    }
  }
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function rewritePresentationSourceAliases(
  value: unknown,
  aliases: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, Record<string, unknown>>,
  findings: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewritePresentationSourceAliases(entry, aliases, sources, findings));
  }
  const record = toRecord(value);
  if (!record) return value;
  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key !== "sourceIds") {
      rewritten[key] = rewritePresentationSourceAliases(child, aliases, sources, findings);
      continue;
    }
    if (!Array.isArray(child)) {
      findings.push("Every `sourceIds` field must be an array.");
      rewritten[key] = [];
      continue;
    }
    const ids: string[] = [];
    for (const rawId of child) {
      if (typeof rawId !== "string" || !rawId.trim()) continue;
      const canonicalId = aliases.get(rawId.trim());
      if (!canonicalId || !sources.has(canonicalId)) {
        findings.push(`Citation source id \`${rawId.trim()}\` is not backed by the declared canonical sources.`);
        continue;
      }
      if (!ids.includes(canonicalId)) ids.push(canonicalId);
    }
    rewritten[key] = ids;
  }
  return rewritten;
}

function validateResearchSlideClaims(input: {
  slides: unknown;
  research: Record<string, unknown> | undefined;
  sources: Array<Record<string, unknown>>;
  ccgBenchmark: boolean;
  findings: string[];
}): { material: number; cited: number } {
  const slides = Array.isArray(input.slides) ? input.slides : [];
  if (slides.length === 0) {
    input.findings.push("Research decks must include substantive slides.");
    return { material: 0, cited: 0 };
  }
  if (input.ccgBenchmark && slides.length < 12) {
    input.findings.push(
      "The CCG benchmark requires at least 12 structured content slides before the generated cover and sources appendix.",
    );
  }
  const sourceById = new Map(input.sources.map((source) => [readString(source.id) ?? "", source]));
  const competitors = readStringArray(input.research?.competitors);
  const criteria = readStringArray(input.research?.comparisonCriteria);
  const usedIndependentCategorySourceIds = new Set<string>();
  let material = 0;
  let cited = 0;
  for (const [slideIndex, rawSlide] of slides.entries()) {
    const slide = toRecord(rawSlide);
    if (!slide) continue;
    const title = readString(slide.title) ?? `slide ${slideIndex + 1}`;
    if (hasMaterialNumericClaim(title)) {
      validateNumericClaim({
        text: title,
        sourceIds: [],
        sourceById,
        competitors,
        location: "slide title",
        findings: input.findings,
      });
    }
    if (HEADING_ASSERTION_PATTERN.test(title) && !NEUTRAL_COMPARISON_HEADING_PATTERN.test(title)) {
      input.findings.push(
        `Evidence-bearing slide title \`${title}\` cannot carry canonical citations; use a neutral title and move the factual or analytical claim into a cited rich bullet.`,
      );
    }
    if (isComparativeOrRankingClaim(title) && !NEUTRAL_COMPARISON_HEADING_PATTERN.test(title)) {
      validateComparativeClaim({
        text: title,
        sourceIds: [],
        sourceById,
        competitors,
        criteria,
        contextText: title,
        location: "slide title",
        findings: input.findings,
      });
    }
    const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
    for (const rawBullet of bullets) {
      if (typeof rawBullet === "string") {
        input.findings.push(
          `Research slide \`${title}\` uses an uncited legacy string bullet; use a rich bullet with claimKind and sourceIds.`,
        );
        material += 1;
        continue;
      }
      const bullet = toRecord(rawBullet);
      const text = readString(bullet?.text);
      if (!bullet || !text) {
        input.findings.push(`Research slide \`${title}\` contains a bullet without text.`);
        continue;
      }
      if (text.length > 240) {
        input.findings.push(
          `Research bullet on \`${title}\` is ${text.length} characters; rewrite it to 240 characters or fewer without dropping its citations.`,
        );
      }
      const claimKind = readString(bullet.claimKind)?.toLowerCase();
      if (!claimKind || !CLAIM_KINDS.has(claimKind)) {
        input.findings.push(`Research bullet \`${text}\` is missing a valid claimKind.`);
        material += 1;
        continue;
      }
      const sourceIds = readStringArray(bullet.sourceIds);
      if (claimKind !== "recommendation") {
        material += 1;
        if (sourceIds.length === 0) {
          input.findings.push(`Material research claim \`${text}\` has no canonical citation.`);
        } else {
          cited += 1;
        }
      }
      if (
        claimKind === "recommendation" &&
        UNIVERSAL_COMPARISON_PATTERN.test(text) &&
        !CONDITIONAL_COMPARISON_PATTERN.test(text)
      ) {
        input.findings.push(
          `Recommendation \`${text}\` must name the audience or decision condition for "better" or "best".`,
        );
      }
      if (claimKind === "recommendation" && !CLEAR_RECOMMENDATION_PATTERN.test(text)) {
        input.findings.push(`Uncited recommendation \`${text}\` is not clearly phrased as a recommendation.`);
      }
      if (claimKind !== "recommendation" && isComparativeOrRankingClaim(text)) {
        validateComparativeClaim({
          text,
          sourceIds,
          sourceById,
          competitors,
          criteria,
          contextText: text,
          location: "claim",
          findings: input.findings,
        });
      }
      if (hasMaterialNumericClaim(text)) {
        validateNumericClaim({
          text,
          sourceIds,
          sourceById,
          competitors,
          contextText: `${title} ${text}`,
          location: "claim",
          findings: input.findings,
        });
      }
      if (claimKind !== "recommendation") {
        validateIndependentCategoryEvidence({
          text,
          contextText: `${title} ${text}`,
          sourceIds,
          sourceById,
          competitors,
          location: "claim",
          findings: input.findings,
          usedSourceIds: usedIndependentCategorySourceIds,
        });
      }
    }
    validateTableClaims({
      value: slide.table,
      title,
      findings: input.findings,
      sourceById,
      competitors,
      criteria,
      usedIndependentCategorySourceIds,
    });
    validateChartClaims({
      value: slide.chart,
      title,
      findings: input.findings,
      sourceById,
      competitors,
      criteria,
      usedIndependentCategorySourceIds,
    });
  }
  if (input.ccgBenchmark && usedIndependentCategorySourceIds.size < 2) {
    input.findings.push(
      `The CCG benchmark requires at least two canonical independent sources to be cited by category-level analytical or comparative conclusions; ${usedIndependentCategorySourceIds.size} were used.`,
    );
  }
  return { material, cited };
}

function validateIndependentCategoryEvidence(input: {
  text: string;
  contextText: string;
  sourceIds: readonly string[];
  sourceById: ReadonlyMap<string, Record<string, unknown>>;
  competitors: readonly string[];
  location: "claim" | "table cell" | "table header" | "chart series";
  findings: string[];
  usedSourceIds: Set<string>;
}): void {
  const mentionedCompetitors = input.competitors.filter((competitor) =>
    textMatchesAliases(input.contextText, authoritativeCompetitorAliases(competitor)),
  );
  const categoryLevel =
    isComparativeOrRankingClaim(input.text) ||
    CATEGORY_LEVEL_CONCLUSION_PATTERN.test(input.text) ||
    mentionedCompetitors.length !== 1;
  if (!categoryLevel) return;
  const independentSourceIds = input.sourceIds.filter((sourceId) => {
    const source = input.sourceById.get(sourceId);
    return Boolean(source && isIndependentCategoryEvidenceSource(source, input.competitors));
  });
  for (const sourceId of independentSourceIds) input.usedSourceIds.add(sourceId);
  if (independentSourceIds.length === 0) {
    input.findings.push(
      `Category-level ${input.location} \`${input.text}\` must cite at least one canonical independent retailer, marketplace, event, or financial source.`,
    );
  }
}

function validateComparativeClaim(input: {
  text: string;
  sourceIds: readonly string[];
  sourceById: ReadonlyMap<string, Record<string, unknown>>;
  competitors: readonly string[];
  criteria: readonly string[];
  contextText?: string;
  location: "claim" | "slide title" | "table cell" | "table header";
  findings: string[];
}): void {
  const criterionMatch = resolveComparisonCriterionMatch(input.contextText ?? input.text, input.criteria);
  if (criterionMatch.families.length === 0 && criterionMatch.tokens.length === 0) {
    input.findings.push(`Comparative ${input.location} \`${input.text}\` does not name its comparison criterion.`);
  }
  const citedSources = input.sourceIds.map((id) => input.sourceById.get(id)).filter(Boolean) as Array<
    Record<string, unknown>
  >;
  const uncovered = input.competitors.filter(
    (competitor) =>
      !citedSources.some(
        (source) =>
          sourceMatchesCompetitor(source, competitor) && sourceSupportsComparisonCriterion(source, criterionMatch),
      ),
  );
  if (input.competitors.length > 1 && uncovered.length > 0) {
    input.findings.push(
      `Comparative ${input.location} \`${input.text}\` lacks evidence covering the named criterion for: ${uncovered.join(", ")}.`,
    );
  }
}

function validateNumericClaim(input: {
  text: string;
  sourceIds: readonly string[];
  sourceById: ReadonlyMap<string, Record<string, unknown>>;
  competitors: readonly string[];
  contextText?: string;
  metricContextText?: string;
  location: "claim" | "slide title" | "table claim" | "table header" | "chart series";
  findings: string[];
}): void {
  const sources = input.sourceIds.map((id) => input.sourceById.get(id)).filter(Boolean) as Array<
    Record<string, unknown>
  >;
  const claimContext = input.contextText ?? input.text;
  const metricContext = input.metricContextText ?? input.text;
  const datedSources = sources.filter(
    (source) =>
      isAbsoluteEvidenceDate(source.publishedAt) ||
      (EXPLICIT_RETRIEVAL_OBSERVATION_PATTERN.test(input.text) && isAbsoluteEvidenceDate(source.retrievedAt)),
  );
  if (datedSources.length === 0) {
    input.findings.push(
      `Numeric ${input.location} \`${input.text}\` lacks a direct published/dated canonical source; retrieval time is valid only for an explicit as-of or observed-retrieval statement.`,
    );
    return;
  }

  const metricFamilies = NUMERIC_METRIC_FAMILIES.filter((family) => family.claimPattern.test(metricContext));
  const mentionedCompetitors = input.competitors.filter((competitor) =>
    textMatchesAliases(claimContext, authoritativeCompetitorAliases(competitor)),
  );
  const relevantSources = datedSources.filter((source) =>
    sourceSupportsNumericMetric(source, metricContext, metricFamilies),
  );
  const uncoveredCompetitors = mentionedCompetitors.filter(
    (competitor) => !relevantSources.some((source) => sourceMatchesCompetitor(source, competitor)),
  );
  if (mentionedCompetitors.length > 0 && uncoveredCompetitors.length === 0) return;
  if (
    mentionedCompetitors.length === 0 &&
    relevantSources.some((source) => sourceMatchesClaimSubject(source, claimContext))
  ) {
    return;
  }
  input.findings.push(
    `Numeric ${input.location} \`${input.text}\` lacks dated canonical evidence whose title, snippet, publisher, or URL directly matches the claimed subject and metric${
      uncoveredCompetitors.length > 0 ? ` for: ${uncoveredCompetitors.join(", ")}` : ""
    }.`,
  );
}

function isAbsoluteEvidenceDate(value: unknown): boolean {
  const date = readString(value);
  return Boolean(date && /\b(?:19|20)\d{2}\b/u.test(date) && Number.isFinite(Date.parse(date)));
}

function hasMaterialNumericClaim(text: string): boolean {
  return NUMERIC_CLAIM_PATTERN.test(
    text
      .replace(/\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/gu, "")
      .replace(
        /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+(?:19|20)\d{2}\b/giu,
        "",
      )
      .replace(
        /\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?:19|20)\d{2}\b/giu,
        "",
      )
      .replace(/\b(?:19|20)\d{2}\b/gu, "")
      .replace(/\bQ[1-4]\b/giu, ""),
  );
}

function validateTableClaims(input: {
  value: unknown;
  title: string;
  findings: string[];
  sourceById: ReadonlyMap<string, Record<string, unknown>>;
  competitors: readonly string[];
  criteria: readonly string[];
  usedIndependentCategorySourceIds: Set<string>;
}): void {
  const table = toRecord(input.value);
  if (!table) return;
  const headers = Array.isArray(table.headers) ? table.headers : [];
  for (const [headerIndex, rawHeader] of headers.entries()) {
    const header = toRecord(rawHeader);
    const text = typeof rawHeader === "string" ? readString(rawHeader) : readString(header?.text);
    if (!text) {
      input.findings.push(`Table header ${headerIndex + 1} on \`${input.title}\` must contain text.`);
      continue;
    }
    const evidenceBearing =
      hasMaterialNumericClaim(text) || HEADING_ASSERTION_PATTERN.test(text) || UNIVERSAL_COMPARISON_PATTERN.test(text);
    if (!evidenceBearing) continue;
    if (!header) {
      input.findings.push(
        `Evidence-bearing table header \`${text}\` on \`${input.title}\` must use a structured cell with canonical sourceIds.`,
      );
    }
    const sourceIds = readStringArray(header?.sourceIds);
    if (sourceIds.length === 0) {
      input.findings.push(`Evidence-bearing table header \`${text}\` on \`${input.title}\` has no canonical citation.`);
    }
    if (isComparativeOrRankingClaim(text)) {
      validateComparativeClaim({
        text,
        sourceIds,
        sourceById: input.sourceById,
        competitors: input.competitors,
        criteria: input.criteria,
        contextText: `${input.title} ${text}`,
        location: "table header",
        findings: input.findings,
      });
    }
    if (hasMaterialNumericClaim(text)) {
      validateNumericClaim({
        text,
        sourceIds,
        sourceById: input.sourceById,
        competitors: input.competitors,
        contextText: `${input.title} ${text}`,
        location: "table header",
        findings: input.findings,
      });
    }
    validateIndependentCategoryEvidence({
      text,
      contextText: `${input.title} ${text}`,
      sourceIds,
      sourceById: input.sourceById,
      competitors: input.competitors,
      location: "table header",
      findings: input.findings,
      usedSourceIds: input.usedIndependentCategorySourceIds,
    });
  }
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const headerTexts = headers.map((rawHeader) =>
    typeof rawHeader === "string" ? (readString(rawHeader) ?? "") : (readString(toRecord(rawHeader)?.text) ?? ""),
  );
  for (const [rowIndex, rawRow] of rows.entries()) {
    if (!Array.isArray(rawRow)) continue;
    const rowSubject = readString(toRecord(rawRow[0])?.text) ?? "";
    for (const [cellIndex, rawCell] of rawRow.entries()) {
      const cell = toRecord(rawCell);
      const text = readString(cell?.text);
      if (!cell || !text) {
        if (cellIndex > 0) {
          input.findings.push(
            `Table on \`${input.title}\` row ${rowIndex + 1}, column ${cellIndex + 1} must use a structured cell.`,
          );
        }
        continue;
      }
      const sourceIds = readStringArray(cell.sourceIds);
      const claimContext = `${input.title} ${headerTexts[cellIndex] ?? ""} ${rowSubject} ${text}`;
      if (cellIndex > 0 && sourceIds.length === 0) {
        input.findings.push(`Table cell \`${text}\` on \`${input.title}\` has no canonical citation.`);
      }
      if (isComparativeOrRankingClaim(text)) {
        validateComparativeClaim({
          text,
          sourceIds,
          sourceById: input.sourceById,
          competitors: input.competitors,
          criteria: input.criteria,
          contextText: `${headerTexts[cellIndex] ?? ""} ${text}`,
          location: "table cell",
          findings: input.findings,
        });
      }
      if (hasMaterialNumericClaim(text)) {
        validateNumericClaim({
          text,
          sourceIds,
          sourceById: input.sourceById,
          competitors: input.competitors,
          contextText: claimContext,
          metricContextText: `${headerTexts[cellIndex] ?? ""} ${text}`,
          location: "table claim",
          findings: input.findings,
        });
      }
      validateIndependentCategoryEvidence({
        text,
        contextText: claimContext,
        sourceIds,
        sourceById: input.sourceById,
        competitors: input.competitors,
        location: "table cell",
        findings: input.findings,
        usedSourceIds: input.usedIndependentCategorySourceIds,
      });
    }
  }
}

function validateChartClaims(input: {
  value: unknown;
  title: string;
  findings: string[];
  sourceById: ReadonlyMap<string, Record<string, unknown>>;
  competitors: readonly string[];
  criteria: readonly string[];
  usedIndependentCategorySourceIds: Set<string>;
}): void {
  const chart = toRecord(input.value);
  if (!chart) return;
  const chartSourceIds = readStringArray(chart.sourceIds);
  const categories = readStringArray(chart.categories);
  const series = Array.isArray(chart.series) ? chart.series : [];
  for (const rawSeries of series) {
    const item = toRecord(rawSeries);
    if (!item) continue;
    const seriesSourceIds = readStringArray(item.sourceIds);
    const sourceIds = [...new Set([...chartSourceIds, ...seriesSourceIds])];
    const name = readString(item.name) ?? "unnamed";
    const claimContext = `${input.title} ${name} ${categories.join(" ")}`;
    if (sourceIds.length === 0) {
      input.findings.push(`Chart series \`${name}\` on \`${input.title}\` has no canonical citation.`);
    }
    if (
      Array.isArray(item.values) &&
      item.values.some((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      if (isComparativeOrRankingClaim(claimContext) || RANKING_METRIC_PATTERN.test(name)) {
        validateComparativeClaim({
          text: name,
          sourceIds,
          sourceById: input.sourceById,
          competitors: input.competitors,
          criteria: input.criteria,
          contextText: claimContext,
          location: "claim",
          findings: input.findings,
        });
      }
      validateNumericClaim({
        text: `${input.title}: ${name}`,
        sourceIds,
        sourceById: input.sourceById,
        competitors: input.competitors,
        contextText: claimContext,
        location: "chart series",
        findings: input.findings,
      });
      validateIndependentCategoryEvidence({
        text: name,
        contextText: claimContext,
        sourceIds,
        sourceById: input.sourceById,
        competitors: input.competitors,
        location: "chart series",
        findings: input.findings,
        usedSourceIds: input.usedIndependentCategorySourceIds,
      });
    }
  }
}

function validateSourceCoverage(input: {
  research: Record<string, unknown> | undefined;
  sources: Array<Record<string, unknown>>;
  ccgBenchmark: boolean;
  findings: string[];
  slides: unknown;
}): void {
  if (input.sources.length < 2) {
    input.findings.push("Research decks require at least two canonical sources.");
  }
  if (!input.ccgBenchmark) return;
  const domains = new Set(input.sources.map((source) => readString(source.domain)).filter(Boolean));
  if (input.sources.length < 12)
    input.findings.push("The CCG benchmark requires at least 12 unique canonical HTTPS sources.");
  if (domains.size < 8) input.findings.push("The CCG benchmark requires sources from at least eight domains.");
  const competitors = readStringArray(input.research?.competitors);
  const independentCount = input.sources.filter((source) =>
    isIndependentCategoryEvidenceSource(source, competitors),
  ).length;
  if (independentCount < 2) {
    input.findings.push(
      "The CCG benchmark requires at least two independent retailer, marketplace, event, or financial sources.",
    );
  }
  for (const expected of CCG_CORE_COMPETITORS) {
    if (!competitors.some((competitor) => textMatchesAliases(competitor, expected.aliases))) {
      input.findings.push(`The CCG benchmark is missing core competitor ${expected.label}.`);
    }
  }

  for (const competitor of competitors) {
    const officialCoverage = input.sources.some((source) => isAuthoritativeOfficialSource(source, competitor));
    if (!officialCoverage) {
      input.findings.push(`The CCG benchmark lacks an official canonical source for ${competitor}.`);
    }
  }

  const matrixCoverage = collectMatrixCompetitorCoverage(input.slides, competitors);
  if (!matrixCoverage.hasMatrix) {
    input.findings.push("The CCG benchmark requires at least one structured comparison matrix.");
  } else {
    for (const competitor of competitors) {
      if (!matrixCoverage.competitors.has(competitor)) {
        input.findings.push(`The structured comparison matrix is missing ${competitor}.`);
      }
    }
  }
  validateCcgRequiredFieldCoverage({
    slides: input.slides,
    competitors,
    criteria: readStringArray(input.research?.comparisonCriteria),
    findings: input.findings,
  });
  if (!hasAnalyticalVisualBeyondMatrix(input.slides)) {
    input.findings.push(
      "The CCG benchmark requires at least one analytical visual beyond the comparison matrix: a structured chart or qualitative positioning structure.",
    );
  }
}

function collectMatrixCompetitorCoverage(
  value: unknown,
  competitors: readonly string[],
): { hasMatrix: boolean; competitors: Set<string> } {
  const coveredCompetitors = new Set<string>();
  if (!Array.isArray(value)) return { hasMatrix: false, competitors: coveredCompetitors };
  let hasMatrix = false;
  for (const rawSlide of value) {
    const slide = toRecord(rawSlide);
    if (!slide || readString(slide.archetype)?.toLowerCase() !== "matrix") continue;
    const table = toRecord(slide.table);
    if (!table) continue;
    hasMatrix = true;
    const headers = (Array.isArray(table.headers) ? table.headers : []).map(readStructuredText);
    const subjectColumnIndexes = matrixSubjectColumnIndexes(headers);
    for (const rawRow of Array.isArray(table.rows) ? table.rows : []) {
      if (!Array.isArray(rawRow)) continue;
      const rowValues = rawRow.map(readStructuredText);
      const rowSubject = subjectColumnIndexes.map((index) => rowValues[index] ?? "").join(" ");
      const matches = competitors.filter((competitor) =>
        textMatchesAliases(rowSubject, authoritativeCompetitorAliases(competitor)),
      );
      if (matches.length === 1) coveredCompetitors.add(matches[0]!);
    }
  }
  return { hasMatrix, competitors: coveredCompetitors };
}

function validateCcgRequiredFieldCoverage(input: {
  slides: unknown;
  competitors: readonly string[];
  criteria: readonly string[];
  findings: string[];
}): void {
  const criteriaText = input.criteria.join(" ");
  const missingRubricFields = CCG_REQUIRED_FIELD_DEFINITIONS.filter(
    (field) => !field.patterns.every((pattern) => pattern.test(criteriaText)),
  ).map((field) => field.label);
  if (missingRubricFields.length > 0) {
    input.findings.push(`The CCG benchmark comparison rubric is missing: ${missingRubricFields.join("; ")}.`);
  }

  for (const competitor of input.competitors) {
    const coveredFields = collectCompetitorFieldCoverage(input.slides, competitor, input.competitors);
    const missingFields = CCG_REQUIRED_FIELD_DEFINITIONS.filter((field) => !coveredFields.has(field.label)).map(
      (field) => field.label,
    );
    if (missingFields.length > 0) {
      input.findings.push(
        `The CCG benchmark competitor ${competitor} is missing required field coverage for: ${missingFields.join("; ")}.`,
      );
    }
  }
}

function collectCompetitorFieldCoverage(
  value: unknown,
  competitor: string,
  allCompetitors: readonly string[],
): Set<string> {
  const coveredFields = new Set<string>();
  if (!Array.isArray(value)) return coveredFields;
  const aliases = authoritativeCompetitorAliases(competitor);
  for (const rawSlide of value) {
    const slide = toRecord(rawSlide);
    if (!slide) continue;
    const title = readString(slide.title) ?? "";
    const bulletTexts = (Array.isArray(slide.bullets) ? slide.bullets : []).map(readStructuredText).filter(Boolean);
    const relevantBullets = textMatchesAliases(title, aliases)
      ? bulletTexts
      : bulletTexts.filter((text) => textMatchesAliases(text, aliases));
    for (const text of relevantBullets) {
      for (const field of CCG_REQUIRED_FIELD_DEFINITIONS) {
        if (field.bulletLabelPattern.test(text) && field.patterns.every((pattern) => pattern.test(text))) {
          coveredFields.add(field.label);
        }
      }
    }

    const table = toRecord(slide.table);
    if (!table || readString(slide.archetype)?.toLowerCase() !== "matrix") continue;
    const headers = (Array.isArray(table.headers) ? table.headers : []).map(readStructuredText);
    const subjectColumnIndexes = matrixSubjectColumnIndexes(headers);
    for (const rawRow of Array.isArray(table.rows) ? table.rows : []) {
      if (!Array.isArray(rawRow)) continue;
      const rowValues = rawRow.map(readStructuredText);
      const rowSubject = subjectColumnIndexes.map((index) => rowValues[index] ?? "").join(" ");
      const matchedCompetitors = allCompetitors.filter((candidate) =>
        textMatchesAliases(rowSubject, authoritativeCompetitorAliases(candidate)),
      );
      if (matchedCompetitors.length !== 1 || !textMatchesAliases(rowSubject, aliases)) continue;
      for (const field of CCG_REQUIRED_FIELD_DEFINITIONS) {
        const matchingColumnIndexes = headers.flatMap((header, index) =>
          field.headerPattern.test(header) ? [index] : [],
        );
        if (
          matchingColumnIndexes.some((index) => {
            const valueText = rowValues[index] ?? "";
            if (!valueText) return false;
            const structuredText = `${headers[index] ?? ""} ${valueText}`;
            return (
              /\b(?:not\s+(?:measured|found|available)|no\s+comparable|unknown)\b/iu.test(valueText) ||
              field.patterns.every((pattern) => pattern.test(structuredText))
            );
          })
        ) {
          coveredFields.add(field.label);
        }
      }
    }
  }
  return coveredFields;
}

function matrixSubjectColumnIndexes(headers: readonly string[]): number[] {
  const declaredSubjectColumnIndexes = headers.flatMap((header, index) =>
    /\b(?:game|competitor|title|ccg)\b/iu.test(header) ? [index] : [],
  );
  return declaredSubjectColumnIndexes.length > 0 ? declaredSubjectColumnIndexes : [0];
}

function hasAnalyticalVisualBeyondMatrix(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((rawSlide) => {
    const slide = toRecord(rawSlide);
    if (!slide) return false;
    const chart = toRecord(slide.chart);
    if (chart) {
      const categories = readStringArray(chart.categories);
      const series = Array.isArray(chart.series) ? chart.series : [];
      if (
        categories.length > 0 &&
        series.some((rawSeries) => {
          const item = toRecord(rawSeries);
          return (
            Boolean(readString(item?.name)) &&
            Array.isArray(item?.values) &&
            item.values.some((entry) => typeof entry === "number" && Number.isFinite(entry))
          );
        })
      ) {
        return true;
      }
    }
    const table = toRecord(slide.table);
    if (readString(slide.archetype)?.toLowerCase() !== "comparison" || !table) return false;
    const headers = Array.isArray(table.headers) ? table.headers.map(readStructuredText).filter(Boolean) : [];
    const rows = Array.isArray(table.rows) ? table.rows.filter(Array.isArray) : [];
    if (headers.length < 2 || rows.length < 2) return false;
    const positioningText = [
      readString(slide.title) ?? "",
      ...(Array.isArray(slide.bullets) ? slide.bullets : []).map(readStructuredText),
      ...collectTableVisibleText(slide.table),
    ].join(" ");
    return /\b(?:positioning|quadrant|spectrum|two[- ]axis|2\s*[x×]\s*2|portfolio\s+map|fit\s+map)\b/iu.test(
      positioningText,
    );
  });
}

function collectTableVisibleText(value: unknown): string[] {
  const table = toRecord(value);
  if (!table) return [];
  return [
    ...(Array.isArray(table.headers) ? table.headers : []),
    ...(Array.isArray(table.rows) ? table.rows.flatMap((row) => (Array.isArray(row) ? row : [])) : []),
  ]
    .map(readStructuredText)
    .filter(Boolean);
}

function readStructuredText(value: unknown): string {
  return typeof value === "string" ? (readString(value) ?? "") : (readString(toRecord(value)?.text) ?? "");
}

interface ComparisonCriterionMatch {
  families: readonly EvidenceSemanticFamily[];
  tokens: readonly string[];
}

function isComparativeOrRankingClaim(text: string): boolean {
  return UNIVERSAL_COMPARISON_PATTERN.test(text) || RANKING_COMPARISON_PATTERN.test(text);
}

function resolveComparisonCriterionMatch(text: string, criteria: readonly string[]): ComparisonCriterionMatch {
  const normalizedText = normalizeComparisonText(text);
  const families = COMPARISON_CRITERION_FAMILIES.filter(
    (family) => family.claimPattern.test(text) && criteria.some((criterion) => family.claimPattern.test(criterion)),
  );
  const tokens = [
    ...new Set(
      criteria.flatMap((criterion) =>
        normalizeComparisonText(criterion)
          .split(" ")
          .filter((word) => word.length >= 4 && !CLAIM_SUBJECT_STOPWORDS.has(word) && normalizedText.includes(word)),
      ),
    ),
  ];
  return { families, tokens };
}

function sourceSupportsComparisonCriterion(
  source: Record<string, unknown>,
  criterionMatch: ComparisonCriterionMatch,
): boolean {
  const sourceText = sourceEvidenceText(source);
  if (criterionMatch.families.length > 0) {
    return criterionMatch.families.every((family) => family.evidencePattern.test(sourceText));
  }
  const sourceTokens = new Set(normalizeComparisonText(sourceText).split(" ").filter(Boolean));
  return criterionMatch.tokens.some((token) => sourceTokens.has(token));
}

function sourceSupportsNumericMetric(
  source: Record<string, unknown>,
  claimText: string,
  metricFamilies: readonly EvidenceSemanticFamily[],
): boolean {
  const sourceText = sourceEvidenceText(source);
  if (metricFamilies.length > 0) {
    return metricFamilies.every((family) => family.evidencePattern.test(sourceText));
  }
  const claimTokens = extractClaimSubjectTokens(claimText);
  const sourceTokens = new Set(normalizeComparisonText(sourceText).split(" ").filter(Boolean));
  return claimTokens.some((token) => sourceTokens.has(token));
}

function sourceMatchesClaimSubject(source: Record<string, unknown>, claimText: string): boolean {
  const subjectTokens = extractClaimSubjectTokens(claimText);
  if (subjectTokens.length === 0) return true;
  const sourceTokens = new Set(normalizeComparisonText(sourceEvidenceText(source)).split(" ").filter(Boolean));
  return subjectTokens.some((token) => sourceTokens.has(token));
}

function extractClaimSubjectTokens(text: string): string[] {
  const metricLabels = new Set(
    NUMERIC_METRIC_FAMILIES.flatMap((family) => normalizeComparisonText(family.label).split(" ")),
  );
  return [
    ...new Set(
      normalizeComparisonText(text)
        .split(" ")
        .filter(
          (token) =>
            token.length >= 4 &&
            !/^\d+$/u.test(token) &&
            !/^(?:19|20)\d{2}$/u.test(token) &&
            !/^q[1-4]$/u.test(token) &&
            !CLAIM_SUBJECT_STOPWORDS.has(token) &&
            !metricLabels.has(token) &&
            ![
              "best",
              "bottom",
              "gmv",
              "growth",
              "lower",
              "market",
              "marketplace",
              "msrp",
              "number",
              "percent",
              "price",
              "rank",
              "ranked",
              "ranking",
              "revenue",
              "sales",
              "stronger",
              "top",
            ].includes(token),
        ),
    ),
  ];
}

function sourceEvidenceText(source: Record<string, unknown>): string {
  return [source.title, source.publisher, source.url, source.domain, source.snippet]
    .map((value) => readString(value) ?? "")
    .join(" ");
}

function sourceMatchesCompetitor(source: Record<string, unknown>, competitor: string): boolean {
  return textMatchesAliases(sourceEvidenceText(source), authoritativeCompetitorAliases(competitor));
}

function isAuthoritativeOfficialSource(source: Record<string, unknown>, competitor: string): boolean {
  return (
    readString(source.role)?.toLowerCase() === "official" && isAuthoritativeDomainForCompetitor(source, competitor)
  );
}

function isIndependentCategoryEvidenceSource(source: Record<string, unknown>, competitors: readonly string[]): boolean {
  const role = readString(source.role)?.toLowerCase() ?? "";
  if (!INDEPENDENT_SOURCE_ROLES.has(role)) return false;
  return !competitors.some((competitor) => isAuthoritativeDomainForCompetitor(source, competitor));
}

function isAuthoritativeDomainForCompetitor(source: Record<string, unknown>, competitor: string): boolean {
  const domain = readString(source.domain)?.toLowerCase();
  if (!domain) return false;
  const registryEntry = CCG_AUTHORITATIVE_COMPETITORS.find((candidate) =>
    textMatchesAliases(competitor, candidate.aliases),
  );
  return Boolean(
    registryEntry?.authoritativeDomains.some(
      (authoritativeDomain) => domain === authoritativeDomain || domain.endsWith(`.${authoritativeDomain}`),
    ),
  );
}

function authoritativeCompetitorAliases(competitor: string): string[] {
  const normalized = normalizeComparisonText(competitor);
  const allWords = normalized.split(" ").filter(Boolean);
  const words = allWords.filter(
    (word) => !["and", "the", "card", "game", "trading", "collectible", "world", "super"].includes(word),
  );
  const acronym = words.map((word) => word[0] ?? "").join("");
  const brandAcronym = allWords
    .filter((word) => !["the", "card", "game", "trading", "collectible", "world"].includes(word))
    .map((word) => word[0] ?? "")
    .join("");
  const fixedCoreAliases =
    CCG_AUTHORITATIVE_COMPETITORS.find((expected) => textMatchesAliases(competitor, expected.aliases))?.aliases ?? [];
  return [
    ...new Set([
      ...competitorAliases(competitor),
      ...fixedCoreAliases,
      ...words.filter((word) => word.length >= 5),
      ...(acronym.length >= 3 ? [acronym.slice(0, 3)] : []),
      ...(brandAcronym.length >= 3 ? [brandAcronym, brandAcronym.slice(0, 3)] : []),
    ]),
  ];
}

function competitorAliases(value: string): string[] {
  const normalized = normalizeComparisonText(value);
  const compact = normalized.replace(/\s+/gu, "");
  const acronym = normalized
    .split(" ")
    .filter((word) => !["and", "the", "card", "game", "trading"].includes(word))
    .map((word) => word[0] ?? "")
    .join("");
  return [normalized, compact, ...(acronym.length >= 3 ? [acronym] : [])];
}

function textMatchesAliases(text: string, aliases: readonly string[]): boolean {
  const normalized = normalizeComparisonText(text);
  const compact = normalized.replace(/\s+/gu, "");
  return aliases.some((alias) => {
    const normalizedAlias = normalizeComparisonText(alias);
    const compactAlias = normalizedAlias.replace(/\s+/gu, "");
    return Boolean(normalizedAlias) && (normalized.includes(normalizedAlias) || compact.includes(compactAlias));
  });
}

function normalizeComparisonText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function emptyGroundingReport(
  required: boolean,
  ccgBenchmark: boolean,
  evidenceSourceCount: number,
): PresentationResearchGroundingReport {
  return {
    required,
    ccgBenchmark,
    passed: true,
    findings: [],
    evidenceSourceCount,
    declaredSourceCount: 0,
    matchedSourceCount: 0,
    domainCount: 0,
    materialClaimCount: 0,
    citedMaterialClaimCount: 0,
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
