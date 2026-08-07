import { createArtifactDesignPlan, type ArtifactDesignPlan } from "./artifact-design.js";
import {
  analyzePresentationDeckQuality,
  resolvePresentationDeckLayoutPlan,
  type PresentationSlideLayoutDecision,
} from "./presentation-layout.js";
import {
  buildPresentationRenderManifest,
  preparePresentationSlides,
  normalizePresentationText,
  presentationSlideText,
  validatePresentationCapacity,
  validatePresentationVisibleContent,
  validateResearchPresentation,
  validateTrustedPresentationNotes,
  type PresentationRenderManifest,
  type PresentationResearch,
  type PresentationSlide,
  type PresentationSource,
} from "./presentation-model.js";
import {
  createFallbackPresentationPptx,
  resolveFallbackPresentationLayoutNames,
} from "./presentation-pptx-fallback.js";
import {
  auditPresentationPptxPackage,
  type PresentationPackageAuditExpectation,
  type PresentationPackageAuditReport,
  type PresentationPackageAuditor,
} from "./presentation-pptx-audit.js";
import {
  buildAuthoredNotes,
  drawPresentationSlide,
  type PptxPresentationLike as RenderPptxPresentationLike,
  type PptxSlideLike,
} from "./presentation-pptx-renderers.js";

export { createStoredZip, type ZipEntry } from "./presentation-pptx-fallback.js";
export { createFallbackPresentationPptx };
export {
  auditPresentationPptxPackage,
  readPresentationZipEntries,
  type PresentationPackageAuditExpectation,
  type PresentationPackageAuditFinding,
  type PresentationPackageAuditObserved,
  type PresentationPackageAuditReport,
  type PresentationPackageAuditor,
} from "./presentation-pptx-audit.js";
export type {
  PresentationArchetype,
  PresentationBullet,
  PresentationChart,
  PresentationChartSeries,
  PresentationClaimKind,
  PresentationRenderManifest,
  PresentationResearch,
  PresentationRichBullet,
  PresentationSlide,
  PresentationSource,
  PresentationSourceRole,
  PresentationTable,
  PresentationTableCell,
} from "./presentation-model.js";

export interface PresentationVisualAsset {
  bytesBase64: string;
  mimeType?: string;
  altText?: string;
  source?: string;
  sourceModel?: string;
  revisedPrompt?: string;
}

export interface PresentationPptxInput {
  title: string;
  subtitle?: string;
  slides: PresentationSlide[];
  createdAt?: Date;
  design?: ArtifactDesignPlan;
  visualAsset?: PresentationVisualAsset;
  /** Ephemeral server-owned assets mapped to final deck slide indexes (cover is 0). */
  visualAssets?: Array<{ slideIndex: number; asset: PresentationVisualAsset }>;
  research?: PresentationResearch;
  sources?: PresentationSource[];
  /** Set only by the policy executor after deterministic pagination and source appendix generation. */
  slidesPrepared?: boolean;
}

export interface PresentationSlideVisual {
  dataUri: string;
  source: string;
  altText: string;
}

export interface PresentationPptxDiagnostics {
  renderer: "pptxgenjs" | "fallback";
  fallbackTriggered: boolean;
  warnings: string[];
  usedAssetIds: string[];
  retryAttempted: boolean;
  packageAudit?: PresentationPackageAuditReport;
  errorMessage?: string;
}

export interface PresentationPptxResult extends PresentationPptxDiagnostics {
  buffer: Buffer;
  manifest: PresentationRenderManifest;
}

type PptxOutput = string | ArrayBuffer | Blob | Uint8Array;

interface PptxPresentationLike extends RenderPptxPresentationLike {
  layout: string;
  author: string;
  company: string;
  subject: string;
  title: string;
  theme: { headFontFace?: string; bodyFontFace?: string };
  ChartType?: Record<string, string>;
  addSlide(): PptxSlideLike;
  write(options: { outputType: "nodebuffer"; compression: boolean }): Promise<PptxOutput>;
}

type PptxGenConstructor = new () => PptxPresentationLike;

export interface PresentationPptxRuntime {
  auditPackage?: PresentationPackageAuditor;
}

export class PresentationPackageAuditError extends Error {
  public constructor(
    public readonly firstAudit: PresentationPackageAuditReport,
    public readonly secondAudit?: PresentationPackageAuditReport,
    detail?: string,
  ) {
    const findings = (secondAudit ?? firstAudit).findings.map((item) => `${item.id}: ${item.message}`).join(" ");
    super(
      `Presentation package failed structural validation after one deterministic repair. ${findings}${detail ? ` ${detail}` : ""}`,
    );
    this.name = "PresentationPackageAuditError";
  }
}

export async function createPresentationPptx(input: PresentationPptxInput): Promise<Buffer> {
  return (await createPresentationPptxWithDiagnostics(input)).buffer;
}

export async function createPresentationPptxWithDiagnostics(
  input: PresentationPptxInput,
  runtime: PresentationPptxRuntime = {},
): Promise<PresentationPptxResult> {
  const preparedInput = preparePresentationPptxInput(input);
  const auditPackage = runtime.auditPackage ?? auditPresentationPptxPackage;
  const mustAudit = Boolean(preparedInput.research || preparedInput.sources?.length || runtime.auditPackage);
  try {
    const rendered = await createPptxGenPresentation(preparedInput);
    if (mustAudit) {
      const firstAudit = await auditRenderedPresentation(auditPackage, rendered, preparedInput, "pptxgenjs");
      if (!firstAudit.passed) {
        return rerenderAfterAuditFailure(preparedInput, firstAudit, auditPackage);
      }
      return {
        ...rendered,
        renderer: "pptxgenjs",
        fallbackTriggered: false,
        warnings: [],
        usedAssetIds: ["renderer-generated-visual", "built-in-shapes-icons"],
        retryAttempted: false,
        packageAudit: firstAudit,
      };
    }
    return {
      ...rendered,
      renderer: "pptxgenjs",
      fallbackTriggered: false,
      warnings: [],
      usedAssetIds: ["renderer-generated-visual", "built-in-shapes-icons"],
      retryAttempted: false,
    };
  } catch (error) {
    if (error instanceof PresentationPackageAuditError) {
      throw error;
    }
    const errorMessage = summarizePresentationRenderError(error);
    return renderAuditedFallback(preparedInput, errorMessage, mustAudit, auditPackage);
  }
}

async function rerenderAfterAuditFailure(
  input: PresentationPptxInput,
  firstAudit: PresentationPackageAuditReport,
  auditPackage: PresentationPackageAuditor,
): Promise<PresentationPptxResult> {
  const repairedInput = deterministicallyRepairPresentationInput(input);
  assertPresentationLayoutQuality(repairedInput);
  let rendered: { buffer: Buffer; manifest: PresentationRenderManifest };
  try {
    rendered = await createPptxGenPresentation(repairedInput);
  } catch (error) {
    throw new PresentationPackageAuditError(
      firstAudit,
      undefined,
      `The repair render failed: ${summarizePresentationRenderError(error)}`,
    );
  }
  const secondAudit = await auditRenderedPresentation(auditPackage, rendered, repairedInput, "pptxgenjs");
  if (!secondAudit.passed) {
    throw new PresentationPackageAuditError(firstAudit, secondAudit);
  }
  return {
    ...rendered,
    renderer: "pptxgenjs",
    fallbackTriggered: false,
    warnings: ["The first structural package audit failed; one deterministic repair and rerender passed."],
    usedAssetIds: ["renderer-generated-visual", "built-in-shapes-icons"],
    retryAttempted: true,
    packageAudit: secondAudit,
  };
}

async function renderAuditedFallback(
  input: PresentationPptxInput,
  errorMessage: string,
  mustAudit: boolean,
  auditPackage: PresentationPackageAuditor,
): Promise<PresentationPptxResult> {
  const manifest = buildFallbackManifest(input);
  const buffer = createFallbackPresentationPptx(input);
  const warning =
    "PPTX visual renderer failed; generated a semantic text fallback preserving authored notes, citations, links, and tables. Unsupported charts are visibly labeled data tables.";
  const result = { buffer, manifest };
  const packageAudit = mustAudit ? await auditRenderedPresentation(auditPackage, result, input, "fallback") : undefined;
  if (packageAudit && !packageAudit.passed) {
    throw new PresentationPackageAuditError(packageAudit, packageAudit, `Primary renderer failure: ${errorMessage}`);
  }
  return {
    ...result,
    renderer: "fallback",
    fallbackTriggered: true,
    warnings: [`${warning} Cause: ${errorMessage}`],
    usedAssetIds: [],
    retryAttempted: true,
    packageAudit,
    errorMessage,
  };
}

async function auditRenderedPresentation(
  auditPackage: PresentationPackageAuditor,
  rendered: { buffer: Buffer; manifest: PresentationRenderManifest },
  input: PresentationPptxInput,
  renderer: "pptxgenjs" | "fallback",
): Promise<PresentationPackageAuditReport> {
  const expectation: PresentationPackageAuditExpectation = {
    title: input.title,
    subtitle: input.subtitle,
    slides: input.slides,
    sources: input.sources ?? [],
    manifest: rendered.manifest,
    renderer,
  };
  return auditPackage(rendered.buffer, expectation);
}

async function createPptxGenPresentation(
  input: PresentationPptxInput,
): Promise<{ buffer: Buffer; manifest: PresentationRenderManifest }> {
  const PptxGen = await loadPptxGen();
  const design =
    input.design ??
    createArtifactDesignPlan({
      kind: "presentation",
      title: input.title,
      body: input.subtitle,
      slides: input.slides.map((slide) => ({
        title: slide.title,
        bullets: presentationSlideText(slide),
        speakerNotes: slide.speakerNotes,
      })),
      format: "pptx",
    });
  const contentSlides = input.slides.length > 0 ? input.slides : [{ title: input.title, bullets: [] }];
  const slides: PresentationSlide[] = [
    {
      title: input.title,
      bullets: input.subtitle ? [input.subtitle] : [],
      archetype: "auto",
    },
    ...contentSlides,
  ];
  const pptx = new PptxGen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "GoatCitadel";
  pptx.company = "GoatCitadel";
  pptx.subject = input.title;
  pptx.title = input.title;
  pptx.theme = {
    headFontFace: design.typography.headingFont,
    bodyFontFace: design.typography.bodyFont,
  };

  const visualAsset = normalizePresentationVisualAsset(input.visualAsset);
  const visualAssets = normalizeMappedPresentationVisualAssets(input.visualAssets, slides.length);
  const mappedVisualSlideIndexes = new Set(visualAssets.map((item) => item.slideIndex));
  const layoutPlan = resolvePresentationDeckLayoutPlan(design, slides, mappedVisualSlideIndexes);
  const slideVisuals = await buildPresentationSlideVisuals(
    input.title,
    slides,
    design,
    layoutPlan,
    visualAsset,
    visualAssets,
  );
  slides.forEach((slide, index) => {
    const pptSlide = pptx.addSlide();
    const slideVisual = slideVisuals[index] ?? slideVisuals[0];
    if (!slideVisual) {
      throw new Error("No presentation visual was generated for the slide deck.");
    }
    pptSlide.background = { color: design.tokens.background };
    pptSlide.color = design.tokens.text;
    drawPresentationSlide({
      pptx,
      slide: pptSlide,
      content: slide,
      design,
      visualData: slideVisual.dataUri,
      index,
      layoutDecision: layoutPlan[index],
      hasMappedVisual: mappedVisualSlideIndexes.has(index),
      sources: input.sources ?? [],
    });
    const notes = buildAuthoredNotes(slide, input.sources ?? []);
    if (notes) {
      pptSlide.addNotes(notes);
    }
  });

  const output = await pptx.write({ outputType: "nodebuffer", compression: true });
  const manifest = buildPresentationRenderManifest({
    slides: input.slides,
    sources: input.sources ?? [],
    layoutNames: layoutPlan.map((decision) => decision.renderer),
    visualCount:
      1 +
      layoutPlan.filter(
        (decision) =>
          decision.slideIndex > 0 &&
          decision.renderer === "image-text" &&
          mappedVisualSlideIndexes.has(decision.slideIndex),
      ).length +
      input.slides.filter((slide) => Boolean(slide.table || slide.chart)).length,
  });
  return { buffer: toBuffer(output), manifest };
}

function preparePresentationPptxInput(input: PresentationPptxInput): PresentationPptxInput {
  const sources = input.sources ?? [];
  const slides = input.slidesPrepared ? input.slides : preparePresentationSlides(input.slides, sources);
  const visualAsset = normalizePresentationVisualAsset(input.visualAsset);
  const visualAssets = normalizeMappedPresentationVisualAssets(input.visualAssets, slides.length + 1);
  if (visualAsset && visualAssets.some((item) => item.slideIndex === 0)) {
    throw new Error("Presentation input supplies two cover visual assets; choose one explicit cover asset.");
  }
  validatePresentationVisibleContent({ title: input.title, subtitle: input.subtitle, slides, sources });
  validatePresentationCapacity(slides, sources);
  validateTrustedPresentationNotes(slides);
  validateResearchPresentation(
    input.research,
    sources,
    slides.filter((slide) => !slide.generatedSourceAppendix),
  );
  const prepared = {
    ...input,
    slides,
    sources,
    visualAsset,
    visualAssets,
    slidesPrepared: true,
    design: input.design ?? createPresentationDesign(input, slides),
  };
  assertPresentationLayoutQuality(prepared);
  return prepared;
}

function buildFallbackManifest(input: PresentationPptxInput): PresentationRenderManifest {
  const layoutNames = resolveFallbackPresentationLayoutNames(input);
  const nativeTableCount = input.slides.filter((slide) => Boolean(slide.table || slide.chart)).length;
  return buildPresentationRenderManifest({
    slides: input.slides,
    sources: input.sources ?? [],
    layoutNames,
    visualCount: nativeTableCount,
  });
}

function createPresentationDesign(
  input: PresentationPptxInput,
  slides: readonly PresentationSlide[],
): ArtifactDesignPlan {
  return createArtifactDesignPlan({
    kind: "presentation",
    title: input.title,
    body: input.subtitle,
    slides: slides.map((slide) => ({
      title: slide.title,
      bullets: presentationSlideText(slide),
      speakerNotes: slide.speakerNotes,
    })),
    format: "pptx",
  });
}

function assertPresentationLayoutQuality(input: PresentationPptxInput): void {
  const design = input.design ?? createPresentationDesign(input, input.slides);
  if (design.mode !== "polished" && !input.research) {
    return;
  }
  const deckSlides: PresentationSlide[] = [
    { title: input.title, bullets: input.subtitle ? [input.subtitle] : [] },
    ...input.slides,
  ];
  const mappedVisualSlideIndexes = new Set(
    (input.visualAssets ?? [])
      .map((item) => item.slideIndex)
      .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < deckSlides.length),
  );
  const quality = analyzePresentationDeckQuality(design, deckSlides, mappedVisualSlideIndexes);
  if (quality.templateWarnings.length > 0) {
    throw new Error(`Presentation layout validation failed: ${quality.templateWarnings.join(" ")}`);
  }
}

function deterministicallyRepairPresentationInput(input: PresentationPptxInput): PresentationPptxInput {
  const slides = input.slides.flatMap((slide) => conservativelyPaginatePreparedSlide(slide));
  if (slides.length + 1 > 40) {
    throw new Error(`Presentation repair pagination produced ${slides.length + 1} slides; the maximum is 40.`);
  }
  const slideCountChanged = slides.length !== input.slides.length;
  return {
    ...input,
    slides,
    slidesPrepared: true,
    visualAssets: slideCountChanged ? [] : input.visualAssets,
    design: input.design ?? createPresentationDesign(input, slides),
  };
}

function conservativelyPaginatePreparedSlide(slide: PresentationSlide): PresentationSlide[] {
  if (slide.generatedSourceAppendix) {
    return [slide];
  }
  if (slide.table && slide.table.rows.length > 2) {
    const pages: PresentationSlide[] = [];
    for (let index = 0; index < slide.table.rows.length; index += 2) {
      const pageIndex = Math.floor(index / 2);
      pages.push({
        ...slide,
        title: pageIndex === 0 ? slide.title : continuationTitle(slide.title),
        bullets: pageIndex === 0 ? slide.bullets : [],
        speakerNotes: pageIndex === 0 ? slide.speakerNotes : undefined,
        table: { headers: slide.table.headers, rows: slide.table.rows.slice(index, index + 2) },
      });
    }
    return pages;
  }
  if (!slide.table && !slide.chart && slide.bullets.length > 4) {
    const pages: PresentationSlide[] = [];
    for (let index = 0; index < slide.bullets.length; index += 4) {
      const pageIndex = Math.floor(index / 4);
      pages.push({
        ...slide,
        title: pageIndex === 0 ? slide.title : continuationTitle(slide.title),
        bullets: slide.bullets.slice(index, index + 4),
        speakerNotes: pageIndex === 0 ? slide.speakerNotes : undefined,
      });
    }
    return pages;
  }
  return [slide];
}

function continuationTitle(value: string): string {
  return `${value.replace(/(?: — Continued)+$/u, "")} — Continued`;
}

function normalizePresentationVisualAsset(
  asset: PresentationVisualAsset | undefined,
): PresentationVisualAsset | undefined {
  if (!asset) {
    return undefined;
  }
  const bytesBase64 = asset.bytesBase64.trim();
  if (!bytesBase64) {
    throw new Error("Presentation visual asset requires non-empty image bytes.");
  }
  const mimeType = asset.mimeType?.trim() || "image/png";
  if (!mimeType.toLowerCase().startsWith("image/")) {
    throw new Error("Presentation visual asset mimeType must be an image type.");
  }
  return {
    ...asset,
    bytesBase64,
    mimeType,
    altText: asset.altText === undefined ? undefined : normalizeRequiredVisualText(asset.altText, "altText"),
    source: asset.source === undefined ? undefined : normalizeRequiredVisualText(asset.source, "source"),
    sourceModel:
      asset.sourceModel === undefined ? undefined : normalizeRequiredVisualText(asset.sourceModel, "sourceModel"),
    revisedPrompt:
      asset.revisedPrompt === undefined ? undefined : normalizeRequiredVisualText(asset.revisedPrompt, "revisedPrompt"),
  };
}

function visualAssetToDataUri(asset: PresentationVisualAsset): string {
  return `data:${asset.mimeType ?? "image/png"};base64,${asset.bytesBase64}`;
}

export async function buildPresentationSlideVisuals(
  deckTitle: string,
  slides: PresentationSlide[],
  design: ArtifactDesignPlan,
  layoutPlan: PresentationSlideLayoutDecision[],
  visualAsset?: PresentationVisualAsset,
  visualAssets: Array<{ slideIndex: number; asset: PresentationVisualAsset }> = [],
): Promise<PresentationSlideVisual[]> {
  const mapped = new Map<number, PresentationVisualAsset>();
  visualAssets.forEach((item) => {
    if (mapped.has(item.slideIndex)) {
      throw new Error(`Presentation input supplies duplicate visual assets for slide ${item.slideIndex}.`);
    }
    mapped.set(item.slideIndex, item.asset);
  });
  if (visualAsset && mapped.has(0)) {
    throw new Error("Presentation input supplies two cover visual assets; choose one explicit cover asset.");
  }
  if (visualAsset) mapped.set(0, visualAsset);
  return Promise.all(
    slides.map(async (slide, index) => {
      const mappedAsset = mapped.get(index);
      if (mappedAsset) {
        const source = `${mappedAsset.source ?? "generated-image"}${
          mappedAsset.sourceModel ? `:${mappedAsset.sourceModel}` : ""
        }`;
        return {
          dataUri: visualAssetToDataUri(mappedAsset),
          source,
          altText:
            mappedAsset.altText ??
            (index === 0
              ? `Generated cover visual for ${deckTitle}.`
              : `Generated supporting visual for ${slide.title}.`),
        };
      }
      return {
        dataUri: await buildAbstractVisualDataUri(
          {
            deckTitle,
            slideTitle: slide.title,
            bullets: presentationSlideText(slide),
            slideIndex: index,
            renderer: layoutPlan[index]?.renderer ?? "image-text",
          },
          design,
        ),
        source: "local-renderer",
        altText: `Generated supporting visual for ${slide.title}.`,
      };
    }),
  );
}

function normalizeMappedPresentationVisualAssets(
  assets: PresentationPptxInput["visualAssets"],
  slideCount: number,
): Array<{ slideIndex: number; asset: PresentationVisualAsset }> {
  const mapped = new Map<number, PresentationVisualAsset>();
  for (const item of assets ?? []) {
    if (!Number.isSafeInteger(item.slideIndex) || item.slideIndex < 0 || item.slideIndex >= slideCount) {
      throw new Error(`Presentation visual asset slideIndex ${item.slideIndex} is outside the rendered deck.`);
    }
    const asset = normalizePresentationVisualAsset(item.asset);
    if (!asset) {
      throw new Error(`Presentation visual asset for slide ${item.slideIndex} is missing.`);
    }
    if (mapped.has(item.slideIndex)) {
      throw new Error(`Presentation input supplies duplicate visual assets for slide ${item.slideIndex}.`);
    }
    mapped.set(item.slideIndex, asset);
  }
  return [...mapped.entries()]
    .map(([slideIndex, asset]) => ({ slideIndex, asset }))
    .sort((left, right) => left.slideIndex - right.slideIndex);
}

function normalizeRequiredVisualText(value: string, label: string): string {
  const normalized = normalizePresentationText(value);
  if (!normalized) {
    throw new Error(`Presentation visual asset ${label} must be a non-empty string when supplied.`);
  }
  return normalized;
}

interface AbstractVisualSeed {
  deckTitle: string;
  slideTitle: string;
  bullets: string[];
  slideIndex: number;
  renderer: string;
}

async function buildAbstractVisualDataUri(seed: AbstractVisualSeed, design: ArtifactDesignPlan): Promise<string> {
  const hash = hashVisualSeed(`${seed.deckTitle}|${seed.slideTitle}|${seed.bullets.join("|")}|${seed.slideIndex}`);
  const colors = rotatePalette([design.tokens.accent, design.tokens.accent2, design.tokens.accent3], hash % 3);
  const curveY = 300 + (hash % 90);
  const circleX = 760 + (hash % 220);
  const circleY = 160 + ((hash >>> 4) % 120);
  const lowerCircleX = 170 + ((hash >>> 8) % 180);
  const barCount = Math.max(2, Math.min(4, seed.bullets.length || 2));
  const bars = Array.from({ length: barCount }, (_, index) => {
    const width = 155 + ((hash >>> (index * 3)) % 150);
    const x = 155 + index * 230;
    const y = 815 + index * 72;
    return `<rect x="${x}" y="${y}" width="${width}" height="48" rx="24" fill="#${colors[index % colors.length]}" opacity="${index === 0 ? "0.9" : "0.72"}"/>`;
  }).join("");
  const markerCount = Math.max(2, Math.min(5, seed.bullets.length + 1));
  const markers = Array.from({ length: markerCount }, (_, index) => {
    const x = 190 + index * 190;
    const y = 1105 + ((hash >>> (index + 2)) % 70);
    return `<circle cx="${x}" cy="${y}" r="${34 - Math.min(index, 3) * 3}" fill="#${colors[index % colors.length]}" opacity="0.82"/>`;
  }).join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">`,
    `<rect width="1200" height="1500" rx="48" fill="#${design.tokens.surface}"/>`,
    `<circle cx="${circleX}" cy="${circleY}" r="250" fill="#${colors[0]}" opacity="0.18"/>`,
    `<circle cx="${lowerCircleX}" cy="1190" r="315" fill="#${colors[1]}" opacity="0.16"/>`,
    `<path d="M120 ${curveY} C320 ${curveY - 170} 520 ${curveY + 180} 730 ${curveY + 32} S1030 ${curveY - 70} 1110 ${curveY + 190}" fill="none" stroke="#${colors[0]}" stroke-width="34" stroke-linecap="round" opacity="0.82"/>`,
    `<path d="M155 720 H1030" stroke="#${design.tokens.border}" stroke-width="8" opacity="0.75"/>`,
    bars,
    markers,
    `</svg>`,
  ].join("");
  const sharp = (await import("sharp")).default;
  const buffer = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function rotatePalette(colors: string[], offset: number): string[] {
  return colors.map((_, index) => colors[(index + offset) % colors.length] ?? colors[index] ?? "0EA5E9");
}

function hashVisualSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function truncateSvgText(value: unknown, maxLength: number): string {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...` : normalized;
}

function summarizePresentationRenderError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || "Error";
    const message = error.message.replace(/\s+/g, " ").trim();
    return truncateSvgText(`${name}: ${message || "unknown renderer failure"}`, 280);
  }
  if (typeof error === "string") {
    return truncateSvgText(error, 280);
  }
  return "unknown renderer failure";
}

async function loadPptxGen(): Promise<PptxGenConstructor> {
  const module = (await import("pptxgenjs")) as unknown as { default?: PptxGenConstructor } & PptxGenConstructor;
  return module.default ?? module;
}

function toBuffer(value: PptxOutput): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "binary");
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    throw new Error("Unexpected browser Blob output from pptxgenjs nodebuffer writer");
  }
  return Buffer.from(value as Uint8Array);
}
