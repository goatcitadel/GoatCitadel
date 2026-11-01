import fs from "node:fs/promises";
import path from "node:path";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
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
  normalizePresentationResearch,
  normalizePresentationSlides,
  normalizePresentationSources,
  normalizePresentationText,
  preparePresentationSlides,
  presentationSlideText,
  validatePresentationVisibleContent,
  validateResearchPresentation,
  type PresentationRenderManifest,
  type PresentationResearch,
} from "../presentation-model.js";
import { createPresentationPdf, type PresentationPdfInput } from "../presentation-pdf.js";
import {
  createPresentationPptxWithDiagnostics,
  type PresentationPackageAuditor,
  type PresentationPptxDiagnostics,
  type PresentationSlide,
  type PresentationVisualAsset,
} from "../presentation-pptx.js";
import type { PreparePresentationVisuals, PreparedPresentationVisuals } from "../presentation-visual-runtime.js";
import { assertToolWritePath } from "../sandbox/tool-write-gate.js";

const ARTIFACT_TOOL_NAMES = new Set(["artifacts.create", "documents.create", "presentations.create"]);
const DESIGN_SKILL_NAMES = new Set(["impeccable", "design-intelligence"]);
// Every renderer wraps and paginates bullets, so the bullet cap only guards against runaway input;
// anything still cut or dropped is reported back in the result's warnings.
const DOCUMENT_TEXT_LIMITS = {
  title: 120,
  body: 12000,
  heading: 100,
  sectionBody: 2000,
  bullet: 1200,
  sections: 40,
  bulletsPerSection: 12,
} as const;

interface PresentationArtifactRuntime {
  request?: ToolInvokeRequest;
  preparePresentationVisuals?: PreparePresentationVisuals;
  presentationPackageAuditor?: PresentationPackageAuditor;
}

export function isArtifactToolName(toolName: string): boolean {
  return ARTIFACT_TOOL_NAMES.has(toolName);
}

export async function executeArtifactTool(
  toolName: string,
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  runtime: PresentationArtifactRuntime = {},
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case "artifacts.create":
      return artifactsCreate(args, config);
    case "documents.create":
      return documentsCreate(args, config, runtime);
    case "presentations.create":
      return presentationsCreate(args, config, runtime);
    default:
      throw new Error(`Unsupported artifact tool executor: ${toolName}`);
  }
}

async function artifactsCreate(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const p = required(args.path, "path");
  assertToolWritePath(p, config.sandbox);
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

async function documentsCreate(
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  runtime: PresentationArtifactRuntime,
) {
  const requestedPath = required(args.path, "path");
  const format = resolveDocumentFormat(asString(args.format), requestedPath);
  const p = ensureDocumentPath(requestedPath, format);
  assertToolWritePath(p, config.sandbox);
  const full = path.resolve(p);
  let title = truncateText(asString(args.title) ?? inferTitleFromPath(full) ?? "Document", DOCUMENT_TEXT_LIMITS.title);
  let body = truncateText(asString(args.body) ?? asString(args.content) ?? "", DOCUMENT_TEXT_LIMITS.body);
  const truncationWarnings = documentTruncationWarnings(args);
  let sections = normalizeDocumentSections(args.sections, body);
  // With no usable sections, the body is also repeated as a generated "Summary" section; renderers
  // that already show the body (the PDF cover callout) skip that one section.
  const bodySummaryIsFallback = normalizeDocumentSections(args.sections, "").length === 0 && sections.length > 0;
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
    bodySummaryIsFallback,
    rows,
    design,
    // Present only when the gateway admitted model-authored markup under a design receipt.
    html: typeof args.html === "string" ? args.html : undefined,
  });
  await fs.mkdir(path.dirname(full), { recursive: true });
  if (artifact.binary) {
    await fs.writeFile(full, artifact.data);
  } else {
    await fs.writeFile(full, artifact.data, "utf8");
  }
  const warnings = [...truncationWarnings, ...(artifact.warnings ?? [])];
  return {
    path: full,
    bytesWritten: Buffer.isBuffer(artifact.data) ? artifact.data.length : Buffer.byteLength(artifact.data, "utf8"),
    format,
    mimeType: artifact.mimeType,
    title,
    sectionCount: sections.length,
    ...(warnings.length > 0 ? { warnings } : {}),
    designReport: buildArtifactDesignReport(design, {
      localPath: full,
      markup: artifact.markup,
      usedAssetIds: usedDocumentAssetIds(format, design.mode),
      ...(artifact.renderedLayouts ? { renderedLayouts: artifact.renderedLayouts } : {}),
      residualRisks: warnings,
      designQuality: {
        retryAttempted: design.mode !== "minimal" && design.mode !== "plain",
        findings: [
          ...repair.findings,
          ...documentAssetSpecificityFindings(format, design.mode, Boolean(args.visualAsset)),
        ],
        runtimeInstructions: runtimeDesignInstructions(runtime.request),
      },
    }),
  };
}

/**
 * The receipt counts as injected only when a design skill (impeccable or design-intelligence)
 * was among the turn's activated skills; another skill's instructions are not a design receipt.
 */
function runtimeDesignInstructions(request: ToolInvokeRequest | undefined): {
  status: "injected" | "not_injected";
  skills: NonNullable<ToolInvokeRequest["runtimeSkillApplications"]>;
} {
  const skills = (request?.runtimeSkillApplications ?? []).filter((skill) =>
    DESIGN_SKILL_NAMES.has(skill.skillId.slice(skill.skillId.lastIndexOf(":") + 1).toLowerCase()),
  );
  return { status: skills.length > 0 ? "injected" : "not_injected", skills };
}

async function presentationsCreate(
  args: Record<string, unknown>,
  config: ToolPolicyConfig,
  runtime: PresentationArtifactRuntime,
) {
  const requestedPath = required(args.path, "path");
  const format = resolvePresentationFormat(asString(args.format), requestedPath);
  const p = ensurePresentationPath(requestedPath, format);
  assertToolWritePath(p, config.sandbox);
  assertStructuredResearchGrounding(args, runtime.request);
  assertNoModelCallablePresentationNotes(args.slides);
  const title = normalizePresentationText(required(args.title, "title"));
  const subtitle = normalizePresentationText(asString(args.subtitle) ?? "");
  const normalizedSources = normalizePresentationSources(args.sources);
  const research = normalizePresentationResearch(args.research);
  const normalizedSlides = normalizePresentationSlides(
    args.slides,
    title,
    asString(args.body),
    normalizedSources.aliases,
  );
  validatePresentationVisibleContent({
    title,
    subtitle: subtitle || undefined,
    slides: normalizedSlides,
    sources: normalizedSources.sources,
  });
  const slides = preparePresentationSlides(normalizedSlides, normalizedSources.sources);
  validateResearchPresentation(
    research,
    normalizedSources.sources,
    slides.filter((slide) => !slide.generatedSourceAppendix),
  );
  const design = createArtifactDesignPlan({
    kind: "presentation",
    title,
    body: subtitle,
    slides: slides.map((slide) => ({
      title: slide.title,
      bullets: presentationSlideText(slide),
      speakerNotes: slide.speakerNotes,
    })),
    format,
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
  const visualAsset = normalizePresentationVisualAsset(args.visualAsset);
  const preVisualDeckQuality = analyzePresentationDeckQuality(design, deckSlides);
  assertPresentationLayoutQualityBeforeVisuals(preVisualDeckQuality, design.mode, Boolean(research));
  const preparedVisuals = await preparePresentationVisuals(runtime, slides);
  const mappedVisualSlideIndexes = new Set(preparedVisuals.assets.map((item) => item.slideIndex));
  const deckQuality = analyzePresentationDeckQuality(design, deckSlides, mappedVisualSlideIndexes);
  const rendererInput: PresentationPdfInput = {
    title,
    subtitle: subtitle || undefined,
    slides,
    sources: normalizedSources.sources,
    design,
    visualAsset,
    visualAssets: preparedVisuals.assets.map((item) => ({ slideIndex: item.slideIndex, asset: item.asset })),
  };
  const rendered =
    format === "pdf"
      ? await renderPresentationPdfArtifact(rendererInput, deckQuality)
      : await renderPresentationPptxArtifact({ ...rendererInput, research }, deckQuality, runtime);
  const full = path.resolve(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, rendered.buffer);
  return {
    path: full,
    bytesWritten: rendered.buffer.length,
    format,
    mimeType: rendered.mimeType,
    title,
    slideCount: rendered.manifest.slideCount,
    renderer: rendered.renderer,
    warnings: [...preparedVisuals.warnings, ...rendered.warnings],
    visualAsset: visualAsset
      ? {
          source: visualAsset.source,
          sourceModel: visualAsset.sourceModel,
          mimeType: visualAsset.mimeType,
        }
      : undefined,
    visualAssets: preparedVisuals.assets.map((item) => ({
      slideIndex: item.slideIndex,
      source: item.asset.source,
      sourceModel: item.asset.sourceModel,
      mimeType: item.asset.mimeType,
      promptSha256: item.promptSha256,
    })),
    visualPlan: preparedVisuals.plan,
    visualProviderCalls: preparedVisuals.providerCalls,
    research: research
      ? {
          asOfDate: research.asOfDate,
          geography: research.geography,
          sourceCount: normalizedSources.sources.length,
        }
      : undefined,
    renderManifest: rendered.manifest,
    packageAudit: rendered.packageAudit,
    designReport: buildArtifactDesignReport(design, {
      localPath: full,
      usedAssetIds: rendered.usedAssetIds,
      providerVisualSupplied: Boolean(visualAsset) || preparedVisuals.assets.length > 0,
      validationResults: rendered.validationResults,
      residualRisks: buildPresentationResidualRisks(
        [...preparedVisuals.warnings, ...rendered.warnings],
        [
          ...presentationQualityFindings(deckQuality),
          ...presentationAssetSpecificityFindings(visualAsset, preparedVisuals.assets.length, design.mode),
        ],
      ),
      designQuality: {
        retryAttempted: rendered.retryAttempted,
        findings: [
          ...presentationQualityFindings(deckQuality),
          ...presentationAssetSpecificityFindings(visualAsset, preparedVisuals.assets.length, design.mode),
        ],
        runtimeInstructions: runtimeDesignInstructions(runtime.request),
        contentGrounding: {
          status: runtime.request?.presentationGrounding ? "passed" : "warning",
          detail: runtime.request?.presentationGrounding
            ? `The Gateway content-quality gate admitted this deck before artifact dispatch (${runtime.request.presentationGrounding.matchedSourceTermCount}/${runtime.request.presentationGrounding.sourceTermCount} bounded source concepts represented${runtime.request.presentationGrounding.sourceUrlCount !== undefined ? `; ${runtime.request.presentationGrounding.matchedSourceUrlCount}/${runtime.request.presentationGrounding.sourceUrlCount} source URLs preserved` : ""}).`
            : "No Gateway presentation-grounding receipt was attached to this direct artifact invocation.",
        },
        visualLayout: {
          status: preparedVisuals.warnings.length > 0 || rendered.warnings.length > 0 ? "warning" : "passed",
          detail:
            preparedVisuals.warnings.length > 0 || rendered.warnings.length > 0
              ? [...preparedVisuals.warnings, ...rendered.warnings].join(" ")
              : `Rendered ${slides.length + 1} slides with ${preparedVisuals.assets.length + (visualAsset ? 1 : 0)} provider visual(s) and content-aware native layouts.`,
        },
      },
    }),
  };
}

type PresentationArtifactFormat = "pptx" | "pdf";

interface RenderedPresentationArtifact {
  buffer: Buffer;
  mimeType: string;
  manifest: PresentationRenderManifest;
  renderer: PresentationPptxDiagnostics["renderer"] | "native-pdf";
  warnings: string[];
  usedAssetIds: string[];
  retryAttempted: boolean;
  packageAudit?: PresentationPptxDiagnostics["packageAudit"];
  validationResults: Record<string, Partial<Pick<ArtifactValidationCheck, "status" | "detail">>>;
}

async function renderPresentationPptxArtifact(
  input: PresentationPdfInput & { research?: PresentationResearch },
  deckQuality: PresentationDeckQualitySummary,
  runtime: PresentationArtifactRuntime,
): Promise<RenderedPresentationArtifact> {
  const pptx = await createPresentationPptxWithDiagnostics(
    { ...input, slidesPrepared: true },
    runtime.presentationPackageAuditor ? { auditPackage: runtime.presentationPackageAuditor } : {},
  );
  return {
    buffer: pptx.buffer,
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    manifest: pptx.manifest,
    renderer: pptx.renderer,
    warnings: pptx.warnings,
    usedAssetIds: pptx.usedAssetIds,
    retryAttempted: pptx.retryAttempted,
    packageAudit: pptx.packageAudit,
    validationResults: presentationValidationResults(deckQuality, pptx),
  };
}

async function renderPresentationPdfArtifact(
  input: PresentationPdfInput,
  deckQuality: PresentationDeckQualitySummary,
): Promise<RenderedPresentationArtifact> {
  const pdf = await createPresentationPdf(input);
  return {
    buffer: pdf.buffer,
    mimeType: "application/pdf",
    manifest: pdf.manifest,
    renderer: "native-pdf",
    warnings: pdf.warnings,
    usedAssetIds: pdf.usedAssetIds,
    retryAttempted: false,
    validationResults: {
      ...presentationValidationResults(deckQuality),
      "pdf-render": {
        status: pdf.warnings.length > 0 ? "warning" : "passed",
        detail:
          pdf.warnings.length > 0
            ? pdf.warnings.join(" ")
            : `Rendered ${pdf.manifest.slideCount} landscape slide page(s) with the deck design tokens and standard PDF fonts.`,
      },
    },
  };
}

function resolvePresentationFormat(value: string | undefined, requestedPath: string): PresentationArtifactFormat {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "pdf") return "pdf";
  if (normalized && !["pptx", "ppt", "powerpoint"].includes(normalized)) {
    throw new Error(`presentations.create format must be "pptx" or "pdf"; received "${value}".`);
  }
  return !normalized && /\.pdf$/iu.test(requestedPath) ? "pdf" : "pptx";
}

function assertPresentationLayoutQualityBeforeVisuals(
  quality: PresentationDeckQualitySummary,
  designMode: string,
  research: boolean,
): void {
  if ((designMode === "polished" || research) && quality.templateWarnings.length > 0) {
    throw new Error(`Presentation layout validation failed: ${quality.templateWarnings.join(" ")}`);
  }
}

function assertNoModelCallablePresentationNotes(value: unknown): void {
  if (!Array.isArray(value)) return;
  const noteSlideIndex = value.findIndex(
    (slide) =>
      Boolean(slide) &&
      typeof slide === "object" &&
      !Array.isArray(slide) &&
      Object.prototype.hasOwnProperty.call(slide, "speakerNotes"),
  );
  if (noteSlideIndex >= 0) {
    throw new Error(
      `presentations.create does not accept model-authored speakerNotes (slide ${noteSlideIndex + 1}); trusted authored notes are available only through the direct presentation renderer API.`,
    );
  }
}

function assertStructuredResearchGrounding(
  args: Readonly<Record<string, unknown>>,
  request: ToolInvokeRequest | undefined,
): void {
  const hasStructuredResearch =
    Object.prototype.hasOwnProperty.call(args, "research") || Object.prototype.hasOwnProperty.call(args, "sources");
  if (!hasStructuredResearch) {
    return;
  }
  const receipt = request?.presentationGrounding;
  if (!receipt || !isValidPresentationGroundingReceipt(receipt)) {
    throw new Error(
      "Structured research presentations require a valid server-authored presentationGrounding receipt before artifact rendering.",
    );
  }
}

function isValidPresentationGroundingReceipt(
  receipt: NonNullable<ToolInvokeRequest["presentationGrounding"]>,
): boolean {
  if (
    !isNonNegativeSafeInteger(receipt.sourceTermCount) ||
    !isNonNegativeSafeInteger(receipt.matchedSourceTermCount) ||
    receipt.matchedSourceTermCount > receipt.sourceTermCount
  ) {
    return false;
  }
  const hasSourceUrlCount = receipt.sourceUrlCount !== undefined;
  const hasMatchedSourceUrlCount = receipt.matchedSourceUrlCount !== undefined;
  if (hasSourceUrlCount !== hasMatchedSourceUrlCount) {
    return false;
  }
  return (
    !hasSourceUrlCount ||
    (isNonNegativeSafeInteger(receipt.sourceUrlCount) &&
      isNonNegativeSafeInteger(receipt.matchedSourceUrlCount) &&
      receipt.matchedSourceUrlCount <= receipt.sourceUrlCount)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
    ...(pptx?.packageAudit
      ? {
          "pptx-package": {
            status: "passed" as const,
            detail: `In-package OOXML audit passed after ${pptx.retryAttempted ? "one deterministic repair" : "the first render"}; ${pptx.packageAudit.observed.slideCount} slide(s), ${pptx.packageAudit.observed.hyperlinkCount} hyperlink occurrence(s), and ${pptx.packageAudit.observed.authoredNoteCount} authored note(s) matched the manifest.`,
          },
        }
      : {}),
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
          ? `Checked ${quality.contentSlideCount} content slide(s); sparse slides avoid forced columns and dense slides use spacious native layouts.`
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
  preparedVisualCount: number,
  mode: string,
): ArtifactDesignQualityFinding[] {
  if (visualAsset || preparedVisualCount > 0 || mode === "minimal" || mode === "plain") {
    return [];
  }
  return [
    {
      id: "asset-specificity",
      severity: "P2",
      dimension: "Visual Coherence",
      message:
        "No provider image was supplied, so the deck carries no provider imagery; charts and tables are unaffected.",
      repaired: false,
    },
  ];
}

async function preparePresentationVisuals(
  input: {
    request?: ToolInvokeRequest;
    preparePresentationVisuals?: PreparePresentationVisuals;
  },
  slides: readonly PresentationSlide[],
): Promise<PreparedPresentationVisuals> {
  if (!input.request || !input.preparePresentationVisuals) {
    return { plan: [], assets: [], warnings: [], providerCalls: 0 };
  }
  return input.preparePresentationVisuals(input.request, slides);
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
      message: "No provider image was supplied, so the DOCX carries no provider imagery.",
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

/**
 * The path documents.create will actually write for these args (extension
 * applied), so policy checks and approvals see the same target as execution.
 */
export function resolveDocumentOutputPath(args: Record<string, unknown>): string | undefined {
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!requestedPath) return undefined;
  return ensureDocumentPath(requestedPath, resolveDocumentFormat(asString(args.format), requestedPath));
}

/** The path presentations.create will actually write for these args (extension applied). */
export function resolvePresentationOutputPath(args: Record<string, unknown>): string | undefined {
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!requestedPath) return undefined;
  return ensurePresentationPath(requestedPath, resolvePresentationFormat(asString(args.format), requestedPath));
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
      const heading = truncateText(
        asString(section.heading) ?? asString(section.title) ?? `Section ${index + 1}`,
        DOCUMENT_TEXT_LIMITS.heading,
      );
      const body = truncateText(
        asString(section.body) ?? asString(section.content) ?? "",
        DOCUMENT_TEXT_LIMITS.sectionBody,
      );
      const bullets = normalizeDocumentBullets(section.bullets);
      return { heading, body, bullets };
    })
    .filter((section) => section.heading || section.body || section.bullets.length > 0)
    .slice(0, DOCUMENT_TEXT_LIMITS.sections);
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

function rawDocumentBullets(value: unknown): unknown[] {
  return Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|;/g) : [];
}

function normalizeDocumentBullets(value: unknown): string[] {
  return rawDocumentBullets(value)
    .map((item) => truncateText(asString(item) ?? "", DOCUMENT_TEXT_LIMITS.bullet))
    .filter((item) => item.length > 0)
    .slice(0, DOCUMENT_TEXT_LIMITS.bulletsPerSection);
}

/** Length a field has after truncateText's whitespace collapse, before any cut. */
function normalizedTextLength(value: unknown): number {
  return (asString(value) ?? "").trim().replace(/\s+/g, " ").length;
}

/**
 * Names every limit that cut or dropped text from a documents.create call, so the model can split
 * the content and write again instead of reporting a complete document.
 */
function documentTruncationWarnings(args: Record<string, unknown>): string[] {
  const rawSections = Array.isArray(args.sections) ? args.sections.map(record) : [];
  const limits = DOCUMENT_TEXT_LIMITS;
  const counts = {
    title: normalizedTextLength(args.title) > limits.title ? 1 : 0,
    body: normalizedTextLength(args.body ?? args.content) > limits.body ? 1 : 0,
    headings: rawSections.filter((s) => normalizedTextLength(s.heading ?? s.title) > limits.heading).length,
    sectionBodies: rawSections.filter((s) => normalizedTextLength(s.body ?? s.content) > limits.sectionBody).length,
    bullets: rawSections.reduce(
      (total, s) =>
        total + rawDocumentBullets(s.bullets).filter((item) => normalizedTextLength(item) > limits.bullet).length,
      0,
    ),
    droppedBullets: rawSections.reduce(
      (total, s) =>
        total +
        Math.max(
          0,
          rawDocumentBullets(s.bullets).filter((item) => normalizedTextLength(item) > 0).length -
            limits.bulletsPerSection,
        ),
      0,
    ),
    droppedSections: Math.max(0, rawSections.length - limits.sections),
  };
  const cut = (count: number, what: string, limit: number) =>
    count > 0 ? [`Cut ${count} ${what} to ${limit} characters.`] : [];
  const parts = [
    ...cut(counts.title, "title", limits.title),
    ...cut(counts.body, "body", limits.body),
    ...cut(counts.headings, "section heading(s)", limits.heading),
    ...cut(counts.sectionBodies, "section body(ies)", limits.sectionBody),
    ...cut(counts.bullets, "bullet(s)", limits.bullet),
    ...(counts.droppedBullets > 0
      ? [`Dropped ${counts.droppedBullets} bullet(s) past ${limits.bulletsPerSection} per section.`]
      : []),
    ...(counts.droppedSections > 0 ? [`Dropped ${counts.droppedSections} section(s) past ${limits.sections}.`] : []),
  ];
  return parts.length > 0
    ? [`Some text is missing from the document: ${parts.join(" ")} Split the content and write the document again.`]
    : [];
}

function ensurePresentationPath(value: string, format: PresentationArtifactFormat): string {
  const extension = `.${format}`;
  if (value.toLowerCase().endsWith(extension)) {
    return value;
  }
  const parsed = path.parse(value);
  const fileName = parsed.name ? `${parsed.name}${extension}` : `presentation${extension}`;
  return path.join(parsed.dir, fileName);
}

function normalizePresentationVisualAsset(value: unknown): PresentationVisualAsset | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const asset = record(value);
  const bytesBase64 = asString(asset.bytesBase64) ?? asString(asset.b64Json) ?? asString(asset.dataBase64);
  if (!bytesBase64) {
    throw new Error("Presentation visualAsset requires non-empty image bytes.");
  }
  const mimeType = asString(asset.mimeType) ?? "image/png";
  if (!mimeType.toLowerCase().startsWith("image/")) {
    throw new Error("Presentation visualAsset mimeType must be an image type.");
  }
  return {
    bytesBase64,
    mimeType,
    altText: normalizePresentationText(asString(asset.altText) ?? "") || undefined,
    source: normalizePresentationText(asString(asset.source) ?? "") || undefined,
    sourceModel: normalizePresentationText(asString(asset.sourceModel) ?? asString(asset.model) ?? "") || undefined,
    revisedPrompt: normalizePresentationText(asString(asset.revisedPrompt) ?? "") || undefined,
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
