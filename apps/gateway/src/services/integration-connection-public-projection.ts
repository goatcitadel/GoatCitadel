import { isDeepStrictEqual } from "node:util";
import {
  SECRET_REDACTION_MARKER,
  type ExternalSideEffectRunRecord,
  type IntegrationConnection,
  type IntegrationConnectionUpdateInput,
} from "@goatcitadel/contracts";
import { projectPublicSecretValue } from "./public-secret-projection.js";

const OMIT_VALUE = Symbol("omit-value");

/**
 * Build the HTTP-safe view of an integration connection. Runtime and storage
 * callers continue to receive the original record with its unredacted config.
 */
export function projectIntegrationConnectionForPublicResponse(
  connection: IntegrationConnection,
): IntegrationConnection {
  return projectPublicSecretValue(connection);
}

export function projectIntegrationConnectionsForPublicResponse(
  connections: IntegrationConnection[],
): IntegrationConnection[] {
  return connections.map(projectIntegrationConnectionForPublicResponse);
}

export function projectExternalSideEffectRunsForPublicResponse(
  records: ExternalSideEffectRunRecord[],
): ExternalSideEffectRunRecord[] {
  return records.map(projectPublicSecretValue);
}

/**
 * Public clients edit a redacted projection of integration config. Reconcile
 * placeholders and omitted secret leaves with the current raw record so a
 * routine settings save cannot replace a working credential with a marker or
 * silently delete a credential the client was never allowed to read.
 *
 * Secret ownership stays with the canonical Gateway projector: this helper
 * only restores values whose raw and projected forms differ.
 */
export function preserveIntegrationConnectionSecretsForPublicUpdate(
  current: IntegrationConnection,
  input: IntegrationConnectionUpdateInput,
): IntegrationConnectionUpdateInput {
  if (input.config === undefined) {
    return { ...input };
  }

  return {
    ...input,
    config: preserveProjectedStructuredSecretsForPublicUpdate(current.config, input.config),
  };
}

export function preserveProjectedStructuredSecretsForPublicUpdate(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const projected = projectPublicSecretValue(current);
  return preserveKnownPublicProjectionSecretsForUpdate(current, projected, incoming);
}

export function preserveKnownPublicProjectionSecretsForUpdate(
  current: Record<string, unknown>,
  projected: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const reconciled = reconcileProjectedSecrets(current, projected, incoming, true);
  return reconciled === OMIT_VALUE ? cloneValue(incoming) : (reconciled as Record<string, unknown>);
}

function reconcileProjectedSecrets(
  raw: unknown,
  projected: unknown,
  incoming: unknown,
  incomingPresent: boolean,
): unknown | typeof OMIT_VALUE {
  const projectionChanged = !isDeepStrictEqual(raw, projected);
  if (!incomingPresent || incoming === undefined) {
    return projectionChanged ? extractProjectedSecrets(raw, projected) : OMIT_VALUE;
  }

  if (!projectionChanged) {
    return cloneValue(incoming);
  }

  // Empty and null are explicit public update values. The owning repository
  // remains responsible for deciding whether a particular field may be clear.
  if (incoming === "" || incoming === null) {
    return incoming;
  }

  if (isRecord(raw) && isRecord(projected) && isRecord(incoming)) {
    const reconciled: Record<string, unknown> = cloneValue(incoming);
    for (const key of Object.keys(raw)) {
      const child = reconcileProjectedSecrets(raw[key], projected[key], incoming[key], Object.hasOwn(incoming, key));
      if (child !== OMIT_VALUE) {
        reconciled[key] = child;
      }
    }
    return reconciled;
  }

  if (Array.isArray(raw) && Array.isArray(projected) && Array.isArray(incoming)) {
    if (incoming.length === 0) {
      return [];
    }
    const identified = reconcileStableIdentityArray(raw, projected, incoming);
    if (identified !== undefined) {
      return identified;
    }
    // Positional arrays cannot safely inherit a hidden value after a reorder.
    // Keep the complete raw array unless every hidden path has an explicit
    // non-marker replacement. Callers with stronger identity (for example MCP
    // argv flag anchors) reconcile that shape before entering this helper.
    return containsRedactionMarkerDeep(incoming) ||
      !hasExplicitReplacementsForEveryProjectedSecret(raw, projected, incoming, true)
      ? cloneValue(raw)
      : cloneValue(incoming);
  }

  if (typeof raw === "string" && typeof projected === "string" && typeof incoming === "string") {
    const reconciled = restoreProjectedUrlFragments(raw, projected, incoming);
    if (reconciled !== undefined) {
      return reconciled;
    }
  }

  if (containsRedactionMarker(incoming) || isDeepStrictEqual(incoming, projected)) {
    return cloneValue(raw);
  }

  return cloneValue(incoming);
}

function extractProjectedSecrets(raw: unknown, projected: unknown): unknown | typeof OMIT_VALUE {
  if (isDeepStrictEqual(raw, projected)) {
    return OMIT_VALUE;
  }

  if (isRecord(raw) && isRecord(projected)) {
    const restored: Record<string, unknown> = {};
    for (const key of Object.keys(raw)) {
      const child = extractProjectedSecrets(raw[key], projected[key]);
      if (child !== OMIT_VALUE) {
        restored[key] = child;
      }
    }
    return Object.keys(restored).length > 0 ? restored : cloneValue(raw);
  }

  // Arrays are positional. Restoring the raw array avoids introducing sparse
  // entries (which JSON would silently convert to null) when a hidden element
  // is the only projected difference.
  if (Array.isArray(raw) && Array.isArray(projected)) {
    return cloneValue(raw);
  }

  return cloneValue(raw);
}

function reconcileStableIdentityArray(
  raw: unknown[],
  projected: unknown[],
  incoming: unknown[],
): unknown[] | undefined {
  if (
    raw.length !== projected.length ||
    !raw.every(isRecord) ||
    !projected.every(isRecord) ||
    !incoming.every(isRecord)
  ) {
    return undefined;
  }

  const identityKey = selectStableIdentityKey(raw, projected, incoming);
  if (!identityKey) {
    return undefined;
  }
  const rawById = indexRecordsByStableIdentity(raw, identityKey);
  const projectedById = indexRecordsByStableIdentity(projected, identityKey);
  const incomingById = indexRecordsByStableIdentity(incoming, identityKey);
  if (!rawById || !projectedById || !incomingById || rawById.size !== projectedById.size) {
    return undefined;
  }
  if (
    [...rawById.keys()].some((identity) => !projectedById.has(identity)) ||
    [...incomingById.keys()].some(
      (identity) => !rawById.has(identity) && containsRedactionMarkerDeep(incomingById.get(identity)),
    )
  ) {
    return undefined;
  }

  return incoming.map((record) => {
    const identity = serializeStableIdentity(record[identityKey]);
    const rawRecord = identity ? rawById.get(identity) : undefined;
    const projectedRecord = identity ? projectedById.get(identity) : undefined;
    if (!rawRecord || !projectedRecord) {
      return cloneValue(record);
    }
    const reconciled = reconcileProjectedSecrets(rawRecord, projectedRecord, record, true);
    return reconciled === OMIT_VALUE ? cloneValue(record) : reconciled;
  });
}

function listStableIdentityKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter(
    (key) => key === "id" || key === "ID" || /(?:Id|ID)$/.test(key) || /(?:^|[_-])id$/i.test(key),
  );
}

function selectStableIdentityKey(
  raw: Array<Record<string, unknown>>,
  projected: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): string | undefined {
  const common = listStableIdentityKeys(raw[0] ?? {}).filter((key) =>
    [...raw, ...projected, ...incoming].every((record) => serializeStableIdentity(record[key]) !== undefined),
  );
  const exactId = common.filter((key) => key.toLowerCase() === "id");
  if (exactId.length === 1) {
    return exactId[0];
  }
  return exactId.length === 0 && common.length === 1 ? common[0] : undefined;
}

function indexRecordsByStableIdentity(
  records: Array<Record<string, unknown>>,
  identityKey: string,
): Map<string, Record<string, unknown>> | undefined {
  const indexed = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const identity = serializeStableIdentity(record[identityKey]);
    if (!identity || indexed.has(identity)) {
      return undefined;
    }
    indexed.set(identity, record);
  }
  return indexed;
}

function serializeStableIdentity(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return `string:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `number:${value}`;
  }
  return undefined;
}

function hasExplicitReplacementsForEveryProjectedSecret(
  raw: unknown,
  projected: unknown,
  incoming: unknown,
  incomingPresent: boolean,
): boolean {
  if (isDeepStrictEqual(raw, projected)) {
    return true;
  }
  if (!incomingPresent) {
    return false;
  }

  if (Array.isArray(raw) && Array.isArray(projected)) {
    if (!Array.isArray(incoming)) {
      return false;
    }
    return raw.every((item, index) =>
      hasExplicitReplacementsForEveryProjectedSecret(item, projected[index], incoming[index], index in incoming),
    );
  }

  if (isRecord(raw) && isRecord(projected)) {
    if (!isRecord(incoming)) {
      return false;
    }
    return Object.keys(raw).every((key) =>
      hasExplicitReplacementsForEveryProjectedSecret(
        raw[key],
        projected[key],
        incoming[key],
        Object.hasOwn(incoming, key),
      ),
    );
  }

  return isExplicitNonMarkerReplacement(incoming, projected);
}

function isExplicitNonMarkerReplacement(incoming: unknown, projected: unknown): boolean {
  if (
    incoming === null ||
    incoming === undefined ||
    isDeepStrictEqual(incoming, projected) ||
    containsRedactionMarkerDeep(incoming)
  ) {
    return false;
  }
  if (typeof incoming === "string") {
    return incoming.trim().length > 0;
  }
  if (Array.isArray(incoming)) {
    return incoming.length > 0;
  }
  return isRecord(incoming) && Object.keys(incoming).length > 0;
}

function containsRedactionMarkerDeep(value: unknown, seen = new WeakSet<object>()): boolean {
  if (containsRedactionMarker(value)) {
    return true;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((item) => containsRedactionMarkerDeep(item, seen));
}

function restoreProjectedUrlFragments(raw: string, projected: string, incoming: string): string | undefined {
  if (projectPublicSecretValue(raw) !== projected) {
    return undefined;
  }

  const rawUrl = parseHttpUrl(raw);
  const projectedUrl = parseHttpUrl(projected);
  const incomingUrl = parseHttpUrl(incoming);
  if (
    !rawUrl ||
    !projectedUrl ||
    !incomingUrl ||
    !hasSameUrlAuthority(rawUrl, projectedUrl) ||
    !hasSameUrlAuthority(projectedUrl, incomingUrl) ||
    containsRedactionMarker(projectedUrl.username) ||
    containsRedactionMarker(projectedUrl.password) ||
    containsRedactionMarker(projectedUrl.hash) ||
    containsRedactionMarker(incomingUrl.username) ||
    containsRedactionMarker(incomingUrl.password) ||
    containsRedactionMarker(incomingUrl.hash)
  ) {
    return undefined;
  }

  const rawPath = rawUrl.pathname.split("/");
  const projectedPath = projectedUrl.pathname.split("/");
  const incomingPath = incomingUrl.pathname.split("/");
  if (rawPath.length !== projectedPath.length || projectedPath.length !== incomingPath.length) {
    return undefined;
  }

  let restoredPathSecret = false;
  const restoredPath = incomingPath.map((segment, index) => {
    const publicSegment = projectedPath[index] ?? "";
    const rawSegment = rawPath[index] ?? "";
    if (isRedactionMarker(publicSegment)) {
      if (containsRedactionMarker(rawSegment) || !isRedactionMarker(segment)) {
        return undefined;
      }
      restoredPathSecret = true;
      return rawSegment;
    }
    if (segment !== publicSegment || containsRedactionMarker(segment)) {
      return undefined;
    }
    return segment;
  });
  if (restoredPath.some((segment) => segment === undefined)) {
    return undefined;
  }

  const rawSlots = new Map(listQuerySlots(rawUrl).map((slot) => [slot.id, slot]));
  const projectedRedactions = new Map<string, string>();
  for (const slot of listQuerySlots(projectedUrl)) {
    if (!isRedactionMarker(slot.value)) {
      if (containsRedactionMarker(slot.value)) {
        return undefined;
      }
      continue;
    }
    const rawSlot = rawSlots.get(slot.id);
    if (!rawSlot || containsRedactionMarker(rawSlot.value)) {
      return undefined;
    }
    projectedRedactions.set(slot.id, rawSlot.value);
  }
  const incomingSlots = listQuerySlots(incomingUrl);
  const replacements = new Map<string, string>();
  for (const slot of incomingSlots) {
    if (!containsRedactionMarker(slot.value)) {
      continue;
    }
    if (!isRedactionMarker(slot.value) || !projectedRedactions.has(slot.id)) {
      return undefined;
    }
    replacements.set(slot.id, projectedRedactions.get(slot.id)!);
  }
  if (!restoredPathSecret && replacements.size === 0) {
    return undefined;
  }

  const restoredParams = new URLSearchParams();
  for (const slot of incomingSlots) {
    restoredParams.append(slot.key, replacements.get(slot.id) ?? slot.value);
  }
  incomingUrl.pathname = restoredPath.join("/");
  incomingUrl.search = restoredParams.toString();
  const restored = incomingUrl.toString();

  // Defense in depth: the canonical projector must reproduce the incoming URL
  // semantically after the slot-bound secret fragments have been restored.
  const reprojected = projectPublicSecretValue(restored);
  return haveSamePublicUrlSemantics(reprojected, incoming) ? restored : undefined;
}

type UrlQuerySlot = {
  id: string;
  key: string;
  value: string;
};

function listQuerySlots(url: URL): UrlQuerySlot[] {
  const occurrences = new Map<string, number>();
  return [...url.searchParams.entries()].map(([key, value]) => {
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return {
      id: JSON.stringify([key, occurrence]),
      key,
      value,
    };
  });
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function hasSameUrlAuthority(left: URL, right: URL): boolean {
  return left.origin === right.origin && left.username === right.username && left.password === right.password;
}

function haveSamePublicUrlSemantics(left: string, right: string): boolean {
  const leftUrl = parseHttpUrl(left);
  const rightUrl = parseHttpUrl(right);
  if (
    !leftUrl ||
    !rightUrl ||
    !hasSameUrlAuthority(leftUrl, rightUrl) ||
    normalizeRedactionMarkers(leftUrl.pathname) !== normalizeRedactionMarkers(rightUrl.pathname) ||
    normalizeRedactionMarkers(leftUrl.hash) !== normalizeRedactionMarkers(rightUrl.hash)
  ) {
    return false;
  }

  const leftSlots = listQuerySlots(leftUrl);
  const rightSlots = listQuerySlots(rightUrl);
  return (
    leftSlots.length === rightSlots.length &&
    leftSlots.every(
      (slot, index) =>
        slot.key === rightSlots[index]?.key &&
        normalizeRedactionMarkers(slot.value) === normalizeRedactionMarkers(rightSlots[index]?.value ?? ""),
    )
  );
}

function containsRedactionMarker(value: unknown): boolean {
  return typeof value === "string" && splitOnRedactionMarker(value).length > 1;
}

function splitOnRedactionMarker(value: string): string[] {
  return value.split(new RegExp(escapeRegExp(SECRET_REDACTION_MARKER), "gi"));
}

function normalizeRedactionMarkers(value: string): string {
  return splitOnRedactionMarker(value).join(SECRET_REDACTION_MARKER);
}

function isRedactionMarker(value: string): boolean {
  return normalizeRedactionMarkers(value) === SECRET_REDACTION_MARKER;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
