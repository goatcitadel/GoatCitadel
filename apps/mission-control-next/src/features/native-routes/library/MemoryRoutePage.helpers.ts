import type {
  EvidenceEnvelope,
  MemoryContextPack,
  MemoryDecisionRecord,
  MemoryEntityRecord,
  MemoryEngineeringKind,
  MemoryItemRecord,
  MemoryLearningRecord,
  MemoryRelationRecord,
  StructuredMemorySourceRef,
  TraceMemoryCandidateRecord,
} from "@goatcitadel/contracts";
import { formatMaybeDateTime, shortId } from "@goatcitadel/mission-control-shared/content/memory-helpers";

export function readMemoryWriteDecision(envelope: EvidenceEnvelope): string {
  const metadata = asRecord(envelope.metadata);
  const decision = metadata?.decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return envelope.signatureStatus;
  }
  const value = (decision as { decision?: unknown }).decision;
  return typeof value === "string" ? value : envelope.signatureStatus;
}

export type ProvenanceCoverageRow = {
  id: string;
  label: string;
  records: number;
  status: "covered" | "empty";
  detail: string;
};

export type MemoryGraphProjection = {
  readiness: "empty" | "partial" | "connected";
  entityCount: number;
  activeEntityCount: number;
  relationCount: number;
  activeRelationCount: number;
  degradedRelationCount: number;
  decisionCount: number;
  orphanEntityCount: number;
  connectedEntityCount: number;
  provenanceSourceCount: number;
  topRelationTypes: Array<{ relationType: string; count: number }>;
  summary: string;
};

export type MemoryModelSummaryRow = {
  kind: MemoryEngineeringKind;
  label: string;
  count: number;
  status: "covered" | "empty";
  detail: string;
};

const PROVENANCE_KINDS = [
  { id: "project", label: "Project" },
  { id: "task", label: "Task" },
  { id: "decision", label: "Decision" },
  { id: "artifact", label: "Artifact" },
  { id: "memory", label: "Memory" },
  { id: "skill", label: "Skill" },
  { id: "tool", label: "Tool" },
  { id: "approval", label: "Approval" },
  { id: "source", label: "Source" },
] as const;

const MEMORY_MODEL_LABELS: Record<MemoryEngineeringKind, string> = {
  working: "Working",
  episodic: "Episodic",
  semantic: "Semantic",
  procedural: "Procedural",
};

export function buildProvenanceCoverage(input: {
  entities: MemoryEntityRecord[];
  relations: MemoryRelationRecord[];
  decisions: MemoryDecisionRecord[];
  memoryItems: MemoryItemRecord[];
  evidence: EvidenceEnvelope[];
}): ProvenanceCoverageRow[] {
  const entityCounts = new Map<string, number>();
  for (const entity of input.entities) {
    const key = normalizeProvenanceKind(entity.entityType);
    entityCounts.set(key, (entityCounts.get(key) ?? 0) + 1);
  }
  const sourceCount = countUniqueSourceRefs([
    ...input.entities.flatMap((item) => item.sourceRefs),
    ...input.relations.flatMap((item) => item.sourceRefs),
    ...input.decisions.flatMap((item) => item.sourceRefs),
  ]);
  const counts: Record<(typeof PROVENANCE_KINDS)[number]["id"], number> = {
    project: entityCounts.get("project") ?? 0,
    task: entityCounts.get("task") ?? 0,
    decision: input.decisions.length,
    artifact: entityCounts.get("artifact") ?? 0,
    memory: input.memoryItems.length + (entityCounts.get("memory") ?? 0),
    skill: entityCounts.get("skill") ?? 0,
    tool: entityCounts.get("tool") ?? 0,
    approval:
      entityCounts.get("approval") ?? input.evidence.filter((item) => item.eventKind.includes("approval")).length,
    source: sourceCount,
  };

  return PROVENANCE_KINDS.map((kind) => {
    const records = counts[kind.id];
    return {
      ...kind,
      records,
      status: records > 0 ? "covered" : "empty",
      detail:
        records > 0
          ? `${records} ${kind.label.toLowerCase()} records linked through memory lifecycle truth.`
          : `${kind.label} records have not been captured in structured memory yet.`,
    };
  });
}

export function buildMemoryGraphProjection(input: {
  entities: MemoryEntityRecord[];
  relations: MemoryRelationRecord[];
  decisions: MemoryDecisionRecord[];
}): MemoryGraphProjection {
  const activeEntities = input.entities.filter((item) => item.status === "active");
  const activeRelations = input.relations.filter((item) => item.status === "active");
  const linkedEntityIds = new Set<string>();
  const relationTypeCounts = new Map<string, number>();
  for (const relation of input.relations) {
    linkedEntityIds.add(relation.fromEntityId);
    linkedEntityIds.add(relation.toEntityId);
    relationTypeCounts.set(relation.relationType, (relationTypeCounts.get(relation.relationType) ?? 0) + 1);
  }
  for (const decision of input.decisions) {
    for (const entityId of decision.linkedEntityIds) {
      linkedEntityIds.add(entityId);
    }
  }
  const entityIds = new Set(input.entities.map((item) => item.id));
  const orphanEntityCount = input.entities.filter((entity) => !linkedEntityIds.has(entity.id)).length;
  const connectedEntityCount = input.entities.filter((entity) => linkedEntityIds.has(entity.id)).length;
  // A relation that is both non-active AND dangling must be counted once, not summed twice
  // (which let degradedRelationCount exceed the total relation count). Use a single union.
  const degradedRelationCount = input.relations.filter(
    (relation) =>
      relation.status !== "active" || !entityIds.has(relation.fromEntityId) || !entityIds.has(relation.toEntityId),
  ).length;
  const provenanceSourceCount = countUniqueSourceRefs([
    ...input.entities.flatMap((item) => item.sourceRefs),
    ...input.relations.flatMap((item) => item.sourceRefs),
    ...input.decisions.flatMap((item) => item.sourceRefs),
  ]);
  const readiness =
    input.entities.length === 0 && input.relations.length === 0
      ? "empty"
      : activeRelations.length > 0 && connectedEntityCount > 0
        ? "connected"
        : "partial";
  const topRelationTypes = [...relationTypeCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([relationType, count]) => ({ relationType, count }));
  return {
    readiness,
    entityCount: input.entities.length,
    activeEntityCount: activeEntities.length,
    relationCount: input.relations.length,
    activeRelationCount: activeRelations.length,
    degradedRelationCount,
    decisionCount: input.decisions.length,
    orphanEntityCount,
    connectedEntityCount,
    provenanceSourceCount,
    topRelationTypes,
    summary: formatMemoryGraphProjectionSummary(readiness, {
      connectedEntityCount,
      entityCount: input.entities.length,
      activeRelationCount: activeRelations.length,
      decisionCount: input.decisions.length,
    }),
  };
}

export function buildMemoryModelSummary(input: {
  recentContexts: MemoryContextPack[];
  memoryItems: MemoryItemRecord[];
  entities: MemoryEntityRecord[];
  relations: MemoryRelationRecord[];
  decisions: MemoryDecisionRecord[];
  traceCandidates: TraceMemoryCandidateRecord[];
  learnings?: MemoryLearningRecord[];
}): MemoryModelSummaryRow[] {
  const semanticLearningCount = (input.learnings ?? []).filter(
    (item) => classifyMemoryLearningKind(item) === "semantic",
  ).length;
  const proceduralLearningCount = (input.learnings ?? []).filter(
    (item) => classifyMemoryLearningKind(item) === "procedural",
  ).length;
  const counts: Record<MemoryEngineeringKind, number> = {
    working: input.recentContexts.length,
    episodic: input.traceCandidates.length,
    semantic:
      input.memoryItems.length +
      input.entities.length +
      input.relations.length +
      input.decisions.length +
      semanticLearningCount,
    procedural: proceduralLearningCount,
  };
  return (["working", "episodic", "semantic", "procedural"] as const).map((kind) => ({
    kind,
    label: MEMORY_MODEL_LABELS[kind],
    count: counts[kind],
    status: counts[kind] > 0 ? "covered" : "empty",
    detail: formatMemoryModelDetail(kind, counts[kind]),
  }));
}

export function classifyMemoryItemKind(_item: MemoryItemRecord): MemoryEngineeringKind {
  return "semantic";
}

export function classifyTraceMemoryCandidateKind(_item: TraceMemoryCandidateRecord): MemoryEngineeringKind {
  return "episodic";
}

export function classifyMemoryLearningKind(item: Pick<MemoryLearningRecord, "type">): MemoryEngineeringKind {
  return item.type === "workflow" || item.type === "bug_pattern" || item.type === "tooling" ? "procedural" : "semantic";
}

export function formatMemoryEngineeringKind(kind: MemoryEngineeringKind): string {
  return MEMORY_MODEL_LABELS[kind];
}

export function formatEntityProvenanceSummary(entity: MemoryEntityRecord): string {
  const source = formatSourceRefs(entity.sourceRefs);
  const summary = entity.summary ? `${entity.summary} · ` : "";
  const lineage = formatLineage(entity.lineage);
  return `${summary}${source} · ${formatConfidence(entity.confidence)} confidence · updated ${formatMaybeDateTime(
    entity.updatedAt,
  )}${lineage}`;
}

export function formatRelationProvenanceSummary(relation: MemoryRelationRecord): string {
  const source = formatSourceRefs(relation.sourceRefs);
  const degraded = relation.degradedReason ? ` · degraded: ${relation.degradedReason}` : "";
  const lineage = formatLineage(relation.lineage);
  return `${shortId(relation.fromEntityId)} to ${shortId(relation.toEntityId)} · ${formatConfidence(
    relation.confidence,
  )} confidence · ${source}${degraded}${lineage}`;
}

export function formatDecisionProvenanceSummary(decision: MemoryDecisionRecord): string {
  const linkCount = decision.linkedEntityIds.length + decision.linkedRelationIds.length;
  const run = decision.runId ? ` · run ${shortId(decision.runId)}` : "";
  const session = decision.sessionId ? ` · session ${shortId(decision.sessionId)}` : "";
  return `${linkCount} linked records · ${formatSourceRefs(decision.sourceRefs)}${run}${session}${formatLineage(
    decision.lineage,
  )}`;
}

export function readMetadataString(metadata: unknown, key: string): string | undefined {
  const value = asRecord(metadata)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveMemoryItemWorkspaceLabel(item: Pick<MemoryItemRecord, "workspaceId" | "metadata">): string {
  const canonicalWorkspaceId = item.workspaceId as unknown;
  if (canonicalWorkspaceId !== undefined) {
    if (
      typeof canonicalWorkspaceId !== "string" ||
      !canonicalWorkspaceId.trim() ||
      canonicalWorkspaceId !== canonicalWorkspaceId.trim()
    ) {
      return "invalid canonical scope";
    }
    return canonicalWorkspaceId;
  }
  return readMetadataString(item.metadata, "workspaceId") ?? "global";
}

export function readMetadataStringList(metadata: unknown, key: string): string[] {
  const value = asRecord(metadata)?.[key];
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeProvenanceKind(value: string | undefined): string {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[_\s-]+/g, "_") ?? "";
  if (normalized.includes("project")) {
    return "project";
  }
  if (normalized.includes("task")) {
    return "task";
  }
  if (normalized.includes("artifact") || normalized.includes("file")) {
    return "artifact";
  }
  if (normalized.includes("memory") || normalized.includes("knowledge")) {
    return "memory";
  }
  if (normalized.includes("skill")) {
    return "skill";
  }
  if (normalized.includes("tool") || normalized.includes("capability")) {
    return "tool";
  }
  if (normalized.includes("approval")) {
    return "approval";
  }
  if (normalized.includes("source")) {
    return "source";
  }
  return normalized || "unknown";
}

function countUniqueSourceRefs(sourceRefs: StructuredMemorySourceRef[]): number {
  const refs = new Set<string>();
  for (const ref of sourceRefs) {
    refs.add(`${ref.sourceType}:${ref.sourceRef}`);
  }
  return refs.size;
}

function formatSourceRefs(sourceRefs: StructuredMemorySourceRef[]): string {
  if (sourceRefs.length === 0) {
    return "no source refs";
  }
  const first = sourceRefs[0]!;
  return `${sourceRefs.length} source refs; primary ${first.title ?? `${first.sourceType}:${first.sourceRef}`}`;
}

function formatLineage(lineage: MemoryEntityRecord["lineage"]): string {
  if (!lineage) {
    return "";
  }
  const parts = [
    lineage.freshness ? `freshness ${lineage.freshness}` : undefined,
    lineage.mentionCount ? `${lineage.mentionCount} mentions` : undefined,
    lineage.sourceRunId ? `source run ${shortId(lineage.sourceRunId)}` : undefined,
    lineage.sourceSummaryRef ? `summary ${shortId(lineage.sourceSummaryRef)}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function formatMemoryGraphProjectionSummary(
  readiness: MemoryGraphProjection["readiness"],
  counts: {
    connectedEntityCount: number;
    entityCount: number;
    activeRelationCount: number;
    decisionCount: number;
  },
): string {
  if (readiness === "empty") {
    return "No typed memory graph records are available yet.";
  }
  if (readiness === "connected") {
    return `${counts.connectedEntityCount}/${counts.entityCount} entities are linked through ${counts.activeRelationCount} active relations and ${counts.decisionCount} decisions.`;
  }
  return `${counts.entityCount} entities are visible, but relation coverage is still partial.`;
}

function formatMemoryModelDetail(kind: MemoryEngineeringKind, count: number): string {
  if (kind === "working") {
    return `${count} context pack${count === 1 ? "" : "s"} available for current-turn recall.`;
  }
  if (kind === "episodic") {
    return `${count} trace-derived record${count === 1 ? "" : "s"} remain evidence-first and proposal-gated.`;
  }
  if (kind === "procedural") {
    return `${count} workflow, tooling, or bug-pattern learning${count === 1 ? "" : "s"} visible.`;
  }
  return `${count} durable fact, item, entity, relation, decision, or preference record${count === 1 ? "" : "s"} visible.`;
}

export function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) {
    return "unknown";
  }
  return `${Math.round(confidence * 100)}%`;
}
