import { createHash } from "node:crypto";
import {
  paginatePresentationItems,
  paginatePresentationSources,
  paginatePresentationTableRows,
  presentationBulletLineCount,
  presentationSourceCapacityFindings,
  presentationTableCapacityFindings,
} from "./presentation-capacity.js";

export type PresentationArchetype =
  | "auto"
  | "narrative"
  | "comparison"
  | "matrix"
  | "chart"
  | "section"
  | "sources"
  | "closing";

export type PresentationClaimKind = "fact" | "analysis" | "recommendation";
export type PresentationSourceRole =
  | "official"
  | "independent"
  | "retailer"
  | "marketplace"
  | "financial"
  | "event"
  | "other";

export interface PresentationRichBullet {
  text: string;
  claimKind?: PresentationClaimKind;
  sourceIds?: string[];
}

export type PresentationBullet = string | PresentationRichBullet;

export interface PresentationTableCell {
  text: string;
  sourceIds?: string[];
}

export type PresentationTableCellInput = string | PresentationTableCell;

export interface PresentationTable {
  headers: PresentationTableCell[];
  rows: PresentationTableCell[][];
}

export interface PresentationChartSeries {
  name: string;
  values: number[];
  sourceIds?: string[];
}

export interface PresentationChart {
  type: "bar" | "column" | "line";
  categories: string[];
  series: PresentationChartSeries[];
  sourceIds?: string[];
}

export interface PresentationSlide {
  title: string;
  bullets: PresentationBullet[];
  /** Trusted direct-render API only; governed presentations.create rejects this field before visual calls. */
  speakerNotes?: string;
  visualBrief?: string;
  archetype?: PresentationArchetype;
  table?: PresentationTable;
  chart?: PresentationChart;
  /** Internal idempotency marker; never accepted as evidence from the model. */
  generatedSourceAppendix?: boolean;
}

export interface PresentationSource {
  id: string;
  title: string;
  url: string;
  publisher: string;
  publishedAt?: string;
  retrievedAt?: string;
  role: PresentationSourceRole;
  domain?: string;
  snippet?: string;
  confidence?: number;
  toolRunId?: string;
  toolName?: string;
  query?: string;
}

export interface PresentationResearch {
  asOfDate: string;
  geography: string;
  physicalDigitalBoundary: string;
  inclusionCriteria: string[];
  exclusions: string[];
  methodology: string[];
  limitations: string[];
  competitors: string[];
  comparisonCriteria: string[];
}

export interface PresentationRenderManifest {
  slideCount: number;
  contentSlideCount: number;
  layoutCounts: Record<string, number>;
  minimumFontSize: number;
  minimumTitleFontSize: number;
  minimumBodyFontSize: number;
  minimumTableFontSize: number;
  minimumSourceFontSize: number;
  minimumCitationFontSize: number;
  minimumSlideNumberFontSize: number;
  hyperlinkCount: number;
  sourceCount: number;
  tableCount: number;
  chartCount: number;
  continuationCount: number;
  visualCount: number;
  authoredNoteCount: number;
}

export interface NormalizedPresentationSources {
  sources: PresentationSource[];
  aliases: ReadonlyMap<string, string>;
}

const ARCHETYPES = new Set<PresentationArchetype>([
  "auto",
  "narrative",
  "comparison",
  "matrix",
  "chart",
  "section",
  "sources",
  "closing",
]);
const CLAIM_KINDS = new Set<PresentationClaimKind>(["fact", "analysis", "recommendation"]);
const SOURCE_ROLES = new Set<PresentationSourceRole>([
  "official",
  "independent",
  "retailer",
  "marketplace",
  "financial",
  "event",
  "other",
]);
const FORBIDDEN_PRESENTATION_VISIBLE_TEXT =
  /(?:\bGoatCitadel design brief\s*-\s*[a-z0-9-]+\b|\bDesign(?:ed)? artifact\b|\bDesign preset:\s*[a-z0-9-]+\b|\bAsset provenance:|\bImage Text\b|\bplaceholder text\b|\blorem\s+ipsum\b|<PLACEHOLDER[^>]*>|\bTODO_PLACEHOLDER\b)/iu;
const INTERNAL_PRESENTATION_NOTE_METADATA =
  /(?:\brevised prompt\b|\bsourceModel\b|\bprovider metadata\b|\bdesign provenance\b|\blayout decision\b|\bimage prompt\b|\basset provenance\b|\brenderer assets used\b|\bdensity\s*=|\bpromptSha256\b|\bprovider\s*=|\bsource model\s*=)/iu;

export function normalizePresentationSources(value: unknown): NormalizedPresentationSources {
  const inputs = Array.isArray(value) ? value : [];
  const byUrl = new Map<string, PresentationSource>();
  const aliases = new Map<string, string>();
  for (const item of inputs) {
    const raw = safeRecord(item);
    const url = canonicalizePresentationSourceUrl(asNonEmptyString(raw.url));
    if (!url) {
      throw new Error("Presentation sources require a valid credential-free HTTPS URL.");
    }
    const id = stablePresentationSourceId(url);
    const suppliedId = asNonEmptyString(raw.id);
    if (suppliedId) {
      aliases.set(suppliedId, id);
    }
    aliases.set(id, id);
    if (byUrl.has(url)) {
      throw new Error(`Presentation sources contain a duplicate canonical URL: ${url}.`);
    }
    byUrl.set(url, {
      id,
      title: normalizeRequiredVisibleText(raw.title, "source title"),
      url,
      publisher: normalizeRequiredVisibleText(raw.publisher, "source publisher"),
      publishedAt: normalizeOptionalText(raw.publishedAt),
      retrievedAt: normalizeOptionalText(raw.retrievedAt),
      role: normalizeSourceRole(raw.role),
      domain: normalizeOptionalText(raw.domain) ?? new URL(url).hostname,
      snippet: normalizeOptionalText(raw.snippet),
      confidence: normalizeConfidence(raw.confidence),
      toolRunId: normalizeOptionalText(raw.toolRunId),
      toolName: normalizeOptionalText(raw.toolName),
      query: normalizeOptionalText(raw.query),
    });
  }
  return { sources: [...byUrl.values()], aliases };
}

export function normalizePresentationResearch(value: unknown): PresentationResearch | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw = safeRecord(value);
  return {
    asOfDate: normalizePresentationText(asNonEmptyString(raw.asOfDate) ?? ""),
    geography: normalizePresentationText(asNonEmptyString(raw.geography) ?? ""),
    physicalDigitalBoundary: normalizePresentationText(asNonEmptyString(raw.physicalDigitalBoundary) ?? ""),
    inclusionCriteria: normalizeTextArray(raw.inclusionCriteria),
    exclusions: normalizeTextArray(raw.exclusions),
    methodology: normalizeTextArray(raw.methodology),
    limitations: normalizeTextArray(raw.limitations),
    competitors: normalizeTextArray(raw.competitors),
    comparisonCriteria: normalizeTextArray(raw.comparisonCriteria),
  };
}

export function normalizePresentationSlides(
  value: unknown,
  _fallbackTitle: string,
  _fallbackBody: string | undefined,
  sourceAliases: ReadonlyMap<string, string>,
): PresentationSlide[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Presentations require at least one authored slide; fallback slide synthesis is not allowed.");
  }
  return value.map((item, index) => normalizeSlide(item, index, sourceAliases));
}

export function preparePresentationSlides(
  inputSlides: readonly PresentationSlide[],
  sources: readonly PresentationSource[],
): PresentationSlide[] {
  validatePresentationVisibleContent({ slides: inputSlides, sources });
  const expanded: PresentationSlide[] = [];
  for (const slide of inputSlides) {
    const bulletPages = paginateBullets(slide.bullets, slide.archetype);
    const flattenedBullets = bulletPages.flat();
    const derived: PresentationSlide[] = [];
    if (slide.table || slide.chart) {
      const keepSingleIntro =
        flattenedBullets.length === 1 &&
        presentationBulletLineCount(presentationBulletText(flattenedBullets[0]!)) === 1;
      if (flattenedBullets.length > 0 && !keepSingleIntro) {
        bulletPages.forEach((bullets, index) => {
          derived.push({
            ...slide,
            title: index === 0 ? slide.title : `${slide.title} — Continued`,
            archetype: "narrative",
            bullets,
            table: undefined,
            chart: undefined,
          });
        });
      }
      if (slide.table) {
        const rowPages = paginatePresentationTableRows({
          headers: slide.table.headers,
          rows: slide.table.rows,
          textOf: presentationTableCellLayoutText,
          hasIntro: keepSingleIntro,
        });
        rowPages.forEach((rows, index) => {
          derived.push({
            ...slide,
            title: index === 0 ? slide.title : `${slide.title} — Continued`,
            bullets: keepSingleIntro && index === 0 ? flattenedBullets : [],
            table: { headers: slide.table!.headers, rows },
          });
        });
      } else {
        derived.push({
          ...slide,
          bullets: keepSingleIntro ? flattenedBullets : [],
        });
      }
    } else {
      const pageCount = Math.max(bulletPages.length, 1);
      for (let index = 0; index < pageCount; index += 1) {
        derived.push({
          ...slide,
          title: index === 0 ? slide.title : `${slide.title} — Continued`,
          bullets: bulletPages[index] ?? [],
        });
      }
    }
    expanded.push(
      ...derived.map((page, index) => ({ ...page, speakerNotes: index === 0 ? slide.speakerNotes : undefined })),
    );
  }
  if (sources.length > 0 && !expanded.some((slide) => slide.generatedSourceAppendix)) {
    expanded.push(...createSourceAppendixSlides(sources));
  }
  if (expanded.length + 1 > 40) {
    throw new Error(`Presentation pagination produced ${expanded.length + 1} slides; the maximum is 40.`);
  }
  validatePresentationCapacity(expanded, sources);
  return expanded;
}

export function validatePresentationVisibleContent(input: {
  title?: string;
  subtitle?: string;
  slides: readonly PresentationSlide[];
  sources: readonly PresentationSource[];
}): void {
  const visible: Array<{ location: string; text: string }> = [
    ...(input.title !== undefined ? [{ location: "title", text: input.title }] : []),
    ...(input.subtitle ? [{ location: "subtitle", text: input.subtitle }] : []),
  ];
  input.slides.forEach((slide, slideIndex) => {
    visible.push({ location: `slide ${slideIndex + 1} title`, text: slide.title });
    slide.bullets.forEach((bullet, bulletIndex) => {
      validateUniquePresentationSourceIds(
        presentationBulletSourceIds(bullet),
        `slide ${slideIndex + 1} bullet ${bulletIndex + 1}`,
      );
      visible.push({
        location: `slide ${slideIndex + 1} bullet ${bulletIndex + 1}`,
        text: presentationBulletText(bullet),
      });
    });
    slide.table?.headers.forEach((cell, cellIndex) => {
      validateUniquePresentationSourceIds(
        cell.sourceIds ?? [],
        `slide ${slideIndex + 1} table header ${cellIndex + 1}`,
      );
      visible.push({ location: `slide ${slideIndex + 1} table header ${cellIndex + 1}`, text: cell.text });
    });
    slide.table?.rows.forEach((row, rowIndex) => {
      row.forEach((cell, cellIndex) => {
        validateUniquePresentationSourceIds(
          cell.sourceIds ?? [],
          `slide ${slideIndex + 1} table row ${rowIndex + 1} cell ${cellIndex + 1}`,
        );
        visible.push({
          location: `slide ${slideIndex + 1} table row ${rowIndex + 1} cell ${cellIndex + 1}`,
          text: cell.text,
        });
      });
    });
    slide.chart?.categories.forEach((category, categoryIndex) => {
      visible.push({ location: `slide ${slideIndex + 1} chart category ${categoryIndex + 1}`, text: category });
    });
    slide.chart?.series.forEach((series, seriesIndex) => {
      validateUniquePresentationSourceIds(
        series.sourceIds ?? [],
        `slide ${slideIndex + 1} chart series ${seriesIndex + 1}`,
      );
      visible.push({ location: `slide ${slideIndex + 1} chart series ${seriesIndex + 1}`, text: series.name });
    });
    validateUniquePresentationSourceIds(slide.chart?.sourceIds ?? [], `slide ${slideIndex + 1} chart`);
  });
  input.sources.forEach((source, sourceIndex) => {
    visible.push(
      { location: `source ${sourceIndex + 1} publisher`, text: source.publisher },
      { location: `source ${sourceIndex + 1} title`, text: source.title },
      { location: `source ${sourceIndex + 1} URL`, text: source.url },
    );
  });
  for (const item of visible) {
    if (!item.text) {
      throw new Error(
        `Presentation visible content is empty at ${item.location}; fallback replacement is not allowed.`,
      );
    }
    if (FORBIDDEN_PRESENTATION_VISIBLE_TEXT.test(item.text)) {
      throw new Error(`Presentation visible content at ${item.location} contains internal or placeholder metadata.`);
    }
  }
}

function validateUniquePresentationSourceIds(sourceIds: readonly string[], location: string): void {
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error(`Presentation ${location} contains duplicate canonical source ids.`);
  }
}

export function presentationCapacityFindings(
  slides: readonly PresentationSlide[],
  sources: readonly PresentationSource[],
): string[] {
  const findings: string[] = [];
  slides.forEach((slide, index) => {
    if (!slide.generatedSourceAppendix) {
      try {
        const pages = paginatePresentationItems(slide.bullets, presentationBulletLayoutText, {
          ...presentationBulletPaginationOptions(slide.archetype),
          authoredTextOf: presentationBulletText,
        });
        if (pages.length > 1) findings.push(`Slide ${index + 1} requires additional bullet pagination.`);
      } catch (error) {
        findings.push(`Slide ${index + 1} ${error instanceof Error ? error.message : "bullet content cannot fit"}`);
      }
    }
    if (slide.table) {
      presentationTableCapacityFindings({
        headers: slide.table.headers.map(presentationTableCellLayoutText),
        rows: slide.table.rows.map((row) => row.map(presentationTableCellLayoutText)),
        hasIntro: slide.bullets.length > 0,
      }).forEach((detail) => findings.push(`Slide ${index + 1} ${detail}`));
    }
  });
  sources.forEach((source, index) => {
    presentationSourceCapacityFindings(`${source.publisher}: ${source.title}`, source.url).forEach((detail) =>
      findings.push(`Source ${index + 1} ${detail}.`),
    );
  });
  return findings;
}

export function validatePresentationCapacity(
  slides: readonly PresentationSlide[],
  sources: readonly PresentationSource[],
): void {
  const findings = presentationCapacityFindings(slides, sources);
  if (findings.length > 0) {
    throw new Error(`Presentation content overflow: ${findings.join(" ")}`);
  }
}

export function validateTrustedPresentationNotes(slides: readonly PresentationSlide[]): void {
  slides.forEach((slide, index) => {
    const notes = slide.speakerNotes;
    if (notes && INTERNAL_PRESENTATION_NOTE_METADATA.test(notes)) {
      throw new Error(`Trusted presenter notes on slide ${index + 1} contain internal render or provider metadata.`);
    }
  });
}

export function validateResearchPresentation(
  research: PresentationResearch | undefined,
  sources: readonly PresentationSource[],
  slides: readonly PresentationSlide[],
): void {
  if (!research) {
    return;
  }
  const missing = [
    ["asOfDate", research.asOfDate],
    ["geography", research.geography],
    ["physicalDigitalBoundary", research.physicalDigitalBoundary],
    ["inclusionCriteria", research.inclusionCriteria],
    ["exclusions", research.exclusions],
    ["methodology", research.methodology],
    ["limitations", research.limitations],
    ["competitors", research.competitors],
    ["comparisonCriteria", research.comparisonCriteria],
  ]
    .filter(([, value]) => (Array.isArray(value) ? value.length === 0 : !value))
    .map(([field]) => field);
  if (missing.length > 0) {
    throw new Error(`Research presentation metadata is incomplete: ${missing.join(", ")}.`);
  }
  if (sources.length === 0) {
    throw new Error("Research presentations require at least one canonical HTTPS source.");
  }
  const uncitedClaims: string[] = [];
  for (const slide of slides) {
    for (const bullet of slide.bullets) {
      if (typeof bullet !== "string" && bullet.claimKind !== "recommendation" && !bullet.sourceIds?.length) {
        uncitedClaims.push(`${slide.title}: ${bullet.text}`);
      }
      if (typeof bullet === "string") {
        uncitedClaims.push(`${slide.title}: ${bullet}`);
      }
    }
    slide.table?.rows.forEach((row, rowIndex) => {
      if (!row.some((cell) => cell.sourceIds?.length)) {
        uncitedClaims.push(`${slide.title}: table row ${rowIndex + 1}`);
      }
    });
    if (
      slide.chart &&
      !slide.chart.sourceIds?.length &&
      !slide.chart.series.every((series) => Boolean(series.sourceIds?.length))
    ) {
      uncitedClaims.push(`${slide.title}: chart data`);
    }
  }
  if (uncitedClaims.length > 0) {
    throw new Error(
      `Research presentations require structured citations for factual and analytical bullets (${uncitedClaims.length} uncited claim(s)).`,
    );
  }
}

export function buildPresentationRenderManifest(input: {
  slides: readonly PresentationSlide[];
  sources: readonly PresentationSource[];
  layoutNames: readonly string[];
  visualCount: number;
}): PresentationRenderManifest {
  const layoutCounts: Record<string, number> = {};
  for (const name of input.layoutNames) {
    layoutCounts[name] = (layoutCounts[name] ?? 0) + 1;
  }
  let hyperlinkCount = 0;
  for (const slide of input.slides) {
    if (slide.archetype === "sources") {
      hyperlinkCount += slide.bullets.reduce((count, bullet) => count + presentationBulletSourceIds(bullet).length, 0);
      continue;
    }
    hyperlinkCount += slide.bullets.reduce((count, bullet) => count + presentationBulletSourceIds(bullet).length, 0);
    if (slide.table) {
      hyperlinkCount += [...slide.table.headers, ...slide.table.rows.flat()].reduce(
        (count, cell) => count + (cell.sourceIds?.length ?? 0),
        0,
      );
    }
    if (slide.chart) {
      const chartIds = [
        ...(slide.chart.sourceIds ?? []),
        ...slide.chart.series.flatMap((series) => series.sourceIds ?? []),
      ];
      hyperlinkCount += new Set(chartIds).size;
    }
  }
  return {
    slideCount: input.slides.length + 1,
    contentSlideCount:
      1 + input.slides.filter((slide) => slide.archetype !== "sources" && !slide.generatedSourceAppendix).length,
    layoutCounts,
    minimumFontSize: 10,
    minimumTitleFontSize: 28,
    minimumBodyFontSize: 16,
    minimumTableFontSize: 14,
    minimumSourceFontSize: 12,
    minimumCitationFontSize: 11,
    minimumSlideNumberFontSize: 10,
    hyperlinkCount,
    sourceCount: input.sources.length,
    tableCount: input.slides.filter((slide) => slide.table).length,
    chartCount: input.slides.filter((slide) => slide.chart).length,
    continuationCount: input.slides.filter((slide) => slide.title.endsWith("— Continued")).length,
    visualCount: input.visualCount,
    authoredNoteCount: input.slides.filter((slide) => Boolean(slide.speakerNotes?.trim())).length,
  };
}

export function presentationBulletText(bullet: PresentationBullet): string {
  return typeof bullet === "string" ? bullet : bullet.text;
}

export function presentationBulletSourceIds(bullet: PresentationBullet): string[] {
  return typeof bullet === "string" ? [] : (bullet.sourceIds ?? []);
}

export function presentationBulletLayoutText(bullet: PresentationBullet): string {
  return `${presentationBulletText(bullet)}${citationLayoutSuffix(presentationBulletSourceIds(bullet))}`;
}

export function presentationTableCellLayoutText(cell: PresentationTableCell): string {
  return `${cell.text}${citationLayoutSuffix(cell.sourceIds ?? [])}`;
}

export function presentationSlideText(slide: PresentationSlide): string[] {
  return slide.bullets.map(presentationBulletText);
}

export function sourceMap(sources: readonly PresentationSource[]): ReadonlyMap<string, PresentationSource> {
  return new Map(sources.map((source) => [source.id, source]));
}

export function stablePresentationSourceId(canonicalUrl: string): string {
  return `src_${createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 12)}`;
}

export function canonicalizePresentationSourceUrl(value: string | undefined): string | undefined {
  if (!value || /(?:\.\.\.|…)/u.test(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return undefined;
    }
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.port === "443") {
      parsed.port = "";
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|msclkid)$/iu.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function normalizePresentationText(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\p{Cc}/gu, "");
}

function normalizeSlide(item: unknown, index: number, sourceAliases: ReadonlyMap<string, string>): PresentationSlide {
  const raw = safeRecord(item);
  return {
    title: normalizeRequiredVisibleText(raw.title, `slide ${index + 1} title`),
    bullets: normalizePresentationBullets(raw.bullets, sourceAliases),
    speakerNotes: normalizeOptionalText(raw.speakerNotes),
    visualBrief: normalizeOptionalText(raw.visualBrief),
    archetype: normalizeArchetype(raw.archetype),
    table: normalizeTable(raw.table, sourceAliases),
    chart: normalizeChart(raw.chart, sourceAliases),
  };
}

function normalizePresentationBullets(
  value: unknown,
  sourceAliases: ReadonlyMap<string, string>,
): PresentationBullet[] {
  if (value === undefined || value === null) return [];
  const rawItems = Array.isArray(value) ? value : [value];
  return rawItems.map((item) => normalizeBullet(item, sourceAliases));
}

function normalizeBullet(value: unknown, sourceAliases: ReadonlyMap<string, string>): PresentationBullet {
  if (typeof value === "string") {
    return normalizeRequiredVisibleText(value, "bullet text");
  }
  const raw = safeRecord(value);
  const text = normalizeRequiredVisibleText(raw.text, "bullet text");
  const kind = asNonEmptyString(raw.claimKind);
  if (kind && !CLAIM_KINDS.has(kind as PresentationClaimKind)) {
    throw new Error(`Presentation bullet has an invalid claimKind: ${kind}.`);
  }
  return {
    text,
    claimKind: kind && CLAIM_KINDS.has(kind as PresentationClaimKind) ? (kind as PresentationClaimKind) : undefined,
    sourceIds: normalizeSourceIds(raw.sourceIds, sourceAliases),
  };
}

function normalizeTable(value: unknown, sourceAliases: ReadonlyMap<string, string>): PresentationTable | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw = safeRecord(value);
  const headers = normalizeCells(raw.headers, sourceAliases);
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).map((row) => normalizeCells(row, sourceAliases));
  if (headers.length === 0 || rows.length === 0) {
    throw new Error("Presentation tables require non-empty headers and rows.");
  }
  if (rows.some((row) => row.length !== headers.length)) {
    throw new Error("Each presentation table row must match the header column count.");
  }
  return { headers, rows };
}

function normalizeCells(value: unknown, sourceAliases: ReadonlyMap<string, string>): PresentationTableCell[] {
  if (!Array.isArray(value)) return [];
  return value.map((cell) => {
    if (typeof cell === "string") {
      return { text: normalizeRequiredVisibleText(cell, "table cell") };
    }
    const raw = safeRecord(cell);
    return {
      text: normalizeRequiredVisibleText(raw.text, "table cell"),
      sourceIds: normalizeSourceIds(raw.sourceIds, sourceAliases),
    };
  });
}

function normalizeChart(value: unknown, sourceAliases: ReadonlyMap<string, string>): PresentationChart | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw = safeRecord(value);
  const rawType = asNonEmptyString(raw.type);
  if (rawType !== "bar" && rawType !== "column" && rawType !== "line") {
    throw new Error("Presentation charts require an explicit bar, column, or line type.");
  }
  const type = rawType;
  const categories = normalizeTextArray(raw.categories, "chart category");
  const series = (Array.isArray(raw.series) ? raw.series : []).map((item) => {
    const rawSeries = safeRecord(item);
    return {
      name: normalizeRequiredVisibleText(rawSeries.name, "chart series name"),
      values: (Array.isArray(rawSeries.values) ? rawSeries.values : []).map((entry) => {
        if (typeof entry !== "number" || !Number.isFinite(entry)) {
          throw new Error("Presentation chart values must be finite numbers.");
        }
        return entry;
      }),
      sourceIds: normalizeSourceIds(rawSeries.sourceIds, sourceAliases),
    };
  });
  if (
    categories.length === 0 ||
    series.length === 0 ||
    series.some((item) => item.values.length !== categories.length)
  ) {
    throw new Error("Presentation charts require categories and equally sized numeric series.");
  }
  if (series.some((item) => item.values.some((entry) => !Number.isFinite(entry)))) {
    throw new Error("Presentation chart values must be finite numbers.");
  }
  return { type, categories, series, sourceIds: normalizeSourceIds(raw.sourceIds, sourceAliases) };
}

function paginateBullets(
  bullets: readonly PresentationBullet[],
  archetype: PresentationArchetype | undefined,
): PresentationBullet[][] {
  return paginatePresentationItems(bullets, presentationBulletLayoutText, {
    ...presentationBulletPaginationOptions(archetype),
    authoredTextOf: presentationBulletText,
  });
}

function presentationBulletPaginationOptions(archetype: PresentationArchetype | undefined): {
  maxItems?: number;
  maxLines?: number;
} {
  if (archetype === "section") return { maxItems: 3, maxLines: 4 };
  if (archetype === "closing") return { maxItems: 3, maxLines: 6 };
  return {};
}

function createSourceAppendixSlides(sources: readonly PresentationSource[]): PresentationSlide[] {
  return paginatePresentationSources(
    sources,
    (source) => `${source.publisher}: ${source.title}`,
    (source) => source.url,
  ).map((page, index) => ({
    title: index === 0 ? "Sources" : "Sources — Continued",
    archetype: "sources",
    generatedSourceAppendix: true,
    bullets: page.map((source) => ({
      text: `${source.publisher}: ${source.title} — ${source.url}`,
      claimKind: "fact",
      sourceIds: [source.id],
    })),
  }));
}

function normalizeSourceIds(value: unknown, aliases: ReadonlyMap<string, string>): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const resolved = value.map((item) => {
    const supplied = asNonEmptyString(item);
    const canonical = supplied ? aliases.get(supplied) : undefined;
    if (!canonical) {
      throw new Error(`Presentation claim references an unknown source id: ${supplied ?? "<empty>"}.`);
    }
    return canonical;
  });
  if (new Set(resolved).size !== resolved.length) {
    throw new Error("Presentation claim sourceIds must not contain duplicate canonical source ids.");
  }
  return resolved;
}

function citationLayoutSuffix(sourceIds: readonly string[]): string {
  return sourceIds.map(() => " [S999]").join("");
}

function normalizeArchetype(value: unknown): PresentationArchetype {
  if (value === undefined || value === null || value === "") return "auto";
  const candidate = asNonEmptyString(value) as PresentationArchetype | undefined;
  if (!candidate || !ARCHETYPES.has(candidate)) {
    throw new Error(`Presentation slide has an invalid archetype: ${candidate ?? "<empty>"}.`);
  }
  return candidate;
}

function normalizeSourceRole(value: unknown): PresentationSourceRole {
  const candidate = asNonEmptyString(value) as PresentationSourceRole | undefined;
  if (!candidate || !SOURCE_ROLES.has(candidate)) {
    throw new Error(`Presentation source has an invalid role: ${candidate ?? "<empty>"}.`);
  }
  return candidate;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Presentation source confidence must be a number from 0 through 1.");
  }
  return value;
}

function normalizeOptionalText(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  return raw ? normalizePresentationText(raw) || undefined : undefined;
}

function normalizeTextArray(value: unknown, label = "text array item"): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeRequiredVisibleText(item, label));
}

function normalizeRequiredVisibleText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Presentation ${label} must be a non-empty string.`);
  }
  const normalized = normalizePresentationText(value);
  if (!normalized) {
    throw new Error(`Presentation ${label} must be a non-empty string.`);
  }
  return normalized;
}

function safeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key]) => !["__proto__", "prototype", "constructor"].includes(key),
    ),
  );
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
