import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_SENTINEL = 0xffffffff;

export const DEFAULT_FORBIDDEN_NOTE_PATTERNS = [
  /GoatCitadel design provenance/iu,
  /(?:^|\n)\s*(?:layout|density|renderer assets used|visual source|revised prompt)\s*:/iu,
  /(?:source model|provider model|generation prompt)\s*:/iu,
];

/**
 * Inspect a PPTX without Office or third-party ZIP/XML packages. This is a
 * deliberately conservative black-box gate: ambiguous package state is
 * reported instead of being silently accepted.
 */
export async function auditPptxPackage(filePath, options = {}) {
  const bytes = await fs.readFile(filePath);
  const entries = readZipEntries(bytes);
  const findings = [];
  const addFinding = (severity, code, message, part) => {
    findings.push({ severity, code, message, ...(part ? { part } : {}) });
  };

  for (const required of ["[Content_Types].xml", "ppt/presentation.xml"]) {
    if (!entries.has(required)) addFinding("error", "missing-required-part", `PPTX is missing ${required}.`, required);
  }

  const slideNames = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort(numericPartSort);
  if (slideNames.length === 0) addFinding("error", "missing-slides", "PPTX contains no slide parts.");

  const presentationXml = readXml(entries, "ppt/presentation.xml");
  const slideSize = readSlideSize(presentationXml);
  const expectedVisibleText = normalizeStringArray(options.expectedVisibleText);
  const expectedVisibleTextBySlide = normalizeExpectedVisibleTextBySlide(
    options.expectedVisibleTextBySlide,
    slideNames.length,
    addFinding,
  );
  const expectedExternalUrls = normalizeExpectedUrls(options.expectedExternalUrls, addFinding);
  const forbiddenNotePatterns = options.forbiddenNotePatterns ?? DEFAULT_FORBIDDEN_NOTE_PATTERNS;
  const allVisibleText = [];
  const visibleTextBySlide = [];
  const allNoteText = [];
  const externalHyperlinks = new Set();
  let hyperlinkRelationshipCount = 0;
  const layoutFamilies = [];
  const layoutNames = [];
  const layoutSignatures = [];
  const semanticLayoutFamilies = [];
  const layoutSections = [];
  const fontRuns = [];
  let authoredNoteCount = 0;
  let citationNoteCount = 0;
  let tableCount = 0;
  let chartReferenceCount = 0;
  let pictureCount = 0;
  let shrinkAutofitCount = 0;
  let bodyShrinkAutofitCount = 0;
  let sourceShrinkAutofitCount = 0;
  let tableShrinkAutofitCount = 0;
  let continuationCount = 0;
  let tableOverflowRiskCount = 0;
  let wrappedTextOverflowRiskCount = 0;

  for (const [slideIndex, slideName] of slideNames.entries()) {
    const slideXml = readXml(entries, slideName);
    const slideText = extractText(slideXml);
    const slideRelsName = slideRelationshipsName(slideName);
    const relationships = parseRelationships(readXml(entries, slideRelsName));
    const chartIds = new Set(matchAttributeValues(slideXml, /<c:chart\b[^>]*\br:id="([^"]+)"/giu));
    for (const id of chartIds) {
      const relationship = relationships.get(id);
      if (!relationship || !relationship.type.endsWith("/chart")) {
        addFinding("error", "dangling-chart-reference", `Slide chart ${id} has no chart relationship.`, slideName);
        continue;
      }
      const chartPart = resolvePartTarget(slideName, relationship.target);
      if (!entries.has(chartPart)) {
        addFinding(
          "error",
          "dangling-chart-relationship",
          `Slide chart target is missing: ${chartPart}.`,
          slideRelsName,
        );
        continue;
      }
      slideText.push(...extractChartText(readXml(entries, chartPart)));
    }
    allVisibleText.push(...slideText);
    visibleTextBySlide.push(normalizeText(slideText.join("\n")));
    hyperlinkRelationshipCount += [...relationships.values()].filter((relationship) =>
      relationship.type.endsWith("/hyperlink"),
    ).length;
    const hyperlinkIds = new Set(
      matchAttributeValues(slideXml, /<a:hlink(?:Click|MouseOver)\b[^>]*\br:id="([^"]+)"/giu),
    );
    const slideHyperlinks = new Set();

    for (const id of hyperlinkIds) {
      const relationship = relationships.get(id);
      if (!relationship) {
        addFinding(
          "error",
          "dangling-hyperlink-reference",
          `Slide references missing hyperlink relationship ${id}.`,
          slideName,
        );
        continue;
      }
      if (!relationship.type.endsWith("/hyperlink")) {
        addFinding(
          "error",
          "wrong-hyperlink-relationship",
          `${id} does not resolve to a hyperlink relationship.`,
          slideName,
        );
        continue;
      }
      validateExternalHyperlink(relationship, slideName, slideHyperlinks, addFinding);
    }

    for (const relationship of relationships.values()) {
      if (relationship.type.endsWith("/hyperlink") && !hyperlinkIds.has(relationship.id)) {
        addFinding(
          "error",
          "unused-hyperlink-relationship",
          `Hyperlink relationship ${relationship.id} is not referenced.`,
          slideRelsName,
        );
      }
    }

    for (const url of extractHttpsUrls(slideText.join(" "))) {
      if (!slideHyperlinks.has(canonicalUrl(url))) {
        addFinding(
          "error",
          "visible-url-not-clickable",
          `Visible URL is not backed by a slide hyperlink: ${url}`,
          slideName,
        );
      }
    }
    for (const hyperlink of slideHyperlinks) externalHyperlinks.add(hyperlink);

    const shapes = parseShapes(slideXml, slideSize);
    if (slideIndex === 0) classifyCoverTextRoles(shapes);
    wrappedTextOverflowRiskCount += validateShapeTextCapacity(shapes, slideName, addFinding);
    const titleText = shapes.find((shape) => shape.role === "title")?.text ?? "";
    const continuation = continuationTitleInfo(titleText);
    if (continuation.isContinuation) continuationCount += 1;
    let bodyShrinkAutofitCountForSlide = 0;
    let sourceShrinkAutofitCountForSlide = 0;
    for (const shape of shapes) {
      fontRuns.push(
        ...shape.fontRuns.map((run) => ({
          size: run.size,
          role: shape.role === "body" && /^\s*\[(?:S|SRC)?\d+\]/iu.test(run.text) ? "citation" : shape.role,
          part: slideName,
          text: run.text || shape.text,
        })),
      );
      if (shape.hasShrinkAutofit && (shape.role === "body" || shape.role === "coverSubtitle")) {
        bodyShrinkAutofitCountForSlide += 1;
      }
      if (shape.hasShrinkAutofit && shape.role === "source") sourceShrinkAutofitCountForSlide += 1;
    }
    fontRuns.push(...parseTableFontRuns(slideXml, slideName));
    const tableShrinkAutofitCountForSlide = countTableShrinkAutofit(slideXml);
    bodyShrinkAutofitCount += bodyShrinkAutofitCountForSlide;
    sourceShrinkAutofitCount += sourceShrinkAutofitCountForSlide;
    tableShrinkAutofitCount += tableShrinkAutofitCountForSlide;
    shrinkAutofitCount +=
      bodyShrinkAutofitCountForSlide + sourceShrinkAutofitCountForSlide + tableShrinkAutofitCountForSlide;

    const slideTables = countMatches(slideXml, /<a:tbl\b/giu);
    const slideCharts = countMatches(slideXml, /<c:chart\b/giu);
    const slidePictures = countMatches(slideXml, /<p:pic\b/giu);
    tableOverflowRiskCount += validateTableGeometry(slideXml, slideName, addFinding);
    wrappedTextOverflowRiskCount += validateTableTextCapacity(slideXml, slideName, slideSize, addFinding);
    tableCount += slideTables;
    chartReferenceCount += slideCharts;
    pictureCount += slidePictures;
    const layout = classifyLayout({
      shapes,
      semanticShapeNames: parseSemanticShapeNames(slideXml),
      tableCount: slideTables,
      chartCount: slideCharts,
      pictureCount: slidePictures,
      isCover: slideIndex === 0,
    });
    layoutFamilies.push(layout.family);
    layoutNames.push(layout.layoutName);
    layoutSignatures.push(layout.signature);
    semanticLayoutFamilies.push(layout.semanticFamily);
    layoutSections.push(continuation);

    if (bodyShrinkAutofitCountForSlide > 0 && options.allowBodyShrinkAutofit !== true) {
      addFinding(
        "error",
        "body-shrink-autofit",
        `${bodyShrinkAutofitCountForSlide} body text shape(s) use shrink-to-fit.`,
        slideName,
      );
    }
    if (sourceShrinkAutofitCountForSlide > 0 && options.allowSourceShrinkAutofit !== true) {
      addFinding(
        "error",
        "source-shrink-autofit",
        `${sourceShrinkAutofitCountForSlide} source text shape(s) use shrink-to-fit.`,
        slideName,
      );
    }
    if (tableShrinkAutofitCountForSlide > 0 && options.allowTableShrinkAutofit !== true) {
      addFinding(
        "error",
        "table-shrink-autofit",
        `${tableShrinkAutofitCountForSlide} table cell(s) use shrink-to-fit.`,
        slideName,
      );
    }

    const notesName = notesTargetForSlide(relationships);
    if (notesName) {
      const notesPart = resolvePartTarget(slideName, notesName);
      if (!entries.has(notesPart)) {
        addFinding(
          "error",
          "dangling-notes-relationship",
          `Slide notes target is missing: ${notesPart}`,
          slideRelsName,
        );
      } else {
        const noteText = extractText(readXml(entries, notesPart)).filter((text) => !/^\d+$/u.test(text));
        const humanNoteText = normalizeText(noteText.join(" "));
        if (humanNoteText) {
          if (/^(?:sources?|citations?)\s*:/iu.test(humanNoteText)) citationNoteCount += 1;
          else authoredNoteCount += 1;
        }
        allNoteText.push(...noteText);
        const joined = noteText.join("\n");
        for (const pattern of forbiddenNotePatterns) {
          if (pattern.test(joined)) {
            addFinding(
              "error",
              "forbidden-note-metadata",
              `Presenter notes contain internal generation metadata (${pattern}).`,
              notesPart,
            );
          }
          pattern.lastIndex = 0;
        }
      }
    }
  }

  const visibleText = normalizeText(allVisibleText.join("\n"));
  const visibleTextNodes = allVisibleText.map(normalizeText).filter(Boolean);
  if (options.requireNoVisibleTruncation !== false) {
    for (const text of visibleTextNodes) {
      if (/(?:\.\.\.|…)(?:\s|$)/u.test(text)) {
        addFinding(
          "error",
          "visible-truncation-marker",
          `Visible text contains a truncation marker: ${quoteSnippet(text)}`,
        );
      }
    }
  }
  for (const [expected, requiredCount] of normalizedTextCounts(expectedVisibleText)) {
    const observedCount = countNormalizedOccurrences(visibleText, expected);
    if (observedCount < requiredCount) {
      addFinding(
        "error",
        "missing-expected-text",
        `Expected visible text occurrence count was not preserved (required ${requiredCount}, found ${observedCount}): ${quoteSnippet(expected)}`,
      );
    }
  }
  for (const expectation of expectedVisibleTextBySlide) {
    const observedText = visibleTextBySlide[expectation.slideNumber - 1] ?? "";
    for (const [expected, requiredCount] of normalizedTextCounts(expectation.expectedVisibleText)) {
      const observedCount = countNormalizedOccurrences(observedText, expected);
      if (observedCount < requiredCount) {
        addFinding(
          "error",
          "missing-expected-slide-text",
          `Slide ${expectation.slideNumber} expected visible text occurrence count was not preserved (required ${requiredCount}, found ${observedCount}): ${quoteSnippet(expected)}`,
          slideNames[expectation.slideNumber - 1],
        );
      }
    }
  }
  for (const expectedUrl of expectedExternalUrls) {
    if (!externalHyperlinks.has(expectedUrl)) {
      addFinding("error", "missing-expected-hyperlink", `Expected external hyperlink is missing: ${expectedUrl}`);
    }
  }

  const fontSummary = validateFonts(fontRuns, options, addFinding);
  const chartPartCount = [...entries.keys()].filter((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name)).length;
  const mediaCount = [...entries.keys()].filter((name) => /^ppt\/media\/[^/]+$/u.test(name)).length;
  if (chartReferenceCount !== chartPartCount) {
    addFinding(
      "error",
      "chart-part-mismatch",
      `Found ${chartReferenceCount} slide chart reference(s) but ${chartPartCount} chart part(s).`,
    );
  }

  const layoutSummary = validateLayoutDiversity(
    layoutFamilies,
    layoutNames,
    layoutSignatures,
    layoutSections,
    slideNames.length,
    options,
    addFinding,
  );
  const sourceSlideCount = layoutFamilies.filter((family) => family === "source").length;
  const minimumFontSize = Math.min(...Object.values(fontSummary.minimums).filter(Number.isFinite));
  const semanticLayoutCounts = countValues(semanticLayoutFamilies);
  const layoutSignatureCounts = countValues(layoutSignatures);
  const metrics = {
    slideCount: slideNames.length,
    contentSlideCount: Math.max(0, slideNames.length - sourceSlideCount),
    tableCount,
    chartCount: chartPartCount,
    mediaCount,
    pictureCount,
    hyperlinkCount: hyperlinkRelationshipCount,
    hyperlinkRelationshipCount,
    uniqueHyperlinkTargetCount: externalHyperlinks.size,
    sourceUrlCount: new Set(extractHttpsUrls(visibleText).map(canonicalUrl)).size,
    sourceCount: new Set(extractHttpsUrls(visibleText).map(canonicalUrl)).size,
    continuationCount,
    visualCount: tableCount + chartPartCount + pictureCount,
    tableOverflowRiskCount,
    wrappedTextOverflowRiskCount,
    authoredNoteCount,
    citationNoteCount,
    shrinkAutofitCount,
    bodyShrinkAutofitCount,
    sourceShrinkAutofitCount,
    tableShrinkAutofitCount,
    layoutFamilyCount: layoutSummary.familyCount,
    layoutFamilies: layoutSummary.counts,
    semanticLayoutCounts,
    layoutSignatureCount: Object.keys(layoutSignatureCounts).length,
    layoutSignatureCounts,
    maximumConsecutiveLayoutCount: layoutSummary.maximumConsecutive,
    maximumRawConsecutiveLayoutCount: layoutSummary.maximumRawConsecutive,
    maximumConsecutiveSignatureCount: layoutSummary.maximumConsecutiveSignature,
    dominantLayoutShare: layoutSummary.dominantShare,
    minimumFonts: fontSummary.minimums,
    minimumFontSize: Number.isFinite(minimumFontSize) ? minimumFontSize : undefined,
    minimumCoverTitleFontSize: fontSummary.minimums.coverTitle,
    minimumCoverSubtitleFontSize: fontSummary.minimums.coverSubtitle,
    minimumTitleFontSize: fontSummary.minimums.title,
    minimumBodyFontSize: fontSummary.minimums.body,
    minimumTableFontSize: fontSummary.minimums.table,
    minimumSourceFontSize: fontSummary.minimums.source,
    minimumCitationFontSize: fontSummary.minimums.citation,
    minimumSlideNumberFontSize: fontSummary.minimums.slideNumber,
  };
  validateManifestAgreement(options.manifest, metrics, addFinding);

  return {
    schemaVersion: 1,
    filePath,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    passed: !findings.some((finding) => finding.severity === "error"),
    findings,
    metrics,
    externalHyperlinks: [...externalHyperlinks].sort(),
    visibleTextDigest: createHash("sha256").update(visibleText).digest("hex"),
    visibleTextNodes,
    noteTextNodes: allNoteText.map(normalizeText).filter(Boolean),
    entries: [...entries.keys()].sort(),
  };
}

export function formatPptxAuditFailure(report) {
  return report.findings
    .filter((finding) => finding.severity === "error")
    .map((finding) => `${finding.code}${finding.part ? ` [${finding.part}]` : ""}: ${finding.message}`)
    .join("\n");
}

export function listZipEntryNames(buffer) {
  return [...readZipEntries(buffer).keys()];
}

export function readZipEntries(buffer) {
  if (buffer.byteLength < 22) throw new Error("ZIP end-of-central-directory record is missing");
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralDirectoryOffset === ZIP64_SENTINEL || entryCount === 0xffff) {
    throw new Error("ZIP64 archives are not supported by the PPTX verifier");
  }

  const entries = new Map();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    ensureRange(buffer, offset, 46, "ZIP central-directory entry is truncated");
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error("ZIP central-directory entry is malformed");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    if ([compressedSize, uncompressedSize, localHeaderOffset].includes(ZIP64_SENTINEL)) {
      throw new Error("ZIP64 entries are not supported by the PPTX verifier");
    }
    ensureRange(buffer, offset + 46, nameLength + extraLength + commentLength, "ZIP directory name is truncated");
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if ((flags & 0x0001) !== 0) throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error(`Unsafe ZIP entry path: ${name}`);
    if (entries.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    const data = readLocalFile(buffer, { name, localHeaderOffset, compressedSize, uncompressedSize, method });
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP entry CRC mismatch: ${name}`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readLocalFile(buffer, entry) {
  const { localHeaderOffset, compressedSize, uncompressedSize, method, name } = entry;
  ensureRange(buffer, localHeaderOffset, 30, `ZIP local-file header is truncated: ${name}`);
  if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error(`ZIP local-file header is malformed: ${name}`);
  }
  const nameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + nameLength + extraLength;
  ensureRange(buffer, dataOffset, compressedSize, `ZIP entry data is truncated: ${name}`);
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
  const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : undefined;
  if (!data) throw new Error(`Unsupported ZIP compression method ${method}: ${name}`);
  if (data.byteLength !== uncompressedSize) throw new Error(`ZIP entry size mismatch: ${name}`);
  return data;
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.byteLength - 65_557);
  for (let offset = buffer.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

function ensureRange(buffer, offset, length, message) {
  if (offset < 0 || length < 0 || offset + length > buffer.byteLength) throw new Error(message);
}

function readXml(entries, name) {
  return entries.get(name)?.toString("utf8") ?? "";
}

function readSlideSize(xml) {
  const match = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/iu.exec(xml);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 12_192_000, height: 6_858_000 };
}

function slideRelationshipsName(slideName) {
  const basename = slideName.slice(slideName.lastIndexOf("/") + 1);
  return `ppt/slides/_rels/${basename}.rels`;
}

function parseRelationships(xml) {
  const relationships = new Map();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/giu)) {
    const attrs = parseXmlAttributes(match[1]);
    if (!attrs.Id) continue;
    relationships.set(attrs.Id, {
      id: attrs.Id,
      type: attrs.Type ?? "",
      target: decodeXml(attrs.Target ?? ""),
      targetMode: attrs.TargetMode ?? "",
    });
  }
  return relationships;
}

function validateExternalHyperlink(relationship, part, hyperlinks, addFinding) {
  if (relationship.targetMode !== "External") {
    addFinding("error", "nonexternal-hyperlink", `Hyperlink ${relationship.id} is not marked External.`, part);
    return;
  }
  let parsed;
  try {
    parsed = new URL(relationship.target);
  } catch {
    addFinding("error", "invalid-hyperlink-target", `Hyperlink ${relationship.id} has an invalid target.`, part);
    return;
  }
  if (parsed.protocol !== "https:") {
    addFinding(
      "error",
      "nonhttps-hyperlink",
      `Hyperlink ${relationship.id} must use HTTPS: ${relationship.target}`,
      part,
    );
  }
  if (parsed.username || parsed.password) {
    addFinding("error", "credentialed-hyperlink", `Hyperlink ${relationship.id} contains URL credentials.`, part);
  }
  if (/(?:\.\.\.|…)/u.test(relationship.target)) {
    addFinding("error", "truncated-hyperlink", `Hyperlink ${relationship.id} contains a truncation marker.`, part);
  }
  hyperlinks.add(canonicalUrl(relationship.target));
}

function parseShapes(slideXml, slideSize) {
  const shapes = [];
  for (const match of slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/giu)) {
    const xml = match[0];
    const text = normalizeText(extractText(xml).join(" "));
    if (!text) continue;
    const nonVisualProperties = /<p:cNvPr\b([^>]*)\/?\s*>/iu.exec(xml);
    const shapeName = nonVisualProperties ? decodeXml(parseXmlAttributes(nonVisualProperties[1]).name ?? "") : "";
    const sizes = [...xml.matchAll(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*\bsz="(\d+)"/giu)].map(
      (sizeMatch) => Number(sizeMatch[1]) / 100,
    );
    const explicitRuns = [...xml.matchAll(/<a:r\b[\s\S]*?<\/a:r>/giu)]
      .map((runMatch) => {
        const runXml = runMatch[0];
        const size = Number(/<a:rPr\b[^>]*\bsz="(\d+)"/iu.exec(runXml)?.[1] ?? Number.NaN) / 100;
        return { text: normalizeText(extractText(runXml).join(" ")), size };
      })
      .filter((run) => Number.isFinite(run.size));
    const yMatch = /<a:off\b[^>]*\by="(\d+)"/iu.exec(xml);
    const y = yMatch ? Number(yMatch[1]) : Number.NaN;
    const xMatch = /<a:off\b[^>]*\bx="(\d+)"/iu.exec(xml);
    const extentMatch = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/iu.exec(xml);
    const bodyProperties = parseXmlAttributes(/<a:bodyPr\b([^>]*)>/iu.exec(xml)?.[1] ?? "");
    const placeholder = /<p:ph\b[^>]*\btype="([^"]+)"/iu.exec(xml)?.[1];
    const role = classifyTextRole({ text, y, slideHeight: slideSize.height, placeholder, shapeName });
    shapes.push({
      text,
      role,
      shapeName,
      fontSizes: sizes,
      fontRuns: explicitRuns.length > 0 ? explicitRuns : sizes.map((size) => ({ text, size })),
      hasShrinkAutofit: /<a:normAutofit\b/iu.test(xml),
      x: xMatch ? Number(xMatch[1]) : Number.NaN,
      y,
      width: extentMatch ? Number(extentMatch[1]) : Number.NaN,
      height: extentMatch ? Number(extentMatch[2]) : Number.NaN,
      margins: readTextMargins(bodyProperties),
      paragraphs: parseCapacityParagraphs(xml, sizes),
    });
  }
  if (shapes.length > 0 && !shapes.some((shape) => shape.role === "title")) {
    const titleCandidate = shapes.find((shape) => shape.role === "body") ?? shapes[0];
    if (titleCandidate) titleCandidate.role = "title";
  }
  if (shapes.some((shape) => shape.role === "source")) {
    for (const shape of shapes) {
      if (shape.role === "body") shape.role = "source";
    }
  }
  return shapes;
}

function classifyCoverTextRoles(shapes) {
  const coverTitle = shapes.find((shape) => shape.role === "title");
  if (coverTitle) coverTitle.role = "coverTitle";
  for (const shape of shapes) {
    if (shape.role === "body") shape.role = "coverSubtitle";
  }
}

function classifyTextRole({ text, y, slideHeight, placeholder, shapeName }) {
  const semanticRole = semanticRoleFromShapeName(shapeName);
  if (semanticRole) return semanticRole;
  if (placeholder === "title" || placeholder === "ctrTitle") return "title";
  if (/^\d+$/u.test(text) && Number.isFinite(y) && y > slideHeight * 0.82) return "slideNumber";
  if (/https?:\/\//iu.test(text)) return "source";
  if (/^(?:\[\d+\]|sources?\s*:)/iu.test(text) && Number.isFinite(y) && y > slideHeight * 0.72) return "citation";
  void y;
  void slideHeight;
  return "body";
}

function semanticRoleFromShapeName(shapeName) {
  const normalized = String(shapeName ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "gc:title") return "title";
  if (normalized === "gc:subtitle") return "coverSubtitle";
  if (normalized === "gc:slide-number") return "slideNumber";
  if (normalized === "gc:citation") return "citation";
  if (normalized === "gc:source") return "source";
  if (normalized === "gc:table") return "table";
  if (normalized.startsWith("gc:body:")) return "body";
  return undefined;
}

function validateFonts(fontRuns, options, addFinding) {
  const floors = {
    coverTitle: options.minimumCoverTitleFontPt ?? 34,
    coverSubtitle: options.minimumCoverSubtitleFontPt ?? 18,
    title: options.minimumTitleFontPt ?? 28,
    body: options.minimumBodyFontPt ?? 16,
    source: options.minimumSourceFontPt ?? 12,
    citation: options.minimumCitationFontPt ?? 11,
    slideNumber: options.minimumSlideNumberFontPt ?? 10,
    table: options.minimumTableFontPt ?? 14,
  };
  const minimums = {};
  for (const role of Object.keys(floors)) {
    const runs = fontRuns.filter((run) => run.role === role && Number.isFinite(run.size));
    if (runs.length === 0) continue;
    const minimum = Math.min(...runs.map((run) => run.size));
    minimums[role] = minimum;
    if (minimum < floors[role]) {
      const offender = runs.find((run) => run.size === minimum);
      addFinding(
        "error",
        `font-below-${role}-floor`,
        `${role} font ${minimum} pt is below the ${floors[role]} pt floor (${quoteSnippet(offender?.text ?? "")}).`,
        offender?.part,
      );
    }
  }
  return { floors, minimums };
}

function classifyLayout({ shapes, semanticShapeNames, tableCount, chartCount, pictureCount, isCover }) {
  let family;
  if (tableCount > 0) family = "table";
  else if (chartCount > 0) family = "chart";
  else if (pictureCount > 0) family = "image";
  else if (shapes.some((shape) => shape.role === "source")) family = "source";
  else if (shapes.filter((shape) => shape.role === "body").length >= 3) family = "cards";
  else if (shapes.filter((shape) => shape.role === "body").length === 2) family = "columns";
  else family = "narrative";
  const semanticNames = new Set([
    ...semanticShapeNames,
    ...shapes.map((shape) => shape.shapeName.toLowerCase()).filter((name) => name.startsWith("gc:")),
  ]);
  const explicitLayoutName = [...semanticNames]
    .filter((name) => name.startsWith("gc:layout:"))
    .map((name) => name.slice("gc:layout:".length))
    .find((name) => Boolean(normalizeLayoutFamily(name)));
  const explicitLayoutFamily = normalizeLayoutFamily(explicitLayoutName);
  let semanticFamily;
  if (explicitLayoutFamily) semanticFamily = explicitLayoutFamily;
  else if (shapes.some((shape) => shape.role === "source")) semanticFamily = "sources";
  else if (tableCount > 0) semanticFamily = "table";
  else if (chartCount > 0 || semanticNames.has("gc:chart")) semanticFamily = "chart";
  else if (semanticNames.has("gc:body:callout-detail")) semanticFamily = "closing";
  else if (semanticNames.has("gc:body:section")) semanticFamily = "section";
  else if (semanticNames.has("gc:body:comparison-left") || semanticNames.has("gc:body:comparison-right")) {
    semanticFamily = "columns";
  } else if (semanticNames.has("gc:body:stacked")) semanticFamily = "stacked-list";
  else if (isCover || pictureCount > 0) semanticFamily = "hero";
  else semanticFamily = normalizeLayoutFamily(family) ?? family;
  const layoutName = explicitLayoutName ?? semanticFamily;
  const signatureNames = [...semanticNames].sort().join(",");
  const signature = `${semanticFamily}:${signatureNames}:${shapes.length}:${tableCount}:${chartCount}:${pictureCount}`;
  return { family, layoutName, semanticFamily, signature };
}

function parseSemanticShapeNames(slideXml) {
  const names = [];
  for (const match of slideXml.matchAll(/<p:cNvPr\b([^>]*)\/?\s*>/giu)) {
    const name = String(parseXmlAttributes(match[1]).name ?? "")
      .trim()
      .toLowerCase();
    if (name.startsWith("gc:")) names.push(name);
  }
  return names;
}

function parseTableFontRuns(slideXml, part) {
  const runs = [];
  for (const match of slideXml.matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/giu)) {
    const xml = match[0];
    const text = normalizeText(extractText(xml).join(" "));
    for (const sizeMatch of xml.matchAll(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*\bsz="(\d+)"/giu)) {
      runs.push({ size: Number(sizeMatch[1]) / 100, role: "table", part, text });
    }
  }
  return runs;
}

function countTableShrinkAutofit(slideXml) {
  let count = 0;
  for (const match of slideXml.matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/giu)) {
    if (/<a:normAutofit\b/iu.test(match[0])) count += 1;
  }
  return count;
}

function validateTableGeometry(slideXml, part, addFinding) {
  let risks = 0;
  for (const match of slideXml.matchAll(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/giu)) {
    const frameXml = match[0];
    if (!/<a:tbl\b/iu.test(frameXml)) continue;
    const frameHeight = Number(/<a:ext\b[^>]*\bcy="(\d+)"/iu.exec(frameXml)?.[1] ?? Number.NaN);
    const rowHeights = [...frameXml.matchAll(/<a:tr\b[^>]*\bh="(\d+)"/giu)].map((row) => Number(row[1]));
    if (!Number.isFinite(frameHeight) || rowHeights.length === 0) continue;
    const declaredRowsHeight = rowHeights.reduce((sum, value) => sum + value, 0);
    if (declaredRowsHeight > frameHeight + 12_700) {
      risks += 1;
      addFinding(
        "error",
        "table-frame-height-overflow",
        `Table rows require ${(declaredRowsHeight / 12_700).toFixed(1)} pt, but the graphic frame provides ${(frameHeight / 12_700).toFixed(1)} pt.`,
        part,
      );
    }
  }
  return risks;
}

function validateShapeTextCapacity(shapes, part, addFinding) {
  let risks = 0;
  for (const shape of shapes) {
    if (!["body", "source", "citation", "coverSubtitle"].includes(shape.role)) continue;
    const capacity = estimateWrappedTextCapacity({
      paragraphs: shape.paragraphs,
      widthEmu: shape.width,
      heightEmu: shape.height,
      margins: shape.margins,
    });
    if (!capacity?.overflow) continue;
    risks += 1;
    const findingRole = shape.role === "coverSubtitle" ? "body" : shape.role;
    addFinding(
      "error",
      `${findingRole}-wrapped-text-overflow-risk`,
      `${findingRole} text likely needs ${capacity.requiredHeightPt.toFixed(1)} pt after wrapping, but the shape provides ${capacity.availableHeightPt.toFixed(1)} pt (${quoteSnippet(shape.text)}).`,
      part,
    );
  }
  return risks;
}

function validateTableTextCapacity(slideXml, part, slideSize, addFinding) {
  let risks = 0;
  for (const frameMatch of slideXml.matchAll(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/giu)) {
    const frameXml = frameMatch[0];
    const tableXml = /<a:tbl\b[\s\S]*?<\/a:tbl>/iu.exec(frameXml)?.[0];
    if (!tableXml) continue;
    const columnWidths = [...tableXml.matchAll(/<a:gridCol\b[^>]*\bw="(\d+)"/giu)].map((match) => Number(match[1]));
    if (columnWidths.length === 0) continue;
    const rows = [...tableXml.matchAll(/<a:tr\b([^>]*)>([\s\S]*?)<\/a:tr>/giu)];
    const frameHeight = Number(/<a:ext\b[^>]*\bcy="(\d+)"/iu.exec(frameXml)?.[1] ?? Number.NaN);
    const frameY = Number(/<a:off\b[^>]*\by="(\d+)"/iu.exec(frameXml)?.[1] ?? Number.NaN);
    const predictedRowHeights = [];
    let worstCell;
    for (const [rowIndex, rowMatch] of rows.entries()) {
      const rowHeight = Number(parseXmlAttributes(rowMatch[1]).h ?? Number.NaN);
      if (!Number.isFinite(rowHeight)) continue;
      let requiredRowHeight = rowHeight;
      const cells = [...rowMatch[2].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/giu)].map((match) => match[0]);
      for (const [cellIndex, cellXml] of cells.entries()) {
        const columnWidth = columnWidths[cellIndex];
        if (!Number.isFinite(columnWidth)) continue;
        const sizes = [...cellXml.matchAll(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*\bsz="(\d+)"/giu)].map(
          (match) => Number(match[1]) / 100,
        );
        const cellProperties = parseXmlAttributes(/<a:tcPr\b([^>]*)>/iu.exec(cellXml)?.[1] ?? "");
        const margins = readTextMargins(cellProperties);
        const capacity = estimateWrappedTextCapacity({
          paragraphs: parseCapacityParagraphs(cellXml, sizes),
          widthEmu: columnWidth,
          heightEmu: rowHeight,
          margins,
        });
        if (!capacity) continue;
        const requiredOuterHeight = capacity.requiredHeightPt * 12_700 + margins.top + margins.bottom;
        requiredRowHeight = Math.max(requiredRowHeight, requiredOuterHeight);
        if (!worstCell || requiredOuterHeight > worstCell.requiredOuterHeight) {
          worstCell = { rowIndex, cellIndex, requiredOuterHeight, text: extractText(cellXml).join(" ") };
        }
      }
      predictedRowHeights.push(requiredRowHeight);
    }
    if (!Number.isFinite(frameY) || predictedRowHeights.length !== rows.length) continue;
    const predictedTableHeight = Math.max(
      Number.isFinite(frameHeight) ? frameHeight : 0,
      predictedRowHeights.reduce((sum, value) => sum + value, 0),
    );
    const bottomSafetyMargin = 365_760;
    const availableTableHeight = Math.max(0, slideSize.height - frameY - bottomSafetyMargin);
    if (predictedTableHeight <= availableTableHeight * 1.03) continue;
    risks += 1;
    addFinding(
      "error",
      "table-cell-wrapped-text-overflow-risk",
      `Wrapped table content likely expands to ${(predictedTableHeight / 12_700).toFixed(1)} pt, but only ${(availableTableHeight / 12_700).toFixed(1)} pt remain before the slide safety margin${worstCell ? `; worst cell is row ${worstCell.rowIndex + 1}, cell ${worstCell.cellIndex + 1} (${quoteSnippet(worstCell.text)})` : ""}.`,
      part,
    );
  }
  return risks;
}

function parseCapacityParagraphs(xml, fallbackSizes) {
  const fallbackSize = fallbackSizes.find(Number.isFinite) ?? Number.NaN;
  const paragraphs = [];
  for (const paragraphMatch of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/giu)) {
    const paragraphXml = paragraphMatch[0];
    const explicitBreaks = countMatches(paragraphXml, /<a:br\b/giu);
    const text = normalizeText(extractText(paragraphXml).join(" "));
    if (!text && explicitBreaks === 0) continue;
    const sizes = [...paragraphXml.matchAll(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*\bsz="(\d+)"/giu)].map(
      (match) => Number(match[1]) / 100,
    );
    paragraphs.push({
      text,
      fontSizePt: sizes.find(Number.isFinite) ?? fallbackSize,
      explicitBreaks,
      bullet: /<a:bu(?:Char|AutoNum|Blip)\b/iu.test(paragraphXml),
    });
  }
  return paragraphs;
}

function readTextMargins(attributes) {
  return {
    left: readEmuAttribute(attributes.lIns ?? attributes.marL, 91_440),
    right: readEmuAttribute(attributes.rIns ?? attributes.marR, 91_440),
    top: readEmuAttribute(attributes.tIns ?? attributes.marT, 45_720),
    bottom: readEmuAttribute(attributes.bIns ?? attributes.marB, 45_720),
  };
}

function readEmuAttribute(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function estimateWrappedTextCapacity({ paragraphs, widthEmu, heightEmu, margins }) {
  if (!Number.isFinite(widthEmu) || !Number.isFinite(heightEmu) || widthEmu <= 0 || heightEmu <= 0) {
    return undefined;
  }
  const widthPt = Math.max(0, (widthEmu - margins.left - margins.right) / 12_700);
  const availableHeightPt = Math.max(0, (heightEmu - margins.top - margins.bottom) / 12_700);
  if (widthPt <= 0 || availableHeightPt <= 0 || paragraphs.length === 0) return undefined;
  let requiredHeightPt = 0;
  for (const paragraph of paragraphs) {
    if (!Number.isFinite(paragraph.fontSizePt) || paragraph.fontSizePt <= 0) return undefined;
    const usableWidthPt = Math.max(paragraph.fontSizePt, widthPt - (paragraph.bullet ? paragraph.fontSizePt * 1.5 : 0));
    const wrappedLines = estimateWrappedLineCount(paragraph.text, usableWidthPt, paragraph.fontSizePt);
    const lineCount = Math.max(1, wrappedLines + paragraph.explicitBreaks);
    requiredHeightPt += lineCount * paragraph.fontSizePt + paragraph.fontSizePt * 0.04;
  }
  return {
    requiredHeightPt,
    availableHeightPt,
    overflow: requiredHeightPt > availableHeightPt * 1.06,
  };
}

function estimateWrappedLineCount(text, widthPt, fontSizePt) {
  if (!text) return 1;
  const maxWidthEm = widthPt / fontSizePt;
  if (!Number.isFinite(maxWidthEm) || maxWidthEm <= 0) return Number.POSITIVE_INFINITY;
  const words = text.split(/\s+/u).filter(Boolean);
  let lines = 1;
  let currentWidth = 0;
  for (const word of words) {
    const width = estimateTextWidthEm(word);
    const spacing = currentWidth > 0 ? 0.28 : 0;
    if (width <= maxWidthEm && currentWidth + spacing + width <= maxWidthEm) {
      currentWidth += spacing + width;
      continue;
    }
    if (currentWidth > 0) {
      lines += 1;
      currentWidth = 0;
    }
    if (width > maxWidthEm) {
      const tokenLines = Math.ceil(width / maxWidthEm);
      lines += tokenLines - 1;
      currentWidth = width - (tokenLines - 1) * maxWidthEm;
    } else {
      currentWidth = width;
    }
  }
  return lines;
}

function estimateTextWidthEm(text) {
  let width = 0;
  for (const character of text) {
    if (/\s/u.test(character)) width += 0.28;
    else if (/[ilI1|.,'`:;]/u.test(character)) width += 0.28;
    else if (/[mwMW@%&#]/u.test(character)) width += 0.75;
    else if (/[A-Z]/u.test(character)) width += 0.56;
    else if (/[0-9]/u.test(character)) width += 0.5;
    else width += 0.45;
  }
  return width;
}

function validateLayoutDiversity(families, layoutNames, signatures, sections, slideCount, options, addFinding) {
  const counts = Object.fromEntries(
    [...new Set(families)].map((family) => [family, families.filter((item) => item === family).length]),
  );
  const familyCount = Object.keys(counts).length;
  const semanticExceptions = new Set(options.semanticLayoutExceptions ?? ["source"]);
  const layoutNameExceptions = new Set(
    [...semanticExceptions].flatMap((family) => (family === "source" ? ["source", "sources"] : [family])),
  );
  const maximumRawConsecutive = longestConsecutiveRun(families);
  const collapsedLayoutNames = collapseContinuationSections(layoutNames, sections);
  const maximumConsecutive = longestConsecutiveRun(collapsedLayoutNames, layoutNameExceptions);
  const semanticSections = collapseContinuationSections(families, sections);
  const maximumConsecutiveSignature = longestConsecutiveSignatureRun(signatures, families, semanticExceptions);
  const analyticalFamilies = semanticSections.filter((family) => !semanticExceptions.has(family));
  const analyticalCounts = Object.fromEntries(
    [...new Set(analyticalFamilies)].map((family) => [
      family,
      analyticalFamilies.filter((item) => item === family).length,
    ]),
  );
  const dominantShare =
    analyticalFamilies.length > 0 ? Math.max(0, ...Object.values(analyticalCounts)) / analyticalFamilies.length : 0;
  if (options.requireLayoutDiversity === true && slideCount >= 8) {
    if (familyCount < 3)
      addFinding(
        "error",
        "insufficient-layout-families",
        `Deck uses ${familyCount} layout families; at least 3 are required.`,
      );
    if (maximumConsecutive > 2)
      addFinding("error", "repeated-layout-run", `A layout family repeats ${maximumConsecutive} times consecutively.`);
    if (maximumConsecutiveSignature > 2) {
      addFinding(
        "error",
        "repeated-layout-signature-run",
        `An identical non-source layout signature repeats ${maximumConsecutiveSignature} times consecutively.`,
      );
    }
    if (dominantShare > 0.6)
      addFinding(
        "error",
        "dominant-layout-family",
        `One layout family occupies ${(dominantShare * 100).toFixed(1)}% of slides.`,
      );
  }
  return {
    counts,
    familyCount,
    maximumConsecutive,
    maximumRawConsecutive,
    maximumConsecutiveSignature,
    dominantShare,
    signatureCount: new Set(signatures).size,
  };
}

function continuationTitleInfo(title) {
  const normalized = normalizeText(title);
  const match = /^(.*?)(?:\s*(?:—|-|–)\s*continued)\s*$/iu.exec(normalized);
  return {
    baseTitle: normalizeText(match?.[1] ?? normalized).toLocaleLowerCase("en-US"),
    isContinuation: Boolean(match),
  };
}

function collapseContinuationSections(families, sections) {
  const collapsed = [];
  let currentBaseTitle = "";
  let currentFamily;
  for (let index = 0; index < families.length; index += 1) {
    const family = families[index];
    const section = sections[index] ?? { baseTitle: "", isContinuation: false };
    const repeatsCurrentSection =
      section.baseTitle.length > 0 && section.baseTitle === currentBaseTitle && family === currentFamily;
    if (!repeatsCurrentSection) collapsed.push(family);
    currentBaseTitle = section.baseTitle;
    currentFamily = family;
  }
  return collapsed;
}

function validateManifestAgreement(manifest, metrics, addFinding) {
  if (!manifest) return;
  const comparisons = [
    ["slideCount", metrics.slideCount],
    ["contentSlideCount", metrics.contentSlideCount],
    ["tableCount", metrics.tableCount],
    ["chartCount", metrics.chartCount],
    ["mediaCount", metrics.mediaCount],
    ["hyperlinkCount", metrics.hyperlinkCount],
    ["authoredNoteCount", metrics.authoredNoteCount],
    ["citationNoteCount", metrics.citationNoteCount],
    ["sourceCount", metrics.sourceCount],
    ["continuationCount", metrics.continuationCount],
    ["visualCount", metrics.visualCount],
    ["minimumFontSize", metrics.minimumFontSize],
    ["minimumCoverTitleFontSize", metrics.minimumCoverTitleFontSize],
    ["minimumCoverSubtitleFontSize", metrics.minimumCoverSubtitleFontSize],
    ["minimumTitleFontSize", metrics.minimumTitleFontSize],
    ["minimumBodyFontSize", metrics.minimumBodyFontSize],
    ["minimumTableFontSize", metrics.minimumTableFontSize],
    ["minimumSourceFontSize", metrics.minimumSourceFontSize],
    ["minimumCitationFontSize", metrics.minimumCitationFontSize],
    ["minimumSlideNumberFontSize", metrics.minimumSlideNumberFontSize],
  ];
  for (const [key, actual] of comparisons) {
    if (actual === undefined) continue;
    const expected = readManifestNumber(manifest, key);
    if (expected !== undefined && expected !== actual) {
      addFinding("error", "manifest-mismatch", `Manifest ${key}=${expected}, but the PPTX package reports ${actual}.`);
    }
  }
  const manifestLayouts = manifest.layoutCounts ?? manifest.layouts;
  if (manifestLayouts && typeof manifestLayouts === "object" && !Array.isArray(manifestLayouts)) {
    const expectedTotal = Object.values(manifestLayouts).reduce((sum, value) => sum + Number(value ?? 0), 0);
    if (Number.isFinite(expectedTotal) && expectedTotal !== metrics.slideCount) {
      addFinding(
        "error",
        "manifest-layout-total-mismatch",
        `Manifest layout total is ${expectedTotal}, not ${metrics.slideCount}.`,
      );
    }
    const normalized = normalizeManifestLayoutCounts(manifestLayouts, addFinding);
    if (normalized.unsupported.length === 0 && normalized.valid) {
      compareCountMaps(
        normalized.counts,
        metrics.semanticLayoutCounts,
        "manifest-layout-family-mismatch",
        "layout family",
        addFinding,
      );
    } else if (normalized.unsupported.length > 0) {
      addFinding(
        "warning",
        "manifest-layout-family-unverifiable",
        `Manifest layout families cannot all be mapped to package semantics: ${normalized.unsupported.join(", ")}.`,
      );
    }
  }

  const manifestSignatures = manifest.layoutSignatureCounts ?? manifest.layoutSignatures;
  if (manifestSignatures !== undefined) {
    const normalizedSignatures = normalizeSignatureCounts(manifestSignatures, addFinding);
    if (normalizedSignatures) {
      compareCountMaps(
        normalizedSignatures,
        metrics.layoutSignatureCounts,
        "manifest-layout-signature-mismatch",
        "layout signature",
        addFinding,
      );
    }
  }
}

function normalizeManifestLayoutCounts(layouts, addFinding) {
  const counts = {};
  const unsupported = [];
  let valid = true;
  for (const [name, rawCount] of Object.entries(layouts)) {
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < 0) {
      valid = false;
      addFinding("error", "manifest-layout-count-invalid", `Manifest layout ${name} has invalid count ${rawCount}.`);
      continue;
    }
    const family = normalizeLayoutFamily(name);
    if (!family) {
      unsupported.push(name);
      continue;
    }
    counts[family] = (counts[family] ?? 0) + count;
  }
  return { counts, unsupported, valid };
}

function normalizeLayoutFamily(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  const aliases = {
    hero: "hero",
    image: "hero",
    cover: "hero",
    comparison: "columns",
    "two-column": "columns",
    columns: "columns",
    "stacked-list": "stacked-list",
    stacked: "stacked-list",
    "image-text": "narrative",
    "stat-callout": "narrative",
    chart: "chart",
    table: "table",
    "table-continuation": "table",
    matrix: "table",
    closing: "closing",
    callout: "closing",
    sources: "sources",
    source: "sources",
    section: "section",
    cards: "cards",
    narrative: "narrative",
  };
  return aliases[normalized];
}

function normalizeSignatureCounts(value, addFinding) {
  if (Array.isArray(value)) return countValues(value.filter((item) => typeof item === "string" && item.length > 0));
  if (!value || typeof value !== "object") {
    addFinding(
      "error",
      "manifest-layout-signature-invalid",
      "Manifest layout signatures must be an array or count map.",
    );
    return undefined;
  }
  const counts = {};
  for (const [signature, rawCount] of Object.entries(value)) {
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < 0) {
      addFinding(
        "error",
        "manifest-layout-signature-invalid",
        `Manifest layout signature ${signature} has invalid count ${rawCount}.`,
      );
      return undefined;
    }
    counts[signature] = count;
  }
  return counts;
}

function compareCountMaps(expected, actual, code, label, addFinding) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    const expectedCount = expected[key] ?? 0;
    const actualCount = actual[key] ?? 0;
    if (expectedCount !== actualCount) {
      addFinding(
        "error",
        code,
        `Manifest ${label} ${key}=${expectedCount}, but the PPTX package reports ${actualCount}.`,
      );
    }
  }
}

function readManifestNumber(manifest, key) {
  const candidates = [manifest[key], manifest.counts?.[key], manifest.metrics?.[key]];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function notesTargetForSlide(relationships) {
  return [...relationships.values()].find((relationship) => relationship.type.endsWith("/notesSlide"))?.target;
}

function resolvePartTarget(fromPart, target) {
  return new URL(target, `pptx://package/${fromPart}`).pathname.slice(1);
}

function extractText(xml) {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/giu)].map((match) => decodeXml(match[1]));
}

function extractChartText(xml) {
  return [
    ...extractText(xml),
    ...[...xml.matchAll(/<c:v(?:\s[^>]*)?>([\s\S]*?)<\/c:v>/giu)].map((match) => decodeXml(match[1])),
  ];
}

function extractHttpsUrls(text) {
  return (text.match(/https:\/\/[^\s<>()\[\]{}"']+/giu) ?? []).map((value) => value.replace(/[.,;:!?]+$/gu, ""));
}

function parseXmlAttributes(text) {
  const attrs = {};
  for (const match of text.matchAll(/([\w:.-]+)="([^"]*)"/gu)) attrs[match[1]] = decodeXml(match[2]);
  return attrs;
}

function matchAttributeValues(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => decodeXml(match[1]));
}

function decodeXml(text) {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/&#x([0-9a-f]+);/giu, (_match, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/gu, (_match, value) => String.fromCodePoint(Number(value)));
}

function canonicalUrl(value) {
  const parsed = new URL(value);
  parsed.hash = "";
  if (
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }
  return parsed.toString();
}

function normalizeExpectedUrls(values, addFinding) {
  const normalized = [];
  for (const value of normalizeStringArray(values)) {
    try {
      normalized.push(canonicalUrl(value));
    } catch {
      addFinding("error", "invalid-expected-url", `Expected hyperlink is not a valid URL: ${value}`);
    }
  }
  return normalized;
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
    : [];
}

function normalizeExpectedVisibleTextBySlide(value, slideCount, addFinding) {
  if (value === undefined || value === null) return [];
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.slides)) {
    addFinding(
      "error",
      "invalid-expected-text-by-slide",
      "Per-slide text expectations require { schemaVersion: 1, slides: [...] }.",
    );
    return [];
  }

  const normalizedBySlide = new Map();
  for (const [index, raw] of value.slides.entries()) {
    if (!isRecord(raw)) {
      addFinding(
        "error",
        "invalid-expected-text-by-slide",
        `Per-slide text expectation ${index + 1} must be an object.`,
      );
      continue;
    }
    const slideNumber = raw.slideNumber;
    const expectedVisibleText = normalizeStringArray(raw.expectedVisibleText);
    if (
      !Number.isInteger(slideNumber) ||
      slideNumber < 1 ||
      slideNumber > slideCount ||
      !Array.isArray(raw.expectedVisibleText) ||
      expectedVisibleText.length !== raw.expectedVisibleText.length
    ) {
      addFinding(
        "error",
        "invalid-expected-text-by-slide",
        `Per-slide text expectation ${index + 1} requires a 1-based slideNumber within the deck and an array of non-empty strings.`,
      );
      continue;
    }
    const existing = normalizedBySlide.get(slideNumber) ?? [];
    existing.push(...expectedVisibleText);
    normalizedBySlide.set(slideNumber, existing);
  }
  return [...normalizedBySlide.entries()]
    .sort(([left], [right]) => left - right)
    .map(([slideNumber, expectedVisibleText]) => ({ slideNumber, expectedVisibleText }));
}

function normalizedTextCounts(values) {
  const counts = new Map();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function countNormalizedOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const match = haystack.indexOf(needle, offset);
    if (match < 0) break;
    count += 1;
    offset = match + needle.length;
  }
  return count;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(text) {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function quoteSnippet(text) {
  const normalized = normalizeText(text);
  return JSON.stringify(normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized);
}

function numericPartSort(left, right) {
  return Number(/(\d+)\.xml$/u.exec(left)?.[1] ?? 0) - Number(/(\d+)\.xml$/u.exec(right)?.[1] ?? 0);
}

function longestConsecutiveRun(values, ignored = new Set()) {
  let longest = 0;
  let current = 0;
  let previous;
  for (const value of values) {
    if (ignored.has(value)) {
      current = 0;
      previous = undefined;
      continue;
    }
    current = value === previous ? current + 1 : 1;
    previous = value;
    longest = Math.max(longest, current);
  }
  return longest;
}

function longestConsecutiveSignatureRun(signatures, families, ignoredFamilies) {
  let longest = 0;
  let current = 0;
  let previous;
  for (let index = 0; index < signatures.length; index += 1) {
    if (ignoredFamilies.has(families[index])) {
      current = 0;
      previous = undefined;
      continue;
    }
    const signature = signatures[index];
    current = signature === previous ? current + 1 : 1;
    previous = signature;
    longest = Math.max(longest, current);
  }
  return longest;
}

function countValues(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
