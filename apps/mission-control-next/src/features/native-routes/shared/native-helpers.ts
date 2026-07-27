import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CapabilityCatalogEntry,
  ChatGeneratedArtifactRecord,
  SkillEvaluationCriterionDraft,
  SkillEvaluationRunRecord,
  SkillEvaluationScenarioDraft,
} from "@goatcitadel/contracts";
import type { AppRoute } from "@next/app/route-model";
import type { TaskDeliverableRecord, TaskRecord } from "@goatcitadel/mission-control-shared/api/types";

export type LoadState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

export type Notice = {
  tone: "success" | "warning" | "error" | "info";
  message: string;
};

export type NativeLoadIssue = {
  label: string;
  message: string;
};

export type NativeLoadResult<T> = {
  data: T;
  issue: NativeLoadIssue | null;
};

export type CapabilityStatusFilter = "all" | "available" | "configured" | "inspect-only" | "degraded" | "unavailable";

export type CoworkTaskContinuationSummary = {
  nextActionLabel: string;
  nextActionDetail: string;
  blockerCount: number;
  activeCount: number;
  reviewCount: number;
  deliverableCount: number;
  recoveryCount: number;
  selectedTaskLabel: string;
  hierarchyDetail: string;
  boardTruth: string;
  firstBlockedTaskId?: string;
};

export async function nativeLoad<T>(label: string, promise: Promise<T>, fallback: T): Promise<NativeLoadResult<T>> {
  try {
    return {
      data: await promise,
      issue: null,
    };
  } catch (error) {
    return {
      data: fallback,
      issue: {
        label,
        message: getErrorMessage(error),
      },
    };
  }
}

export function nativeLoadIssues(results: Array<NativeLoadResult<unknown>>): NativeLoadIssue[] {
  return results.map((result) => result.issue).filter((issue): issue is NativeLoadIssue => Boolean(issue));
}

export function useAsyncLoad<T>(loader: () => Promise<T>, deps: ReadonlyArray<unknown> = [loader]) {
  const [state, setState] = useState<LoadState<T>>({
    loading: true,
    error: null,
    data: null,
  });
  // Monotonic request id mirrors `useShellStatus.refreshIdRef`: a later reload
  // bumps the id so an earlier (slower) response is dropped, and unmount bumps
  // it so no in-flight response calls setState after teardown. This prevents
  // last-writer-wins races on workspace switch and setState-after-unmount.
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrentRequest = () => requestIdRef.current === requestId;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loader();
      if (!isCurrentRequest()) {
        return;
      }
      setState({
        loading: false,
        error: null,
        data,
      });
    } catch (loadError) {
      if (!isCurrentRequest()) {
        return;
      }
      setState({
        loading: false,
        error: getErrorMessage(loadError),
        data: null,
      });
    }
    // The dependency list is part of this custom hook's caller contract so
    // callers can reload on route/workspace changes without duplicating the
    // stale-response guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
    return () => {
      // Supersede any in-flight reload so its resolution is ignored once this
      // effect (and typically the component) tears down.
      requestIdRef.current += 1;
    };
  }, [reload]);

  return { ...state, reload };
}

export function dedupeAgentProfiles<T extends { agentId: string; roleId?: string; name?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.agentId || item.roleId || ""}:${item.name ?? ""}`.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function routeSectionWithDefault(route: AppRoute, fallback: NonNullable<AppRoute["section"]>) {
  return (route.section ?? fallback) as NonNullable<AppRoute["section"]>;
}

export function mergeCapabilities(
  inspectable: CapabilityCatalogEntry[],
  callable: CapabilityCatalogEntry[],
): CapabilityCatalogEntry[] {
  const merged = new Map<string, CapabilityCatalogEntry>();
  for (const item of inspectable) {
    merged.set(item.capabilityId, item);
  }
  for (const item of callable) {
    merged.set(item.capabilityId, { ...(merged.get(item.capabilityId) ?? item), ...item, callable: true });
  }
  return Array.from(merged.values()).sort((left, right) => left.title.localeCompare(right.title));
}

export function deriveCapabilityStatus(item: CapabilityCatalogEntry): {
  status: CapabilityStatusFilter;
  label: string;
  reason: string;
} {
  if (item.lifecycleState === "revoked") {
    return { status: "unavailable", label: "Unavailable", reason: "The catalog marks this capability as revoked." };
  }
  if (item.reviewWarning || item.lifecycleState === "deprecated") {
    return {
      status: "degraded",
      label: "Degraded",
      reason: item.reviewWarning ?? "The catalog marks this capability as deprecated.",
    };
  }
  if (item.callable) {
    return { status: "available", label: "Available", reason: "Ready for the runtime to call." };
  }
  if (item.kind === "proposal" || item.kind === "candidate_skill") {
    return { status: "inspect-only", label: "Inspect-only", reason: "Visible for review, not enabled for direct use." };
  }
  if (item.sourceRef || item.sourceProvider || item.toolName || item.skillId) {
    return { status: "configured", label: "Configured", reason: "Known to the catalog but not currently callable." };
  }
  return { status: "unavailable", label: "Unavailable", reason: "No callable runtime path is available." };
}

export function summarizeCapabilityCounts(items: CapabilityCatalogEntry[]): Record<CapabilityStatusFilter, number> {
  const counts: Record<CapabilityStatusFilter, number> = {
    all: items.length,
    available: 0,
    configured: 0,
    "inspect-only": 0,
    degraded: 0,
    unavailable: 0,
  };
  for (const item of items) {
    counts[deriveCapabilityStatus(item).status] += 1;
  }
  return counts;
}

export function splitCommaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function serializeScenarioDrafts(items: SkillEvaluationRunRecord["scenarios"]) {
  return items.map((item) => `${item.title} | ${item.prompt} | ${item.expectedOutcome}`).join("\n");
}

export function serializeCriterionDrafts(items: SkillEvaluationRunRecord["criteria"]) {
  return items
    .map((item) => `${item.label} | ${item.description} | ${(item.requiredTerms ?? []).join(", ")}`)
    .join("\n");
}

export function parseScenarioDrafts(value: string): SkillEvaluationScenarioDraft[] | undefined {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return undefined;
  }
  return lines.map((line, index) => {
    const [title, prompt, expectedOutcome] = line.split("|").map((part) => part.trim());
    if (!title || !prompt || !expectedOutcome) {
      throw new Error(`Scenario line ${index + 1} needs title, prompt, and expected outcome.`);
    }
    return {
      title,
      prompt,
      expectedOutcome,
    };
  });
}

export function parseCriterionDrafts(value: string): SkillEvaluationCriterionDraft[] | undefined {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return undefined;
  }
  return lines.map((line, index) => {
    const [label, description, terms] = line.split("|").map((part) => part.trim());
    if (!label || !description) {
      throw new Error(`Criterion line ${index + 1} needs label and description.`);
    }
    return {
      label,
      description,
      requiredTerms: terms ? splitCommaList(terms) : undefined,
    };
  });
}

export function readPayloadString(payload: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = readPayloadPath(payload, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function readPayloadPath(payload: unknown, path: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, payload);
}

export function readPayloadEvidenceRefs(payload: unknown) {
  const refs = readPayloadPath(payload, "evidenceRefs");
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const refType = typeof record.refType === "string" ? record.refType : undefined;
      const refId = typeof record.refId === "string" ? record.refId : undefined;
      if (!refType || !refId) {
        return null;
      }
      return {
        refType,
        refId,
        hash: typeof record.hash === "string" ? record.hash : undefined,
        metadata:
          record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
            ? (record.metadata as Record<string, unknown>)
            : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

export function formatEvidenceMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) {
    return undefined;
  }
  const entries = Object.entries(metadata)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return entries.length ? entries.join(" · ") : undefined;
}

export function formatPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${Math.round(value * 100)}%`;
}

export function truncateText(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit).trimEnd()}\n\n…`;
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(scaled >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatTaskStatus(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function readErrorString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isErrorRecord(error: unknown): error is Record<string, unknown> {
  return typeof error === "object" && error !== null;
}

/**
 * Humanizes machine enum tokens for operator-facing text: "not_started" ->
 * "Not started", "provider-ready" -> "Provider ready", "hybrid_guarded" ->
 * "Hybrid guarded". Leaves already-human values untouched apart from the
 * leading capital.
 */
export function humanizeEnumToken(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const spaced = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) {
    return "";
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function getErrorMessage(error: unknown): string {
  const errorMessage = error instanceof Error ? readErrorString(error.message) : null;
  if (errorMessage) {
    return errorMessage;
  }
  const stringMessage = readErrorString(error);
  if (stringMessage) {
    return stringMessage;
  }
  if (isErrorRecord(error)) {
    const message = readErrorString(error.message) ?? readErrorString(error.error) ?? readErrorString(error.detail);
    const code = readErrorString(error.code);
    if (message && code) {
      return `${message} (${code})`;
    }
    if (message) {
      return message;
    }
    if (code) {
      return `Request failed (${code})`;
    }
  }
  return "Something went wrong.";
}

export function formatKnowledgeCitationSummary(citations: unknown[]): string {
  if (!citations.length) {
    return "0 citations";
  }
  const sourceTypes = new Set(
    citations
      .map((citation) => readPayloadString(citation, ["sourceType", "kind", "retrievalMode"]))
      .filter((value): value is string => Boolean(value)),
  );
  const sourceLabel = sourceTypes.size ? Array.from(sourceTypes).slice(0, 2).join(", ") : "source";
  return `${citations.length} citation${citations.length === 1 ? "" : "s"} · ${sourceLabel}`;
}

export function formatKnowledgeCitationAction(citation: unknown, contextId: string, index: number) {
  const label = readPayloadString(citation, ["title", "sourceRef", "source", "path", "url"]) ?? `Citation ${index + 1}`;
  const chunk = readPayloadString(citation, ["chunkId", "chunk", "locator"]);
  const mode = readPayloadString(citation, ["retrievalMode", "sourceType", "kind"]) ?? "source";
  const score = readPayloadString(citation, ["score", "confidence"]);
  const whyUsed = readPayloadString(citation, ["provenance.selectionReason"]);
  const retrievalStrategy = readPayloadString(citation, ["provenance.retrievalStrategy"]);
  const freshness = readPayloadString(citation, ["provenance.freshness"]);
  const relationScope = readPayloadString(citation, ["provenance.relationScope"]);
  const sourceTimestamp = readPayloadString(citation, ["provenance.sourceTimestamp"]);
  return {
    id: `${contextId}:${index}:${label}`,
    label,
    description:
      whyUsed ?? (chunk ? `Context ${contextId} cites chunk ${chunk}.` : `Context ${contextId} cites this source.`),
    meta: [
      mode,
      score ? `score ${score}` : undefined,
      retrievalStrategy,
      relationScope,
      freshness,
      sourceTimestamp ? `source ${formatDateTime(sourceTimestamp)}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
  };
}

export function formatArtifactProvenance(artifact: ChatGeneratedArtifactRecord): string {
  return JSON.stringify(
    {
      artifactId: artifact.artifactId,
      sourceSurface: artifact.sourceSurface,
      sessionId: artifact.sessionId,
      projectId: artifact.projectId ?? "unscoped",
      turnId: artifact.turnId,
      provider: artifact.providerId ?? "unknown",
      model: artifact.model ?? "unknown",
      contentHash: artifact.contentHash ?? "not recorded",
      sourceBlockIndex: artifact.sourceBlockIndex ?? "not recorded",
      supersedesArtifactId: artifact.supersedesArtifactId ?? "none",
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    },
    null,
    2,
  );
}

export function deriveCoworkTaskContinuation(input: {
  tasks: TaskRecord[];
  deletedTasks: TaskRecord[];
  selectedTask: TaskRecord | null;
  deliverables: TaskDeliverableRecord[];
  deliverablesLoading?: boolean;
}): CoworkTaskContinuationSummary {
  const blockedTasks = input.tasks.filter((item) => item.status === "blocked");
  const reviewTasks = input.tasks.filter((item) => item.status === "review");
  const activeTasks = input.tasks.filter((item) => ["assigned", "in_progress", "testing"].includes(item.status));
  const planningTasks = input.tasks.filter((item) => item.status === "planning" || item.status === "inbox");
  const selectedTaskLabel = input.selectedTask ? formatTaskStatus(input.selectedTask.status) : "No task selected";
  const deliverableCount = input.deliverables.length;
  const hierarchyDetail = input.selectedTask
    ? `${input.selectedTask.title} -> ${
        input.deliverablesLoading
          ? "loading deliverables"
          : `${deliverableCount} deliverable${deliverableCount === 1 ? "" : "s"} attached`
      }`
    : "Select or create a task before attaching deliverables.";

  if (blockedTasks.length > 0) {
    const first = blockedTasks[0]!;
    return {
      nextActionLabel: "Clear blocker",
      nextActionDetail: `${first.title} is blocked; inspect detail before resuming work.`,
      blockerCount: blockedTasks.length,
      activeCount: activeTasks.length,
      reviewCount: reviewTasks.length,
      deliverableCount,
      recoveryCount: input.deletedTasks.length,
      selectedTaskLabel,
      hierarchyDetail,
      boardTruth:
        "The board is an operator projection of task and runtime posture. It does not bypass approvals or force live executor control.",
      firstBlockedTaskId: first.taskId,
    };
  }

  if (reviewTasks.length > 0) {
    return {
      nextActionLabel: "Review output",
      nextActionDetail: `${reviewTasks.length} task${reviewTasks.length === 1 ? "" : "s"} ready for review.`,
      blockerCount: 0,
      activeCount: activeTasks.length,
      reviewCount: reviewTasks.length,
      deliverableCount,
      recoveryCount: input.deletedTasks.length,
      selectedTaskLabel,
      hierarchyDetail,
      boardTruth:
        "The board is an operator projection of task and runtime posture. It does not bypass approvals or force live executor control.",
    };
  }

  if (activeTasks.length > 0) {
    return {
      nextActionLabel: "Continue active work",
      nextActionDetail: `${activeTasks.length} task${activeTasks.length === 1 ? "" : "s"} still in motion.`,
      blockerCount: 0,
      activeCount: activeTasks.length,
      reviewCount: 0,
      deliverableCount,
      recoveryCount: input.deletedTasks.length,
      selectedTaskLabel,
      hierarchyDetail,
      boardTruth:
        "The board is an operator projection of task and runtime posture. It does not bypass approvals or force live executor control.",
    };
  }

  if (planningTasks.length > 0) {
    return {
      nextActionLabel: "Start planned task",
      nextActionDetail: `${planningTasks.length} planned task${planningTasks.length === 1 ? "" : "s"} waiting for execution.`,
      blockerCount: 0,
      activeCount: 0,
      reviewCount: 0,
      deliverableCount,
      recoveryCount: input.deletedTasks.length,
      selectedTaskLabel,
      hierarchyDetail,
      boardTruth:
        "The board is an operator projection of task and runtime posture. It does not bypass approvals or force live executor control.",
    };
  }

  if (input.deletedTasks.length > 0) {
    return {
      nextActionLabel: "Restore or create",
      nextActionDetail: `${input.deletedTasks.length} archived task${input.deletedTasks.length === 1 ? "" : "s"} can be restored if still relevant.`,
      blockerCount: 0,
      activeCount: 0,
      reviewCount: 0,
      deliverableCount,
      recoveryCount: input.deletedTasks.length,
      selectedTaskLabel,
      hierarchyDetail,
      boardTruth:
        "The board is an operator projection of task and runtime posture. It does not bypass approvals or force live executor control.",
    };
  }

  return {
    nextActionLabel: "Create first task",
    nextActionDetail: "No task is active in this workspace yet.",
    blockerCount: 0,
    activeCount: 0,
    reviewCount: 0,
    deliverableCount,
    recoveryCount: 0,
    selectedTaskLabel,
    hierarchyDetail,
    boardTruth:
      "The board is an operator projection of task and runtime posture. It does not bypass approvals or force live executor control.",
  };
}
