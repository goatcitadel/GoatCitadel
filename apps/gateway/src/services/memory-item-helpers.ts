import { randomUUID } from "node:crypto";
import type { MemoryChangeEvent, MemoryItemRecord } from "@goatcitadel/contracts";
import { MEMORY_ITEM_STATUS_VALUES, type GatewayService } from "./gateway-service.js";

export type MemoryItemHost = GatewayService;

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
}

export function mapMemoryItemRow(host: MemoryItemHost, row: MemoryItemRow): MemoryItemRecord {
  return {
    itemId: row.item_id,
    namespace: row.namespace,
    title: row.title,
    content: row.content,
    metadata: host.tryParseJson<Record<string, unknown>>(row.metadata_json, {}),
    pinned: Boolean(row.pinned),
    ttlOverrideSeconds: row.ttl_override_seconds ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    status: MEMORY_ITEM_STATUS_VALUES.has(row.status) ? row.status : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgottenAt: row.forgotten_at ?? undefined,
  };
}

export function requireMemoryItem(host: MemoryItemHost, itemId: string): MemoryItemRecord {
  const row = host.gatewaySql
    .prepare(
      `
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at
      FROM memory_items
      WHERE item_id = ?
    `,
    )
    .get(itemId) as MemoryItemRow | undefined;
  if (!row) {
    throw new Error(`Memory item not found: ${itemId}`);
  }
  return mapMemoryItemRow(host, row);
}

export function recordMemoryChange(
  host: MemoryItemHost,
  itemId: string,
  changeType: MemoryChangeEvent["changeType"],
  actorId: string | undefined,
  payload: Record<string, unknown>,
): MemoryChangeEvent {
  const change: MemoryChangeEvent = {
    changeId: randomUUID(),
    itemId,
    changeType,
    actorId: actorId?.trim() || undefined,
    payload,
    createdAt: new Date().toISOString(),
  };
  host.gatewaySql
    .prepare(
      `
      INSERT INTO memory_change_history (change_id, item_id, change_type, actor_id, payload_json, created_at)
      VALUES (@changeId, @itemId, @changeType, @actorId, @payloadJson, @createdAt)
    `,
    )
    .run({
      changeId: change.changeId,
      itemId: change.itemId,
      changeType: change.changeType,
      actorId: change.actorId ?? null,
      payloadJson: JSON.stringify(change.payload ?? {}),
      createdAt: change.createdAt,
    });
  return change;
}
