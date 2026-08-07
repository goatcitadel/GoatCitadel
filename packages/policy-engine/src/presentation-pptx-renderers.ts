import type { ArtifactDesignPlan } from "./artifact-design.js";
import type { PresentationSlideLayoutDecision } from "./presentation-layout.js";
import { presentationSourceEntryLayout, presentationTableRowHeights } from "./presentation-capacity.js";
import {
  presentationBulletSourceIds,
  presentationBulletText,
  presentationTableCellLayoutText,
  sourceMap,
  type PresentationBullet,
  type PresentationSlide,
  type PresentationSource,
  type PresentationTableCell,
} from "./presentation-model.js";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

interface PptxTextRun {
  text: string;
  options?: Record<string, unknown>;
}

export interface PptxSlideLike {
  background?: { color: string };
  color?: string;
  addShape(shapeName: string, options?: Record<string, unknown>): PptxSlideLike;
  addImage(options: Record<string, unknown>): PptxSlideLike;
  addText(text: string | PptxTextRun[], options?: Record<string, unknown>): PptxSlideLike;
  addTable?(rows: Array<Array<string | Record<string, unknown>>>, options?: Record<string, unknown>): PptxSlideLike;
  addChart?(
    chartType: string,
    series: Array<{ name: string; labels: string[]; values: number[] }>,
    options?: Record<string, unknown>,
  ): PptxSlideLike;
  addNotes(notes: string): PptxSlideLike;
}

export interface PptxPresentationLike {
  ShapeType: Record<string, string>;
  ChartType?: Record<string, string>;
}

export function drawPresentationSlide(input: {
  pptx: PptxPresentationLike;
  slide: PptxSlideLike;
  content: PresentationSlide;
  design: ArtifactDesignPlan;
  visualData: string;
  index: number;
  layoutDecision?: PresentationSlideLayoutDecision;
  hasMappedVisual: boolean;
  sources: readonly PresentationSource[];
}): void {
  drawSlideFrame(input.pptx, input.slide, input.design, input.index);
  const renderer = input.index === 0 ? "hero" : (input.layoutDecision?.renderer ?? "image-text");
  drawLayoutSignature(input.pptx, input.slide, renderer);
  if (input.index === 0) {
    drawHeroSlide(input.pptx, input.slide, input.content, input.design, input.visualData);
    return;
  }
  if (renderer !== "section" && renderer !== "section-continuation") {
    drawContentTitle(input.slide, input.content, input.design);
  }
  switch (renderer) {
    case "comparison":
    case "two-column":
      drawComparisonSlide(input.pptx, input.slide, input.content, input.design, input.sources);
      break;
    case "stacked-list":
      drawStackedListSlide(input.pptx, input.slide, input.content, input.design, input.sources);
      break;
    case "stat-callout":
    case "closing":
      drawCalloutSlide(input.pptx, input.slide, input.content, input.design, input.sources);
      break;
    case "table":
      drawTableSlide(input.pptx, input.slide, input.content, input.design, input.sources);
      break;
    case "table-continuation":
      drawTableSlide(input.pptx, input.slide, input.content, input.design, input.sources, true);
      break;
    case "chart":
      drawChartSlide(input.pptx, input.slide, input.content, input.design, input.sources);
      break;
    case "chart-continuation":
      drawChartSlide(input.pptx, input.slide, input.content, input.design, input.sources, true);
      break;
    case "section":
      drawSectionSlide(input.pptx, input.slide, input.content, input.design, input.sources);
      break;
    case "section-continuation":
      drawSectionSlide(input.pptx, input.slide, input.content, input.design, input.sources, true);
      break;
    case "sources":
      drawSourcesSlide(input.pptx, input.slide, input.content, input.design, input.sources);
      break;
    case "sources-continuation":
      drawSourcesSlide(input.pptx, input.slide, input.content, input.design, input.sources, true);
      break;
    default:
      drawImageTextSlide(
        input.pptx,
        input.slide,
        input.content,
        input.design,
        input.visualData,
        input.sources,
        input.hasMappedVisual,
      );
  }
}

function drawLayoutSignature(pptx: PptxPresentationLike, slide: PptxSlideLike, renderer: string): void {
  slide.addShape(shape(pptx, "rect"), {
    objectName: `gc:layout:${renderer}`,
    x: 0,
    y: 0,
    w: 0.01,
    h: 0.01,
    fill: { color: "FFFFFF", transparency: 100 },
    line: { color: "FFFFFF", transparency: 100 },
  });
}

export function buildAuthoredNotes(
  slide: PresentationSlide,
  _sources: readonly PresentationSource[],
): string | undefined {
  return slide.speakerNotes?.trim() ? slide.speakerNotes : undefined;
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
    objectName: "gc:slide-number",
    x: 12,
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
    w: 7,
    h: 6,
    rectRadius: 0.08,
    fill: { color: design.tokens.surface, transparency: design.preset === "cyberpunk-ops" ? 10 : 0 },
    line: { color: design.tokens.border, transparency: 15 },
  });
  slide.addText(content.title, {
    objectName: "gc:title",
    x: 1,
    y: 1.08,
    w: 6.25,
    h: 1.55,
    fontFace: design.typography.headingFont,
    fontSize: 34,
    bold: true,
    color: design.tokens.text,
    margin: 0.02,
    valign: "mid",
  });
  const subtitle = content.bullets[0] ? presentationBulletText(content.bullets[0]) : undefined;
  if (subtitle) {
    slide.addText(subtitle, {
      objectName: "gc:subtitle",
      x: 1.04,
      y: 2.85,
      w: 5.85,
      h: 1.1,
      fontFace: design.typography.bodyFont,
      fontSize: 18,
      color: design.tokens.mutedText,
      margin: 0,
      valign: "top",
    });
  }
  slide.addImage({
    data: visualData,
    x: 8.05,
    y: 0.72,
    w: 4.6,
    h: 5.7,
    altText: `Supporting visual for ${content.title}`,
    objectName: "GoatCitadel cover visual",
  });
}

function drawContentTitle(slide: PptxSlideLike, content: PresentationSlide, design: ArtifactDesignPlan): void {
  slide.addText(wrapPresentationTitle(content.title), {
    objectName: "gc:title",
    x: 0.76,
    y: 0.45,
    w: 11.5,
    h: 0.9,
    fontFace: design.typography.headingFont,
    fontSize: 28,
    bold: true,
    align: "left",
    color: design.tokens.text,
    margin: 0,
    valign: "mid",
  });
}

function drawImageTextSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  visualData: string,
  sources: readonly PresentationSource[],
  showVisual: boolean,
): void {
  const contentWidth = showVisual ? 7.05 : 11.62;
  slide.addShape(shape(pptx, "roundRect"), {
    x: 0.76,
    y: 1.42,
    w: contentWidth,
    h: 4.86,
    rectRadius: 0.05,
    fill: { color: design.tokens.surface },
    line: { color: design.tokens.border, transparency: 15 },
  });
  addBulletBlock(slide, content.bullets, design, 1.08, 1.72, showVisual ? 6.32 : 10.98, 4.25, sources);
  if (showVisual) {
    slide.addImage({
      data: visualData,
      x: 8.35,
      y: 1.55,
      w: 3.9,
      h: 4.65,
      altText: `Supporting visual for ${content.title}`,
      objectName: "GoatCitadel supporting visual",
    });
  }
}

function drawComparisonSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  sources: readonly PresentationSource[],
): void {
  const left = content.bullets.slice(0, Math.ceil(content.bullets.length / 2));
  const right = content.bullets.slice(left.length);
  [0.76, 6.42].forEach((x, index) => {
    slide.addShape(shape(pptx, "roundRect"), {
      x,
      y: 1.44,
      w: 5.15,
      h: 4.82,
      rectRadius: 0.05,
      fill: { color: index === 0 ? design.tokens.surface : design.tokens.background, transparency: index * 6 },
      line: { color: index === 0 ? design.tokens.border : design.tokens.accent2, transparency: 18 },
    });
  });
  addBulletBlock(slide, left, design, 1.08, 1.78, 4.45, 4.05, sources, "gc:body:comparison-left");
  addBulletBlock(slide, right, design, 6.74, 1.78, 4.45, 4.05, sources, "gc:body:comparison-right");
}

function drawStackedListSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  sources: readonly PresentationSource[],
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
  addBulletBlock(slide, content.bullets, design, 1.08, 1.72, 10.98, 4.25, sources, "gc:body:stacked");
}

function drawCalloutSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  sources: readonly PresentationSource[],
): void {
  const [first, ...rest] = content.bullets;
  slide.addShape(shape(pptx, "roundRect"), {
    x: 0.9,
    y: 1.55,
    w: 11.25,
    h: 1.65,
    rectRadius: 0.07,
    fill: { color: design.tokens.accent, transparency: 4 },
    line: { color: design.tokens.accent, transparency: 100 },
  });
  if (first) {
    slide.addText(citationRuns(first, sources, design, "FFFFFF"), {
      objectName: "gc:body",
      x: 1.35,
      y: 1.9,
      w: 10.35,
      h: 0.9,
      fontFace: design.typography.headingFont,
      fontSize: 22,
      bold: true,
      color: "FFFFFF",
      margin: 0,
      valign: "mid",
    });
  }
  addBulletBlock(slide, rest, design, 1.15, 3.6, 10.85, 2.05, sources, "gc:body:callout-detail");
}

function drawTableSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  sources: readonly PresentationSource[],
  alternate = false,
): void {
  const table = content.table;
  if (!table || !slide.addTable) {
    drawTableAsRows(pptx, slide, content, design, sources);
    return;
  }
  const rows = [
    table.headers.map((cell) => tableCellContent(cell, sources, design)),
    ...table.rows.map((row) => row.map((cell) => tableCellContent(cell, sources, design))),
  ];
  const rowHeights = presentationTableRowHeights(
    table.headers.map(presentationTableCellLayoutText),
    table.rows.map((row) => row.map(presentationTableCellLayoutText)),
  );
  if (alternate) {
    drawContinuationRail(pptx, slide, design, 1.48, content.bullets.length > 0 ? 3.55 : 4.35);
  }
  slide.addTable(rows, {
    objectName: "gc:table",
    x: 0.76,
    y: content.bullets.length > 0 ? 2.05 : 1.48,
    w: 11.62,
    h: content.bullets.length > 0 ? 3.55 : 4.35,
    fontFace: design.typography.bodyFont,
    fontSize: 14,
    color: design.tokens.text,
    border: { color: design.tokens.border, pt: 1 },
    fill: design.tokens.surface,
    margin: 0.08,
    autoFit: false,
    bold: false,
    rowH: rowHeights,
  });
  if (content.bullets.length > 0) {
    addCompactIntro(slide, content.bullets, design, sources);
  }
}

function drawTableAsRows(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  sources: readonly PresentationSource[],
): void {
  const table = content.table;
  const rows = table
    ? [table.headers, ...table.rows].map((row) => row.map((cell) => tableCellText(cell, sources)).join(" | "))
    : content.bullets.map(presentationBulletText);
  addBulletRows(pptx, slide, rows, design, 0.95, 1.55, 11.2, 4.65, sources, 14);
}

function drawChartSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  sources: readonly PresentationSource[],
  alternate = false,
): void {
  const chart = content.chart;
  if (!chart || !slide.addChart) {
    const rows = chart
      ? chart.categories.map((category, index) =>
          [category, ...chart.series.map((series) => `${series.name}: ${series.values[index] ?? ""}`)].join(" — "),
        )
      : content.bullets.map(presentationBulletText);
    addBulletRows(pptx, slide, rows, design, 0.95, 1.55, 11.2, 4.65, sources, 16);
    return;
  }
  const hasIntro = content.bullets.length > 0;
  if (alternate) {
    slide.addShape(shape(pptx, "roundRect"), {
      x: 0.7,
      y: hasIntro ? 1.74 : 1.3,
      w: 11.68,
      h: hasIntro ? 4.38 : 4.88,
      rectRadius: 0.04,
      fill: { color: design.tokens.surface },
      line: { color: design.tokens.accent2, transparency: 30 },
    });
  }
  slide.addText(`Series: ${chart.series.map((series) => series.name).join(" • ")}`, {
    objectName: "gc:chart-label",
    x: 0.86,
    y: hasIntro ? 1.84 : 1.36,
    w: 11.35,
    h: 0.4,
    fontFace: design.typography.bodyFont,
    fontSize: 16,
    bold: true,
    color: design.tokens.mutedText,
    margin: 0,
    align: "center",
  });
  slide.addChart(
    chartType(pptx, chart.type),
    chart.series.map((series) => ({ name: series.name, labels: chart.categories, values: series.values })),
    {
      objectName: "gc:chart",
      x: 0.86,
      y: hasIntro ? 2.28 : 1.84,
      w: 11.35,
      h: hasIntro ? 3.7 : 4.15,
      showTitle: false,
      showLegend: chart.series.length > 1,
      legendFontFace: design.typography.bodyFont,
      legendFontSize: 14,
      legendPos: "t",
      showValue: true,
      catAxisLabelFontFace: design.typography.bodyFont,
      catAxisLabelFontSize: 14,
      valAxisLabelFontFace: design.typography.bodyFont,
      valAxisLabelFontSize: 14,
      chartColors: [design.tokens.accent, design.tokens.accent2, design.tokens.accent3],
      barDir: chart.type === "bar" ? "bar" : "col",
      showCatName: false,
      showSerName: false,
    },
  );
  if (content.bullets.length > 0) {
    addCompactIntro(slide, content.bullets, design, sources);
  }
  const ids = [...(chart.sourceIds ?? []), ...chart.series.flatMap((series) => series.sourceIds ?? [])];
  addSourceFooter(slide, ids, sources, design);
}

function drawSectionSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  sources: readonly PresentationSource[],
  alternate = false,
): void {
  slide.addShape(shape(pptx, "roundRect"), {
    x: 0.9,
    y: 1.45,
    w: 11.35,
    h: 4.7,
    rectRadius: 0.08,
    fill: { color: design.tokens.surface },
    line: { color: design.tokens.accent, transparency: 25 },
  });
  slide.addText(content.title, {
    objectName: "gc:title",
    x: alternate ? 1.65 : 1.35,
    y: 2.05,
    w: alternate ? 9.75 : 10.45,
    h: 1.1,
    fontFace: design.typography.headingFont,
    fontSize: 34,
    bold: true,
    align: alternate ? "left" : "center",
    color: design.tokens.text,
    margin: 0,
  });
  if (alternate) {
    drawContinuationRail(pptx, slide, design, 1.82, 3.6);
  }
  addBulletBlock(
    slide,
    content.bullets,
    design,
    alternate ? 1.65 : 2.15,
    3.45,
    alternate ? 9.75 : 8.85,
    1.8,
    sources,
    "gc:body:section",
    18,
  );
}

function drawSourcesSlide(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  content: PresentationSlide,
  design: ArtifactDesignPlan,
  sources: readonly PresentationSource[],
  alternate = false,
): void {
  if (!content.generatedSourceAppendix) {
    drawStackedListSlide(pptx, slide, content, design, sources);
    if (alternate) drawContinuationRail(pptx, slide, design, 1.42, 4.86);
    return;
  }
  const byId = sourceMap(sources);
  let y = 1.42;
  if (alternate) {
    drawContinuationRail(pptx, slide, design, 1.42, 5);
  }
  for (const bullet of content.bullets) {
    const source = presentationBulletSourceIds(bullet)
      .map((id) => byId.get(id))
      .find(Boolean);
    const label = source ? `${source.publisher}: ${source.title}` : presentationBulletText(bullet);
    const url = source?.url;
    const metrics = presentationSourceEntryLayout(label, url ?? "");
    slide.addShape(shape(pptx, "roundRect"), {
      x: 0.76,
      y,
      w: 11.62,
      h: metrics.cardHeight,
      rectRadius: 0.04,
      fill: { color: design.tokens.surface },
      line: { color: design.tokens.border, transparency: 20 },
    });
    slide.addText(label, {
      objectName: "gc:source",
      x: 1.02,
      y: y + 0.15,
      w: 10.95,
      h: metrics.labelHeight,
      fontFace: design.typography.bodyFont,
      fontSize: 14,
      bold: true,
      color: design.tokens.text,
      margin: 0,
    });
    if (url) {
      slide.addText([{ text: url, options: { hyperlink: { url }, color: design.tokens.accent2 } }], {
        objectName: "gc:source",
        x: 1.02,
        y: y + 0.25 + metrics.labelHeight,
        w: 10.95,
        h: metrics.urlHeight,
        fontFace: design.typography.bodyFont,
        fontSize: 12,
        color: design.tokens.accent2,
        margin: 0,
        breakLineOnHyphen: false,
      });
    }
    y += metrics.advance;
  }
}

function drawContinuationRail(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  design: ArtifactDesignPlan,
  y: number,
  h: number,
): void {
  slide.addShape(shape(pptx, "rect"), {
    objectName: "gc:continuation-rail",
    x: 0.61,
    y,
    w: 0.07,
    h,
    fill: { color: design.tokens.accent2 },
    line: { color: design.tokens.accent2, transparency: 100 },
  });
}

function addBulletBlock(
  slide: PptxSlideLike,
  bullets: readonly PresentationBullet[],
  design: ArtifactDesignPlan,
  x: number,
  y: number,
  w: number,
  h: number,
  sources: readonly PresentationSource[],
  objectName = "gc:body",
  fontSize = 16,
): void {
  if (bullets.length === 0) {
    return;
  }
  slide.addText(bulletBlockRuns(bullets, sources, design), {
    objectName,
    x,
    y,
    w,
    h,
    fontFace: design.typography.bodyFont,
    fontSize,
    color: design.tokens.text,
    breakLineOnHyphen: false,
    breakLine: false,
    paraSpaceAfterPt: 12,
    margin: 0.04,
    valign: "mid",
  });
}

function bulletBlockRuns(
  bullets: readonly PresentationBullet[],
  sources: readonly PresentationSource[],
  design: ArtifactDesignPlan,
): PptxTextRun[] {
  const runs: PptxTextRun[] = [];
  bullets.forEach((bullet, index) => {
    runs.push({ text: "• ", options: { bold: true, color: design.tokens.accent } });
    const bulletRuns = citationRuns(bullet, sources, design).map((run) => ({
      ...run,
      options: { ...run.options },
    }));
    if (index < bullets.length - 1) {
      const last = bulletRuns.at(-1);
      if (last) {
        last.options = { ...last.options, breakLine: true, paraSpaceAfterPt: 12 };
      }
    }
    runs.push(...bulletRuns);
  });
  return runs;
}

function addBulletRows(
  pptx: PptxPresentationLike,
  slide: PptxSlideLike,
  bullets: readonly PresentationBullet[],
  design: ArtifactDesignPlan,
  x: number,
  y: number,
  w: number,
  h: number,
  sources: readonly PresentationSource[],
  fontSize = 16,
): void {
  if (bullets.length === 0) {
    return;
  }
  const rowGap = 0.12;
  const rowHeight = (h - rowGap * Math.max(0, bullets.length - 1)) / bullets.length;
  bullets.forEach((bullet, index) => {
    const rowY = y + index * (rowHeight + rowGap);
    slide.addShape(shape(pptx, "rect"), {
      x,
      y: rowY + 0.05,
      w: 0.05,
      h: Math.max(0.25, rowHeight - 0.1),
      fill: { color: index % 2 === 0 ? design.tokens.accent : design.tokens.accent2 },
      line: { color: design.tokens.border, transparency: 100 },
    });
    slide.addText(citationRuns(bullet, sources, design), {
      objectName: "gc:body",
      x: x + 0.2,
      y: rowY,
      w: w - 0.2,
      h: rowHeight,
      fontFace: design.typography.bodyFont,
      fontSize,
      color: design.tokens.text,
      valign: "mid",
      margin: 0.02,
      breakLineOnHyphen: false,
    });
  });
}

function citationRuns(
  bullet: PresentationBullet,
  sources: readonly PresentationSource[],
  design: ArtifactDesignPlan,
  textColor = design.tokens.text,
): PptxTextRun[] {
  const byId = sourceMap(sources);
  const runs: PptxTextRun[] = [{ text: presentationBulletText(bullet), options: { color: textColor } }];
  presentationBulletSourceIds(bullet).forEach((id) => {
    const source = byId.get(id);
    if (source) {
      runs.push({
        text: ` [${sourceLabel(source, sources)}]`,
        options: { fontSize: 11, color: design.tokens.accent2, hyperlink: { url: source.url }, breakLine: false },
      });
    }
  });
  return runs;
}

function addCompactIntro(
  slide: PptxSlideLike,
  bullets: readonly PresentationBullet[],
  design: ArtifactDesignPlan,
  sources: readonly PresentationSource[],
): void {
  const first = bullets[0];
  if (!first) {
    return;
  }
  slide.addText(citationRuns(first, sources, design), {
    objectName: "gc:body",
    x: 0.86,
    y: 1.36,
    w: 11.35,
    h: 0.48,
    fontFace: design.typography.bodyFont,
    fontSize: 16,
    color: design.tokens.text,
    margin: 0,
  });
}

function addSourceFooter(
  slide: PptxSlideLike,
  sourceIds: readonly string[],
  sources: readonly PresentationSource[],
  design: ArtifactDesignPlan,
): void {
  const unique = [...new Set(sourceIds)];
  if (unique.length === 0) {
    return;
  }
  const byId = sourceMap(sources);
  const runs: PptxTextRun[] = [{ text: "Sources: ", options: { color: design.tokens.mutedText } }];
  unique.forEach((id, index) => {
    const source = byId.get(id);
    if (!source) {
      return;
    }
    runs.push({
      text: `${index > 0 ? " · " : ""}[${sourceLabel(source, sources)}]`,
      options: { color: design.tokens.accent2, hyperlink: { url: source.url } },
    });
  });
  slide.addText(runs, {
    objectName: "gc:citation",
    x: 0.86,
    y: 6.28,
    w: 10.9,
    h: 0.45,
    fontFace: design.typography.bodyFont,
    fontSize: 11,
    margin: 0,
  });
}

function tableCellContent(
  cell: PresentationTableCell,
  sources: readonly PresentationSource[],
  design: ArtifactDesignPlan,
): Record<string, unknown> {
  const byId = sourceMap(sources);
  const text: Array<Record<string, unknown>> = [{ text: cell.text, options: { fontSize: 14 } }];
  for (const sourceId of cell.sourceIds ?? []) {
    const source = byId.get(sourceId);
    if (source) {
      text.push({
        text: ` [${sourceLabel(source, sources)}]`,
        options: { fontSize: 14, color: design.tokens.accent2, hyperlink: { url: source.url } },
      });
    }
  }
  return { text };
}

function tableCellText(cell: PresentationTableCell, sources: readonly PresentationSource[]): string {
  const markers = (cell.sourceIds ?? [])
    .map((id) => sources.find((source) => source.id === id))
    .filter((source): source is PresentationSource => Boolean(source))
    .map((source) => `[${sourceLabel(source, sources)}]`)
    .join(" ");
  return markers ? `${cell.text} ${markers}` : cell.text;
}

function sourceLabel(source: PresentationSource, sources: readonly PresentationSource[]): string {
  return `S${
    Math.max(
      0,
      sources.findIndex((candidate) => candidate.id === source.id),
    ) + 1
  }`;
}

function wrapPresentationTitle(value: string): string {
  if (value.length <= 44) {
    return value;
  }
  const midpoint = Math.floor(value.length / 2);
  const leftBoundary = value.lastIndexOf(" ", midpoint);
  const rightBoundary = value.indexOf(" ", midpoint + 1);
  const splitAt =
    leftBoundary > 20 && (rightBoundary < 0 || midpoint - leftBoundary <= rightBoundary - midpoint)
      ? leftBoundary
      : rightBoundary;
  return splitAt > 0 ? `${value.slice(0, splitAt)}\n${value.slice(splitAt + 1)}` : value;
}

function chartType(pptx: PptxPresentationLike, type: "bar" | "column" | "line"): string {
  if (type === "column") {
    return pptx.ChartType?.bar ?? "bar";
  }
  return pptx.ChartType?.[type] ?? type;
}

function shape(pptx: PptxPresentationLike, name: string): string {
  return pptx.ShapeType[name] ?? name;
}
