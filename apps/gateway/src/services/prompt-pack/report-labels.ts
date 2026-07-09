import type { PromptPackExecutionStyle, PromptPackReportRecord } from "@goatcitadel/contracts";
import { DEFAULT_PROMPT_PACK_EXECUTION_STYLE } from "../prompt-pack-execution-profile.js";

export function derivePromptPackReportProviderModelSlug(
  report: PromptPackReportRecord,
  sanitizeFileName: (value: string) => string,
): string {
  const pairs = new Set(
    report.runs
      .map((run) => {
        const providerId = run.providerId?.trim();
        const model = run.model?.trim();
        return providerId && model ? `${providerId}_${model}` : undefined;
      })
      .filter((value): value is string => Boolean(value)),
  );
  if (pairs.size === 0) {
    return "no-model";
  }
  if (pairs.size > 1) {
    return "mixed-models";
  }
  return sanitizeFileName([...pairs][0] ?? "no-model");
}

export function derivePromptPackReportExecutionStyleSlug(report: PromptPackReportRecord): string {
  const styles = new Set(
    report.runs.map((run) => run.executionStyle ?? DEFAULT_PROMPT_PACK_EXECUTION_STYLE).filter(Boolean),
  );
  if (styles.size > 1) {
    return "mixed-style";
  }
  return formatPromptPackExecutionStyleSlug([...styles][0] ?? DEFAULT_PROMPT_PACK_EXECUTION_STYLE);
}

export function formatPromptPackExecutionStyleSlug(style: PromptPackExecutionStyle): "agentic" | "harness" {
  return style === "single_turn_harness" ? "harness" : "agentic";
}

export function formatPromptPackReportProviderModelLabel(report: PromptPackReportRecord): string {
  const pairs = new Set(
    report.runs
      .map((run) => {
        const providerId = run.providerId?.trim();
        const model = run.model?.trim();
        return providerId && model ? `${providerId}/${model}` : undefined;
      })
      .filter((value): value is string => Boolean(value)),
  );
  if (pairs.size === 0) {
    return "no model recorded";
  }
  if (pairs.size > 1) {
    return "mixed models";
  }
  return [...pairs][0] ?? "no model recorded";
}

export function formatPromptPackReportExecutionStyleLabel(report: PromptPackReportRecord): string {
  const styles = new Set(
    report.runs.map((run) => run.executionStyle ?? DEFAULT_PROMPT_PACK_EXECUTION_STYLE).filter(Boolean),
  );
  if (styles.size > 1) {
    return "mixed-style";
  }
  return formatPromptPackExecutionStyleSlug([...styles][0] ?? DEFAULT_PROMPT_PACK_EXECUTION_STYLE);
}
