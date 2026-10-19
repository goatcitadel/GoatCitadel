import { canonicalJsonString, type CitadelVaultSnapshot } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

/** Only public metadata is retained in review and admission state. */
export type VaultChange = { type: "store"; name: string } | { type: "delete"; secretId: string };
export const sameVaultValue = (left: unknown, right: unknown) =>
  canonicalJsonString(left) === canonicalJsonString(right);
const ITEM_KEYS = ["secretId", "secretName", "createdAt", "updatedAt", "chamberId", "keyVersion"];
const isOptionalNumber = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
function hasVaultKeyMetadata(keys: CitadelVaultSnapshot["keys"] | undefined): boolean {
  return Boolean(
    keys &&
    typeof keys === "object" &&
    isOptionalNumber(keys.kekVersion) &&
    typeof keys.legacySecretCount === "number" &&
    Array.isArray(keys.scopes) &&
    keys.scopes.every(
      (scope) =>
        scope &&
        (scope.chamberId === null || typeof scope.chamberId === "string") &&
        isOptionalNumber(scope.activeKeyVersion) &&
        typeof scope.secretCount === "number",
    ),
  );
}
/** Key versions change under a background upgrade or rotation; write confirmation ignores them. */
const reviewedItems = (items: CitadelVaultSnapshot["items"]) =>
  items.map(({ keyVersion: _keyVersion, ...item }) => item);
/** The reviewed part of a snapshot: what its revision binds, not key versions or counts. */
export const sameVaultReview = (left: CitadelVaultSnapshot, right: CitadelVaultSnapshot) =>
  left.citadelId === right.citadelId &&
  left.revision === right.revision &&
  sameVaultValue(left.record, right.record) &&
  sameVaultValue(reviewedItems(left.items), reviewedItems(right.items));
export function hasVaultSnapshot(value: CitadelVaultSnapshot, citadelId: string): boolean {
  return Boolean(
    value &&
    value.citadelId === citadelId &&
    /^[a-f0-9]{64}$/u.test(value.revision) &&
    Object.keys(value).every((key) => ["citadelId", "revision", "record", "items", "keys"].includes(key)) &&
    hasVaultKeyMetadata(value.keys) &&
    (!value.record || value.record.citadelId === citadelId) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        item &&
        typeof item.secretId === "string" &&
        item.secretId.length > 0 &&
        typeof item.secretName === "string" &&
        item.secretName.length > 0 &&
        typeof item.createdAt === "string" &&
        typeof item.updatedAt === "string" &&
        (item.chamberId === null || typeof item.chamberId === "string") &&
        isOptionalNumber(item.keyVersion) &&
        Object.keys(item).every((key) => ITEM_KEYS.includes(key)),
    ) &&
    new Set(value.items.map((item) => item.secretId)).size === value.items.length &&
    new Set(value.items.map((item) => item.secretName)).size === value.items.length,
  );
}
export function vaultMutationMatches(before: CitadelVaultSnapshot, after: CitadelVaultSnapshot, change: VaultChange) {
  if (
    !hasVaultSnapshot(after, before.citadelId) ||
    before.revision === after.revision ||
    !sameVaultValue(before.record, after.record)
  )
    return false;
  if (change.type === "delete")
    return (
      before.items.some((item) => item.secretId === change.secretId) &&
      sameVaultValue(
        reviewedItems(after.items),
        reviewedItems(before.items.filter((item) => item.secretId !== change.secretId)),
      )
    );
  const prior = before.items.find((item) => item.secretName === change.name);
  const saved = after.items.find((item) => item.secretName === change.name);
  if (
    !saved ||
    !sameVaultValue(
      reviewedItems(before.items.filter((item) => item.secretName !== change.name)),
      reviewedItems(after.items.filter((item) => item.secretName !== change.name)),
    )
  )
    return false;
  return prior
    ? saved.secretId === prior.secretId && saved.createdAt === prior.createdAt && saved.updatedAt !== prior.updatedAt
    : !before.items.some((item) => item.secretId === saved.secretId);
}
export function isVaultPrewriteRejection(error: unknown, citadelId: string, change: VaultChange) {
  if (!isApiRequestError(error) || error.kind !== "http") return false;
  const path = `/api/v1/citadels/${encodeURIComponent(citadelId)}/vault-secrets`;
  if (
    error.method !== (change.type === "store" ? "POST" : "DELETE") ||
    error.path !== (change.type === "store" ? path : `${path}/${encodeURIComponent(change.secretId)}`)
  )
    return false;
  const body = error.body as
    | {
        code?: string;
        error?: string;
        mutationCommitted?: boolean;
        committed?: boolean;
        details?: { reason?: string; mutationCommitted?: boolean; committed?: boolean };
      }
    | undefined;
  if (!body || body.mutationCommitted || body.committed || body.details?.mutationCommitted || body.details?.committed)
    return false;
  return (
    (error.status === 409 &&
      body.code === "WRITE_CONFLICT" &&
      ["CITADEL_VAULT_REVISION_CONFLICT", "CITADEL_ARCHIVED"].includes(body.details?.reason ?? "")) ||
    (change.type === "store" &&
      error.status === 503 &&
      body.error === "Vault is unavailable — the secret store could not provide a key.")
  );
}
