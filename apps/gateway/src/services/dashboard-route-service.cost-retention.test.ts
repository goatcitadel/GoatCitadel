import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { createDashboardRoutePort } from "./dashboard-route-service.js";

const storages: Storage[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dashboard spend totals after a chat is deleted", () => {
  it("keeps session and day cost totals unchanged, detached under the deleted-session key", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-cost-retention-"));
    roots.push(root);
    const storage = new Storage({
      dbPath: path.join(root, "storage.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    storages.push(storage);
    const now = "2026-07-13T00:00:00.000Z";
    storage.sessions.upsert({
      sessionId: "chat-1",
      sessionKey: "mission:operator:chat-1",
      kind: "dm",
      channel: "mission",
      account: "operator",
      timestamp: now,
    });
    storage.chatSessionMeta.ensure("chat-1", now, "default");
    storage.costLedger.insert({
      sessionId: "chat-1",
      agentId: "assistant",
      tokenInput: 10,
      tokenOutput: 20,
      tokenCachedInput: 0,
      costUsd: 1.5,
      createdAt: now,
    });

    const port = createDashboardRoutePort({ storage } as never);
    const from = "2026-07-13T00:00:00.000Z";
    const to = "2026-07-13T23:59:59.999Z";
    const dayBefore = await port.costSummary("day", from, to);
    expect(dayBefore.reduce((sum, row) => sum + row.costUsd, 0)).toBe(1.5);

    expect(storage.deleteChatSessionData("chat-1").deleted).toBe(true);

    const dayAfter = await port.costSummary("day", from, to);
    expect(dayAfter).toEqual(dayBefore);
    const bySession = await port.costSummary("session", from, to);
    expect(bySession.map((row) => [row.key, row.costUsd])).toEqual([["deleted-session", 1.5]]);
  });
});
