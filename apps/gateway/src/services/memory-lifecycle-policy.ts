import type {
  LearnedMemoryItemRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRecommendationKind,
  MemoryItemRecord,
} from "@goatcitadel/contracts";

export const DEFAULT_MEMORY_WORKSPACE_ID = "default";
export const MEMORY_RECOMMENDATION_DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000;
export const MEMORY_CONFLICT_OVERLAP_THRESHOLD = 0.45;
export const MEMORY_CONFIDENCE_DIFF_THRESHOLD = 0.2;

export function clampMemoryConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeMemoryLifecycleText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function computeMemoryLifecycleTextOverlap(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  const leftTokens = new Set(left.split(" ").filter((token) => token.length > 2));
  const rightTokens = new Set(right.split(" ").filter((token) => token.length > 2));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / Math.max(leftTokens.size, rightTokens.size);
}

export type LearnedMemoryWriteDecision =
  | {
      action: "skip";
    }
  | {
      action: "merge_duplicate";
      itemId: string;
      nextConfidence: number;
    }
  | {
      action: "record_conflict";
      existingItemId: string;
      incomingConfidence: number;
    }
  | {
      action: "supersede";
      existingItemId: string;
      incomingConfidence: number;
    }
  | {
      action: "insert_active";
      incomingConfidence: number;
    };

export function decideLearnedMemoryWrite(input: {
  content: string;
  confidence: number;
  existing: Array<Pick<LearnedMemoryItemRecord, "itemId" | "content" | "confidence">>;
}): LearnedMemoryWriteDecision {
  const normalized = normalizeMemoryLifecycleText(input.content);
  if (!normalized) {
    return { action: "skip" };
  }

  const incomingConfidence = clampMemoryConfidence(input.confidence);
  const duplicate = input.existing.find((item) => normalizeMemoryLifecycleText(item.content) === normalized);
  if (duplicate) {
    return {
      action: "merge_duplicate",
      itemId: duplicate.itemId,
      nextConfidence: Math.max(incomingConfidence, clampMemoryConfidence(duplicate.confidence)),
    };
  }

  const current = input.existing[0];
  if (!current) {
    return {
      action: "insert_active",
      incomingConfidence,
    };
  }

  const overlap = computeMemoryLifecycleTextOverlap(normalized, normalizeMemoryLifecycleText(current.content));
  const existingConfidence = clampMemoryConfidence(current.confidence);
  if (overlap < MEMORY_CONFLICT_OVERLAP_THRESHOLD) {
    const confidenceDiff = Math.abs(incomingConfidence - existingConfidence);
    if (confidenceDiff < MEMORY_CONFIDENCE_DIFF_THRESHOLD) {
      return {
        action: "record_conflict",
        existingItemId: current.itemId,
        incomingConfidence,
      };
    }
    if (incomingConfidence > existingConfidence + MEMORY_CONFIDENCE_DIFF_THRESHOLD) {
      return {
        action: "supersede",
        existingItemId: current.itemId,
        incomingConfidence,
      };
    }
  }

  return {
    action: "insert_active",
    incomingConfidence,
  };
}

export function matchesMemoryWorkspaceScope(
  item: Pick<MemoryItemRecord, "namespace" | "metadata"> & { metadata: Record<string, unknown> },
  workspaceId: string,
  normalizeWorkspaceId: (workspaceId?: string) => string,
  defaultWorkspaceId = DEFAULT_MEMORY_WORKSPACE_ID,
): boolean {
  const explicitWorkspaceId =
    typeof item.metadata.workspaceId === "string" ? normalizeWorkspaceId(item.metadata.workspaceId) : undefined;
  if (explicitWorkspaceId) {
    return explicitWorkspaceId === workspaceId;
  }
  if (workspaceId === defaultWorkspaceId) {
    return true;
  }
  return item.namespace.startsWith(`${workspaceId}.`) || item.namespace.startsWith(`${workspaceId}/`);
}

export function shouldSuppressMaintenanceRecommendation(input: {
  existing: MemoryMaintenanceRecommendationRecord[];
  kind: MemoryMaintenanceRecommendationKind;
  proposedPatch: Record<string, unknown>;
  now?: number;
  dedupeWindowMs?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const dedupeWindowMs = input.dedupeWindowMs ?? MEMORY_RECOMMENDATION_DEDUP_WINDOW_MS;
  return input.existing.some((item) => {
    if (item.kind !== input.kind || item.status === "rejected") {
      return false;
    }
    const updatedAtMs = Date.parse(item.updatedAt);
    if (Number.isFinite(updatedAtMs) && now - updatedAtMs > dedupeWindowMs) {
      return false;
    }
    return JSON.stringify(item.proposedPatch) === JSON.stringify(input.proposedPatch);
  });
}
