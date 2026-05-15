export function renderActivityPayloadSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const nextWakeAt = typeof record.nextWakeAt === "string" ? record.nextWakeAt : undefined;
  const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
  const originSurface = typeof record.originSurface === "string" ? record.originSurface : undefined;
  const externalReferenceRoots = Array.isArray(record.externalReferenceRoots)
    ? record.externalReferenceRoots.length
    : 0;
  const summary = [
    originSurface ? `surface ${originSurface}` : null,
    nextWakeAt ? `wake ${new Date(nextWakeAt).toLocaleString()}` : null,
    stopReason ? `stop ${stopReason}` : null,
    externalReferenceRoots > 0
      ? `${externalReferenceRoots} reference root${externalReferenceRoots === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" | ");
  return summary || null;
}
