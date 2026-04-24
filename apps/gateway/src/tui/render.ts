import { tuiTheme } from "./theme.js";

function border(width: number, left: string, fill: string, right: string): string {
  return `${left}${fill.repeat(Math.max(0, width - 2))}${right}`;
}

function pad(text: string, contentWidth: number): string {
  return ` ${text}${" ".repeat(Math.max(0, contentWidth - text.length))} `;
}

function textWidth(lines: string[]): number {
  return Math.max(...lines.map((line) => line.length), 0) + 4;
}

function wrapLine(text: string, width: number): string[] {
  if (!text) {
    return [""];
  }
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(" ", width);
    if (split <= 0 || split < Math.floor(width * 0.6)) {
      split = width;
    }
    lines.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  lines.push(remaining);
  return lines;
}

export function renderBox(
  title: string,
  lines: string[],
  tone: "info" | "success" | "warning" | "danger" = "info",
): string {
  const color =
    tone === "success"
      ? tuiTheme.success
      : tone === "warning"
        ? tuiTheme.warning
        : tone === "danger"
          ? tuiTheme.danger
          : tuiTheme.info;
  const titledLines = [`${title}`, ...lines];
  const width = Math.min(Math.max(textWidth(titledLines), 40), 108);
  const contentWidth = width - 4;
  const wrappedTitle = wrapLine(title, contentWidth);
  const wrappedLines = lines.flatMap((line) => wrapLine(line, contentWidth));
  return [
    color(border(width, "┌", "─", "┐")),
    ...wrappedTitle.map((line) => color(`│${pad(line, contentWidth)}│`)),
    ...wrappedLines.map((line) => color(`│${pad(line, contentWidth)}│`)),
    color(border(width, "└", "─", "┘")),
  ].join("\n");
}

export function renderSection(title: string, subtitle?: string): string {
  const lines = [tuiTheme.heading(title)];
  if (subtitle) {
    lines.push(tuiTheme.muted(subtitle));
  }
  return `${lines.join("\n")}\n${tuiTheme.dim("─".repeat(72))}`;
}

export function renderKeyValueSummary(items: Array<{ key: string; value: string }>): string {
  return items.map((item) => `${tuiTheme.key(item.key)} ${tuiTheme.value(item.value)}`).join("\n");
}

export function renderBulletList(items: string[], tone: "muted" | "accent" = "muted"): string {
  const color = tone === "accent" ? tuiTheme.accent : tuiTheme.muted;
  return items.map((item) => color(`- ${item}`)).join("\n");
}

export type TuiOperatorSectionId = "activity" | "thinking" | "tools" | "diagnostics" | "voice_meeting" | "details";

export interface TuiOperatorSection {
  id: TuiOperatorSectionId;
  title: string;
  lines: string[];
  visible?: boolean;
  contentBearing?: boolean;
}

export function renderOperatorSection(section: TuiOperatorSection): string {
  const contentBearing = section.contentBearing ?? section.lines.some((line) => line.trim().length > 0);
  const visible = section.visible ?? defaultOperatorSectionVisibility(section.id, contentBearing);
  const marker = visible ? "expanded" : "collapsed";
  const label = `${section.title} (${marker})`;
  if (!visible) {
    return tuiTheme.muted(`${label} - ${contentBearing ? "content available" : "no current activity"}`);
  }
  return [
    renderSection(label, section.id === "voice_meeting" ? "Voice / meeting status" : undefined),
    ...(contentBearing ? section.lines : [tuiTheme.muted("No current activity.")]),
  ].join("\n");
}

export function defaultOperatorSectionVisibility(id: TuiOperatorSectionId, contentBearing: boolean): boolean {
  if (id === "activity" || id === "diagnostics" || id === "details") {
    return false;
  }
  if (id === "thinking" || id === "tools" || id === "voice_meeting") {
    return contentBearing;
  }
  return contentBearing;
}
