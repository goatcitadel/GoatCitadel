import { randomBytes, randomUUID } from "node:crypto";
import type { DiscordPairingRecord } from "@goatcitadel/contracts";
import type { GatewayService } from "./gateway-service.js";

export type DiscordPairingHost = GatewayService;

export function generateDiscordPairingCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

export function findApprovedDiscordPairing(
  host: DiscordPairingHost,
  connectionId: string,
  userId: string,
): DiscordPairingRecord | undefined {
  return host
    .readDiscordPairings()
    .find((item) => item.connectionId === connectionId && item.userId === userId && item.status === "approved");
}

export function ensurePendingDiscordPairing(
  host: DiscordPairingHost,
  connectionId: string,
  userId: string,
  displayName?: string,
): DiscordPairingRecord {
  const records = host.readDiscordPairings();
  const now = new Date().toISOString();
  const existing = records.find(
    (item) => item.connectionId === connectionId && item.userId === userId && item.status === "pending",
  );
  if (existing) {
    const updated: DiscordPairingRecord = {
      ...existing,
      displayName: displayName?.trim() || existing.displayName,
      updatedAt: now,
    };
    host.writeDiscordPairings(records.map((item) => (item.pairingId === updated.pairingId ? updated : item)));
    return updated;
  }
  const created: DiscordPairingRecord = {
    pairingId: randomUUID(),
    connectionId,
    userId,
    displayName: displayName?.trim() || undefined,
    code: generateDiscordPairingCode(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  host.writeDiscordPairings([created, ...records]);
  return created;
}

export function touchDiscordPairing(host: DiscordPairingHost, pairingId: string): void {
  const now = new Date().toISOString();
  host.writeDiscordPairings(
    host.readDiscordPairings().map((item) =>
      item.pairingId === pairingId
        ? {
            ...item,
            lastInboundAt: now,
            updatedAt: now,
          }
        : item,
    ),
  );
}
