import sharp from "sharp";
import { createArtifactDesignPlan, type ArtifactDesignPlan } from "./artifact-design.js";
import {
  resolveContentSlideRenderer,
  resolvePresentationDeckLayoutPlan,
  type PresentationSlideLayoutDecision,
} from "./presentation-layout.js";

export interface PresentationSlide {
  title: string;
  bullets: string[];
  speakerNotes?: string;
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
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

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
  try {
    return await createPptxGenPresentation(input);
  } catch {
    return createFallbackPresentationPptx(input);
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
  const visualData = visualAsset
    ? visualAssetToDataUri(visualAsset)
    : await buildAbstractVisualDataUri(input.title, design);
  const visualSource = visualAsset
    ? `${visualAsset.source ?? "generated-image"}${visualAsset.sourceModel ? `:${visualAsset.sourceModel}` : ""}`
    : "local-renderer";
  const layoutPlan = resolvePresentationDeckLayoutPlan(design, slides);
  slides.forEach((slide, index) => {
    const pptSlide = pptx.addSlide();
    pptSlide.background = { color: design.tokens.background };
    pptSlide.color = design.tokens.text;
    drawSlideFrame(pptx, pptSlide, design, index);
    if (index === 0) {
      drawHeroSlide(pptx, pptSlide, slide, design, visualData);
    } else {
      drawContentSlide(pptx, pptSlide, slide, design, visualData, index, layoutPlan[index]);
    }
    const notes = [
      slide.speakerNotes,
      `Layout: ${layoutPlan[index]?.renderer ?? "unknown"}; density=${layoutPlan[index]?.density ?? "unknown"}; reason=${layoutPlan[index]?.reason ?? "n/a"}.`,
      `GoatCitadel design provenance: preset=${design.preset}; visualLevel=${design.visualLevel}; assetPolicy=${design.assetPolicy}.`,
      `Visual source: ${visualSource}.`,
      visualAsset?.revisedPrompt ? `Visual revised prompt: ${visualAsset.revisedPrompt}` : undefined,
      `Assets: ${design.assetPlan.map((asset) => `${asset.id}:${asset.status}`).join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");
    pptSlide.addNotes(notes);
  });

  const output = await pptx.write({ outputType: "nodebuffer", compression: true });
  return toBuffer(output);
}

export function createFallbackPresentationPptx(input: PresentationPptxInput): Buffer {
  const contentSlides = input.slides.length > 0 ? input.slides : [{ title: input.title, bullets: [] }];
  const slides: PresentationSlide[] = [
    {
      title: input.title,
      bullets: input.subtitle ? [input.subtitle] : [],
    },
    ...contentSlides,
  ];
  const createdAt = input.createdAt ?? new Date();
  const entries: ZipEntry[] = [
    xmlEntry("[Content_Types].xml", buildContentTypes(slides.length)),
    xmlEntry("_rels/.rels", buildRootRelationships()),
    xmlEntry("docProps/core.xml", buildCoreProperties(input.title, createdAt)),
    xmlEntry("docProps/app.xml", buildAppProperties(slides.length)),
    xmlEntry("ppt/presentation.xml", buildPresentationXml(slides.length)),
    xmlEntry("ppt/_rels/presentation.xml.rels", buildPresentationRelationships(slides.length)),
    xmlEntry("ppt/slideMasters/slideMaster1.xml", buildSlideMasterXml()),
    xmlEntry("ppt/slideMasters/_rels/slideMaster1.xml.rels", buildSlideMasterRelationships()),
    xmlEntry("ppt/slideLayouts/slideLayout1.xml", buildSlideLayoutXml()),
    xmlEntry("ppt/slideLayouts/_rels/slideLayout1.xml.rels", buildSlideLayoutRelationships()),
    xmlEntry("ppt/theme/theme1.xml", buildThemeXml()),
  ];
  slides.forEach((slide, index) => {
    entries.push(xmlEntry(`ppt/slides/slide${index + 1}.xml`, buildSlideXml(slide, index)));
    entries.push(xmlEntry(`ppt/slides/_rels/slide${index + 1}.xml.rels`, buildSlideRelationships()));
  });
  return createStoredZip(entries);
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
  slide.addText(`GoatCitadel design brief - ${design.preset}`, {
    x: 0.54,
    y: 7.03,
    w: 6,
    h: 0.18,
    fontFace: design.typography.bodyFont,
    fontSize: 6.5,
    color: design.tokens.mutedText,
    margin: 0,
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
  slide.addText("Designed artifact", {
    x: 1.04,
    y: 4.35,
    w: 2.2,
    h: 0.26,
    fontFace: design.typography.bodyFont,
    fontSize: 9,
    bold: true,
    color: design.tokens.accent,
    margin: 0,
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
  const renderer = layoutDecision?.renderer === "hero" ? "image-text" : layoutDecision?.renderer;
  const resolvedRenderer = renderer ?? resolveContentSlideRenderer(design, index, content);
  if (resolvedRenderer === "two-column") {
    drawTwoColumnSlide(pptx, slide, content, design, visualData);
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
  visualData: string,
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
  slide.addImage({
    data: visualData,
    x: 10.95,
    y: 5.25,
    w: 1.25,
    h: 0.75,
    transparency: 12,
    altText: `Small generated accent visual for ${content.title}`,
    objectName: "GoatCitadel accent visual",
  });
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
  const rowGap = options.compact ? 0.12 : 0.18;
  const maxRowHeight = options.compact ? 0.76 : 0.92;
  const rowHeight = Math.max(
    options.compact ? 0.42 : 0.5,
    Math.min(maxRowHeight, (h - rowGap * Math.max(0, bullets.length - 1)) / bullets.length),
  );
  const fontSize = options.compact ? (bullets.length > 3 ? 10.8 : 12) : bullets.length > 3 ? 12.5 : 14;
  const startIndex = options.startIndex ?? 1;
  bullets.forEach((bullet, index) => {
    const rowY = y + index * (rowHeight + rowGap);
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
      fontSize,
      fit: "shrink",
      color: design.tokens.text,
      breakLine: false,
      valign: "top",
      margin: 0.02,
      breakLineOnHyphen: false,
    });
  });
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

async function buildAbstractVisualDataUri(title: string, design: ArtifactDesignPlan): Promise<string> {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">`,
    `<rect width="1200" height="1500" rx="48" fill="#${design.tokens.surface}"/>`,
    `<circle cx="920" cy="190" r="260" fill="#${design.tokens.accent}" opacity="0.18"/>`,
    `<circle cx="240" cy="1200" r="330" fill="#${design.tokens.accent2}" opacity="0.16"/>`,
    `<path d="M120 345 C360 180 520 550 760 390 S1040 275 1110 520" fill="none" stroke="#${design.tokens.accent}" stroke-width="34" stroke-linecap="round" opacity="0.82"/>`,
    `<path d="M155 720 H1030" stroke="#${design.tokens.border}" stroke-width="8" opacity="0.75"/>`,
    `<rect x="155" y="810" width="300" height="300" rx="32" fill="#${design.tokens.accent}" opacity="0.9"/>`,
    `<rect x="505" y="810" width="300" height="300" rx="32" fill="#${design.tokens.accent2}" opacity="0.9"/>`,
    `<rect x="855" y="810" width="190" height="300" rx="32" fill="#${design.tokens.accent3}" opacity="0.9"/>`,
    `<text x="155" y="1260" fill="#${design.tokens.mutedText}" font-family="Arial, sans-serif" font-size="54" font-weight="700">${escapeSvgText(title.slice(0, 34))}</text>`,
    `</svg>`,
  ].join("");
  const buffer = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
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

function escapeSvgText(value: string): string {
  return value.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function xmlEntry(name: string, xml: string): ZipEntry {
  return { name, data: Buffer.from(xml, "utf8") };
}

function buildContentTypes(slideCount: number): string {
  const slideOverrides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");
  return xmlDocument(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      slideOverrides +
      `</Types>`,
  );
}

function buildRootRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="ppt/presentation.xml"/>` +
      `<Relationship Id="rId2" Type="${PACKAGE_REL_NS}/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
  );
}

function buildCoreProperties(title: string, createdAt: Date): string {
  const timestamp = createdAt.toISOString();
  return xmlDocument(
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
      `xmlns:dcterms="http://purl.org/dc/terms/" ` +
      `xmlns:dcmitype="http://purl.org/dc/dcmitype/" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${escapeXml(title)}</dc:title>` +
      `<dc:creator>GoatCitadel</dc:creator>` +
      `<cp:lastModifiedBy>GoatCitadel</cp:lastModifiedBy>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>` +
      `</cp:coreProperties>`,
  );
}

function buildAppProperties(slideCount: number): string {
  return xmlDocument(
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
      `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      `<Application>GoatCitadel</Application>` +
      `<PresentationFormat>Widescreen</PresentationFormat>` +
      `<Slides>${slideCount}</Slides>` +
      `<Notes>0</Notes>` +
      `<HiddenSlides>0</HiddenSlides>` +
      `<MMClips>0</MMClips>` +
      `<ScaleCrop>false</ScaleCrop>` +
      `</Properties>`,
  );
}

function buildPresentationXml(slideCount: number): string {
  const slideIds = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join("");
  return xmlDocument(
    `<p:presentation xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
      `<p:sldSz cx="12192000" cy="6858000" type="wide"/>` +
      `<p:notesSz cx="6858000" cy="9144000"/>` +
      `<p:defaultTextStyle/>` +
      `</p:presentation>`,
  );
}

function buildPresentationRelationships(slideCount: number): string {
  const slideRelationships = Array.from(
    { length: slideCount },
    (_, index) => `<Relationship Id="rId${index + 2}" Type="${REL_NS}/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      slideRelationships +
      `</Relationships>`,
  );
}

function buildSlideXml(slide: PresentationSlide, index: number): string {
  const titleShape = textShape({
    id: 2,
    name: "Title",
    x: 609600,
    y: 365760,
    cx: 10972800,
    cy: 914400,
    paragraphs: [runParagraph(slide.title, 3600, true)],
  });
  const bodyParagraphs =
    slide.bullets.length > 0
      ? slide.bullets.map((bullet) => bulletParagraph(bullet))
      : [runParagraph(index === 0 ? "Generated by GoatCitadel." : "No details provided.", 2200, false)];
  const bodyShape = textShape({
    id: 3,
    name: "Body",
    x: 914400,
    y: 1554480,
    cx: 10363200,
    cy: 4724400,
    paragraphs: bodyParagraphs,
  });
  return xmlDocument(
    `<p:sld xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      titleShape +
      bodyShape +
      `</p:spTree></p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
      `</p:sld>`,
  );
}

function buildSlideRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `</Relationships>`,
  );
}

function buildSlideMasterXml(): string {
  return xmlDocument(
    `<p:sldMaster xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="111827"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
      `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      `<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>` +
      `</p:sldMaster>`,
  );
}

function buildSlideMasterRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL_NS}/theme" Target="../theme/theme1.xml"/>` +
      `</Relationships>`,
  );
}

function buildSlideLayoutXml(): string {
  return xmlDocument(
    `<p:sldLayout xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}" type="blank" preserve="1">` +
      `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  );
}

function buildSlideLayoutRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
      `</Relationships>`,
  );
}

function buildThemeXml(): string {
  return xmlDocument(
    `<a:theme xmlns:a="${DRAWING_NS}" name="GoatCitadel">` +
      `<a:themeElements><a:clrScheme name="GoatCitadel">` +
      `<a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="F8FAFC"/></a:lt1>` +
      `<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="E5E7EB"/></a:lt2>` +
      `<a:accent1><a:srgbClr val="2DD4BF"/></a:accent1><a:accent2><a:srgbClr val="60A5FA"/></a:accent2>` +
      `<a:accent3><a:srgbClr val="F472B6"/></a:accent3><a:accent4><a:srgbClr val="FBBF24"/></a:accent4>` +
      `<a:accent5><a:srgbClr val="A78BFA"/></a:accent5><a:accent6><a:srgbClr val="34D399"/></a:accent6>` +
      `<a:hlink><a:srgbClr val="60A5FA"/></a:hlink><a:folHlink><a:srgbClr val="A78BFA"/></a:folHlink>` +
      `</a:clrScheme><a:fontScheme name="Aptos"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
      `<a:fmtScheme name="GoatCitadel">` +
      `<a:fillStyleLst>` +
      `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
      `<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>` +
      `<a:solidFill><a:schemeClr val="accent2"/></a:solidFill>` +
      `</a:fillStyleLst>` +
      `<a:lnStyleLst>` +
      `<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
      `<a:ln w="25400"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>` +
      `<a:ln w="38100"><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:ln>` +
      `</a:lnStyleLst>` +
      `<a:effectStyleLst>` +
      `<a:effectStyle><a:effectLst/></a:effectStyle>` +
      `<a:effectStyle><a:effectLst/></a:effectStyle>` +
      `<a:effectStyle><a:effectLst/></a:effectStyle>` +
      `</a:effectStyleLst>` +
      `<a:bgFillStyleLst>` +
      `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
      `<a:solidFill><a:schemeClr val="lt1"/></a:solidFill>` +
      `<a:solidFill><a:schemeClr val="dk1"/></a:solidFill>` +
      `</a:bgFillStyleLst>` +
      `</a:fmtScheme>` +
      `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`,
  );
}

function textShape(input: {
  id: number;
  name: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  paragraphs: string[];
}): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${input.id}" name="${escapeXml(input.name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${input.x}" y="${input.y}"/><a:ext cx="${input.cx}" cy="${input.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${input.paragraphs.join("")}</p:txBody></p:sp>`
  );
}

function runParagraph(text: string, size: number, bold: boolean): string {
  return `<a:p><a:r><a:rPr lang="en-US" sz="${size}"${bold ? ` b="1"` : ""}><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill></a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

function bulletParagraph(text: string): string {
  return `<a:p><a:pPr marL="342900" indent="-171450"><a:buChar char="-"/></a:pPr><a:r><a:rPr lang="en-US" sz="2200"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

export function createStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

const CRC32_TABLE = makeCrc32Table();

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
