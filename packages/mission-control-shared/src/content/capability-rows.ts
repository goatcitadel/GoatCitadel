import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { humanizeToken, type StatusPresentation } from "./status-vocabulary.js";

export type CapabilityStatusFilter = "all" | "available" | "configured" | "inspect-only" | "degraded" | "unavailable";

export function presentCapabilityTitle(item: Pick<CapabilityCatalogEntry, "title">): string {
  const title = item.title.trim();
  return /^[a-z0-9][a-z0-9._-]*$/u.test(title) ? humanizeToken(title) : title;
}

export function presentCapabilityDescription(item: Pick<CapabilityCatalogEntry, "title" | "summary">): string {
  const title = item.title.trim().toLocaleLowerCase();
  const lines = item.summary.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const description = lines.find((line) => {
    if (/^#{1,6}\s/u.test(line)) return false;
    return line.replace(/^[*_`\s]+|[*_`\s]+$/gu, "").toLocaleLowerCase() !== title;
  });
  return description?.replace(/^[-*]\s+/u, "").replace(/\s+/gu, " ").slice(0, 240) || "No description recorded.";
}

export function mergeCapabilities(
  inspectable: CapabilityCatalogEntry[],
  callable: CapabilityCatalogEntry[],
): CapabilityCatalogEntry[] {
  const merged = new Map<string, CapabilityCatalogEntry>();
  for (const item of inspectable) merged.set(item.capabilityId, item);
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
    return { status: "available", label: "Available", reason: "Listed as callable. Runtime policy and approvals still govern each use." };
  }
  if (item.kind === "proposal" || item.kind === "candidate_skill") {
    return { status: "inspect-only", label: "Inspect-only", reason: "Visible for review, not enabled for direct use." };
  }
  if (item.sourceRef || item.sourceProvider || item.toolName || item.skillId) {
    return { status: "configured", label: "Configured", reason: "Known to the catalog but not currently callable." };
  }
  return { status: "unavailable", label: "Unavailable", reason: "No callable runtime path is available." };
}

export function presentCapabilityStatus(item: CapabilityCatalogEntry): StatusPresentation {
  const { status, label } = deriveCapabilityStatus(item);
  if (status === "available" || status === "configured") return { label, tone: "done" };
  if (status === "degraded") return { label, tone: "waiting" };
  if (status === "unavailable") return { label, tone: "failed" };
  return { label, tone: "neutral" };
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
  for (const item of items) counts[deriveCapabilityStatus(item).status] += 1;
  return counts;
}
