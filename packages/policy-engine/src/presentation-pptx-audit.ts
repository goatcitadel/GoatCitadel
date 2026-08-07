import { inflateRawSync } from "node:zlib";
import { posix as pathPosix } from "node:path";
import { paginatePresentationSources } from "./presentation-capacity.js";
import {
  presentationCapacityFindings,
  presentationBulletText,
  type PresentationRenderManifest,
  type PresentationSlide,
  type PresentationSource,
} from "./presentation-model.js";

export type PresentationPackageRenderer = "pptxgenjs" | "fallback";

export interface PresentationPackageAuditExpectation {
  title: string;
  subtitle?: string;
  slides: readonly PresentationSlide[];
  sources: readonly PresentationSource[];
  manifest: PresentationRenderManifest;
  renderer: PresentationPackageRenderer;
}

export interface PresentationPackageAuditFinding {
  id: string;
  message: string;
  repairable: boolean;
}

export interface PresentationPackageAuditObserved {
  slideCount: number;
  hyperlinkCount: number;
  uniqueHyperlinkTargetCount: number;
  tableCount: number;
  chartCount: number;
  pictureCount: number;
  authoredNoteCount: number;
  layoutCounts: Record<string, number>;
}

export interface PresentationPackageAuditReport {
  passed: boolean;
  findings: PresentationPackageAuditFinding[];
  observed: PresentationPackageAuditObserved;
}

export type PresentationPackageAuditor = (
  buffer: Buffer,
  expectation: PresentationPackageAuditExpectation,
) => PresentationPackageAuditReport | Promise<PresentationPackageAuditReport>;

interface ZipDirectoryEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

const EMPTY_OBSERVED: PresentationPackageAuditObserved = {
  slideCount: 0,
  hyperlinkCount: 0,
  uniqueHyperlinkTargetCount: 0,
  tableCount: 0,
  chartCount: 0,
  pictureCount: 0,
  authoredNoteCount: 0,
  layoutCounts: {},
};

const ROLE_FLOORS: ReadonlyArray<{ prefix: string; points: number }> = [
  { prefix: "gc:title", points: 28 },
  { prefix: "gc:subtitle", points: 18 },
  { prefix: "gc:body", points: 16 },
  { prefix: "gc:table", points: 14 },
  { prefix: "gc:chart-label", points: 14 },
  { prefix: "gc:source", points: 12 },
  { prefix: "gc:citation", points: 11 },
  { prefix: "gc:slide-number", points: 10 },
];
const EMUS_PER_POINT = 12_700;
const AVERAGE_GLYPH_WIDTH_EM = 0.48;
const BODY_LINE_HEIGHT_MULTIPLIER = 1.2;
const BODY_PARAGRAPH_GAP_POINTS = 6;

export function auditPresentationPptxPackage(
  buffer: Buffer,
  expectation: PresentationPackageAuditExpectation,
): PresentationPackageAuditReport {
  const findings: PresentationPackageAuditFinding[] = [];
  let entries: ReadonlyMap<string, Buffer>;
  try {
    entries = readPresentationZipEntries(buffer);
  } catch (error) {
    return {
      passed: false,
      findings: [
        finding(
          "package-unreadable",
          `The rendered PPTX package could not be read: ${error instanceof Error ? error.message : "unknown ZIP error"}.`,
          true,
        ),
      ],
      observed: { ...EMPTY_OBSERVED },
    };
  }

  const slideEntries = sortedXmlEntries(entries, /^ppt\/slides\/slide(\d+)\.xml$/u);
  const slideXml = slideEntries.map(([, data]) => data.toString("utf8"));
  const relationshipEntries = sortedXmlEntries(entries, /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/u);
  const relationshipXml = relationshipEntries.map(([, data]) => data.toString("utf8"));
  const noteEntries = sortedXmlEntries(entries, /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/u);
  const noteXml = noteEntries.map(([, data]) => data.toString("utf8"));
  const chartEntries = sortedXmlEntries(entries, /^ppt\/charts\/chart(\d+)\.xml$/u);
  const chartXml = chartEntries.map(([, data]) => data.toString("utf8"));
  const slideVisibleText = collectSlideVisibleText(entries, slideEntries);
  const packageText = normalizeAuditText(
    [...slideXml, ...chartXml].flatMap(extractXmlText).concat(chartXml.flatMap(extractChartValues)).join(" "),
  );
  const hyperlinks = collectHyperlinks(slideXml, relationshipXml, findings);
  const layoutCounts = collectLayoutCounts(slideXml);
  const tableCount = countMatches(slideXml, /<a:tbl(?:\s|>)/gu);
  const chartCount = chartEntries.length;
  const pictureCount = countMatches(slideXml, /<p:pic(?:\s|>)/gu);
  const authoredNoteCount = countAuthoredNotes(expectation.slides, noteXml, findings);
  const observed: PresentationPackageAuditObserved = {
    slideCount: slideEntries.length,
    hyperlinkCount: hyperlinks.occurrences,
    uniqueHyperlinkTargetCount: hyperlinks.targets.size,
    tableCount,
    chartCount,
    pictureCount,
    authoredNoteCount,
    layoutCounts,
  };

  auditManifestAgreement(expectation, observed, findings);
  auditVisibleText(expectation, slideVisibleText, findings);
  auditCoverSubtitleRole(expectation, slideXml, findings);
  auditSemanticFonts(slideXml, findings);
  auditAutofit(slideXml, findings);
  auditTextBoxGeometry(slideXml, findings);
  auditSourceCoverage(expectation.sources, hyperlinks.targets, findings);
  auditNotesCleanliness(noteXml, findings);
  auditPagination(expectation.slides, findings);
  auditLayoutRhythm(expectation.slides, slideXml, findings);
  auditFallbackChartParity(expectation, packageText, observed, findings);

  return { passed: findings.length === 0, findings, observed };
}

export function readPresentationZipEntries(buffer: Buffer): ReadonlyMap<string, Buffer> {
  const directory = readCentralDirectory(buffer);
  const entries = new Map<string, Buffer>();
  for (const item of directory) {
    if (buffer.readUInt32LE(item.localOffset) !== 0x04034b50) {
      throw new Error(`Invalid local ZIP header for ${item.name}`);
    }
    const nameLength = buffer.readUInt16LE(item.localOffset + 26);
    const extraLength = buffer.readUInt16LE(item.localOffset + 28);
    const dataOffset = item.localOffset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + item.compressedSize);
    const data =
      item.method === 0 ? Buffer.from(compressed) : item.method === 8 ? inflateRawSync(compressed) : undefined;
    if (!data) {
      throw new Error(`Unsupported ZIP compression method ${item.method} for ${item.name}`);
    }
    if (data.length !== item.uncompressedSize) {
      throw new Error(`ZIP entry length mismatch for ${item.name}`);
    }
    entries.set(item.name, data);
  }
  return entries;
}

function readCentralDirectory(buffer: Buffer): ZipDirectoryEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries: ZipDirectoryEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Invalid ZIP central-directory header");
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({
      name,
      method: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localOffset: buffer.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("ZIP end-of-central-directory record was not found");
}

function sortedXmlEntries(entries: ReadonlyMap<string, Buffer>, pattern: RegExp): Array<[string, Buffer]> {
  return [...entries.entries()]
    .map(([name, data]) => ({ name, data, match: pattern.exec(name) }))
    .filter((item): item is { name: string; data: Buffer; match: RegExpExecArray } => Boolean(item.match))
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map(({ name, data }) => [name, data]);
}

function collectHyperlinks(
  slides: readonly string[],
  relationships: readonly string[],
  findings: PresentationPackageAuditFinding[],
): { occurrences: number; targets: Set<string> } {
  let occurrences = 0;
  const targets = new Set<string>();
  slides.forEach((xml, index) => {
    const ids = [...xml.matchAll(/<a:hlinkClick\b[^>]*\br:id="([^"]+)"/gu)].map((match) => match[1] ?? "");
    occurrences += ids.length;
    const rels = new Map<string, string>();
    for (const match of (relationships[index] ?? "").matchAll(/<Relationship\b([^>]*)\/>/gu)) {
      const attributes = parseXmlAttributes(match[1] ?? "");
      if (attributes.Type?.endsWith("/hyperlink") && attributes.TargetMode === "External") {
        rels.set(attributes.Id ?? "", decodeXml(attributes.Target ?? ""));
      }
    }
    for (const id of ids) {
      const target = rels.get(id);
      if (!target) {
        findings.push(
          finding("hyperlink-dangling", `Slide ${index + 1} has a dangling hyperlink relationship ${id}.`, true),
        );
        continue;
      }
      if (!isSafeHyperlink(target)) {
        findings.push(finding("hyperlink-invalid", `Slide ${index + 1} has an invalid hyperlink target.`, true));
        continue;
      }
      targets.add(target);
    }
  });
  return { occurrences, targets };
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/\b([A-Za-z_:][\w:.-]*)="([^"]*)"/gu)) {
    attributes[match[1] ?? ""] = match[2] ?? "";
  }
  return attributes;
}

function auditManifestAgreement(
  expectation: PresentationPackageAuditExpectation,
  observed: PresentationPackageAuditObserved,
  findings: PresentationPackageAuditFinding[],
): void {
  const manifest = expectation.manifest;
  compareCount("manifest-slide-count", "slide", manifest.slideCount, observed.slideCount, findings);
  compareCount(
    "manifest-hyperlink-count",
    "hyperlink occurrence",
    manifest.hyperlinkCount,
    observed.hyperlinkCount,
    findings,
  );
  const expectedTables = manifest.tableCount + (expectation.renderer === "fallback" ? manifest.chartCount : 0);
  compareCount("manifest-table-count", "table", expectedTables, observed.tableCount, findings);
  compareCount(
    "manifest-chart-count",
    "chart",
    expectation.renderer === "fallback" ? 0 : manifest.chartCount,
    observed.chartCount,
    findings,
  );
  compareCount(
    "manifest-note-count",
    "authored note",
    manifest.authoredNoteCount,
    observed.authoredNoteCount,
    findings,
  );
  const visualCount = observed.pictureCount + observed.tableCount + observed.chartCount;
  compareCount("manifest-visual-count", "visual", manifest.visualCount, visualCount, findings);
  const expectedLayouts = normalizeCountMap(manifest.layoutCounts);
  const observedLayouts = normalizeCountMap(observed.layoutCounts);
  if (JSON.stringify(expectedLayouts) !== JSON.stringify(observedLayouts)) {
    findings.push(finding("manifest-layout-counts", "Layout signatures do not agree with the render manifest.", true));
  }
}

function auditVisibleText(
  expectation: PresentationPackageAuditExpectation,
  slideVisibleText: readonly (readonly string[])[],
  findings: PresentationPackageAuditFinding[],
): void {
  const sourcePages = expectedSourceAppendixPages(expectation.sources, findings);
  const expectedSourcePageCount = sourcePages.length;
  const sourcePageCount = expectation.slides.filter((slide) => slide.generatedSourceAppendix).length;
  if (sourcePageCount !== expectedSourcePageCount) {
    findings.push(
      finding(
        "visible-text-loss",
        `Source appendix pagination expects ${expectedSourcePageCount} slide(s), but the prepared deck contains ${sourcePageCount}.`,
        true,
      ),
    );
  }
  const expectedBySlide = expectedVisibleTextBySlide(expectation, sourcePages);
  expectedBySlide.forEach((expected, slideIndex) => {
    const expectedCounts = normalizedTextCounts(expected);
    const observedCounts = normalizedTextCounts(slideVisibleText[slideIndex] ?? []);
    for (const [text, expectedCount] of expectedCounts) {
      const observedCount = observedCounts.get(text) ?? 0;
      if (observedCount < expectedCount) {
        findings.push(
          finding(
            "visible-text-loss",
            `Slide ${slideIndex + 1} is missing ${expectedCount - observedCount} occurrence(s) of visible text: ${auditLabel(text)}.`,
            true,
          ),
        );
      }
    }
  });
}

function expectedVisibleTextBySlide(
  expectation: PresentationPackageAuditExpectation,
  sourcePages: readonly (readonly PresentationSource[])[],
): string[][] {
  let sourcePageIndex = 0;
  return [
    [expectation.title, expectation.subtitle].filter((value): value is string => Boolean(value?.trim())),
    ...expectation.slides.map((slide) => {
      let bulletText: string[];
      if (slide.generatedSourceAppendix) {
        const pageSources = sourcePages[sourcePageIndex] ?? [];
        sourcePageIndex += 1;
        bulletText = expectedSourceAppendixText(pageSources, expectation.renderer);
      } else {
        bulletText = slide.bullets.map(presentationBulletText);
      }
      return [
        slide.title,
        ...bulletText,
        ...(slide.table ? [...slide.table.headers, ...slide.table.rows.flat()].map((cell) => cell.text) : []),
        ...(slide.chart
          ? [
              ...slide.chart.categories,
              ...slide.chart.series.flatMap((series) => [series.name, ...series.values.map(String)]),
            ]
          : []),
      ];
    }),
  ];
}

function expectedSourceAppendixPages(
  sources: readonly PresentationSource[],
  findings: PresentationPackageAuditFinding[],
): PresentationSource[][] {
  try {
    return paginatePresentationSources(
      sources,
      (source) => `${source.publisher}: ${source.title}`,
      (source) => source.url,
    );
  } catch (error) {
    findings.push(
      finding(
        "content-overflow",
        error instanceof Error ? error.message : "Source appendix content cannot fit at the typography floor.",
        true,
      ),
    );
    return sources.length > 0 ? [[...sources]] : [];
  }
}

function expectedSourceAppendixText(
  sources: readonly PresentationSource[],
  renderer: PresentationPackageRenderer,
): string[] {
  if (renderer === "fallback") {
    return sources.map((source) => `${source.publisher}: ${source.title} — ${source.url}`);
  }
  return sources.flatMap((source) => [`${source.publisher}: ${source.title}`, source.url]);
}

function normalizedTextCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = normalizeAuditText(value);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function collectSlideVisibleText(
  entries: ReadonlyMap<string, Buffer>,
  slideEntries: readonly (readonly [string, Buffer])[],
): string[][] {
  return slideEntries.map(([slideName, data]) => {
    const slideXml = data.toString("utf8");
    const values = extractXmlText(slideXml);
    for (const block of extractShapeBlocks(slideXml)) {
      const name = decodeXml(block.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/u)?.[1] ?? "");
      if (!/^gc:(?:title|subtitle)$/u.test(name)) continue;
      const parts = extractXmlText(block).map(normalizeAuditText).filter(Boolean);
      if (parts.length > 1) {
        values.push(parts.join(" "));
      }
    }
    const slideNumber = slideName.match(/^ppt\/slides\/slide(\d+)\.xml$/u)?.[1];
    const relationships = slideNumber
      ? entries.get(`ppt/slides/_rels/slide${slideNumber}.xml.rels`)?.toString("utf8")
      : undefined;
    if (relationships) {
      for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gu)) {
        const attributes = parseXmlAttributes(match[1] ?? "");
        if (!attributes.Type?.endsWith("/chart") || !attributes.Target) continue;
        const target = resolveRelatedPart(slideName, decodeXml(attributes.Target));
        const chart = target ? entries.get(target)?.toString("utf8") : undefined;
        if (chart) {
          values.push(...extractXmlText(chart), ...extractChartValues(chart));
        }
      }
    }
    return values.map(normalizeAuditText).filter(Boolean);
  });
}

function resolveRelatedPart(sourceName: string, target: string): string | undefined {
  if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) return undefined;
  const normalized = pathPosix.normalize(
    target.startsWith("/") ? target.slice(1) : pathPosix.join(pathPosix.dirname(sourceName), target),
  );
  return normalized === ".." || normalized.startsWith("../") ? undefined : normalized;
}

function auditSemanticFonts(slides: readonly string[], findings: PresentationPackageAuditFinding[]): void {
  slides.forEach((xml, slideIndex) => {
    for (const block of extractShapeBlocks(xml)) {
      const name = decodeXml(block.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/u)?.[1] ?? "");
      const role = ROLE_FLOORS.find((item) => name.startsWith(item.prefix));
      if (!role) continue;
      const bodyRuns = name.startsWith("gc:body")
        ? [...block.matchAll(/<a:r(?:\s|>)[\s\S]*?<\/a:r>/gu)]
            .map((match) => match[0])
            .filter((run) => !/<a:hlinkClick\b/u.test(run))
        : [];
      const fontScope = name.startsWith("gc:body") && bodyRuns.length > 0 ? bodyRuns.join("") : block;
      const sizes = [...fontScope.matchAll(/\bsz="(\d+)"/gu)].map((match) => Number(match[1]) / 100);
      if (sizes.length === 0) {
        findings.push(
          finding("semantic-font-missing", `Slide ${slideIndex + 1} role ${name} has no explicit font size.`, true),
        );
        continue;
      }
      const floor = slideIndex === 0 && name === "gc:title" ? 34 : role.points;
      if (Math.min(...sizes) < floor) {
        findings.push(
          finding("semantic-font-floor", `Slide ${slideIndex + 1} role ${name} falls below ${floor} pt.`, true),
        );
      }
    }
  });
}

function auditCoverSubtitleRole(
  expectation: PresentationPackageAuditExpectation,
  slides: readonly string[],
  findings: PresentationPackageAuditFinding[],
): void {
  if (!expectation.subtitle?.trim()) return;
  const hasSemanticSubtitle = extractShapeBlocks(slides[0] ?? "").some((block) => {
    const name = decodeXml(block.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/u)?.[1] ?? "");
    return name === "gc:subtitle";
  });
  if (!hasSemanticSubtitle) {
    findings.push(
      finding("semantic-subtitle-missing", "The cover subtitle is not rendered with the gc:subtitle role.", true),
    );
  }
}

function auditAutofit(slides: readonly string[], findings: PresentationPackageAuditFinding[]): void {
  slides.forEach((xml, slideIndex) => {
    for (const block of extractShapeBlocks(xml)) {
      const name = decodeXml(block.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/u)?.[1] ?? "");
      if (/^gc:(?:body|table|source)/u.test(name) && /<a:normAutofit(?:\s|\/|>)/u.test(block)) {
        findings.push(finding("body-shrink-to-fit", `Slide ${slideIndex + 1} role ${name} uses shrink-to-fit.`, true));
      }
    }
  });
}

function auditTextBoxGeometry(slides: readonly string[], findings: PresentationPackageAuditFinding[]): void {
  slides.forEach((xml, slideIndex) => {
    for (const block of extractShapeBlocks(xml)) {
      const name = decodeXml(block.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/u)?.[1] ?? "");
      if (!name.startsWith("gc:body")) continue;
      const extent = block.match(/<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/u);
      if (!extent) continue;
      const bodyAttributes = parseXmlAttributes(block.match(/<a:bodyPr\b([^>]*)/u)?.[1] ?? "");
      const widthPoints =
        (Number(extent[1]) - numericAttribute(bodyAttributes, "lIns") - numericAttribute(bodyAttributes, "rIns")) /
        EMUS_PER_POINT;
      const heightPoints =
        (Number(extent[2]) - numericAttribute(bodyAttributes, "tIns") - numericAttribute(bodyAttributes, "bIns")) /
        EMUS_PER_POINT;
      if (!(widthPoints > 0) || !(heightPoints > 0)) continue;
      const paragraphs = [...block.matchAll(/<a:p(?:\s|>)[\s\S]*?<\/a:p>/gu)]
        .map((match) => estimateParagraphHeight(match[0], widthPoints))
        .filter((height): height is number => height !== undefined);
      if (paragraphs.length === 0) continue;
      const requiredHeight =
        paragraphs.reduce((total, height) => total + height, 0) +
        Math.max(0, paragraphs.length - 1) * BODY_PARAGRAPH_GAP_POINTS;
      if (requiredHeight > heightPoints + 1) {
        findings.push(
          finding(
            "text-box-overflow",
            `Slide ${slideIndex + 1} role ${name} requires an estimated ${requiredHeight.toFixed(1)} pt of vertical space in a ${heightPoints.toFixed(1)} pt box.`,
            true,
          ),
        );
      }
    }
  });
}

function estimateParagraphHeight(paragraphXml: string, widthPoints: number): number | undefined {
  const text = normalizeAuditText(extractXmlText(paragraphXml).join(""));
  if (!text) return undefined;
  const fontPoints = Math.max(
    1,
    ...[...paragraphXml.matchAll(/\bsz="(\d+)"/gu)].map((match) => Number(match[1]) / 100),
  );
  const charactersPerLine = Math.max(1, Math.floor(widthPoints / (fontPoints * AVERAGE_GLYPH_WIDTH_EM)));
  const wrappedLines = Math.max(1, Math.ceil(text.length / charactersPerLine));
  const explicitBreaks = [...paragraphXml.matchAll(/<a:br(?:\s|\/|>)/gu)].length;
  return (wrappedLines + explicitBreaks) * fontPoints * BODY_LINE_HEIGHT_MULTIPLIER;
}

function numericAttribute(attributes: Readonly<Record<string, string>>, name: string): number {
  const value = Number(attributes[name] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function auditSourceCoverage(
  sources: readonly PresentationSource[],
  targets: ReadonlySet<string>,
  findings: PresentationPackageAuditFinding[],
): void {
  for (const source of sources) {
    if (!targets.has(source.url)) {
      findings.push(finding("source-link-missing", `Source ${source.id} has no clickable hyperlink occurrence.`, true));
    }
  }
}

function countAuthoredNotes(
  slides: readonly PresentationSlide[],
  notes: readonly string[],
  findings: PresentationPackageAuditFinding[],
): number {
  const noteText = notes.map((xml) => normalizeAuditText(extractXmlText(xml).join(" ")));
  const unmatched = new Set(noteText.map((_, index) => index));
  let matched = 0;
  for (const slide of slides) {
    const authored = slide.speakerNotes?.trim();
    if (!authored) continue;
    const matchIndex = [...unmatched].find((index) => noteText[index]?.includes(normalizeAuditText(authored)));
    if (matchIndex === undefined) {
      findings.push(
        finding("authored-note-missing", `Authored notes for ${auditLabel(slide.title)} are missing.`, true),
      );
    } else {
      unmatched.delete(matchIndex);
      matched += 1;
    }
  }
  return matched;
}

function auditNotesCleanliness(notes: readonly string[], findings: PresentationPackageAuditFinding[]): void {
  const text = normalizeAuditText(notes.flatMap(extractXmlText).join(" "));
  if (
    /(?:\brevised prompt\b|\bsourceModel\b|\bprovider metadata\b|\bdesign provenance\b|\blayout decision\b|\bimage prompt\b|\basset provenance\b|\brenderer assets used\b|\bdensity\s*=|\bpromptSha256\b|\bprovider\s*=|\bsource model\s*=)/iu.test(
      text,
    )
  ) {
    findings.push(
      finding("notes-internal-metadata", "Presenter notes contain internal render or provider metadata.", true),
    );
  }
}

function auditPagination(slides: readonly PresentationSlide[], findings: PresentationPackageAuditFinding[]): void {
  presentationCapacityFindings(slides, []).forEach((detail) => {
    findings.push(finding("content-overflow", detail, true));
  });
}

function auditLayoutRhythm(
  slides: readonly PresentationSlide[],
  slideXml: readonly string[],
  findings: PresentationPackageAuditFinding[],
): void {
  const layouts = slideXml.map((xml) => decodeXml(xml.match(/<p:cNvPr\b[^>]*\bname="gc:layout:([^"]+)"/u)?.[1] ?? ""));
  let previous: string | undefined;
  let repeated = 0;
  layouts.slice(1).forEach((layout, index) => {
    if (slides[index]?.generatedSourceAppendix) {
      previous = undefined;
      repeated = 0;
      return;
    }
    if (!layout) return;
    repeated = layout === previous ? repeated + 1 : 1;
    if (repeated > 2) {
      findings.push(
        finding(
          "layout-repetition",
          `Slide ${index + 2} repeats analytical layout ${layout} more than twice consecutively.`,
          true,
        ),
      );
    }
    previous = layout;
  });
}

function auditFallbackChartParity(
  expectation: PresentationPackageAuditExpectation,
  packageText: string,
  observed: PresentationPackageAuditObserved,
  findings: PresentationPackageAuditFinding[],
): void {
  if (expectation.renderer !== "fallback" || expectation.manifest.chartCount === 0) return;
  if (
    !packageText.includes(normalizeAuditText("Chart unavailable in compatibility renderer; data shown as a table."))
  ) {
    findings.push(
      finding("fallback-chart-warning", "Fallback chart data does not include the required visible warning.", true),
    );
  }
  if (observed.tableCount < expectation.manifest.tableCount + expectation.manifest.chartCount) {
    findings.push(
      finding("fallback-chart-table", "Fallback chart data was not preserved as a labeled data table.", true),
    );
  }
}

function collectLayoutCounts(slides: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const xml of slides) {
    for (const match of xml.matchAll(/<p:cNvPr\b[^>]*\bname="gc:layout:([^"]+)"/gu)) {
      const name = decodeXml(match[1] ?? "");
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

function extractShapeBlocks(xml: string): string[] {
  return [
    ...xml.matchAll(/<p:sp(?:\s|>)[\s\S]*?<\/p:sp>/gu),
    ...xml.matchAll(/<p:graphicFrame(?:\s|>)[\s\S]*?<\/p:graphicFrame>/gu),
  ].map((match) => match[0]);
}

function extractXmlText(xml: string): string[] {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map((match) => decodeXml(match[1] ?? ""));
}

function extractChartValues(xml: string): string[] {
  return [...xml.matchAll(/<c:v>([\s\S]*?)<\/c:v>/gu)].map((match) => decodeXml(match[1] ?? ""));
}

function countMatches(values: readonly string[], pattern: RegExp): number {
  return values.reduce((count, value) => count + [...value.matchAll(pattern)].length, 0);
}

function compareCount(
  id: string,
  label: string,
  expected: number,
  actual: number,
  findings: PresentationPackageAuditFinding[],
): void {
  if (expected !== actual) {
    findings.push(
      finding(id, `Render manifest expects ${expected} ${label}(s), but the package contains ${actual}.`, true),
    );
  }
}

function normalizeCountMap(value: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function finding(id: string, message: string, repairable: boolean): PresentationPackageAuditFinding {
  return { id, message, repairable };
}

function normalizeAuditText(value: string): string {
  return decodeXml(value).replace(/\s+/gu, " ").trim();
}

function auditLabel(value: string): string {
  const normalized = normalizeAuditText(value);
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function isSafeHyperlink(value: string): boolean {
  if (/(?:\.\.\.|…)/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
