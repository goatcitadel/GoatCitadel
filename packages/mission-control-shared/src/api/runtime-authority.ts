import type {
  RuntimeAuthorityClass,
  RuntimeAuthorityDomain,
  RuntimeAuthorityFreshness,
  RuntimeAuthorityItem,
  RuntimeAuthorityPosture,
  RuntimeAuthorityProjectionResponse,
  RuntimeAuthorityReference,
  RuntimeAuthorityScope,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchRuntimeAuthorityProjection(
  workspaceId: string,
): Promise<RuntimeAuthorityProjectionResponse> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(normalizedWorkspaceId)) {
    throw new Error("Runtime authority requires a valid workspace scope.");
  }
  const query = new URLSearchParams({ workspaceId: normalizedWorkspaceId });
  const payload = await request<unknown>(`/api/v1/ops/runtime-authority?${query.toString()}`);
  return parseRuntimeAuthorityProjection(payload, normalizedWorkspaceId);
}

const AUTHORITY_CLASSES = new Set<RuntimeAuthorityClass>([
  "canonical_record",
  "derived_projection",
  "retained_signal",
  "inferred",
  "unavailable",
]);
const DOMAINS = new Set<RuntimeAuthorityDomain>(["runs", "approvals", "workers", "backups", "reconciliation"]);
const FRESHNESS = new Set<RuntimeAuthorityFreshness>(["current", "stale", "missing", "contradictory", "unknown"]);
const POSTURES = new Set<RuntimeAuthorityPosture>(["ok", "neutral", "attention", "critical", "unavailable"]);

function parseRuntimeAuthorityProjection(payload: unknown, workspaceId: string): RuntimeAuthorityProjectionResponse {
  const record = asRecord(payload);
  if (
    record?.schemaVersion !== 1 ||
    record.workspaceId !== workspaceId ||
    !isIsoTimestamp(record.generatedAt) ||
    !Array.isArray(record.items) ||
    record.items.length > 40
  ) {
    throw invalidProjection();
  }
  const items = record.items.map((item) => parseAuthorityItem(item, workspaceId));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw invalidProjection();
  }
  return {
    schemaVersion: 1,
    generatedAt: record.generatedAt,
    workspaceId,
    items,
  };
}

function parseAuthorityItem(value: unknown, workspaceId: string): RuntimeAuthorityItem {
  const item = asRecord(value);
  if (
    !item ||
    !isBoundedText(item.id, 160) ||
    !isBoundedText(item.label, 96) ||
    !AUTHORITY_CLASSES.has(item.authorityClass as RuntimeAuthorityClass) ||
    !DOMAINS.has(item.domain as RuntimeAuthorityDomain) ||
    !isBoundedText(item.owner, 96) ||
    !isBoundedText(item.source, 120) ||
    !FRESHNESS.has(item.freshness as RuntimeAuthorityFreshness) ||
    !POSTURES.has(item.posture as RuntimeAuthorityPosture) ||
    !isBoundedText(item.state, 240) ||
    !isBoundedText(item.basis, 240) ||
    (item.caveat !== undefined && !isBoundedText(item.caveat, 240)) ||
    (item.observedAt !== undefined && !isIsoTimestamp(item.observedAt))
  ) {
    throw invalidProjection();
  }
  const scope = parseScope(item.scope, workspaceId);
  const canonicalRef = item.canonicalRef === undefined ? undefined : parseReference(item.canonicalRef);
  if (item.authorityClass === "unavailable" && canonicalRef) {
    throw invalidProjection();
  }
  return {
    id: item.id,
    domain: item.domain as RuntimeAuthorityDomain,
    label: item.label,
    authorityClass: item.authorityClass as RuntimeAuthorityClass,
    owner: item.owner,
    source: item.source,
    ...(item.observedAt === undefined ? {} : { observedAt: item.observedAt }),
    freshness: item.freshness as RuntimeAuthorityFreshness,
    posture: item.posture as RuntimeAuthorityPosture,
    state: item.state,
    basis: item.basis,
    ...(item.caveat === undefined ? {} : { caveat: item.caveat }),
    scope,
    ...(canonicalRef ? { canonicalRef } : {}),
  };
}

function parseScope(value: unknown, workspaceId: string): RuntimeAuthorityScope {
  const scope = asRecord(value);
  if (scope?.kind === "workspace" && scope.workspaceId === workspaceId) {
    return { kind: "workspace", workspaceId };
  }
  if (scope?.kind === "citadel" && scope.workspaceId === undefined) {
    return { kind: "citadel" };
  }
  throw invalidProjection();
}

function parseReference(value: unknown): RuntimeAuthorityReference {
  const reference = asRecord(value);
  if (!reference) throw invalidProjection();
  switch (reference.kind) {
    case "durable_run":
      if (reference.label === "Open run detail" && isRecordId(reference.runId)) {
        return { kind: "durable_run", label: "Open run detail", runId: reference.runId };
      }
      break;
    case "approval":
      if (reference.label === "Open approval detail" && isRecordId(reference.approvalId)) {
        return { kind: "approval", label: "Open approval detail", approvalId: reference.approvalId };
      }
      break;
    case "release_evidence":
      if (reference.label === "Open release evidence") {
        return { kind: "release_evidence", label: "Open release evidence" };
      }
      break;
    case "external_side_effects":
      if (reference.label === "Open reconciliation ledger") {
        return { kind: "external_side_effects", label: "Open reconciliation ledger" };
      }
      break;
  }
  throw invalidProjection();
}

function isRecordId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function invalidProjection(): Error {
  return new Error("Gateway returned an invalid runtime authority envelope.");
}
