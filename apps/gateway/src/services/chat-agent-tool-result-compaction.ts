import type { ChatNormalizationProfile, ChatToolRunRecord, ToolInvokeRequest } from "@goatcitadel/contracts";

const TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES = 12_000;
const TOOL_OUTPUT_INLINE_SUMMARY_CHARS = 1_400;
const TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS = 4_000;
const TOOL_RESULT_AGGREGATE_CONTEXT_BUDGET_BYTES = 80_000;
const TOOL_RESULT_FORCE_ARTIFACT_MIN_BYTES = 2_000;
const QUICK_WEB_SEARCH_RESULT_LIMIT = 3;
const QUICK_WEB_SNIPPET_CHARS = 520;

type ToolSourceAttribution = NonNullable<ToolInvokeRequest["sourceAttribution"]>[number];

export interface PersistableToolArtifactContent {
  readonly content: string;
  readonly contentType?: string;
  readonly snippet: string;
  readonly summary: string;
  readonly virtualized: boolean;
  readonly compactMode: "textual" | "structured";
}

export interface PersistedToolArtifactSummary {
  readonly artifactId: string;
  readonly storageRelPath: string;
  readonly byteLength: number;
  readonly contentType?: string;
  readonly snippet?: string;
  readonly summary: string;
  readonly virtualized: boolean;
  readonly compactMode: "textual" | "structured";
}

export interface ToolArtifactExtractionOptions {
  readonly forceStructuredArtifact?: boolean;
}

export function extractPersistableToolArtifactContent(
  toolName: string,
  result: Record<string, unknown>,
  options: ToolArtifactExtractionOptions = {},
): PersistableToolArtifactContent | undefined {
  if (typeof result.body === "string" && result.body.length > 0) {
    if (
      !options.forceStructuredArtifact &&
      Buffer.byteLength(result.body, "utf8") <= TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES
    ) {
      return undefined;
    }
    return {
      content: result.body,
      contentType: typeof result.contentType === "string" ? result.contentType : undefined,
      snippet:
        typeof result.bodySnippet === "string"
          ? result.bodySnippet.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS)
          : result.body.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS),
      summary: summarizeVirtualizedToolResult(toolName, result),
      virtualized: true,
      compactMode: "textual",
    };
  }
  if (typeof result.text === "string" && result.text.length > 0) {
    if (
      !options.forceStructuredArtifact &&
      Buffer.byteLength(result.text, "utf8") <= TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES
    ) {
      return undefined;
    }
    return {
      content: result.text,
      contentType: "text/plain; charset=utf-8",
      snippet: result.text.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS),
      summary: summarizeVirtualizedToolResult(toolName, result),
      virtualized: true,
      compactMode: "textual",
    };
  }
  const serialized = safeSerializeToolResult(result);
  if (
    !serialized ||
    (!options.forceStructuredArtifact &&
      Buffer.byteLength(serialized, "utf8") <= TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES)
  ) {
    return undefined;
  }
  return {
    content: serialized,
    contentType: "application/json; charset=utf-8",
    snippet: serialized.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS),
    summary: summarizeVirtualizedToolResult(toolName, result),
    virtualized: true,
    compactMode: "structured",
  };
}

export function compactToolResultForExecutionProfile(
  toolName: string,
  result: Record<string, unknown>,
  normalizationProfile: ChatNormalizationProfile | undefined,
): Record<string, unknown> {
  if (normalizationProfile !== "quick_web" || toolName !== "browser.search" || !Array.isArray(result.results)) {
    return result;
  }
  return {
    ...buildCompactToolResultMetadata(result),
    results: result.results.slice(0, QUICK_WEB_SEARCH_RESULT_LIMIT).map(compactQuickWebSearchResult),
    resultCount: result.results.length,
    compactedForProfile: "quick_web",
  };
}

export function shouldPersistToolArtifactForAggregateBudget(input: {
  readonly result?: Record<string, unknown>;
  readonly priorToolRuns: readonly ChatToolRunRecord[];
}): boolean {
  if (!input.result) {
    return false;
  }
  const serialized = safeSerializeToolResult(input.result);
  if (!serialized) {
    return false;
  }
  const currentBytes = Buffer.byteLength(serialized, "utf8");
  if (currentBytes < TOOL_RESULT_FORCE_ARTIFACT_MIN_BYTES) {
    return false;
  }
  return currentBytes + estimatePriorToolResultBytes(input.priorToolRuns) > TOOL_RESULT_AGGREGATE_CONTEXT_BUDGET_BYTES;
}

export function safeSerializeToolResult(result: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return undefined;
  }
}

export function summarizeVirtualizedToolResult(toolName: string, result: Record<string, unknown>): string {
  const candidates = [
    typeof result.message === "string" ? result.message : undefined,
    typeof result.bodySnippet === "string" ? result.bodySnippet : undefined,
    typeof result.textSnippet === "string" ? result.textSnippet : undefined,
    Array.isArray(result.results)
      ? `${result.results.length} result${result.results.length === 1 ? "" : "s"} returned.`
      : undefined,
    typeof result.status === "number" ? `HTTP ${result.status}` : undefined,
  ].filter((value): value is string => Boolean(value && value.trim()));
  if (candidates.length > 0) {
    return candidates.join(" ").slice(0, TOOL_OUTPUT_INLINE_SUMMARY_CHARS);
  }
  return `Stored ${toolName} output as an artifact to keep live context compact.`;
}

export function buildCompactToolResultMetadata(result: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  const scalarKeys = [
    "url",
    "finalUrl",
    "status",
    "httpStatus",
    "message",
    "engineTier",
    "engineLabel",
    "browserFailureClass",
    "title",
    "path",
    "fallbackPath",
    "bytesWritten",
    "format",
    "mimeType",
    "slideCount",
  ] as const;
  for (const key of scalarKeys) {
    const value = result[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      compacted[key] = value;
    }
  }
  if (Array.isArray(result.results)) {
    compacted.resultCount = result.results.length;
  }
  const sourceAttribution = collectCompactSourceAttribution(result);
  if (sourceAttribution.length > 0) {
    compacted.sourceAttribution = sourceAttribution;
  }
  if (Array.isArray(result.fallbackChain) && result.fallbackChain.length > 0) {
    compacted.fallbackChain = result.fallbackChain;
  }
  const localBusinessResearch = compactLocalBusinessResearchRecord(result.localBusinessResearch);
  if (localBusinessResearch) {
    compacted.localBusinessResearch = localBusinessResearch;
  }
  const renderManifest = compactPresentationRenderManifest(result.renderManifest);
  if (renderManifest) {
    compacted.renderManifest = renderManifest;
  }
  const packageAudit = compactPresentationPackageAudit(result.packageAudit);
  if (packageAudit) {
    compacted.packageAudit = packageAudit;
  }
  return compacted;
}

function compactPresentationRenderManifest(value: unknown): Record<string, unknown> | undefined {
  const record = toPlainRecord(value);
  if (!record || readCount(record.slideCount) === undefined) {
    return undefined;
  }
  return compactDefinedRecord({
    slideCount: readCount(record.slideCount),
    contentSlideCount: readCount(record.contentSlideCount),
    layoutCounts: compactCountMap(record.layoutCounts),
    minimumFontSize: readNumber(record.minimumFontSize),
    minimumTitleFontSize: readNumber(record.minimumTitleFontSize),
    minimumBodyFontSize: readNumber(record.minimumBodyFontSize),
    minimumTableFontSize: readNumber(record.minimumTableFontSize),
    minimumSourceFontSize: readNumber(record.minimumSourceFontSize),
    minimumCitationFontSize: readNumber(record.minimumCitationFontSize),
    minimumSlideNumberFontSize: readNumber(record.minimumSlideNumberFontSize),
    hyperlinkCount: readCount(record.hyperlinkCount),
    sourceCount: readCount(record.sourceCount),
    tableCount: readCount(record.tableCount),
    chartCount: readCount(record.chartCount),
    continuationCount: readCount(record.continuationCount),
    visualCount: readCount(record.visualCount),
    authoredNoteCount: readCount(record.authoredNoteCount),
  });
}

function compactPresentationPackageAudit(value: unknown): Record<string, unknown> | undefined {
  const record = toPlainRecord(value);
  if (!record || typeof record.passed !== "boolean") {
    return undefined;
  }
  const observed = toPlainRecord(record.observed);
  return compactDefinedRecord({
    passed: record.passed,
    findingCount: Array.isArray(record.findings) ? record.findings.length : undefined,
    observed: observed
      ? compactDefinedRecord({
          slideCount: readCount(observed.slideCount),
          hyperlinkCount: readCount(observed.hyperlinkCount),
          uniqueHyperlinkTargetCount: readCount(observed.uniqueHyperlinkTargetCount),
          tableCount: readCount(observed.tableCount),
          chartCount: readCount(observed.chartCount),
          pictureCount: readCount(observed.pictureCount),
          authoredNoteCount: readCount(observed.authoredNoteCount),
          layoutCounts: compactCountMap(observed.layoutCounts),
        })
      : undefined,
  });
}

function compactCountMap(value: unknown): Record<string, number> | undefined {
  const record = toPlainRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .filter(([key, count]) => key.length > 0 && key.length <= 80 && readCount(count) !== undefined)
    .slice(0, 32)
    .map(([key, count]) => [key, readCount(count) as number]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function compactLocalBusinessResearchRecord(value: unknown): Record<string, unknown> | undefined {
  const record = toPlainRecord(value);
  if (!record || record.kind !== "local_business_contact_research") {
    return undefined;
  }
  return {
    kind: record.kind,
    workflow: record.workflow === "local_business.research" ? record.workflow : undefined,
    plan: compactLocalBusinessPlan(record.plan),
    stages: compactLocalBusinessStages(record.stages),
    candidates: compactLocalBusinessCandidates(record.candidates),
    excluded: compactLocalBusinessExcluded(record.excluded),
    blockers: readStringArray(record.blockers).slice(0, 20),
    verificationNote:
      typeof record.verificationNote === "string" && record.verificationNote.trim()
        ? record.verificationNote.trim().slice(0, 800)
        : undefined,
  };
}

function compactQuickWebSearchResult(value: unknown): Record<string, unknown> {
  const record = toPlainRecord(value);
  if (!record) {
    return {};
  }
  return compactDefinedRecord({
    title: readString(record.title)?.slice(0, 180),
    url: readString(record.url) ?? readString(record.link),
    snippet: (readString(record.snippet) ?? readString(record.description) ?? readString(record.text))?.slice(
      0,
      QUICK_WEB_SNIPPET_CHARS,
    ),
    publishedAt: readString(record.publishedAt) ?? readString(record.date),
    source: readString(record.source) ?? readString(record.siteName),
  });
}

function estimatePriorToolResultBytes(priorToolRuns: readonly ChatToolRunRecord[]): number {
  let total = 0;
  for (const run of priorToolRuns) {
    if (!run.result) {
      continue;
    }
    const serialized = safeSerializeToolResult(run.result);
    if (serialized) {
      total += Buffer.byteLength(serialized, "utf8");
    }
  }
  return total;
}

function compactLocalBusinessPlan(value: unknown): Record<string, unknown> | undefined {
  const record = toPlainRecord(value);
  if (!record) {
    return undefined;
  }
  return compactDefinedRecord({
    location: readString(record.location),
    radiusMiles: readNumber(record.radiusMiles),
    categories: readStringArray(record.categories).slice(0, 8),
    requireEmail: typeof record.requireEmail === "boolean" ? record.requireEmail : undefined,
    requireContactName: typeof record.requireContactName === "boolean" ? record.requireContactName : undefined,
  });
}

function compactLocalBusinessStages(value: unknown): Record<string, unknown>[] {
  return readRecordArray(value)
    .slice(0, 8)
    .map((stage) =>
      compactDefinedRecord({
        name: readString(stage.name),
        status: readString(stage.status),
        summary: readString(stage.summary)?.slice(0, 500),
        resultCount: readNumber(stage.resultCount),
        candidateCount: readNumber(stage.candidateCount),
        excludedCount: readNumber(stage.excludedCount),
        sourceUrls: readStringArray(stage.sourceUrls).filter(isHttpUrl).slice(0, 10),
        blockers: readStringArray(stage.blockers).slice(0, 10),
      }),
    );
}

function compactLocalBusinessCandidates(value: unknown): Record<string, unknown>[] {
  return readRecordArray(value)
    .slice(0, 20)
    .map((candidate) =>
      compactDefinedRecord({
        storeName: readString(candidate.storeName),
        address: readString(candidate.address),
        distanceMiles: readNumber(candidate.distanceMiles),
        category: readString(candidate.category),
        website: readString(candidate.website),
        email: readString(candidate.email),
        contactName: readString(candidate.contactName),
        contactRole: readString(candidate.contactRole),
        sourceUrls: readStringArray(candidate.sourceUrls).filter(isHttpUrl).slice(0, 12),
        confidence: readString(candidate.confidence),
        verificationStatus: readString(candidate.verificationStatus),
        blockers: readStringArray(candidate.blockers).slice(0, 12),
        evidence: compactLocalBusinessEvidence(candidate.evidence),
      }),
    );
}

function compactLocalBusinessEvidence(value: unknown): Record<string, unknown>[] {
  return readRecordArray(value)
    .slice(0, 16)
    .map((evidence) =>
      compactDefinedRecord({
        url: readString(evidence.url),
        title: readString(evidence.title)?.slice(0, 240),
        snippet: readString(evidence.snippet)?.slice(0, 500),
        evidenceKind: readString(evidence.evidenceKind),
        confidence: readString(evidence.confidence),
      }),
    );
}

function compactLocalBusinessExcluded(value: unknown): Record<string, unknown>[] {
  return readRecordArray(value)
    .slice(0, 20)
    .map((excluded) =>
      compactDefinedRecord({
        reason: readString(excluded.reason),
        sourceUrl: readString(excluded.sourceUrl),
        title: readString(excluded.title)?.slice(0, 240),
      }),
    );
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(toPlainRecord(item)))
    : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactDefinedRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === undefined) {
        return false;
      }
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return true;
    }),
  );
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function collectCompactSourceAttribution(result: Record<string, unknown>): ToolSourceAttribution[] {
  const attributions: ToolSourceAttribution[] = [];
  appendAttribution(result.attribution, attributions);
  for (const value of Array.isArray(result.sourceAttribution) ? result.sourceAttribution : []) {
    appendAttribution(value, attributions);
  }
  appendAttribution(toPlainRecord(result.document)?.attribution, attributions);
  for (const key of ["items", "chunks"] as const) {
    const items = Array.isArray(result[key]) ? result[key] : [];
    for (const item of items) {
      appendAttribution(toPlainRecord(item)?.attribution, attributions);
    }
  }
  const seen = new Set<string>();
  return attributions.filter((attribution) => {
    const key = [
      attribution.sourceType,
      attribution.sourceRef,
      attribution.trustLevel ?? "",
      attribution.backend ?? "",
      attribution.title ?? "",
    ].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function appendAttribution(value: unknown, output: ToolSourceAttribution[]): void {
  const attribution = normalizeAttribution(value);
  if (attribution) {
    output.push(attribution);
  }
}

function normalizeAttribution(value: unknown): ToolSourceAttribution | undefined {
  const record = toPlainRecord(value);
  if (!record) {
    return undefined;
  }
  const sourceType = readSourceType(record.sourceType);
  const sourceRef =
    typeof record.sourceRef === "string" && record.sourceRef.trim() ? record.sourceRef.trim() : undefined;
  if (!sourceType || !sourceRef) {
    return undefined;
  }
  const trustLevel = readTrustLevel(record.trustLevel);
  return {
    sourceType,
    sourceRef,
    ...(typeof record.title === "string" && record.title.trim() ? { title: record.title.trim() } : {}),
    ...(record.backend === "native" || record.backend === "firecrawl" ? { backend: record.backend } : {}),
    ...(typeof record.fetchedAt === "string" && record.fetchedAt.trim() ? { fetchedAt: record.fetchedAt.trim() } : {}),
    ...(trustLevel ? { trustLevel } : {}),
  };
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readSourceType(value: unknown): ToolSourceAttribution["sourceType"] | undefined {
  return value === "file" || value === "url" || value === "text" || value === "memory" || value === "mcp"
    ? value
    : undefined;
}

function readTrustLevel(value: unknown): ToolSourceAttribution["trustLevel"] | undefined {
  return value === "trusted_operator" ||
    value === "trusted_workspace" ||
    value === "mixed_untrusted" ||
    value === "untrusted_external"
    ? value
    : undefined;
}

export function compactToolResultForTurn(
  result: Record<string, unknown>,
  artifact: PersistedToolArtifactSummary,
): Record<string, unknown> {
  const resultText = typeof result.text === "string" ? result.text : undefined;
  const resultBodySnippet = typeof result.bodySnippet === "string" ? result.bodySnippet : undefined;
  const compacted: Record<string, unknown> = {
    ...(artifact.compactMode === "structured" ? buildCompactToolResultMetadata(result) : result),
    artifactId: artifact.artifactId,
    artifactPath: artifact.storageRelPath,
    byteLength: artifact.byteLength,
    originalByteLength: artifact.byteLength,
    contentType: artifact.contentType ?? result.contentType,
    snippet: artifact.snippet ?? resultBodySnippet ?? resultText?.slice(0, 4000),
    artifactSummary: artifact.summary,
    virtualized: artifact.virtualized,
    storedAsArtifact: true,
  };
  if ("body" in compacted) {
    delete (compacted as { body?: unknown }).body;
  }
  if (resultText && resultText.length > 4000) {
    compacted.text = resultText.slice(0, 4000);
  }
  if (artifact.compactMode === "structured" && "text" in compacted) {
    delete (compacted as { text?: unknown }).text;
  }
  if (!("bodySnippet" in compacted) && typeof compacted.snippet === "string") {
    compacted.bodySnippet = compacted.snippet;
  }
  return compacted;
}
