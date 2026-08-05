import { randomBytes, randomUUID } from "node:crypto";
import type { DiscordPairingRecord } from "@goatcitadel/contracts";

export interface DiscordPairingHost {
  readDiscordPairings(): Promise<DiscordPairingRecord[]>;
  writeDiscordPairings(records: DiscordPairingRecord[]): Promise<void>;
}

export function generateDiscordPairingCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

export async function findApprovedDiscordPairing(
  host: DiscordPairingHost,
  connectionId: string,
  userId: string,
): Promise<DiscordPairingRecord | undefined> {
  return (await host.readDiscordPairings()).find(
    (item) => item.connectionId === connectionId && item.userId === userId && item.status === "approved",
  );
}

export async function ensurePendingDiscordPairing(
  host: DiscordPairingHost,
  connectionId: string,
  userId: string,
  displayName?: string,
): Promise<DiscordPairingRecord> {
  const records = await host.readDiscordPairings();
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
    await host.writeDiscordPairings(records.map((item) => (item.pairingId === updated.pairingId ? updated : item)));
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
  await host.writeDiscordPairings([created, ...records]);
  return created;
}

export async function touchDiscordPairing(host: DiscordPairingHost, pairingId: string): Promise<void> {
  const now = new Date().toISOString();
  await host.writeDiscordPairings(
    (await host.readDiscordPairings()).map((item) =>
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
