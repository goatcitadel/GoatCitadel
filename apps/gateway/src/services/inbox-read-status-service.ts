import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  type OperatorInboxResponse,
  type OperatorInboxUpdateReference,
  type OperatorInboxReadResponse,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { projectPublicSecretValue } from "./public-secret-projection.js";
const MAX_ENTRIES = 1000;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
type Entry = OperatorInboxUpdateReference & { at: number };
const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
export function versionInboxUpdates(projection: OperatorInboxResponse): OperatorInboxResponse {
  return {
    ...projection,
    items: projection.items.map((item) => {
      if (item.group !== "updates") return item;
      const { version: _version, read: _read, ...publicItem } = projectPublicSecretValue(item);
      return { ...publicItem, version: digest(publicItem) };
    }),
  };
}
/** Read receipts carry no decision authority. Storage receives only opaque scope and bounded references. */
export class InboxReadStatusService {
  constructor(private readonly settings: Pick<AsyncStorage["systemSettings"], "get" | "compareAndSet">) {}
  private key(workspaceId: string, actor: string) {
    return `inbox.read.v1.${digest([actor, workspaceId])}`;
  }
  private entries(value: unknown, now: number): Entry[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (e): e is Entry =>
          e &&
          typeof e.id === "string" &&
          typeof e.version === "string" &&
          typeof e.at === "number" &&
          e.at > now - RETENTION_MS &&
          e.at <= now,
      )
      .slice(-MAX_ENTRIES)
      .map(({ id, version, at }) => ({ id, version, at }));
  }
  async project(projection: OperatorInboxResponse, actor?: string): Promise<OperatorInboxResponse> {
    if (!actor) return { ...projection, readStatus: { scope: "browser_local" } };
    const key = this.key(projection.workspaceId, actor);
    try {
      const record = await this.settings.get(key);
      const entries = this.entries(record?.value, Date.now());
      return {
        ...projection,
        readStatus: { scope: "operator", scopeId: key },
        items: projection.items.map((item) =>
          item.group === "updates"
            ? { ...item, read: entries.some((e) => e.id === item.id && e.version === item.version) }
            : item,
        ),
      };
    } catch {
      return { ...projection, readStatus: { scope: "unavailable", scopeId: key } };
    }
  }
  async acknowledge(
    projection: OperatorInboxResponse,
    actor: string | undefined,
    updates: OperatorInboxUpdateReference[],
  ): Promise<OperatorInboxReadResponse> {
    if (!actor)
      return {
        readStatus: { scope: "browser_local" },
        acknowledged: [],
        skipped: updates.map((u) => ({ ...u, reason: "browser_local" })),
      };
    const key = this.key(projection.workspaceId, actor);
    const valid = updates.filter((u) =>
      projection.items.some(
        (item) =>
          item.group === "updates" &&
          item.source.workspaceId === projection.workspaceId &&
          item.id === u.id &&
          item.version === u.version,
      ),
    );
    const skipped: OperatorInboxReadResponse["skipped"] = updates
      .filter((u) => !valid.includes(u))
      .map((u) => ({ ...u, reason: "not_current" }));
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const now = Date.now();
        const previous = await this.settings.get(key);
        const entries = this.entries(previous?.value, now).filter(
          (e) => !valid.some((u) => u.id === e.id && u.version === e.version),
        );
        const additions = [
          ...new Map(
            valid.map((u) => [JSON.stringify([u.id, u.version]), { id: u.id, version: u.version, at: now }]),
          ).values(),
        ];
        const next = [...entries, ...additions].slice(-MAX_ENTRIES);
        if (await this.settings.compareAndSet(key, previous, next, new Date(now).toISOString()))
          return { readStatus: { scope: "operator", scopeId: key }, acknowledged: valid, skipped };
      }
    } catch {
      /* No acknowledgement is reported without a committed receipt. */
    }
    return {
      readStatus: { scope: "unavailable", scopeId: key },
      acknowledged: [],
      skipped: updates.map((u) => ({ ...u, reason: "unavailable" })),
    };
  }
}
