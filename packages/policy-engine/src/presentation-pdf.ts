import sharp from "sharp";
import type { ArtifactDesignPlan } from "./artifact-design.js";
import {
  PdfDocumentWriter,
  PdfPage,
  countWinAnsiLoss,
  measureWinAnsi,
  mixPdfColors,
  pdfColor,
  pdfColorLuminance,
  toWinAnsiBytes,
  truncateWinAnsi,
  type PdfImageXObject,
} from "./pdf-writer.js";
import { drawPdfChart, drawPdfTable, drawPdfTableCards, type PdfDeckTheme } from "./presentation-pdf-blocks.js";
import {
  bulletRuns,
  drawBulletList,
  drawWrappedText,
  fitTextSize,
  type PdfTextBox,
  type PdfTextRun,
} from "./presentation-pdf-text.js";
import { resolvePresentationDeckLayoutPlan, type PresentationDeckRenderer } from "./presentation-layout.js";
import {
  buildPresentationRenderManifest,
  presentationBulletText,
  type PresentationRenderManifest,
  type PresentationSlide,
  type PresentationSource,
} from "./presentation-model.js";
import type { PresentationVisualAsset } from "./presentation-pptx.js";

/** 16:9 slide pages, 13.333 x 7.5 inches, matching the PPTX deck geometry. */
const PAGE_W = 960;
const PAGE_H = 540;
const MARGIN_X = 55;
const BODY_TOP = 104;
const BODY_BOTTOM = 486;
const BODY_MIN_SIZE = 16;
const SOURCE_MIN_SIZE = 12;
const MAX_IMAGE_EDGE = 1600;
const MAX_LOST_SHARE = 0.2;
const MIN_LOST_TO_REJECT = 5;

export interface PresentationPdfInput {
  title: string;
  subtitle?: string;
  /** Slides after preparePresentationSlides (paginated, source appendix appended). */
  slides: PresentationSlide[];
  sources: PresentationSource[];
  design: ArtifactDesignPlan;
  visualAsset?: PresentationVisualAsset;
  /** Server-owned assets mapped to final deck slide indexes (cover is 0). */
  visualAssets?: Array<{ slideIndex: number; asset: PresentationVisualAsset }>;
}

export interface PresentationPdfResult {
  buffer: Buffer;
  manifest: PresentationRenderManifest;
  layoutNames: PresentationDeckRenderer[];
  warnings: string[];
  usedAssetIds: string[];
}

interface SlideContext {
  page: PdfPage;
  slide: PresentationSlide;
  index: number;
  theme: PdfDeckTheme;
  sources: readonly PresentationSource[];
  image?: PdfImageXObject & { width: number; height: number };
  warnings: string[];
}

/** Renders a deck-style PDF: one landscape page per slide in the deck's design tokens. */
export async function createPresentationPdf(input: PresentationPdfInput): Promise<PresentationPdfResult> {
  const theme = resolveTheme(input.design);
  const deckSlides: PresentationSlide[] = [
    { title: input.title, bullets: input.subtitle ? [input.subtitle] : [] },
    ...input.slides,
  ];
  const warnings: string[] = [];
  assertLatinRenderable(deckSlides, warnings);
  const writer = new PdfDocumentWriter();
  const catalogId = writer.reserve();
  const pagesId = writer.reserve();
  const fonts = writer.addStandardFonts();
  const images = await embedVisuals(writer, input, theme, warnings);
  const layout = resolvePresentationDeckLayoutPlan(input.design, deckSlides, new Set(images.keys()));
  // PDF geometry is distinct from PPTX template names. Keep every approved
  // visual visible and vary adjacent prose pages without changing data semantics.
  let tableOrdinal = 0;
  for (let index = 1; index < layout.length; index += 1) {
    const decision = layout[index]!;
    const slide = deckSlides[index]!;
    if (slide.table) {
      decision.renderer = tableOrdinal++ % 2 === 0 ? "table" : "table-continuation";
    } else if (images.has(index) && !slide.table && !slide.chart && slide.archetype !== "sources") {
      decision.renderer = "image-text";
    } else if (decision.renderer === layout[index - 1]?.renderer && !slide.table && !slide.chart) {
      if (decision.renderer === "two-column" || decision.renderer === "comparison") decision.renderer = "stacked-list";
      else if (decision.renderer === "closing" || decision.renderer === "section")
        decision.renderer = "section-continuation";
      else if (decision.renderer === "image-text" || decision.renderer === "stacked-list")
        decision.renderer = "two-column";
      else if (decision.renderer === "sources") decision.renderer = "sources-continuation";
    }
  }
  const pageIds = deckSlides.map((slide, index) => {
    const page = new PdfPage(PAGE_W, PAGE_H);
    const context: SlideContext = {
      page,
      slide,
      index,
      theme,
      sources: input.sources,
      image: images.get(index),
      warnings,
    };
    drawSlideFrame(context, input.title);
    drawSlide(context, layout[index]?.renderer ?? "image-text");
    return writer.addPage(page, pagesId, fonts);
  });
  writer.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /PageLayout /SinglePage >>`);
  writer.set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  );
  const infoId = writer.add(writer.infoDictionary(input.title));
  const layoutNames = layout.map((decision) => decision.renderer);
  return {
    buffer: writer.serialize(catalogId, infoId),
    manifest: buildPresentationRenderManifest({
      slides: input.slides,
      sources: input.sources,
      layoutNames,
      visualCount: images.size,
    }),
    layoutNames,
    warnings,
    usedAssetIds: ["renderer-generated-visual", "built-in-shapes-icons"],
  };
}

/**
 * The PDF uses the standard Latin (WinAnsi) Helvetica faces. Mostly non-Latin
 * decks would render as "?" glyphs, so they fail before writing; a few lost
 * characters (emoji, stray symbols) are disclosed as a warning instead.
 */
function assertLatinRenderable(slides: readonly PresentationSlide[], warnings: string[]): void {
  const text = slides.flatMap((slide) => [
    slide.title,
    ...slide.bullets.map(presentationBulletText),
    ...(slide.table ? [...slide.table.headers, ...slide.table.rows.flat()].map((cell) => cell.text) : []),
    ...(slide.chart ? [...slide.chart.categories, ...slide.chart.series.map((series) => series.name)] : []),
  ]);
  const { lost, visible } = countWinAnsiLoss(text.join("\n"));
  if (lost === 0) return;
  if (lost >= MIN_LOST_TO_REJECT && lost / Math.max(1, visible) > MAX_LOST_SHARE) {
    throw new Error(
      `PDF decks support Latin-script text only, and ${lost} of ${visible} characters cannot be shown; use format "pptx" for this content.`,
    );
  }
  warnings.push(
    `${lost} character(s) outside the PDF's Latin character set (such as emoji or non-Latin script) were replaced or dropped.`,
  );
}

function resolveTheme(design: ArtifactDesignPlan): PdfDeckTheme {
  const accent = pdfColor(design.tokens.accent);
  const surface = pdfColor(design.tokens.surface);
  const text = pdfColor(design.tokens.text);
  const accent2 = pdfColor(design.tokens.accent2);
  const contrast = (ink: ReturnType<typeof pdfColor>) => {
    const a = pdfColorLuminance(ink);
    const b = pdfColorLuminance(surface);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const citation = contrast(accent2) >= 4.5 ? accent2 : contrast(accent) >= 4.5 ? accent : text;
  return {
    background: pdfColor(design.tokens.background),
    surface,
    text,
    citation,
    muted: pdfColor(design.tokens.mutedText),
    accent,
    accent2: pdfColor(design.tokens.accent2),
    accent3: pdfColor(design.tokens.accent3),
    border: pdfColor(design.tokens.border),
    onAccent: pdfColorLuminance(accent) > 0.45 ? pdfColor("111827") : pdfColor("FFFFFF"),
  };
}

async function embedVisuals(
  writer: PdfDocumentWriter,
  input: PresentationPdfInput,
  theme: PdfDeckTheme,
  warnings: string[],
): Promise<Map<number, PdfImageXObject & { width: number; height: number }>> {
  const assets = new Map<number, PresentationVisualAsset>();
  for (const item of input.visualAssets ?? []) assets.set(item.slideIndex, item.asset);
  if (input.visualAsset && !assets.has(0)) assets.set(0, input.visualAsset);
  const embedded = new Map<number, PdfImageXObject & { width: number; height: number }>();
  for (const [slideIndex, asset] of [...assets.entries()].sort(([left], [right]) => left - right)) {
    if (slideIndex < 0 || slideIndex > input.slides.length) continue;
    try {
      const { data, info } = await sharp(Buffer.from(asset.bytesBase64, "base64"))
        .rotate()
        .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: { r: theme.surface.r, g: theme.surface.g, b: theme.surface.b } })
        .toColourspace("srgb")
        .jpeg({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      const objectId = writer.addImage(data, info.width, info.height);
      embedded.set(slideIndex, { name: `Im${slideIndex}`, objectId, width: info.width, height: info.height });
    } catch (error) {
      warnings.push(
        `Skipped the visual for slide ${slideIndex + 1}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }
  return embedded;
}

function drawSlideFrame(context: SlideContext, deckTitle: string): void {
  const { page, theme, index } = context;
  page.rect(0, 0, PAGE_W, PAGE_H, theme.background);
  page.rect(0, 0, 9.4, PAGE_H, theme.accent);
  page.line(37, 500, 908, 500, mixPdfColors(theme.background, theme.border, 0.6), 1);
  const number = String(index + 1).padStart(2, "0");
  page.text(908 - measureWinAnsi(number, "bold", 10), 516, number, { font: "bold", size: 10, color: theme.accent });
  if (index > 0) {
    const footer = truncateWinAnsi(toWinAnsiBytes(deckTitle), "regular", 10, 600);
    page.text(37, 516, footer, { font: "regular", size: 10, color: theme.muted });
  }
}

function drawSlide(context: SlideContext, renderer: PresentationDeckRenderer): void {
  switch (renderer) {
    case "hero":
      return drawCover(context);
    case "section":
    case "closing":
      return drawSection(context, renderer === "closing");
    case "section-continuation":
      return drawStacked(context);
    case "sources":
    case "sources-continuation":
      return drawSources(context, renderer === "sources-continuation");
    case "table":
    case "table-continuation":
    case "chart":
    case "chart-continuation":
      return drawDataSlide(context, renderer === "table-continuation");
    case "two-column":
      return drawColumns(context);
    case "comparison":
      return drawRows(context, true);
    case "stacked-list":
      return drawRows(context, false);
    case "stat-callout":
      return drawCallout(context);
    default:
      return drawStacked(context);
  }
}

function drawCover(context: SlideContext): void {
  const { page, slide, theme, image } = context;
  const panelWidth = image ? 504 : 870;
  page.rect(47.5, 46, panelWidth, 432, theme.surface, { color: theme.border, width: 0.75 });
  page.rect(72, 92, 64, 5, theme.accent);
  const titleWidth = panelWidth - 50;
  const titleSize = fitTextSize(slide.title, "bold", titleWidth, image ? 40 : 46, 28, 3);
  const titleHeight = drawWrappedText(
    page,
    slide.title,
    { x: 72, y: 112, w: titleWidth },
    {
      font: "bold",
      size: titleSize,
      color: theme.text,
      maxLines: 3,
    },
  );
  const subtitle = slide.bullets[0] ? presentationBulletText(slide.bullets[0]) : "";
  if (subtitle) {
    drawWrappedText(
      page,
      subtitle,
      { x: 74, y: 112 + titleHeight + 18, w: titleWidth - 20 },
      {
        font: "regular",
        size: 20,
        color: theme.muted,
        maxLines: 4,
      },
    );
  }
  if (image) {
    drawImage(context, { x: 580, y: 52, w: 331, h: 410 });
    return;
  }
  // Geometric motif stands in for a cover visual when none was provided.
  page.rect(700, 330, 150, 110, mixPdfColors(theme.surface, theme.accent, 0.85));
  page.rect(760, 280, 110, 90, mixPdfColors(theme.surface, theme.accent2, 0.8));
  page.rect(820, 360, 60, 60, mixPdfColors(theme.surface, theme.accent3, 0.85));
}

function drawContentTitle(context: SlideContext): void {
  const { page, slide, theme } = context;
  drawWrappedText(
    page,
    slide.title,
    { x: MARGIN_X, y: 26, w: 850 },
    {
      font: "bold",
      size: 28,
      color: theme.text,
      maxLines: 2,
    },
  );
}

function drawStacked(context: SlideContext): void {
  drawContentTitle(context);
  const { page, theme, image } = context;
  const cardWidth = image ? 508 : 836;
  const imageLeft = Boolean(image && context.index % 2 === 0);
  const imageWidth = 836 - cardWidth - 18;
  const card = {
    x: MARGIN_X + (imageLeft ? imageWidth + 18 : 0),
    y: BODY_TOP,
    w: cardWidth,
    h: BODY_BOTTOM - BODY_TOP,
  };
  page.rect(card.x, card.y, card.w, card.h, theme.surface, { color: theme.border, width: 0.75 });
  drawBullets(
    context,
    context.slide.bullets.map((bullet) => bulletRuns(bullet, context.sources)),
    inset(card, 22),
  );
  if (image)
    drawImage(context, { x: imageLeft ? MARGIN_X : MARGIN_X + cardWidth + 18, y: BODY_TOP, w: imageWidth, h: card.h });
}

/** Full-width editorial rows preserve all claims while avoiding repeated split cards. */
function drawRows(context: SlideContext, comparison: boolean): void {
  drawContentTitle(context);
  const { page, theme, slide } = context;
  const count = slide.bullets.length;
  if (count === 0) return;
  const gap = 8;
  const height = (BODY_BOTTOM - BODY_TOP - gap * (count - 1)) / count;
  // Extremely dense direct-render input retains the bounded text-fit fallback.
  if (height < 42) {
    drawStacked(context);
    return;
  }
  slide.bullets.forEach((bullet, index) => {
    const box = { x: MARGIN_X, y: BODY_TOP + index * (height + gap), w: 836, h: height };
    const accent = index % 2 === 0 ? theme.accent : theme.accent2;
    page.rect(box.x, box.y, box.w, box.h, theme.surface, { color: theme.border, width: 0.75 });
    const labelWidth = comparison ? 72 : 10;
    page.rect(box.x, box.y, labelWidth, box.h, comparison ? mixPdfColors(theme.surface, accent, 0.16) : accent);
    if (comparison)
      page.text(box.x + 18, box.y + Math.min(35, box.h / 2 + 7), String(index + 1).padStart(2, "0"), {
        font: "bold",
        size: 20,
        color: theme.citation ?? theme.text,
      });
    drawBullets(context, [bulletRuns(bullet, context.sources)], {
      x: box.x + labelWidth + 18,
      y: box.y + 10,
      w: box.w - labelWidth - 36,
      h: box.h - 20,
    });
  });
}

function drawColumns(context: SlideContext): void {
  drawContentTitle(context);
  const { page, theme, slide } = context;
  const half = Math.ceil(slide.bullets.length / 2);
  const columns = [slide.bullets.slice(0, half), slide.bullets.slice(half)].filter((column) => column.length > 0);
  const gap = 18;
  const width = (836 - gap * (columns.length - 1)) / Math.max(1, columns.length);
  columns.forEach((bullets, index) => {
    const card = { x: MARGIN_X + index * (width + gap), y: BODY_TOP, w: width, h: BODY_BOTTOM - BODY_TOP };
    page.rect(card.x, card.y, card.w, card.h, theme.surface, { color: theme.border, width: 0.75 });
    page.rect(card.x, card.y, card.w, 4, index === 0 ? theme.accent : theme.accent2);
    drawBullets(
      context,
      bullets.map((bullet) => bulletRuns(bullet, context.sources)),
      inset(card, 20),
    );
  });
}

function drawCallout(context: SlideContext): void {
  drawContentTitle(context);
  const { page, theme, slide } = context;
  const [lead, ...rest] = slide.bullets;
  if (!lead) return;
  const calloutWidth = rest.length > 0 ? 330 : 836;
  const panel = { x: MARGIN_X, y: BODY_TOP, w: calloutWidth, h: BODY_BOTTOM - BODY_TOP };
  page.rect(panel.x, panel.y, panel.w, panel.h, theme.accent);
  drawBulletList(page, [bulletRuns(lead, context.sources)], inset(panel, 28), {
    font: "bold",
    maxSize: rest.length > 0 ? 26 : 32,
    minSize: BODY_MIN_SIZE,
    colors: { text: theme.onAccent, citation: theme.onAccent },
    center: true,
  });
  if (rest.length === 0) return;
  const card = { x: panel.x + panel.w + 18, y: BODY_TOP, w: 836 - panel.w - 18, h: panel.h };
  page.rect(card.x, card.y, card.w, card.h, theme.surface, { color: theme.border, width: 0.75 });
  drawBullets(
    context,
    rest.map((bullet) => bulletRuns(bullet, context.sources)),
    inset(card, 22),
  );
}

function drawSection(context: SlideContext, closing: boolean): void {
  const { page, slide, theme, image } = context;
  const width = image ? 500 : 820;
  page.rect(MARGIN_X, 196, 80, 6, closing ? theme.accent2 : theme.accent);
  const titleSize = fitTextSize(slide.title, "bold", width, 40, 28, 2);
  const titleHeight = drawWrappedText(
    page,
    slide.title,
    { x: MARGIN_X, y: 214, w: width },
    {
      font: "bold",
      size: titleSize,
      color: theme.text,
      maxLines: 2,
    },
  );
  if (slide.bullets.length > 0) {
    drawBullets(
      context,
      slide.bullets.map((bullet) => bulletRuns(bullet, context.sources)),
      { x: MARGIN_X, y: 214 + titleHeight + 22, w: width, h: BODY_BOTTOM - (214 + titleHeight + 22) },
      { muted: true },
    );
  }
  if (image) drawImage(context, { x: 600, y: BODY_TOP, w: 291, h: BODY_BOTTOM - BODY_TOP });
}

function drawSources(context: SlideContext, continuation = false): void {
  drawContentTitle(context);
  const { page, theme, slide } = context;
  if (continuation) {
    page.rect(MARGIN_X, BODY_TOP, 150, BODY_BOTTOM - BODY_TOP, theme.accent);
    page.text(MARGIN_X + 20, BODY_TOP + 42, "REFERENCES", { font: "bold", size: 16, color: theme.onAccent });
  }
  const card = {
    x: MARGIN_X + (continuation ? 168 : 0),
    y: BODY_TOP,
    w: continuation ? 668 : 836,
    h: BODY_BOTTOM - BODY_TOP,
  };
  page.rect(card.x, card.y, card.w, card.h, theme.surface, { color: theme.border, width: 0.75 });
  const truncated = drawBulletList(
    page,
    slide.bullets.map((bullet) => bulletRuns(bullet, context.sources)),
    inset(card, 20),
    {
      maxSize: 14,
      minSize: SOURCE_MIN_SIZE,
      colors: { text: theme.text, citation: theme.citation ?? theme.text },
      marker: theme.citation ?? theme.text,
      linkEntries: true,
    },
  );
  if (truncated) context.warnings.push(`Slide ${context.index + 1} source list was shortened to fit the page.`);
}

function drawDataSlide(context: SlideContext, cards = false): void {
  const { page, theme, slide } = context;
  if (!slide.table && !slide.chart) {
    // A matrix/chart archetype without data keeps its full bullet list.
    drawStacked(context);
    return;
  }
  drawContentTitle(context);
  let top = BODY_TOP;
  if (slide.bullets.length > 0) {
    const introHeight = 54;
    drawBullets(
      context,
      slide.bullets.map((bullet) => bulletRuns(bullet, context.sources)),
      { x: MARGIN_X, y: top, w: 836, h: introHeight },
      { plain: true },
    );
    top += introHeight + 6;
  }
  const box = { x: MARGIN_X, y: top, w: 836, h: BODY_BOTTOM - top };
  if (slide.table) {
    if ((cards ? drawPdfTableCards : drawPdfTable)(page, slide.table, context.sources, theme, box)) {
      context.warnings.push(`Slide ${context.index + 1} table rows were cut to fit the page.`);
    }
    return;
  }
  if (slide.chart) {
    page.rect(box.x, box.y, box.w, box.h, theme.surface, { color: theme.border, width: 0.75 });
    drawPdfChart(page, slide.chart, theme, inset(box, 18));
  }
}

function drawBullets(
  context: SlideContext,
  entries: ReadonlyArray<readonly PdfTextRun[]>,
  box: PdfTextBox,
  options: { muted?: boolean; plain?: boolean } = {},
): void {
  const { page, theme } = context;
  const truncated = drawBulletList(page, entries, box, {
    maxSize: options.plain ? BODY_MIN_SIZE : 22,
    minSize: BODY_MIN_SIZE,
    colors: { text: options.muted ? theme.muted : theme.text, citation: theme.citation ?? theme.text },
    marker: options.plain || options.muted ? undefined : theme.accent,
  });
  if (truncated) context.warnings.push(`Slide ${context.index + 1} text was shortened to fit the page.`);
}

function drawImage(context: SlideContext, box: PdfTextBox): void {
  const { page, image, theme } = context;
  if (!image) return;
  page.rect(box.x, box.y, box.w, box.h, theme.surface, { color: theme.border, width: 0.75 });
  const scale = Math.min(box.w / image.width, box.h / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.image(image, box.x + (box.w - width) / 2, box.y + (box.h - height) / 2, width, height);
}

function inset(box: PdfTextBox, padding: number): PdfTextBox {
  return { x: box.x + padding, y: box.y + padding, w: box.w - padding * 2, h: box.h - padding * 2 };
}
