import fs from "node:fs/promises";
import path from "node:path";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import {
  buildArtifactDesignReport,
  createArtifactDesignPlan,
  type ArtifactDesignQualityFinding,
  type ArtifactValidationCheck,
} from "../artifact-design.js";
import {
  createDocumentArtifact,
  documentArtifactExtension,
  type DocumentArtifactFormat,
  type DocumentArtifactSection,
} from "../document-artifacts.js";
import { analyzePresentationDeckQuality, type PresentationDeckQualitySummary } from "../presentation-layout.js";
import {
  createPresentationPptxWithDiagnostics,
  type PresentationPptxDiagnostics,
  type PresentationSlide,
  type PresentationVisualAsset,
} from "../presentation-pptx.js";
import { assertWritePathInJail } from "../sandbox/path-jail.js";

const ARTIFACT_TOOL_NAMES = new Set(["artifacts.create", "documents.create", "presentations.create"]);

export function isArtifactToolName(toolName: string): boolean {
  return ARTIFACT_TOOL_NAMES.has(toolName);
}

export async function executeArtifactTool(
  toolName: string,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case "artifacts.create":
      return artifactsCreate(args, config);
    case "documents.create":
      return documentsCreate(args, config);
    case "presentations.create":
      return presentationsCreate(args, config);
    default:
      throw new Error(`Unsupported artifact tool executor: ${toolName}`);
  }
}

async function artifactsCreate(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const p = required(args.path, "path");
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  const title = asString(args.title) ?? "Artifact";
  const template = asString(args.template) ?? "report";
  const body = asString(args.body) ?? "";
  const design = createArtifactDesignPlan({
    kind: "document",
    title,
    body,
    format: "markdown",
    design: args.design,
    destination: args.destination,
  });
  const out = [
    `# ${title}`,
    "",
    `Template: ${template}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    body || "_No content provided._",
    "",
  ].join("\n");
  const full = path.resolve(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, out, "utf8");
  return {
    path: full,
    bytesWritten: out.length,
    template,
    designReport: buildArtifactDesignReport(design, {
      localPath: full,
      usedAssetIds: [],
    }),
  };
}

async function documentsCreate(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const requestedPath = required(args.path, "path");
  const format = resolveDocumentFormat(asString(args.format), requestedPath);
  const p = ensureDocumentPath(requestedPath, format);
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  const full = path.resolve(p);
  let title = truncateText(asString(args.title) ?? inferTitleFromPath(full) ?? "Document", 120);
  let body = truncateText(asString(args.body) ?? asString(args.content) ?? "", 12000);
  let sections = normalizeDocumentSections(args.sections, body);
  const rows = normalizeDocumentRows(args.rows);
  const repair = repairDocumentDesignQuality({ title, body, sections });
  title = repair.title;
  body = repair.body;
  sections = repair.sections;
  const design = createArtifactDesignPlan({
    kind: documentDesignKind(format),
    title,
    body,
    sections,
    format,
    design: args.design,
    destination: args.destination,
  });
  const artifact = await createDocumentArtifact(format, {
    title,
    body,
    sections,
    rows,
    design,
  });
  await fs.mkdir(path.dirname(full), { recursive: true });
  if (artifact.binary) {
    await fs.writeFile(full, artifact.data);
  } else {
    await fs.writeFile(full, artifact.data, "utf8");
  }
  return {
    path: full,
    bytesWritten: Buffer.isBuffer(artifact.data) ? artifact.data.length : Buffer.byteLength(artifact.data, "utf8"),
    format,
    mimeType: artifact.mimeType,
    title,
    sectionCount: sections.length,
    designReport: buildArtifactDesignReport(design, {
      localPath: full,
      usedAssetIds: usedDocumentAssetIds(format, design.mode),
      designQuality: {
        retryAttempted: design.mode !== "minimal" && design.mode !== "plain",
        findings: [
          ...repair.findings,
          ...documentAssetSpecificityFindings(format, design.mode, Boolean(args.visualAsset)),
        ],
      },
    }),
  };
}

async function presentationsCreate(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const requestedPath = required(args.path, "path");
  const p = ensurePptxPath(requestedPath);
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  let title = truncateText(asString(args.title) ?? "Presentation", 120);
  let subtitle = truncateText(asString(args.subtitle) ?? "", 180);
  let slides = normalizePresentationSlides(args.slides, title, asString(args.body));
  const repair = repairPresentationDesignQuality({ title, subtitle, slides });
  title = repair.title;
  subtitle = repair.subtitle;
  slides = repair.slides;
  const design = createArtifactDesignPlan({
    kind: "presentation",
    title,
    body: subtitle,
    slides,
    format: "pptx",
    design: normalizePresentationDesignInput(args),
    destination: args.destination,
  });
  const deckSlides: PresentationSlide[] = [
    {
      title,
      bullets: subtitle ? [subtitle] : [],
    },
    ...slides,
  ];
  const deckQuality = analyzePresentationDeckQuality(design, deckSlides);
  const visualAsset = normalizePresentationVisualAsset(args.visualAsset);
  const pptx = await createPresentationPptxWithDiagnostics({
    title,
    subtitle: subtitle || undefined,
    slides,
    design,
    visualAsset,
  });
  const full = path.resolve(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, pptx.buffer);
  return {
    path: full,
    bytesWritten: pptx.buffer.length,
    format: "pptx",
    title,
    slideCount: slides.length + 1,
    renderer: pptx.renderer,
    warnings: pptx.warnings,
    visualAsset: visualAsset
      ? {
          source: visualAsset.source,
          sourceModel: visualAsset.sourceModel,
          mimeType: visualAsset.mimeType,
        }
      : undefined,
    designReport: buildArtifactDesignReport(design, {
      localPath: full,
      usedAssetIds: pptx.usedAssetIds,
      validationResults: presentationValidationResults(deckQuality, pptx),
      residualRisks: buildPresentationResidualRisks(pptx.warnings, [
        ...repair.findings,
        ...presentationQualityFindings(deckQuality),
        ...presentationAssetSpecificityFindings(visualAsset, design.mode),
      ]),
      designQuality: {
        retryAttempted: design.mode !== "minimal" && design.mode !== "plain",
        findings: [
          ...repair.findings,
          ...presentationQualityFindings(deckQuality),
          ...presentationAssetSpecificityFindings(visualAsset, design.mode),
        ],
      },
    }),
  };
}

function buildPresentationResidualRisks(
  warnings: readonly string[],
  findings: readonly ArtifactDesignQualityFinding[],
): string[] | undefined {
  const risks = [...warnings, ...findings.map((finding) => finding.message)];
  return risks.length > 0 ? risks : undefined;
}

function presentationValidationResults(
  quality: PresentationDeckQualitySummary,
  pptx?: PresentationPptxDiagnostics,
): Record<string, Partial<Pick<ArtifactValidationCheck, "status" | "detail">>> {
  const templateWarnings = [...(quality.templateWarnings ?? []), ...(pptx?.fallbackTriggered ? pptx.warnings : [])];
  const contentWarnings = quality.contentWarnings ?? [];
  const templateStatus = templateWarnings.length > 0 ? "warning" : "passed";
  const contentDensityStatus = contentWarnings.length > 0 ? "warning" : "passed";
  const rendererSummary = Object.entries(quality.rendererCounts)
    .filter(([, count]) => count > 0)
    .map(([renderer, count]) => `${renderer}:${count}`)
    .join(", ");
  return {
    "presentation-template": {
      status: templateStatus,
      detail:
        templateStatus === "passed"
          ? `Resolved ${quality.contentSlideCount} content slide(s) through content-aware templates${
              rendererSummary ? ` (${rendererSummary})` : ""
            }.`
          : templateWarnings.join(" "),
    },
    "content-density": {
      status: contentDensityStatus,
      detail:
        contentDensityStatus === "passed"
          ? `Checked ${quality.contentSlideCount} content slide(s); sparse slides avoid forced columns and dense slides use column layouts.`
          : contentWarnings.join(" "),
    },
  };
}

function repairDocumentDesignQuality(input: { title: string; body: string; sections: DocumentArtifactSection[] }): {
  title: string;
  body: string;
  sections: DocumentArtifactSection[];
  findings: ArtifactDesignQualityFinding[];
} {
  const findings: ArtifactDesignQualityFinding[] = [];
  const title = repairVisibleArtifactText(input.title, "Document", findings);
  const body = repairVisibleArtifactText(input.body, "", findings);
  const sections = input.sections.map((section, index) => ({
    heading: repairVisibleArtifactText(section.heading, `Section ${index + 1}`, findings),
    body: repairVisibleArtifactText(section.body, "", findings),
    bullets: section.bullets
      .map((bullet) => repairVisibleArtifactText(bullet, "", findings))
      .filter((bullet) => bullet.length > 0),
  }));
  return {
    title,
    body,
    sections,
    findings: dedupeDesignQualityFindings(findings),
  };
}

function repairPresentationDesignQuality(input: { title: string; subtitle: string; slides: PresentationSlide[] }): {
  title: string;
  subtitle: string;
  slides: PresentationSlide[];
  findings: ArtifactDesignQualityFinding[];
} {
  const findings: ArtifactDesignQualityFinding[] = [];
  const title = repairVisibleArtifactText(input.title, "Presentation", findings);
  const subtitle = repairVisibleArtifactText(input.subtitle, "", findings);
  const slides = input.slides.map((slide, index) => ({
    title: repairVisibleArtifactText(slide.title, `Slide ${index + 1}`, findings),
    bullets: slide.bullets
      .map((bullet) => repairVisibleArtifactText(bullet, "", findings))
      .filter((bullet) => bullet.length > 0),
    speakerNotes: slide.speakerNotes,
  }));
  return {
    title,
    subtitle,
    slides,
    findings: dedupeDesignQualityFindings(findings),
  };
}

function repairVisibleArtifactText(value: string, fallback: string, findings: ArtifactDesignQualityFinding[]): string {
  const cleaned = value
    .replace(/\bGoatCitadel design brief\s*-\s*[a-z0-9-]+\b/giu, "")
    .replace(/\bDesign(?:ed)? artifact\b/giu, "")
    .replace(/\bDesign preset:\s*[a-z0-9-]+\b/giu, "")
    .replace(/\bAsset provenance:[^\r\n]*/giu, "")
    .replace(/\bImage Text\b/giu, "")
    .replace(/\bplaceholder text\b/giu, "")
    .replace(/\blorem\s+ipsum\b/giu, "")
    .replace(/<PLACEHOLDER[^>]*>/giu, "")
    .replace(/\bTODO_PLACEHOLDER\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned !== value.trim()) {
    findings.push({
      id: "visible-placeholder-copy",
      severity: "P1",
      dimension: "State Completeness",
      message: "Visible placeholder, renderer, or provenance copy was removed before artifact output.",
      repaired: true,
    });
  }
  return cleaned || fallback;
}

function dedupeDesignQualityFindings(
  findings: readonly ArtifactDesignQualityFinding[],
): ArtifactDesignQualityFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.id}:${finding.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function presentationQualityFindings(quality: PresentationDeckQualitySummary): ArtifactDesignQualityFinding[] {
  return dedupeDesignQualityFindings(
    [...(quality.templateWarnings ?? []), ...(quality.contentWarnings ?? [])].map((warning) => ({
      id: "layout-integrity",
      severity: "P2",
      dimension: "Responsiveness",
      message: warning,
      repaired: false,
    })),
  );
}

function presentationAssetSpecificityFindings(
  visualAsset: PresentationVisualAsset | undefined,
  mode: string,
): ArtifactDesignQualityFinding[] {
  if (visualAsset || mode === "minimal" || mode === "plain") {
    return [];
  }
  return [
    {
      id: "asset-specificity",
      severity: "P2",
      dimension: "Visual Coherence",
      message: "Presentation used local renderer-only visuals because no provider-generated visual asset was supplied.",
      repaired: false,
    },
  ];
}

function documentAssetSpecificityFindings(
  format: DocumentArtifactFormat,
  mode: string,
  hasVisualAsset: boolean,
): ArtifactDesignQualityFinding[] {
  if (hasVisualAsset || mode === "minimal" || mode === "plain" || format !== "docx") {
    return [];
  }
  return [
    {
      id: "asset-specificity",
      severity: "P3",
      dimension: "Visual Coherence",
      message: "DOCX output used local decorative renderer visuals rather than provider-generated imagery.",
      repaired: false,
    },
  ];
}

function documentDesignKind(format: DocumentArtifactFormat): "document" | "html" | "pdf" | "data" {
  switch (format) {
    case "html":
      return "html";
    case "pdf":
      return "pdf";
    case "json":
    case "csv":
    case "txt":
      return "data";
    default:
      return "document";
  }
}

function normalizePresentationDesignInput(args: Record<string, unknown>): unknown {
  if (args.design !== undefined) {
    return args.design;
  }
  const theme = asString(args.theme);
  return theme ? { preset: theme } : undefined;
}

function usedDocumentAssetIds(format: DocumentArtifactFormat, mode: string): string[] {
  if (mode === "minimal" || mode === "plain") {
    return [];
  }
  switch (format) {
    case "docx":
      return ["renderer-generated-visual", "built-in-shapes-icons"];
    case "html":
      return ["built-in-shapes-icons"];
    default:
      return [];
  }
}

function resolveDocumentFormat(rawFormat: string | undefined, requestedPath: string): DocumentArtifactFormat {
  const raw = (rawFormat ?? path.extname(requestedPath).replace(/^\./, "")).trim().toLowerCase();
  switch (raw) {
    case "":
    case "md":
    case "markdown":
      return "markdown";
    case "txt":
    case "text":
      return "txt";
    case "html":
    case "htm":
      return "html";
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "doc":
    case "docx":
    case "word":
      return "docx";
    case "pdf":
      return "pdf";
    default:
      throw new Error(`Unsupported document format: ${raw}`);
  }
}

function ensureDocumentPath(value: string, format: DocumentArtifactFormat): string {
  const extension = documentArtifactExtension(format);
  if (new RegExp(`${escapeRegExp(extension)}$`, "i").test(value)) {
    return value;
  }
  const parsed = path.parse(value);
  const fileName = parsed.name ? `${parsed.name}${extension}` : `document${extension}`;
  return path.join(parsed.dir, fileName);
}

function inferTitleFromPath(value: string): string | undefined {
  const baseName = path.basename(value, path.extname(value)).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!baseName) {
    return undefined;
  }
  return baseName.replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeDocumentSections(value: unknown, fallbackBody: string): DocumentArtifactSection[] {
  const rawSections = Array.isArray(value) ? value : [];
  const sections = rawSections
    .map((item, index) => {
      const section = record(item);
      const heading = truncateText(asString(section.heading) ?? asString(section.title) ?? `Section ${index + 1}`, 100);
      const body = truncateText(asString(section.body) ?? asString(section.content) ?? "", 2000);
      const bullets = normalizeDocumentBullets(section.bullets);
      return { heading, body, bullets };
    })
    .filter((section) => section.heading || section.body || section.bullets.length > 0)
    .slice(0, 40);
  if (sections.length > 0) {
    return sections;
  }
  return fallbackBody ? [{ heading: "Summary", body: fallbackBody, bullets: [] }] : [];
}

function normalizeDocumentRows(value: unknown): Array<Record<string, unknown> | unknown[]> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .map((item) => (Array.isArray(item) ? item : record(item)))
    .filter((item) => (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0))
    .slice(0, 500);
}

function normalizeDocumentBullets(value: unknown): string[] {
  const rawItems = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|;/g) : [];
  return rawItems
    .map((item) => truncateText(asString(item) ?? "", 220))
    .filter((item) => item.length > 0)
    .slice(0, 12);
}

function ensurePptxPath(value: string): string {
  if (/\.pptx$/i.test(value)) {
    return value;
  }
  const parsed = path.parse(value);
  const fileName = parsed.name ? `${parsed.name}.pptx` : "presentation.pptx";
  return path.join(parsed.dir, fileName);
}

function normalizePresentationSlides(
  value: unknown,
  fallbackTitle: string,
  fallbackBody?: string,
): PresentationSlide[] {
  const rawSlides = Array.isArray(value) ? value : [];
  const slides = rawSlides
    .map((item, index) => {
      const slide = record(item);
      const title = truncateText(asString(slide.title) ?? `Slide ${index + 1}`, 100);
      const bullets = normalizePresentationBullets(slide.bullets);
      return {
        title,
        bullets,
        speakerNotes: truncateText(asString(slide.speakerNotes) ?? "", 600) || undefined,
      } satisfies PresentationSlide;
    })
    .filter((slide) => slide.title || slide.bullets.length > 0)
    .slice(0, 40);
  if (slides.length > 0) {
    return slides;
  }
  const fallbackBullets = normalizePresentationBullets(fallbackBody);
  return [{ title: fallbackTitle, bullets: fallbackBullets }];
}

function normalizePresentationBullets(value: unknown): string[] {
  const rawItems = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|;/g) : [];
  return rawItems
    .map((item) => truncateText(asString(item) ?? "", 180))
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

function normalizePresentationVisualAsset(value: unknown): PresentationVisualAsset | undefined {
  const asset = record(value);
  const bytesBase64 = asString(asset.bytesBase64) ?? asString(asset.b64Json) ?? asString(asset.dataBase64);
  if (!bytesBase64) {
    return undefined;
  }
  const mimeType = asString(asset.mimeType) ?? "image/png";
  if (!mimeType.toLowerCase().startsWith("image/")) {
    return undefined;
  }
  return {
    bytesBase64,
    mimeType,
    altText: truncateText(asString(asset.altText) ?? "", 220) || undefined,
    source: truncateText(asString(asset.source) ?? "", 80) || undefined,
    sourceModel: truncateText(asString(asset.sourceModel) ?? asString(asset.model) ?? "", 80) || undefined,
    revisedPrompt: truncateText(asString(asset.revisedPrompt) ?? "", 600) || undefined,
  };
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value
    .trim()
    .replace(/\s+/g, " ")
    // Strip XML-1.0-illegal control chars (\t \n \r were already collapsed above) so the
    // generated docx/pptx XML stays well-formed on both the styled and fallback render paths.
    // eslint-disable-next-line no-control-regex -- intentionally matching C0 control chars
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...` : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!["__proto__", "prototype", "constructor"].includes(key)) {
        output[key] = item;
      }
    }
    return output;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function required(value: unknown, field: string): string {
  const out = asString(value);
  if (!out) {
    throw new Error(`Missing required argument: ${field}`);
  }
  return out;
}
