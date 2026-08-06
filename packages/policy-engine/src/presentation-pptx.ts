import { createArtifactDesignPlan, type ArtifactDesignPlan } from "./artifact-design.js";
import {
  resolveContentSlideRenderer,
  resolvePresentationDeckLayoutPlan,
  type PresentationSlideLayoutDecision,
} from "./presentation-layout.js";
import { createFallbackPresentationPptx } from "./presentation-pptx-fallback.js";

export { createStoredZip, type ZipEntry } from "./presentation-pptx-fallback.js";
export { createFallbackPresentationPptx };

export interface PresentationSlide {
  title: string;
  bullets: string[];
  speakerNotes?: string;
  visualBrief?: string;
}

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
  errorMessage?: string;
}

export interface PresentationPptxResult extends PresentationPptxDiagnostics {
  buffer: Buffer;
}

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

type PptxOutput = string | ArrayBuffer | Blob | Uint8Array;

interface PptxSlideLike {
  background?: { color: string };
  color?: string;
  addShape(shapeName: string, options?: Record<string, unknown>): PptxSlideLike;
  addImage(options: Record<string, unknown>): PptxSlideLike;
  addText(text: string, options?: Record<string, unknown>): PptxSlideLike;
  addNotes(notes: string): PptxSlideLike;
}

interface PptxPresentationLike {
  layout: string;
  author: string;
  company: string;
  subject: string;
  title: string;
  theme: { headFontFace?: string; bodyFontFace?: string };
  ShapeType: Record<string, string>;
  addSlide(): PptxSlideLike;
  write(options: { outputType: "nodebuffer"; compression: boolean }): Promise<PptxOutput>;
}

type PptxGenConstructor = new () => PptxPresentationLike;

export async function createPresentationPptx(input: PresentationPptxInput): Promise<Buffer> {
  return (await createPresentationPptxWithDiagnostics(input)).buffer;
}

export async function createPresentationPptxWithDiagnostics(
  input: PresentationPptxInput,
): Promise<PresentationPptxResult> {
  try {
    return {
      buffer: await createPptxGenPresentation(input),
      renderer: "pptxgenjs",
      fallbackTriggered: false,
      warnings: [],
      usedAssetIds: ["renderer-generated-visual", "built-in-shapes-icons"],
    };
  } catch (error) {
    const errorMessage = summarizePresentationRenderError(error);
    return {
      buffer: createFallbackPresentationPptx(input),
      renderer: "fallback",
      fallbackTriggered: true,
      warnings: [`PPTX visual renderer failed; generated a text-only fallback deck instead. Cause: ${errorMessage}`],
      usedAssetIds: [],
      errorMessage,
    };
  }
}

async function createPptxGenPresentation(input: PresentationPptxInput): Promise<Buffer> {
  const PptxGen = await loadPptxGen();
  const design =
    input.design ??
    createArtifactDesignPlan({
      kind: "presentation",
      title: input.title,
      body: input.subtitle,
      slides: input.slides,
      format: "pptx",
    });
  const contentSlides = input.slides.length > 0 ? input.slides : [{ title: input.title, bullets: [] }];
  const slides: PresentationSlide[] = [
    {
      title: input.title,
      bullets: input.subtitle ? [input.subtitle] : [],
      speakerNotes: `Design preset: ${design.preset}`,
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
    drawSlideFrame(pptx, pptSlide, design, index);
    if (index === 0) {
      drawHeroSlide(pptx, pptSlide, slide, design, slideVisual.dataUri);
    } else {
      drawContentSlide(
        pptx,
        pptSlide,
        slide,
        design,
        slideVisual.dataUri,
        index,
        layoutPlan[index],
        mappedVisualSlideIndexes.has(index),
      );
    }
    const notes = [
      slide.speakerNotes,
      `Layout: ${layoutPlan[index]?.renderer ?? "unknown"}; density=${layoutPlan[index]?.density ?? "unknown"}; reason=${layoutPlan[index]?.reason ?? "n/a"}.`,
      `GoatCitadel design provenance: preset=${design.preset}; visualLevel=${design.visualLevel}; assetPolicy=${design.assetPolicy}.`,
      `Visual source: ${slideVisual.source}.`,
      (visualAssets.find((item) => item.slideIndex === index)?.asset ?? (index === 0 ? visualAsset : undefined))
        ?.revisedPrompt
        ? `Generated visual revised prompt: ${
            (visualAssets.find((item) => item.slideIndex === index)?.asset ?? visualAsset)?.revisedPrompt
          }`
        : undefined,
      "Renderer assets used: renderer-generated-visual, built-in-shapes-icons.",
    ]
      .filter(Boolean)
      .join("\n");
    pptSlide.addNotes(notes);
  });

  const output = await pptx.write({ outputType: "nodebuffer", compression: true });
  return toBuffer(output);
}

function drawSlideFrame(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  design: ArtifactDesignPlan,
  index: number,
): void {
  slide.addShape(shape(pptx, "rect"), {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: SLIDE_H,
    fill: { color: design.tokens.background },
    line: { color: design.tokens.background, transparency: 100 },
  });
  slide.addShape(shape(pptx, "rect"), {
    x: 0,
    y: 0,
    w: 0.13,
    h: SLIDE_H,
    fill: { color: design.tokens.accent },
    line: { color: design.tokens.accent, transparency: 100 },
  });
  slide.addShape(shape(pptx, "rect"), {
    x: 0.52,
    y: 6.95,
    w: 12.1,
    h: 0.02,
    fill: { color: design.tokens.border, transparency: 40 },
    line: { color: design.tokens.border, transparency: 100 },
  });
  slide.addText(String(index + 1).padStart(2, "0"), {
    x: 12.0,
    y: 6.96,
    w: 0.55,
    h: 0.3,
    fontFace: design.typography.headingFont,
    fontSize: 10,
    bold: true,
    color: design.tokens.accent,
    align: "right",
    margin: 0,
  });
}

function drawHeroSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  visualData: string,
): void {
  slide.addShape(shape(pptx, "roundRect"), {
    x: 0.66,
    y: 0.64,
    w: 7.0,
    h: 6.0,
    rectRadius: 0.08,
    fill: { color: design.tokens.surface, transparency: design.preset === "cyberpunk-ops" ? 10 : 0 },
    line: { color: design.tokens.border, transparency: 15 },
    shadow: { type: "outer", color: "000000", opacity: 0.12, blur: 2, angle: 45, offset: 1 },
  });
  slide.addText(content.title, {
    x: 1.0,
    y: 1.1,
    w: 6.25,
    h: 1.45,
    fontFace: design.typography.headingFont,
    fontSize: 32,
    bold: true,
    fit: "shrink",
    color: design.tokens.text,
    breakLine: false,
    margin: 0.02,
  });
  if (content.bullets[0]) {
    slide.addText(content.bullets[0], {
      x: 1.04,
      y: 2.85,
      w: 5.85,
      h: 0.75,
      fontFace: design.typography.bodyFont,
      fontSize: 17,
      fit: "shrink",
      color: design.tokens.mutedText,
      margin: 0,
    });
  }
  slide.addShape(shape(pptx, "rect"), {
    x: 1.04,
    y: 4.0,
    w: 1.25,
    h: 0.08,
    fill: { color: design.tokens.accent },
    line: { color: design.tokens.accent, transparency: 100 },
  });
  slide.addImage({
    data: visualData,
    x: 8.05,
    y: 0.72,
    w: 4.6,
    h: 5.7,
    altText: `Generated abstract visual for ${content.title}`,
    objectName: "GoatCitadel generated visual",
  });
}

function drawContentSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  visualData: string,
  index: number,
  layoutDecision?: PresentationSlideLayoutDecision,
  hasMappedVisual = false,
): void {
  slide.addText(content.title, {
    x: 0.76,
    y: 0.48,
    w: 10.9,
    h: 0.68,
    fontFace: design.typography.headingFont,
    fontSize: 24,
    bold: true,
    fit: "shrink",
    color: design.tokens.text,
    margin: 0,
  });
  if (hasMappedVisual) {
    if (content.bullets.length >= 4) {
      drawVisualFeatureSlide(pptx, slide, content, design, visualData);
    } else {
      drawImageTextSlide(pptx, slide, content, design, visualData);
    }
    return;
  }
  const renderer = layoutDecision?.renderer === "hero" ? "image-text" : layoutDecision?.renderer;
  const resolvedRenderer = renderer ?? resolveContentSlideRenderer(design, index, content);
  if (resolvedRenderer === "two-column") {
    drawTwoColumnSlide(pptx, slide, content, design);
    return;
  }
  if (resolvedRenderer === "stacked-list") {
    drawStackedListSlide(pptx, slide, content, design);
    return;
  }
  if (resolvedRenderer === "stat-callout") {
    drawCalloutSlide(pptx, slide, content, design, visualData);
    return;
  }
  drawImageTextSlide(pptx, slide, content, design, visualData);
}

function drawImageTextSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  visualData: string,
): void {
  slide.addShape(shape(pptx, "roundRect"), {
    x: 0.76,
    y: 1.45,
    w: 7.05,
    h: 4.85,
    rectRadius: 0.05,
    fill: { color: design.tokens.surface },
    line: { color: design.tokens.border, transparency: 15 },
  });
  drawRhythmBand(pptx, slide, content, design, 1.08, 1.78, 1.72);
  addBulletRows(pptx, slide, content.bullets, design, 1.08, 2.12, 6.32, 3.62);
  slide.addImage({
    data: visualData,
    x: 8.35,
    y: 1.55,
    w: 3.9,
    h: 4.65,
    altText: `Generated supporting visual for ${content.title}`,
    objectName: "GoatCitadel supporting visual",
  });
  drawRhythmBand(pptx, slide, content, design, 1.08, 5.98, 2.65);
}

function drawTwoColumnSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
): void {
  const left = content.bullets.slice(0, Math.ceil(content.bullets.length / 2));
  const right = content.bullets.slice(left.length);
  [0.76, 6.42].forEach((x, columnIndex) => {
    slide.addShape(shape(pptx, "roundRect"), {
      x,
      y: 1.44,
      w: 5.15,
      h: 4.82,
      rectRadius: 0.05,
      fill: {
        color: columnIndex === 0 ? design.tokens.surface : design.tokens.background,
        transparency: columnIndex === 0 ? 0 : 8,
      },
      line: { color: columnIndex === 0 ? design.tokens.border : design.tokens.accent2, transparency: 18 },
    });
  });
  addBulletRows(pptx, slide, left, design, 1.08, 1.82, 4.45, 3.95, { compact: true });
  addBulletRows(pptx, slide, right, design, 6.74, 1.82, 4.45, 3.95, {
    compact: true,
    startIndex: left.length + 1,
  });
}

function drawStackedListSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
): void {
  slide.addShape(shape(pptx, "roundRect"), {
    x: 0.76,
    y: 1.42,
    w: 11.62,
    h: 4.86,
    rectRadius: 0.05,
    fill: { color: design.tokens.surface },
    line: { color: design.tokens.border, transparency: 15 },
  });
  drawRhythmBand(pptx, slide, content, design, 1.08, 1.76, 2.4);
  addBulletRows(pptx, slide, content.bullets, design, 1.08, 2.08, 10.98, 3.88, {
    compact: true,
  });
}

function drawVisualFeatureSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  visualData: string,
): void {
  const left = content.bullets.slice(0, Math.ceil(content.bullets.length / 2));
  const right = content.bullets.slice(left.length);
  slide.addShape(shape(pptx, "roundRect"), {
    x: 0.76,
    y: 1.42,
    w: 6.2,
    h: 4.86,
    rectRadius: 0.05,
    fill: { color: design.tokens.surface },
    line: { color: design.tokens.border, transparency: 15 },
  });
  addBulletRows(pptx, slide, left, design, 1.08, 1.78, 5.55, 4.12, { compact: true });
  slide.addImage({
    data: visualData,
    x: 7.28,
    y: 1.42,
    w: 5.1,
    h: 2.75,
    altText: `Generated supporting visual for ${content.title}`,
    objectName: "GoatCitadel section visual",
  });
  if (right.length > 0) {
    slide.addShape(shape(pptx, "roundRect"), {
      x: 7.28,
      y: 4.42,
      w: 5.1,
      h: 1.86,
      rectRadius: 0.04,
      fill: { color: design.tokens.background, transparency: 5 },
      line: { color: design.tokens.accent2, transparency: 20 },
    });
    addBulletRows(pptx, slide, right, design, 7.56, 4.68, 4.54, 1.34, {
      compact: true,
      startIndex: left.length + 1,
    });
  }
}

function drawCalloutSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  visualData: string,
): void {
  const [first, ...rest] = content.bullets;
  slide.addImage({
    data: visualData,
    x: 0.76,
    y: 1.36,
    w: 4.0,
    h: 4.95,
    altText: `Generated visual callout for ${content.title}`,
    objectName: "GoatCitadel callout visual",
  });
  slide.addShape(shape(pptx, "roundRect"), {
    x: 5.15,
    y: 1.65,
    w: 6.85,
    h: 1.45,
    rectRadius: 0.07,
    fill: { color: design.tokens.accent, transparency: 4 },
    line: { color: design.tokens.accent, transparency: 100 },
  });
  slide.addText(first ?? "Key takeaway", {
    x: 5.55,
    y: 1.94,
    w: 6.0,
    h: 0.7,
    fontFace: design.typography.headingFont,
    fontSize: 22,
    bold: true,
    fit: "shrink",
    color: "FFFFFF",
    margin: 0,
  });
  if (rest.length > 0) {
    addBulletRows(pptx, slide, rest, design, 5.35, 3.55, 6.4, 2.5, { compact: true });
  } else {
    drawRhythmBand(pptx, slide, content, design, 5.55, 3.62, 2.4);
  }
}

function addBulletRows(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  bullets: string[],
  design: ArtifactDesignPlan,
  x: number,
  y: number,
  w: number,
  h: number,
  options: { compact?: boolean; startIndex?: number } = {},
): void {
  if (bullets.length === 0) {
    slide.addText("No details provided.", {
      x,
      y,
      w,
      h: 0.45,
      fontFace: design.typography.bodyFont,
      fontSize: options.compact ? 11 : 13,
      color: design.tokens.mutedText,
      margin: 0,
    });
    return;
  }
  const rowGap = options.compact ? 0.1 : 0.16;
  const baseFontSize = options.compact ? (bullets.length > 3 ? 10.6 : 11.6) : bullets.length > 3 ? 12.2 : 13.6;
  const availableHeight = Math.max(0.4, h - rowGap * Math.max(0, bullets.length - 1));
  const rowMetrics = allocateBulletRowMetrics(
    bullets,
    w - 0.58,
    availableHeight,
    baseFontSize,
    Boolean(options.compact),
  );
  const startIndex = options.startIndex ?? 1;
  let rowY = y;
  bullets.forEach((bullet, index) => {
    const rowHeight = rowMetrics.heights[index] ?? availableHeight / bullets.length;
    slide.addShape(shape(pptx, "rect"), {
      x,
      y: rowY + 0.06,
      w: 0.05,
      h: Math.max(0.22, rowHeight - 0.14),
      fill: { color: index % 2 === 0 ? design.tokens.accent : design.tokens.accent2 },
      line: { color: design.tokens.border, transparency: 100 },
    });
    slide.addText(String(startIndex + index).padStart(2, "0"), {
      x: x + 0.14,
      y: rowY + 0.05,
      w: 0.32,
      h: 0.24,
      fontFace: design.typography.headingFont,
      fontSize: options.compact ? 6.6 : 7.4,
      bold: true,
      color: design.tokens.accent,
      margin: 0,
    });
    slide.addText(bullet, {
      x: x + 0.52,
      y: rowY,
      w: w - 0.58,
      h: rowHeight,
      fontFace: design.typography.bodyFont,
      fontSize: rowMetrics.fontSize,
      // Keep the complete source text visible when PowerPoint's real font
      // metrics wrap more aggressively than our deterministic row estimate.
      // A fixed-size text box silently replaces overflow with an ellipsis;
      // shrink-to-fit preserves the content inside the allocated row instead.
      fit: "shrink",
      color: design.tokens.text,
      breakLine: false,
      valign: "top",
      margin: 0.02,
      breakLineOnHyphen: false,
    });
    rowY += rowHeight + rowGap;
  });
}

function allocateBulletRowMetrics(
  bullets: string[],
  textWidth: number,
  availableHeight: number,
  baseFontSize: number,
  compact: boolean,
): { heights: number[]; fontSize: number } {
  const minimumHeight = compact ? 0.42 : 0.5;
  const charactersPerLine = Math.max(24, Math.floor((textWidth * 120) / baseFontSize));
  const lineCounts = bullets.map((bullet) => Math.max(1, Math.ceil(bullet.trim().length / charactersPerLine)));
  const preferred = lineCounts.map((lineCount) => Math.max(minimumHeight, 0.13 + lineCount * (baseFontSize / 52)));
  const preferredTotal = preferred.reduce((total, value) => total + value, 0);
  if (preferredTotal <= availableHeight) {
    return { heights: preferred, fontSize: baseFontSize };
  }
  const scale = availableHeight / preferredTotal;
  const fontSize = Math.max(compact ? 9.2 : 10.4, Math.round(baseFontSize * scale * 10) / 10);
  const scaled = preferred.map((height) => Math.max(minimumHeight, height * scale));
  const scaledTotal = scaled.reduce((total, value) => total + value, 0);
  if (scaledTotal <= availableHeight) {
    return { heights: scaled, fontSize };
  }
  const finalScale = availableHeight / scaledTotal;
  return {
    heights: scaled.map((height) => height * finalScale),
    fontSize,
  };
}

function drawRhythmBand(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  x: number,
  y: number,
  w: number,
): void {
  const colors = [design.tokens.accent, design.tokens.accent2, design.tokens.accent3];
  const segmentCount = Math.max(1, Math.min(3, content.bullets.length || 1));
  const segmentGap = 0.08;
  const segmentWidth = (w - segmentGap * (segmentCount - 1)) / segmentCount;
  for (let index = 0; index < segmentCount; index += 1) {
    slide.addShape(shape(pptx, "rect"), {
      x: x + index * (segmentWidth + segmentGap),
      y,
      w: segmentWidth,
      h: 0.06,
      fill: { color: colors[index % colors.length] },
      line: { color: colors[index % colors.length], transparency: 100 },
    });
  }
}

function normalizePresentationVisualAsset(
  asset: PresentationVisualAsset | undefined,
): PresentationVisualAsset | undefined {
  if (!asset) {
    return undefined;
  }
  const bytesBase64 = asset.bytesBase64.trim();
  if (!bytesBase64) {
    return undefined;
  }
  const mimeType = asset.mimeType?.trim() || "image/png";
  if (!mimeType.toLowerCase().startsWith("image/")) {
    return undefined;
  }
  return {
    ...asset,
    bytesBase64,
    mimeType,
    altText: asset.altText?.trim() || undefined,
    source: asset.source?.trim() || undefined,
    sourceModel: asset.sourceModel?.trim() || undefined,
    revisedPrompt: asset.revisedPrompt?.trim() || undefined,
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
  const mapped = new Map(visualAssets.map((item) => [item.slideIndex, item.asset]));
  if (visualAsset && !mapped.has(0)) mapped.set(0, visualAsset);
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
            bullets: slide.bullets,
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
    if (!Number.isSafeInteger(item.slideIndex) || item.slideIndex < 0 || item.slideIndex >= slideCount) continue;
    const asset = normalizePresentationVisualAsset(item.asset);
    if (asset) mapped.set(item.slideIndex, asset);
  }
  return [...mapped.entries()]
    .map(([slideIndex, asset]) => ({ slideIndex, asset }))
    .sort((left, right) => left.slideIndex - right.slideIndex);
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

function shape(pptx: PptxPresentationLike, name: string): string {
  return pptx.ShapeType[name] ?? name;
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
