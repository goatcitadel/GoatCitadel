import {
  NotFoundError,
  REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_DEFAULT_LIMIT,
  REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES,
  REMOTE_WORKER_REGISTRY_MAX_LIMIT,
  REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION,
  canonicalJsonString,
  compareRemoteWorkerCanonicalIdentifiers,
  freezeRemoteWorkerRegistryDetail,
  freezeRemoteWorkerRegistryPage,
  normalizeRemoteWorkerRegistryCursor,
  type RemoteWorkerRegistryCursorV1,
  type RemoteWorkerRegistryDetail,
  type RemoteWorkerRegistryItem,
  type RemoteWorkerRegistryPage,
  type RemoteWorkerTruth,
} from "@goatcitadel/contracts";
import type { ListRemoteWorkerRegistryResult, RemoteWorkerRegistryRecord } from "@goatcitadel/storage";

export interface RemoteWorkerRegistryStore {
  listWorkerRegistry(
    registryWorkspaceId: string,
    options?: { limit?: number; cursor?: string },
  ): ListRemoteWorkerRegistryResult;
  findWorkerRegistryEntry(registryWorkspaceId: string, workerId: string): RemoteWorkerRegistryRecord | undefined;
}

export interface ListRemoteWorkerRegistryInput {
  readonly workspaceId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface GetRemoteWorkerRegistryInput {
  readonly workspaceId: string;
  readonly workerId: string;
}

export class RemoteWorkerRegistryInputError extends Error {
  public constructor() {
    super("Remote worker registry request is invalid.");
    this.name = "RemoteWorkerRegistryInputError";
  }
}

export class RemoteWorkersRouteService {
  public constructor(
    private readonly registry: RemoteWorkerRegistryStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public listRegistry(input: ListRemoteWorkerRegistryInput): RemoteWorkerRegistryPage {
    const workspaceId = inputIdentifier(input.workspaceId);
    const limit = inputLimit(input.limit);
    const cursor = input.cursor === undefined ? undefined : decodeRemoteWorkerRegistryCursor(input.cursor);
    if (cursor && cursor.workspaceId !== workspaceId) throw new RemoteWorkerRegistryInputError();
    const stored = this.registry.listWorkerRegistry(workspaceId, {
      limit,
      ...(cursor ? { cursor: cursor.lastWorkerId } : {}),
    });
    if (
      stored.items.length > limit ||
      (cursor !== undefined &&
        stored.items.some(
          (record) => compareRemoteWorkerCanonicalIdentifiers(record.admission.workerId, cursor.lastWorkerId) <= 0,
        )) ||
      (stored.nextCursor !== undefined && stored.items.length < limit)
    ) {
      throw new TypeError("Remote worker registry storage page is inconsistent.");
    }
    const observedAt = this.now();
    const items = stored.items.map((record) => projectRegistryItem(record, observedAt));
    if (stored.nextCursor !== undefined && (items.length === 0 || stored.nextCursor !== items.at(-1)?.workerId)) {
      throw new TypeError("Remote worker registry storage cursor is inconsistent.");
    }
    return freezeRemoteWorkerRegistryPage({
      schemaVersion: REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId,
      items,
      ...(stored.nextCursor
        ? {
            nextCursor: encodeRemoteWorkerRegistryCursor({
              schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
              workspaceId,
              lastWorkerId: stored.nextCursor,
            }),
          }
        : {}),
      observedAt,
    });
  }

  public getRegistryEntry(input: GetRemoteWorkerRegistryInput): RemoteWorkerRegistryDetail {
    const workspaceId = inputIdentifier(input.workspaceId);
    const workerId = inputIdentifier(input.workerId);
    const stored = this.registry.findWorkerRegistryEntry(workspaceId, workerId);
    if (!stored) throw new NotFoundError({ entity: "remote worker registry entry", id: "unavailable" });
    if (stored.admission.workerId !== workerId) {
      throw new TypeError("Remote worker registry storage detail is inconsistent.");
    }
    const observedAt = this.now();
    return freezeRemoteWorkerRegistryDetail({
      schemaVersion: REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId,
      item: projectRegistryItem(stored, observedAt),
      observedAt,
    });
  }
}

export function encodeRemoteWorkerRegistryCursor(cursor: RemoteWorkerRegistryCursorV1): string {
  let normalized: RemoteWorkerRegistryCursorV1;
  try {
    normalized = normalizeRemoteWorkerRegistryCursor(cursor);
  } catch {
    throw new RemoteWorkerRegistryInputError();
  }
  const encoded = Buffer.from(canonicalJsonString(normalized), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES) {
    throw new RemoteWorkerRegistryInputError();
  }
  return encoded;
}

export function decodeRemoteWorkerRegistryCursor(value: string): RemoteWorkerRegistryCursorV1 {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES
  ) {
    throw new RemoteWorkerRegistryInputError();
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.length > REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES) throw new Error();
    const normalized = normalizeRemoteWorkerRegistryCursor(JSON.parse(bytes.toString("utf8")) as unknown);
    if (encodeRemoteWorkerRegistryCursor(normalized) !== value) throw new Error();
    return normalized;
  } catch {
    throw new RemoteWorkerRegistryInputError();
  }
}

function projectRegistryItem(record: RemoteWorkerRegistryRecord, observedAt: string): RemoteWorkerRegistryItem {
  const posture = record.control?.action === "quarantine" ? "quarantined" : record.control ? "revoked" : "active";
  return {
    schemaVersion: REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION,
    workerId: record.admission.workerId,
    admission: {
      value: record.admission,
      authorityClass: "canonical_record",
      owner: "storage.remoteWorkerAdmissions",
      observedAt,
    },
    control: {
      value: record.control ?? null,
      authorityClass: "canonical_record",
      owner: "storage.remoteWorkerAdmissions",
      observedAt,
    },
    posture: {
      value: posture,
      authorityClass: "derived_projection",
      owner: "gateway.remoteWorkers",
      observedAt,
    },
    unavailable: {
      connectionHealth: unavailableTruth("gateway.remoteWorkerListener", observedAt),
      assignments: unavailableTruth("storage.remoteWorkerAssignments", observedAt),
      usageAndCost: unavailableTruth("storage.remoteWorkerUsage", observedAt),
      resourceCell: unavailableTruth("storage.remoteWorkerResourceCells", observedAt),
      artifactAndEffects: unavailableTruth("storage.remoteWorkerArtifacts", observedAt),
    },
  };
}

function unavailableTruth(owner: string, observedAt: string): RemoteWorkerTruth<never> {
  return {
    value: null,
    authorityClass: "unavailable",
    owner,
    observedAt,
    caveat: "Unavailable in the server-only canonical registry read tranche.",
  };
}

function inputIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value !== value.normalize("NFKC").trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new RemoteWorkerRegistryInputError();
  }
  return value;
}

function inputLimit(value: number | undefined): number {
  const normalized = value ?? REMOTE_WORKER_REGISTRY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > REMOTE_WORKER_REGISTRY_MAX_LIMIT) {
    throw new RemoteWorkerRegistryInputError();
  }
  return normalized;
}
