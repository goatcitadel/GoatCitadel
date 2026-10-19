/**
 * Writes outside every write root that an operator may admit from a Chat
 * approval: either once for the exact approved request, or through an
 * expiring, path-scoped folder grant. Off by default; deny-wins, Citadel
 * Wards, hard-forbidden runtime paths and approvals are never weakened.
 */
export const OUTSIDE_ROOT_WRITE_MODES = ["deny", "approval_required"] as const;
export type OutsideRootWriteMode = (typeof OUTSIDE_ROOT_WRITE_MODES)[number];

/** Folder-grant lifetimes an operator may choose; never persistent. */
export const OUTSIDE_ROOT_WRITE_GRANT_DURATIONS = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "8h": 8 * 60 * 60_000,
} as const;
export type OutsideRootWriteGrantDuration = keyof typeof OUTSIDE_ROOT_WRITE_GRANT_DURATIONS;
/** The duration choices as a non-empty tuple, for request validators such as zod enums. */
export const OUTSIDE_ROOT_WRITE_GRANT_DURATION_CHOICES = Object.keys(OUTSIDE_ROOT_WRITE_GRANT_DURATIONS) as [
  OutsideRootWriteGrantDuration,
  ...OutsideRootWriteGrantDuration[],
];
/** The rootId format the policy engine issues for each candidate folder. */
export const OUTSIDE_ROOT_WRITE_ROOT_ID_PATTERN = /^owr_[a-f0-9]{16}$/u;
export const OUTSIDE_ROOT_WRITE_GRANT_DEFAULT_DURATION: OutsideRootWriteGrantDuration = "1h";
export const OUTSIDE_ROOT_WRITE_GRANT_MAX_TTL_MS = 24 * 60 * 60_000;
export const OUTSIDE_ROOT_WRITE_GRANT_MAX_ROOTS = 4;
/** A folder grant can only be minted this soon after its approval was granted. */
export const OUTSIDE_ROOT_WRITE_GRANT_MINT_WINDOW_MS = 15 * 60_000;

/** Write tools whose targets may be admitted outside the write roots. Deletes never are. */
export const OUTSIDE_ROOT_WRITE_TOOLS = [
  "fs.write",
  "fs.patch",
  "fs.copy",
  "fs.move",
  "artifacts.create",
  "documents.create",
  "presentations.create",
  "browser.screenshot",
  "browser.interact",
] as const;
export type OutsideRootWriteTool = (typeof OUTSIDE_ROOT_WRITE_TOOLS)[number];

export function isOutsideRootWriteTool(toolName: string): toolName is OutsideRootWriteTool {
  return (OUTSIDE_ROOT_WRITE_TOOLS as readonly string[]).includes(toolName);
}

/** A server-derived folder an approval may open; clients choose by rootId only. */
export interface OutsideRootWriteCandidateRoot {
  rootId: string;
  path: string;
}

/**
 * The folder an operator chose when approving an outside-root write: a
 * server-issued rootId and a lifetime. Sent as `writeGrant` on the Chat
 * approve route; the Gateway re-checks it against the approval it describes.
 */
export interface OutsideRootWriteGrantChoice {
  rootId: string;
  duration: OutsideRootWriteGrantDuration;
}

/**
 * Engine-authored record of an outside-root write approval. It is written into
 * the `pending_action_registered` approval event (authoritative) and copied into
 * the approval preview for display only.
 */
export interface OutsideRootWriteApprovalDetails {
  kind: "outside_root_write";
  targets: string[];
  candidates: OutsideRootWriteCandidateRoot[];
  durations: OutsideRootWriteGrantDuration[];
  defaultDuration: OutsideRootWriteGrantDuration;
}

export function isOutsideRootWriteGrantDuration(value: unknown): value is OutsideRootWriteGrantDuration {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(OUTSIDE_ROOT_WRITE_GRANT_DURATIONS, value);
}

/** Parse the details object from an untrusted record; returns undefined when malformed. */
export function readOutsideRootWriteApprovalDetails(value: unknown): OutsideRootWriteApprovalDetails | undefined {
  if (!isRecord(value) || value.kind !== "outside_root_write") return undefined;
  const { targets, candidates, durations, defaultDuration } = value;
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every(isNonEmptyString)) return undefined;
  if (!Array.isArray(candidates) || !candidates.every(isCandidateRoot)) return undefined;
  if (!Array.isArray(durations) || !durations.every(isOutsideRootWriteGrantDuration)) return undefined;
  if (!isOutsideRootWriteGrantDuration(defaultDuration)) return undefined;
  return {
    kind: "outside_root_write",
    targets: [...targets],
    candidates: candidates.map((candidate) => ({ rootId: candidate.rootId, path: candidate.path })),
    durations: [...durations],
    defaultDuration,
  };
}

function isCandidateRoot(value: unknown): value is OutsideRootWriteCandidateRoot {
  return isRecord(value) && isNonEmptyString(value.rootId) && isNonEmptyString(value.path);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
