import { redactStructuredSecrets } from "@goatcitadel/contracts";

const INTERNAL_DURABLE_EVIDENCE_KEYS = new Set(["heartbeatDecisionRawOutput"]);

export function projectDurableRouteResponse<T>(value: T): T {
  return omitInternalDurableEvidence(redactStructuredSecrets(value).value) as T;
}

/**
 * Raw heartbeat provider bytes are durable replay evidence, not a public API
 * field. Omit the exact key recursively from projections without mutating the
 * canonical run/checkpoint objects or marker-replacing their contents.
 */
function omitInternalDurableEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => omitInternalDurableEvidence(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const projected: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (INTERNAL_DURABLE_EVIDENCE_KEYS.has(key)) continue;
    projected[key] = omitInternalDurableEvidence(nested);
  }
  return projected;
}
