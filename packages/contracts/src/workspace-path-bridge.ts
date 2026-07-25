export const WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION = "goatcitadel.workspace-path-bridge-snapshot.v1" as const;
export const WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH = 2_048;
export const WORKSPACE_PATH_BRIDGE_MAX_SNAPSHOT_BYTES = 65_536;
export const WORKSPACE_PATH_BRIDGE_MAX_LIST_LIMIT = 100;

/**
 * `posix` is a native POSIX host path. The other four flavors all describe a
 * path on a Windows host — `msys` and `wsl` merely spell one with forward
 * slashes. A single translation therefore never mixes `posix` with the others;
 * see {@link assertCoherentWorkspacePathFlavors}.
 */
export type WorkspacePathFlavor = "windows_native" | "windows_forward" | "msys" | "wsl" | "posix";
export type WorkspacePathBridgeStatus = "verified" | "blocked" | "unavailable";
export type WorkspacePathBridgeReasonCode =
  | "invalid_path"
  | "outside_jail"
  | "canonicalization_failed"
  | "symlink_escape"
  | "round_trip_mismatch"
  | "wsl_unavailable"
  | "wsl_conversion_failed"
  | "git_not_repository"
  | "git_unavailable"
  | "git_verification_failed"
  | "git_identity_mismatch";

export interface WorkspacePathBridgeResolveRequest {
  verificationId: string;
  workspaceId: string;
  inputPath: string;
  inputFlavor: WorkspacePathFlavor;
  targetFlavor: WorkspacePathFlavor;
  requireGitIdentity: boolean;
  distro?: string;
  expectedGitIdentitySha256?: string;
}

export interface WorkspacePathBridgeRoundTripEvidence {
  attempted: boolean;
  converter: "native" | "wslpath";
  inputHostPathSha256?: string;
  targetPathSha256?: string;
  roundTripHostPathSha256?: string;
  equal: boolean;
}

export interface WorkspacePathBridgeGitIdentityEvidence {
  status: "verified" | "not_repository" | "unavailable" | "failed" | "mismatch";
  topLevelPath?: string;
  commonDirPath?: string;
  identitySha256?: string;
}

/**
 * Immutable, workspace-scoped evidence for a path translation. The input path
 * itself is intentionally represented only by a hash. Canonical paths are
 * retained because they are the operator-inspectable execution boundary.
 */
export interface WorkspacePathBridgeSnapshotRecord {
  schemaVersion: typeof WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION;
  snapshotId: string;
  requestHash: string;
  workspaceId: string;
  inputFlavor: WorkspacePathFlavor;
  targetFlavor: WorkspacePathFlavor;
  gitIdentityRequired: boolean;
  inputPathHash: string;
  allowedRootsHash: string;
  canonicalHostPath?: string;
  canonicalTargetPath?: string;
  distro?: string;
  roundTrip: WorkspacePathBridgeRoundTripEvidence;
  gitIdentity: WorkspacePathBridgeGitIdentityEvidence;
  status: WorkspacePathBridgeStatus;
  reasonCode?: WorkspacePathBridgeReasonCode;
  callable: boolean;
  snapshotSha256: string;
  createdAt: string;
}

export interface WorkspacePathBridgeListResponse {
  workspaceId: string;
  snapshots: WorkspacePathBridgeSnapshotRecord[];
}

const SHA256 = /^[a-f0-9]{64}$/u;
const FLAVORS = new Set<WorkspacePathFlavor>(["windows_native", "windows_forward", "msys", "wsl", "posix"]);

export function isWorkspacePathFlavor(value: unknown): value is WorkspacePathFlavor {
  return FLAVORS.has(value as WorkspacePathFlavor);
}

/**
 * A native POSIX host path and a Windows host path are never two ends of the
 * same translation, so a request that pairs `posix` with any Windows flavor is
 * rejected rather than silently resolved by whichever host happens to serve it.
 */
export function assertCoherentWorkspacePathFlavors(
  inputFlavor: WorkspacePathFlavor,
  targetFlavor: WorkspacePathFlavor,
  subject = "Workspace path bridge",
): void {
  if ((inputFlavor === "posix") !== (targetFlavor === "posix")) {
    throw new Error(`${subject} cannot translate between POSIX and Windows path flavors.`);
  }
}
const STATUSES = new Set<WorkspacePathBridgeStatus>(["verified", "blocked", "unavailable"]);
const REASONS = new Set<WorkspacePathBridgeReasonCode>([
  "invalid_path",
  "outside_jail",
  "canonicalization_failed",
  "symlink_escape",
  "round_trip_mismatch",
  "wsl_unavailable",
  "wsl_conversion_failed",
  "git_not_repository",
  "git_unavailable",
  "git_verification_failed",
  "git_identity_mismatch",
]);

const SNAPSHOT_KEYS = [
  "schemaVersion",
  "snapshotId",
  "requestHash",
  "workspaceId",
  "inputFlavor",
  "targetFlavor",
  "gitIdentityRequired",
  "inputPathHash",
  "allowedRootsHash",
  "canonicalHostPath",
  "canonicalTargetPath",
  "distro",
  "roundTrip",
  "gitIdentity",
  "status",
  "reasonCode",
  "callable",
  "snapshotSha256",
  "createdAt",
] as const;
const ROUND_TRIP_KEYS = [
  "attempted",
  "converter",
  "inputHostPathSha256",
  "targetPathSha256",
  "roundTripHostPathSha256",
  "equal",
] as const;
const GIT_KEYS = ["status", "topLevelPath", "commonDirPath", "identitySha256"] as const;

export function assertWorkspacePathBridgeSnapshot(value: WorkspacePathBridgeSnapshotRecord): void {
  if (!isRecord(value)) {
    throw new Error("Workspace path bridge snapshot is malformed.");
  }
  assertExactKeys(value, SNAPSHOT_KEYS, new Set(["canonicalHostPath", "canonicalTargetPath", "distro", "reasonCode"]));
  assertIdentifier(value.snapshotId, "snapshotId", 256);
  assertIdentifier(value.workspaceId, "workspaceId", 256);
  if (value.schemaVersion !== WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION) {
    throw new Error("Workspace path bridge snapshot has an unsupported schema version.");
  }
  for (const [name, hash] of [
    ["requestHash", value.requestHash],
    ["inputPathHash", value.inputPathHash],
    ["allowedRootsHash", value.allowedRootsHash],
    ["snapshotSha256", value.snapshotSha256],
  ] as const) {
    if (!SHA256.test(hash)) {
      throw new Error(`Workspace path bridge ${name} is invalid.`);
    }
  }
  if (!FLAVORS.has(value.inputFlavor) || !FLAVORS.has(value.targetFlavor)) {
    throw new Error("Workspace path bridge flavor is invalid.");
  }
  assertCoherentWorkspacePathFlavors(value.inputFlavor, value.targetFlavor);
  if (typeof value.gitIdentityRequired !== "boolean") {
    throw new Error("Workspace path bridge Git identity posture is invalid.");
  }
  if ((value.inputFlavor === "wsl" || value.targetFlavor === "wsl") !== (value.distro !== undefined)) {
    throw new Error("Workspace path bridge distro evidence is inconsistent.");
  }
  if (value.distro !== undefined) {
    assertIdentifier(value.distro, "distro", 64);
  }
  assertOptionalPath(value.canonicalHostPath, "canonicalHostPath");
  assertOptionalPath(value.canonicalTargetPath, "canonicalTargetPath");
  assertRoundTrip(value.roundTrip);
  assertGitIdentity(value.gitIdentity);
  if (!STATUSES.has(value.status)) {
    throw new Error("Workspace path bridge status is invalid.");
  }
  if (value.status === "verified") {
    if (
      value.reasonCode !== undefined ||
      value.callable !== true ||
      !value.canonicalHostPath ||
      !value.canonicalTargetPath ||
      !value.roundTrip.attempted ||
      !value.roundTrip.equal ||
      value.gitIdentity.status === "mismatch" ||
      (value.gitIdentityRequired && value.gitIdentity.status !== "verified")
    ) {
      throw new Error("Verified workspace path bridge evidence is incomplete.");
    }
  } else if (value.callable !== false || value.reasonCode === undefined || !REASONS.has(value.reasonCode)) {
    throw new Error("Blocked workspace path bridge evidence cannot be callable.");
  }
  if (
    value.status === "unavailable" &&
    value.reasonCode !== "wsl_unavailable" &&
    value.reasonCode !== "git_unavailable"
  ) {
    throw new Error("Unavailable workspace path bridge evidence has an invalid reason.");
  }
  if (
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new Error("Workspace path bridge creation evidence is invalid.");
  }
}

function assertRoundTrip(value: WorkspacePathBridgeRoundTripEvidence): void {
  if (!isRecord(value)) {
    throw new Error("Workspace path bridge round-trip evidence is malformed.");
  }
  assertExactKeys(
    value,
    ROUND_TRIP_KEYS,
    new Set(["inputHostPathSha256", "targetPathSha256", "roundTripHostPathSha256"]),
  );
  if (typeof value.attempted !== "boolean" || typeof value.equal !== "boolean") {
    throw new Error("Workspace path bridge round-trip flags are invalid.");
  }
  if (value.converter !== "native" && value.converter !== "wslpath") {
    throw new Error("Workspace path bridge converter is invalid.");
  }
  for (const hash of [value.inputHostPathSha256, value.targetPathSha256, value.roundTripHostPathSha256]) {
    if (hash !== undefined && !SHA256.test(hash)) {
      throw new Error("Workspace path bridge round-trip hash is invalid.");
    }
  }
  if (!value.attempted && (value.equal || value.roundTripHostPathSha256 !== undefined)) {
    throw new Error("Workspace path bridge round-trip evidence is inconsistent.");
  }
  if (value.equal && (!value.inputHostPathSha256 || !value.targetPathSha256 || !value.roundTripHostPathSha256)) {
    throw new Error("Workspace path bridge successful round-trip hashes are incomplete.");
  }
}

function assertGitIdentity(value: WorkspacePathBridgeGitIdentityEvidence): void {
  if (!isRecord(value)) {
    throw new Error("Workspace path bridge Git identity is malformed.");
  }
  assertExactKeys(value, GIT_KEYS, new Set(["topLevelPath", "commonDirPath", "identitySha256"]));
  if (!new Set(["verified", "not_repository", "unavailable", "failed", "mismatch"]).has(value.status)) {
    throw new Error("Workspace path bridge Git identity status is invalid.");
  }
  assertOptionalPath(value.topLevelPath, "git.topLevelPath");
  assertOptionalPath(value.commonDirPath, "git.commonDirPath");
  if (value.identitySha256 !== undefined && !SHA256.test(value.identitySha256)) {
    throw new Error("Workspace path bridge Git identity hash is invalid.");
  }
  if (value.status === "verified" && (!value.topLevelPath || !value.commonDirPath || !value.identitySha256)) {
    throw new Error("Workspace path bridge verified Git identity is incomplete.");
  }
  if (value.status !== "verified" && value.status !== "mismatch" && value.identitySha256 !== undefined) {
    throw new Error("Workspace path bridge failed Git identity contains authority evidence.");
  }
}

function assertOptionalPath(value: string | undefined, name: string): void {
  if (
    value !== undefined &&
    (typeof value !== "string" ||
      !value ||
      value !== value.trim() ||
      value.length > WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH ||
      containsAsciiControlCharacter(value))
  ) {
    throw new Error(`Workspace path bridge ${name} is invalid.`);
  }
}

function assertIdentifier(value: string, name: string, max: number): void {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > max ||
    containsAsciiControlCharacter(value)
  ) {
    throw new Error(`Workspace path bridge ${name} is invalid.`);
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function assertExactKeys(value: object, keys: readonly string[], optional: ReadonlySet<string>): void {
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  if (actual.some((key) => !allowed.has(key)) || keys.some((key) => !optional.has(key) && !actual.includes(key))) {
    throw new Error("Workspace path bridge evidence contains unsupported or missing fields.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
