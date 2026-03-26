import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { adminRoutes } from "./admin.js";

describe("admin routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns retention policy from the gateway", async () => {
    const getRetentionPolicy = vi.fn(() => ({
      realtimeEventsDays: 14,
      backupsKeep: 5,
    }));
    app = Fastify();
    app.decorate("gateway", { getRetentionPolicy } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/retention",
    });

    expect(response.statusCode).toBe(200);
    expect(getRetentionPolicy).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({ backupsKeep: 5 });
  });

  it("validates prune input and forwards dryRun", async () => {
    const pruneRetention = vi.fn(async () => ({ deletedEvents: 0, dryRun: false }));
    app = Fastify();
    app.decorate("gateway", { pruneRetention } as never);
    await app.register(adminRoutes);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/admin/retention/prune",
      payload: { dryRun: "bad" },
    });
    expect(invalid.statusCode).toBe(400);

    const valid = await app.inject({
      method: "POST",
      url: "/api/v1/admin/retention/prune",
      payload: { dryRun: false },
    });
    expect(valid.statusCode).toBe(200);
    expect(pruneRetention).toHaveBeenCalledWith({ dryRun: false });
  });

  it("returns backup restore errors as 400s", async () => {
    const restoreBackup = vi.fn(async () => {
      throw new Error("restore blocked: file path outside workspace");
    });
    app = Fastify();
    app.decorate("gateway", { restoreBackup } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/backups/restore",
      payload: {
        filePath: "../outside.zip",
        confirm: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Backup file path must stay within the GoatCitadel backup directory.",
    });
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("returns backup verification output from the gateway", async () => {
    const verifyBackup = vi.fn(async () => ({
      backupPath: "F:/code/personal-ai/backups/example.backup",
      backupId: "example",
      verified: true,
      filesVerified: 3,
      issues: [],
    }));
    app = Fastify();
    app.decorate("gateway", { verifyBackup } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/backups/verify",
      payload: {
        filePath: "example.backup",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(verifyBackup).toHaveBeenCalledWith({
      filePath: "example.backup",
    });
    expect(response.json()).toMatchObject({
      verified: true,
      filesVerified: 3,
    });
  });

  it("rejects backup verification traversal before reaching the gateway", async () => {
    const verifyBackup = vi.fn(async () => ({
      verified: true,
    }));
    app = Fastify();
    app.decorate("gateway", { verifyBackup } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/backups/verify",
      payload: {
        filePath: "../outside.backup",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Backup file path must stay within the GoatCitadel backup directory.",
    });
    expect(verifyBackup).not.toHaveBeenCalled();
  });
});
