import type { ReactNode } from "react";
import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import type { WorkbenchPaneId } from "./format";

export type CodePanelType = Extract<MissionThreadedWorkflowPanel, { kind: "code" }>;

export const CODE_WORKBENCH_LAYOUT_STORAGE_KEY = "goatcitadel.code-workbench.layout.v1";
export const CODE_WORKBENCH_INSPECTOR_STORAGE_KEY = "goatcitadel.code-workbench.inspector.v1";
export const DEFAULT_FILE_PANE_PERCENT = 28;
export const EMPTY_CHANGED_FILES: string[] = [];
export function readStoredFilePanePercent(): number {
  if (typeof window === "undefined") {
    return DEFAULT_FILE_PANE_PERCENT;
  }
  const parsed = Number(window.localStorage.getItem(CODE_WORKBENCH_LAYOUT_STORAGE_KEY));
  return Number.isFinite(parsed) && parsed >= 18 && parsed <= 42 ? parsed : DEFAULT_FILE_PANE_PERCENT;
}

export type CodeSourceTabId = "existing" | "local" | "github";
export type CodeInspectorSectionId =
  | "progress"
  | "environment"
  | "changes"
  | "local"
  | "actions"
  | "browser"
  | "sources"
  | "ledger"
  | "runtime";

export interface CodeInspectorRow {
  label: string;
  value: string;
  tone?: "good" | "warning" | "danger" | "muted";
  title?: string;
}

export interface CodeInspectorSection {
  id: CodeInspectorSectionId;
  label: string;
  summary: string;
  rows: CodeInspectorRow[];
  extra?: ReactNode;
}

export function readStoredInspectorSections(): Set<CodeInspectorSectionId> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CODE_WORKBENCH_INSPECTOR_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((value): value is CodeInspectorSectionId =>
        ["progress", "environment", "changes", "local", "actions", "browser", "sources", "ledger", "runtime"].includes(
          value,
        ),
      ),
    );
  } catch {
    return new Set();
  }
}

export function formatOptionalText(value: unknown, fallback = "not recorded"): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function formatAvailability(
  blockedReason: string | null | undefined,
  unavailableReason?: string,
): Omit<CodeInspectorRow, "label"> {
  if (unavailableReason) {
    return { value: unavailableReason, tone: "muted" };
  }
  return blockedReason ? { value: blockedReason, tone: "warning" } : { value: "Available", tone: "good" };
}

export function formatProviderModelSummaryFromTurn(selectedTurn: CodePanelType["props"]["selectedTurn"]): string {
  const trace = selectedTurn?.trace as { model?: unknown; routing?: Record<string, unknown> } | undefined;
  const routing = trace?.routing;
  const provider = formatOptionalText(
    routing?.effectiveProviderId ?? routing?.primaryProviderId ?? routing?.requestedProviderId,
    "",
  );
  const model = formatOptionalText(
    routing?.effectiveModel ?? trace?.model ?? routing?.primaryModel ?? routing?.requestedModel,
    "",
  );
  if (provider && model) {
    return `${provider} / ${model}`;
  }
  return provider || model || "provider/model pending";
}

export type CodeWorkbenchPaneDef = { id: WorkbenchPaneId; label: string };

export function buildWorkbenchPaneDefs(includeArtifact: boolean): ReadonlyArray<CodeWorkbenchPaneDef> {
  const base: CodeWorkbenchPaneDef[] = [
    { id: "files", label: "Files" },
    { id: "selected-diff", label: "Selected diff" },
    { id: "repo-diff", label: "Repo diff" },
    { id: "review-packet", label: "Review packet" },
    { id: "output", label: "Run log" },
    { id: "snippets", label: "Snippets" },
  ];
  if (includeArtifact) {
    base.push({ id: "artifact", label: "Artifact" });
  }
  return base;
}

export interface CodeWorkbenchPaneProps {
  activePane: WorkbenchPaneId;
  paneMounted: (id: WorkbenchPaneId) => boolean;
  buildWorkbenchTabId: (id: WorkbenchPaneId) => string;
  buildWorkbenchPanelId: (id: WorkbenchPaneId) => string;
}
