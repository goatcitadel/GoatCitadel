import { randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  canonicalJsonString,
  deriveMemoryItemLifecycleState,
  type MemoryChangeEvent,
  type MemoryItemRecord,
} from "@goatcitadel/contracts";
import type { AsyncGatewaySqlRepository } from "@goatcitadel/storage";
export const MEMORY_ITEM_STATUS_VALUES = new Set(["active", "forgotten"]);

export interface MemoryItemHost {
  gatewaySql: AsyncGatewaySqlRepository;
  tryParseJson<T>(raw: string | null | undefined, fallback: T): T;
}

interface MemoryItemRow {
  item_id: string;
  namespace: string;
  title: string;
  content: string;
  metadata_json: string | null;
  pinned: number;
  ttl_override_seconds: number | null;
  expires_at: string | null;
  status: MemoryItemRecord["status"];
  created_at: string;
  updated_at: string;
  forgotten_at: string | null;
  workspace_id: string | null;
}

export function mapMemoryItemRow(host: MemoryItemHost, row: MemoryItemRow): MemoryItemRecord {
  const status = MEMORY_ITEM_STATUS_VALUES.has(row.status) ? row.status : "active";
  const expiresAt = row.expires_at ?? undefined;
  const forgottenAt = row.forgotten_at ?? undefined;
  const parsedMetadata = host.tryParseJson<unknown>(row.metadata_json, {});
  const metadata =
    parsedMetadata && typeof parsedMetadata === "object" && !Array.isArray(parsedMetadata)
      ? (parsedMetadata as Record<string, unknown>)
      : {};
  return {
    itemId: row.item_id,
    namespace: row.namespace,
    title: row.title,
    content: row.content,
    metadata,
    pinned: Boolean(row.pinned),
    ttlOverrideSeconds: row.ttl_override_seconds ?? undefined,
    expiresAt,
    status,
    workspaceId: row.workspace_id ?? undefined,
    lifecycleState: deriveMemoryItemLifecycleState({
      status,
      expiresAt,
      forgottenAt,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgottenAt,
  };
}

export async function requireMemoryItem(host: MemoryItemHost, itemId: string): Promise<MemoryItemRecord> {
  const row = (await host.gatewaySql
    .prepare(
      `
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at, workspace_id
      FROM memory_items
      WHERE item_id = ?
    `,
    )
    .get(itemId)) as MemoryItemRow | undefined;
  if (!row) {
    throw new NotFoundError({ entity: "Memory item", id: itemId });
  }
  return mapMemoryItemRow(host, row);
}

export async function recordMemoryChange(
  host: MemoryItemHost,
  itemId: string,
  changeType: MemoryChangeEvent["changeType"],
  actorId: string | undefined,
  payload: Record<string, unknown>,
  identity: { changeId?: string; createdAt?: string } = {},
): Promise<MemoryChangeEvent> {
  if ((identity.changeId === undefined) !== (identity.createdAt === undefined)) {
    throw new TypeError("Deterministic memory history identity requires both changeId and createdAt.");
  }
  const deterministicIdentity = identity.changeId !== undefined;
  const payloadJson = deterministicIdentity ? canonicalJsonString(payload ?? {}) : JSON.stringify(payload ?? {});
  const change: MemoryChangeEvent = {
    changeId: identity.changeId ?? randomUUID(),
    itemId,
    changeType,
    actorId: actorId?.trim() || undefined,
    payload,
    createdAt: identity.createdAt ?? new Date().toISOString(),
  };
  await host.gatewaySql
    .prepare(
      `
      INSERT INTO memory_change_history (change_id, item_id, change_type, actor_id, payload_json, created_at)
      VALUES (@changeId, @itemId, @changeType, @actorId, @payloadJson, @createdAt)
      ${deterministicIdentity ? "ON CONFLICT DO NOTHING" : ""}
    `,
    )
    .run({
      changeId: change.changeId,
      itemId: change.itemId,
      changeType: change.changeType,
      actorId: change.actorId ?? null,
      payloadJson,
      createdAt: change.createdAt,
    });
  if (!deterministicIdentity) {
    return change;
  }
  const row = (await host.gatewaySql
    .prepare(
      `
      SELECT change_id, item_id, change_type, actor_id, payload_json, created_at
      FROM memory_change_history
      WHERE change_id = ?
    `,
    )
    .get(change.changeId)) as
    | {
        change_id: string;
        item_id: string;
        change_type: MemoryChangeEvent["changeType"];
        actor_id: string | null;
        payload_json: string | null;
        created_at: string;
      }
    | undefined;
  const stored = row
    ? {
        changeId: row.change_id,
        itemId: row.item_id,
        changeType: row.change_type,
        actorId: row.actor_id ?? undefined,
        payload: host.tryParseJson<Record<string, unknown>>(row.payload_json, {}),
        createdAt: row.created_at,
      }
    : undefined;
  if (!stored || row?.payload_json !== payloadJson || canonicalJsonString(stored) !== canonicalJsonString(change)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Memory history ${change.changeId} conflicts with an existing immutable record.`,
    });
  }
  return stored;
}
