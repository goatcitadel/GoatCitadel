import { describe, expect, it } from "vitest";
import type { DiscordPairingRecord } from "@goatcitadel/contracts";
import {
  ensurePendingDiscordPairing,
  findApprovedDiscordPairing,
  generateDiscordPairingCode,
  touchDiscordPairing,
  type DiscordPairingHost,
} from "./discord-pairing-helpers.js";

function createPairingHost(
  initial: DiscordPairingRecord[] = [],
): DiscordPairingHost & { records: DiscordPairingRecord[] } {
  return {
    records: [...initial],
    readDiscordPairings() {
      return this.records;
    },
    writeDiscordPairings(records: DiscordPairingRecord[]) {
      this.records = records;
    },
  };
}

describe("discord pairing helpers", () => {
  it("generates six-character uppercase pairing codes", () => {
    expect(generateDiscordPairingCode()).toMatch(/^[0-9A-F]{6}$/u);
  });

  it("finds only approved pairings for the requested connection and user", async () => {
    const approved: DiscordPairingRecord = {
      pairingId: "pair-approved",
      connectionId: "discord-main",
      userId: "user-1",
      code: "ABC123",
      status: "approved",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    };
    const host = createPairingHost([
      { ...approved, pairingId: "pair-pending", status: "pending" },
      { ...approved, pairingId: "pair-other-user", userId: "user-2" },
      approved,
    ]);

    expect(await findApprovedDiscordPairing(host, "discord-main", "user-1")).toBe(approved);
    expect(await findApprovedDiscordPairing(host, "discord-main", "missing-user")).toBeUndefined();
  });

  it("creates pending pairings with trimmed display names and prepends them to persisted records", async () => {
    const existing: DiscordPairingRecord = {
      pairingId: "existing",
      connectionId: "discord-main",
      userId: "other-user",
      code: "ABC123",
      status: "approved",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    };
    const host = createPairingHost([existing]);

    const created = await ensurePendingDiscordPairing(host, "discord-main", "user-1", "  Operator  ");

    expect(created).toMatchObject({
      connectionId: "discord-main",
      userId: "user-1",
      displayName: "Operator",
      status: "pending",
    });
    expect(created.pairingId).toBeTruthy();
    expect(created.code).toMatch(/^[0-9A-F]{6}$/u);
    expect(Date.parse(created.createdAt)).not.toBeNaN();
    expect(created.updatedAt).toBe(created.createdAt);
    expect(host.records[0]).toBe(created);
    expect(host.records[1]).toBe(existing);
  });

  it("updates an existing pending pairing without losing its display name when the new one is blank", async () => {
    const pending: DiscordPairingRecord = {
      pairingId: "pending",
      connectionId: "discord-main",
      userId: "user-1",
      displayName: "Existing Name",
      code: "ABC123",
      status: "pending",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    };
    const host = createPairingHost([pending]);

    const updated = await ensurePendingDiscordPairing(host, "discord-main", "user-1", "   ");

    expect(updated).toMatchObject({
      pairingId: "pending",
      displayName: "Existing Name",
      code: "ABC123",
      status: "pending",
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(pending.updatedAt));
    expect(host.records).toEqual([updated]);
  });

  it("touches only the matching pairing with inbound timestamps", async () => {
    const target: DiscordPairingRecord = {
      pairingId: "target",
      connectionId: "discord-main",
      userId: "user-1",
      code: "ABC123",
      status: "approved",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    };
    const untouched: DiscordPairingRecord = {
      ...target,
      pairingId: "untouched",
      userId: "user-2",
    };
    const host = createPairingHost([target, untouched]);

    await touchDiscordPairing(host, "target");

    expect(host.records[0]).toMatchObject({
      pairingId: "target",
      lastInboundAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(Date.parse(host.records[0].lastInboundAt ?? "")).not.toBeNaN();
    expect(host.records[1]).toEqual(untouched);
  });
});
