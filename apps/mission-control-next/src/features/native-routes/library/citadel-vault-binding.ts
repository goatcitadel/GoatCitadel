import { canonicalJsonString, type CitadelVaultSnapshot } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

/** Only public metadata is retained in review and admission state. */
export type VaultChange = { type: "store"; name: string } | { type: "delete"; secretId: string };
export const sameVaultValue = (left: unknown, right: unknown) =>
  canonicalJsonString(left) === canonicalJsonString(right);
export function hasVaultSnapshot(value: CitadelVaultSnapshot, citadelId: string): boolean {
  return Boolean(
    value &&
    value.citadelId === citadelId &&
    /^[a-f0-9]{64}$/u.test(value.revision) &&
    Object.keys(value).every((key) => ["citadelId", "revision", "record", "items"].includes(key)) &&
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
        Object.keys(item).every((key) => ["secretId", "secretName", "createdAt", "updatedAt"].includes(key)),
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
        after.items,
        before.items.filter((item) => item.secretId !== change.secretId),
      )
    );
  const prior = before.items.find((item) => item.secretName === change.name);
  const saved = after.items.find((item) => item.secretName === change.name);
  if (
    !saved ||
    !sameVaultValue(
      before.items.filter((item) => item.secretName !== change.name),
      after.items.filter((item) => item.secretName !== change.name),
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
