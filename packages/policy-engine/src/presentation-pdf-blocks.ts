import {
  measureWinAnsi,
  mixPdfColors,
  toWinAnsiBytes,
  truncateWinAnsi,
  type PdfColor,
  type PdfPage,
} from "./pdf-writer.js";
import { layoutRuns, drawRunLine, tableCellRuns, type PdfTextBox } from "./presentation-pdf-text.js";
import type { PresentationChart, PresentationSource, PresentationTable } from "./presentation-model.js";

export interface PdfDeckTheme {
  background: PdfColor;
  surface: PdfColor;
  text: PdfColor;
  muted: PdfColor;
  accent: PdfColor;
  accent2: PdfColor;
  accent3: PdfColor;
  border: PdfColor;
  onAccent: PdfColor;
}

export const PDF_TABLE_FONT_SIZE = 14;
const TABLE_MAX_CELL_LINES = 3;

/** Draws a table with an accent header row. Returns true when rows were cut to fit. */
export function drawPdfTable(
  page: PdfPage,
  table: PresentationTable,
  sources: readonly PresentationSource[],
  theme: PdfDeckTheme,
  box: PdfTextBox,
): boolean {
  const columnCount = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 1);
  const widths = tableColumnWidths(table, columnCount, box.w);
  const size = PDF_TABLE_FONT_SIZE;
  const lineHeight = size * 1.22;
  const padding = 7;
  const layoutRow = (cells: ReadonlyArray<{ text: string; sourceIds?: string[] }>, bold: boolean) =>
    widths.map((width, index) => {
      const cell = cells[index] ?? { text: "" };
      const lines = layoutRuns(tableCellRuns(cell, sources), bold ? "bold" : "regular", size, width - padding * 2);
      return lines.slice(0, TABLE_MAX_CELL_LINES);
    });
  const rowHeight = (row: ReturnType<typeof layoutRow>) =>
    Math.max(1, ...row.map((lines) => lines.length)) * lineHeight + padding * 2;

  let cursor = box.y;
  const header = layoutRow(table.headers, true);
  const headerHeight = rowHeight(header);
  page.rect(box.x, cursor, box.w, headerHeight, theme.accent);
  drawTableRow(page, header, widths, box.x, cursor, padding, size, "bold", {
    text: theme.onAccent,
    citation: theme.onAccent,
  });
  cursor += headerHeight;
  let truncated = false;
  for (const [index, cells] of table.rows.entries()) {
    const row = layoutRow(cells, false);
    const height = rowHeight(row);
    if (cursor + height > box.y + box.h) {
      truncated = true;
      break;
    }
    page.rect(
      box.x,
      cursor,
      box.w,
      height,
      index % 2 === 0 ? theme.surface : mixPdfColors(theme.surface, theme.border, 0.18),
    );
    drawTableRow(page, row, widths, box.x, cursor, padding, size, "regular", {
      text: theme.text,
      citation: theme.accent2,
    });
    cursor += height;
  }
  page.rect(box.x, box.y, box.w, cursor - box.y, undefined, { color: theme.border, width: 0.75 });
  let columnX = box.x;
  for (const width of widths.slice(0, -1)) {
    columnX += width;
    page.line(columnX, box.y, columnX, cursor, theme.border, 0.5);
  }
  return truncated;
}

function drawTableRow(
  page: PdfPage,
  row: ReadonlyArray<ReturnType<typeof layoutRuns>>,
  widths: readonly number[],
  x: number,
  y: number,
  padding: number,
  size: number,
  font: "regular" | "bold",
  colors: { text: PdfColor; citation: PdfColor },
): void {
  let cellX = x;
  row.forEach((lines, index) => {
    lines.forEach((tokens, lineIndex) => {
      drawRunLine(page, tokens, cellX + padding, y + padding + size + lineIndex * size * 1.22, font, size, colors);
    });
    cellX += widths[index] ?? 0;
  });
}

function tableColumnWidths(table: PresentationTable, columnCount: number, totalWidth: number): number[] {
  const weights = Array.from({ length: columnCount }, (_, column) => {
    const lengths = [table.headers[column], ...table.rows.map((row) => row[column])].map(
      (cell) => (cell?.text.length ?? 0) + (cell?.sourceIds?.length ?? 0) * 5,
    );
    return Math.min(60, Math.max(8, ...lengths));
  });
  const sum = weights.reduce((total, weight) => total + weight, 0);
  return weights.map((weight) => (weight / sum) * totalWidth);
}

/** Draws a bar, column or line chart with axis, labels and a legend. */
export function drawPdfChart(page: PdfPage, chart: PresentationChart, theme: PdfDeckTheme, box: PdfTextBox): void {
  const palette = [theme.accent, theme.accent2, theme.accent3, mixPdfColors(theme.accent, theme.text, 0.35)];
  const colorOf = (index: number) => palette[index % palette.length]!;
  const legendHeight = drawLegend(page, chart, theme, box, colorOf);
  const plot = { x: box.x + 56, y: box.y + legendHeight + 8, w: box.w - 70, h: box.h - legendHeight - 38 };
  const values = chart.series.flatMap((series) => series.values).filter(Number.isFinite);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  if (chart.type === "bar") {
    drawHorizontalBars(page, chart, theme, plot, { min, span }, colorOf);
    return;
  }
  const valueY = (value: number) => plot.y + plot.h - ((value - min) / span) * plot.h;
  for (const tick of axisTicks(min, max)) {
    const y = valueY(tick);
    page.line(plot.x, y, plot.x + plot.w, y, mixPdfColors(theme.surface, theme.border, 0.6), 0.5);
    const label = toWinAnsiBytes(formatChartValue(tick));
    page.text(plot.x - 8 - measureWinAnsi(label, "regular", 11), y + 4, label, {
      font: "regular",
      size: 11,
      color: theme.muted,
    });
  }
  const slot = plot.w / Math.max(1, chart.categories.length);
  chart.categories.forEach((category, index) => {
    const label = truncateWinAnsi(toWinAnsiBytes(category), "regular", 11, slot - 6);
    const width = measureWinAnsi(label, "regular", 11);
    page.text(plot.x + slot * index + (slot - width) / 2, plot.y + plot.h + 18, label, {
      font: "regular",
      size: 11,
      color: theme.muted,
    });
  });
  if (chart.type === "line") {
    chart.series.forEach((series, seriesIndex) => {
      const points = series.values
        .slice(0, chart.categories.length)
        .map((value, index) => [plot.x + slot * index + slot / 2, valueY(value)] as const);
      page.polyline(points, colorOf(seriesIndex), 2.5);
      for (const [x, y] of points) page.rect(x - 3, y - 3, 6, 6, colorOf(seriesIndex));
    });
  } else {
    const groupWidth = slot * 0.7;
    const barWidth = groupWidth / Math.max(1, chart.series.length);
    chart.series.forEach((series, seriesIndex) => {
      series.values.slice(0, chart.categories.length).forEach((value, index) => {
        const x = plot.x + slot * index + (slot - groupWidth) / 2 + barWidth * seriesIndex;
        const top = valueY(Math.max(value, 0));
        const bottom = valueY(Math.min(value, 0));
        page.rect(x + 1, top, Math.max(1, barWidth - 2), Math.max(0.5, bottom - top), colorOf(seriesIndex));
      });
    });
  }
  page.line(plot.x, valueY(0), plot.x + plot.w, valueY(0), theme.border, 1);
}

function drawHorizontalBars(
  page: PdfPage,
  chart: PresentationChart,
  theme: PdfDeckTheme,
  plot: PdfTextBox,
  scale: { min: number; span: number },
  colorOf: (index: number) => PdfColor,
): void {
  const labelWidth = Math.min(180, plot.w * 0.3);
  const area = { ...plot, x: plot.x + labelWidth - 40, w: plot.w - labelWidth + 40 };
  const valueX = (value: number) => area.x + ((value - scale.min) / scale.span) * area.w;
  const slot = area.h / Math.max(1, chart.categories.length);
  const barHeight = (slot * 0.7) / Math.max(1, chart.series.length);
  chart.categories.forEach((category, index) => {
    const label = truncateWinAnsi(toWinAnsiBytes(category), "regular", 12, labelWidth - 12);
    page.text(plot.x - 50, area.y + slot * index + slot / 2 + 4, label, {
      font: "regular",
      size: 12,
      color: theme.text,
    });
    chart.series.forEach((series, seriesIndex) => {
      const value = series.values[index];
      if (value === undefined || !Number.isFinite(value)) return;
      const y = area.y + slot * index + slot * 0.15 + barHeight * seriesIndex;
      const left = valueX(Math.min(value, 0));
      const right = valueX(Math.max(value, 0));
      page.rect(left, y + 1, Math.max(0.5, right - left), Math.max(1, barHeight - 2), colorOf(seriesIndex));
      const valueLabel = toWinAnsiBytes(formatChartValue(value));
      page.text(right + 4, y + barHeight / 2 + 4, valueLabel, { font: "regular", size: 11, color: theme.muted });
    });
  });
  page.line(valueX(0), area.y, valueX(0), area.y + area.h, theme.border, 1);
}

function drawLegend(
  page: PdfPage,
  chart: PresentationChart,
  theme: PdfDeckTheme,
  box: PdfTextBox,
  colorOf: (index: number) => PdfColor,
): number {
  let x = box.x;
  chart.series.forEach((series, index) => {
    const label = truncateWinAnsi(toWinAnsiBytes(series.name), "regular", 12, 200);
    page.rect(x, box.y + 3, 11, 11, colorOf(index));
    page.text(x + 16, box.y + 13, label, { font: "regular", size: 12, color: theme.text });
    x += 16 + measureWinAnsi(label, "regular", 12) + 22;
  });
  return 22;
}

function axisTicks(min: number, max: number): number[] {
  const span = max - min || 1;
  const rough = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? rough;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step)
    ticks.push(Number(tick.toFixed(10)));
  return ticks;
}

function formatChartValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimNumber(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trimNumber(value / 1_000)}K`;
  return trimNumber(value);
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}
