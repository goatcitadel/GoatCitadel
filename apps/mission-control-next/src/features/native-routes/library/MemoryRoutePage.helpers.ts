import type {
  EvidenceEnvelope,
  MemoryDecisionRecord,
  MemoryEntityRecord,
  MemoryItemRecord,
  MemoryRelationRecord,
  StructuredMemorySourceRef,
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

export function formatEntityProvenanceSummary(entity: MemoryEntityRecord): string {
  const source = formatSourceRefs(entity.sourceRefs);
  const summary = entity.summary ? `${entity.summary} · ` : "";
  return `${summary}${source} · ${formatConfidence(entity.confidence)} confidence · updated ${formatMaybeDateTime(
    entity.updatedAt,
  )}`;
}

export function formatRelationProvenanceSummary(relation: MemoryRelationRecord): string {
  const source = formatSourceRefs(relation.sourceRefs);
  const degraded = relation.degradedReason ? ` · degraded: ${relation.degradedReason}` : "";
  return `${shortId(relation.fromEntityId)} to ${shortId(relation.toEntityId)} · ${formatConfidence(
    relation.confidence,
  )} confidence · ${source}${degraded}`;
}

export function formatDecisionProvenanceSummary(decision: MemoryDecisionRecord): string {
  const linkCount = decision.linkedEntityIds.length + decision.linkedRelationIds.length;
  const run = decision.runId ? ` · run ${shortId(decision.runId)}` : "";
  const session = decision.sessionId ? ` · session ${shortId(decision.sessionId)}` : "";
  return `${linkCount} linked records · ${formatSourceRefs(decision.sourceRefs)}${run}${session}`;
}

export function readMetadataString(metadata: unknown, key: string): string | undefined {
  const value = asRecord(metadata)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

export function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) {
    return "unknown";
  }
  return `${Math.round(confidence * 100)}%`;
}
