import {
  canonicalJsonString,
  type LocalAiFitRecommendation,
  type LocalAiReadinessResponse,
} from "@goatcitadel/contracts";

export type LocalAiIntent = "download" | "serve";
export const localAiModelKey = (item: Pick<LocalAiFitRecommendation, "modelId" | "backend">) =>
  JSON.stringify([item.modelId, item.backend]);
export const formatLocalAiFit = (fit: string) => fit.replaceAll("_", " ");
export function formatLocalAiBytes(value?: number): string {
  if (!value || value <= 0) return "Unknown";
  const gib = value / (1024 * 1024 * 1024);
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
}
export function assertLocalAiReadiness(value: LocalAiReadinessResponse): LocalAiReadinessResponse {
  if (
    !value?.hardware?.os ||
    !value.hardware.cpu ||
    !value.hardware.memory ||
    !value.hardware.disk ||
    !Array.isArray(value.hardware.runtimes) ||
    !Array.isArray(value.hardware.gpu) ||
    !Array.isArray(value.catalog) ||
    !Array.isArray(value.recommendations) ||
    !Array.isArray(value.downloads) ||
    !Array.isArray(value.serveJobs) ||
    !Array.isArray(value.endpoints)
  ) {
    throw new Error("Local AI readiness is incomplete. Hardware, model fit and retained jobs are unavailable.");
  }
  return value;
}
/** An advisory review snapshot, never a server-side grant or execution precondition. */
export function localAiReviewBinding(readiness: LocalAiReadinessResponse, key: string): string {
  const recommendations = readiness.recommendations.filter((item) => localAiModelKey(item) === key);
  const recommendation = recommendations[0];
  const models = readiness.catalog.filter((item) => item.modelId === recommendation?.modelId);
  if (
    recommendations.length !== 1 ||
    models.length !== 1 ||
    !models[0]!.preferredBackends.includes(recommendation!.backend)
  ) {
    throw new Error("This exact model and backend are no longer available in the Local AI catalog.");
  }
  return canonicalJsonString({
    recommendation,
    model: models[0],
    runtime: readiness.hardware.runtimes.find((runtime) => runtime.backend === recommendation!.backend) ?? null,
  });
}
export function groupLocalAiRecommendations(recommendations: LocalAiFitRecommendation[]) {
  const grouped = new Map<string, LocalAiFitRecommendation[]>();
  for (const recommendation of recommendations) {
    const entries = grouped.get(recommendation.modelId) ?? [];
    entries.push(recommendation);
    grouped.set(recommendation.modelId, entries);
  }
  return [...grouped.entries()].map(([modelId, entries]) => ({
    id: modelId,
    label: modelId,
    description: [
      ...new Set(entries.flatMap((entry) => [...entry.reasons, ...entry.limitations]).filter(Boolean)),
    ].join(" "),
    meta: entries.map((entry) => `${entry.backend}: ${formatLocalAiFit(entry.fit)} (${entry.confidence})`).join(" · "),
    actionLabel: entries.every((entry) => entry.fit === "not_recommended") ? "Advisory" : "Candidate",
  }));
}
