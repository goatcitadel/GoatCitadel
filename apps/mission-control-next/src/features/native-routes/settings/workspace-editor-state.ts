import type { WorkspaceRecord } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

export interface WorkspaceDraft {
  name: string;
  description: string;
  slug: string;
}
export function workspaceDraft(record?: WorkspaceRecord | null): WorkspaceDraft {
  return { name: record?.name ?? "", description: record?.description ?? "", slug: record?.slug ?? "" };
}
export interface WorkspaceAttempt {
  phase: "idle" | "checking" | "saving" | "saved" | "uncertain";
  message?: string;
  rejectedRevision?: string;
}
const IDLE: WorkspaceAttempt = { phase: "idle" };
const attempts = new Map<string, WorkspaceAttempt>();
const listeners = new Set<() => void>();
let attemptVersion = 0;
export const workspaceAttemptsVersion = () => attemptVersion;
export const subscribeWorkspaceAttempts = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const workspaceAttempt = (key: string) => attempts.get(key) ?? IDLE;
export const workspaceAttemptLocked = (key: string) =>
  ["checking", "saving", "uncertain"].includes(workspaceAttempt(key).phase);
export function setWorkspaceAttempt(key: string, value: WorkspaceAttempt) {
  attempts.set(key, value);
  attemptVersion += 1;
  for (const listener of listeners) listener();
}
export function hasWorkspaceBinding(
  record: WorkspaceRecord | null | undefined,
  citadelId: string,
): record is WorkspaceRecord {
  return Boolean(
    record &&
    record.citadelId === citadelId &&
    typeof record.workspaceId === "string" &&
    record.workspaceId &&
    typeof record.name === "string" &&
    record.name.trim() &&
    Number.isSafeInteger(record.revision) &&
    record.revision > 0 &&
    typeof record.slug === "string" &&
    record.slug &&
    ["active", "archived"].includes(record.lifecycleStatus),
  );
}
export function workspaceReceiptMatches(
  saved: WorkspaceRecord,
  citadelId: string,
  submitted: WorkspaceDraft,
  previous?: WorkspaceRecord,
): boolean {
  // Receipt consistency only; normalization and uniqueness remain enforced by the workspace repository.
  const requestedSlug = (submitted.slug.trim() || submitted.name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (
    !hasWorkspaceBinding(saved, citadelId) ||
    saved.name !== submitted.name.trim() ||
    saved.slug !== requestedSlug ||
    (saved.description ?? "") !== submitted.description.trim()
  )
    return false;
  if (!previous) return saved.lifecycleStatus === "active";
  return (
    saved.workspaceId === previous.workspaceId &&
    (saved.revision === previous.revision + 1 ||
      (saved.revision === previous.revision &&
        saved.name === previous.name &&
        (saved.description ?? "") === (previous.description ?? "") &&
        saved.slug === previous.slug)) &&
    saved.lifecycleStatus === previous.lifecycleStatus &&
    saved.archivedAt === previous.archivedAt &&
    saved.createdAt === previous.createdAt &&
    JSON.stringify(saved.workspacePrefs ?? {}) === JSON.stringify(previous.workspacePrefs ?? {})
  );
}
export function isWorkspaceRevisionConflict(error: unknown, workspaceId: string, expectedRevision: number): boolean {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object") return false;
  const body = error.body as Record<string, unknown>;
  const details = body.details as Record<string, unknown> | undefined;
  return (
    body.code === "WRITE_CONFLICT" &&
    details?.resourceKind === "workspace" &&
    details.resourceId === workspaceId &&
    details.expectedRevision === expectedRevision &&
    body.committed !== true &&
    body.mutationCommitted !== true &&
    details.committed !== true &&
    details.mutationCommitted !== true
  );
}
export function __resetWorkspaceAttemptsForTests() {
  attempts.clear();
  attemptVersion += 1;
  for (const listener of listeners) listener();
}
