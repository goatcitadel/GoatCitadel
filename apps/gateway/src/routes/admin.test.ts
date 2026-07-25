import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
import { adminRoutes } from "./admin.js";

describe("admin routes", () => {
  let app: FastifyInstance | null = null;
  const originalBackupDir = process.env.GOATCITADEL_BACKUP_DIR;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    if (originalBackupDir === undefined) {
      delete process.env.GOATCITADEL_BACKUP_DIR;
    } else {
      process.env.GOATCITADEL_BACKUP_DIR = originalBackupDir;
    }
  });

  it("returns retention policy from the gateway", async () => {
    const getRetentionPolicy = vi.fn(() => ({
      realtimeEventsDays: 14,
      backupsKeep: 5,
    }));
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: { getRetentionPolicy } } as never);
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
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: { pruneRetention } } as never);
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

  it("normalizes retention patches and maps backup create errors without changing route contracts", async () => {
    const updateRetentionPolicy = vi.fn((patch: Record<string, unknown>) => ({ ...patch, updated: true }));
    const listBackups = vi.fn(async () => [{ backupId: "backup-1" }]);
    const createBackup = vi.fn(async (input: Record<string, unknown>) => {
      if (input.name === "bad") {
        throw new Error("backup rejected");
      }
      return { backupId: "backup-2", ...input };
    });
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: { updateRetentionPolicy, listBackups, createBackup } } as never);
    await app.register(adminRoutes);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/retention",
      payload: {
        realtimeEventsDays: 30,
        backupsKeep: 9,
        transcriptsDays: "off",
        auditDays: null,
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(updateRetentionPolicy).toHaveBeenCalledWith({
      realtimeEventsDays: 30,
      backupsKeep: 9,
      transcriptsDays: undefined,
      auditDays: undefined,
    });

    const invalidPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/retention",
      payload: { backupsKeep: 0 },
    });
    expect(invalidPatch.statusCode).toBe(400);

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/backups?limit=2" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [{ backupId: "backup-1" }] });
    expect(listBackups).toHaveBeenCalledWith(2);

    const invalidList = await app.inject({ method: "GET", url: "/api/v1/admin/backups?limit=0" });
    expect(invalidList.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/backups/create",
      payload: { name: "manual", outputPath: "manual.backup" },
    });
    expect(created.statusCode).toBe(201);
    expect(createBackup).toHaveBeenCalledWith({ name: "manual", outputPath: "manual.backup" });

    const invalidCreate = await app.inject({
      method: "POST",
      url: "/api/v1/admin/backups/create",
      payload: { name: 123 },
    });
    expect(invalidCreate.statusCode).toBe(400);

    const rejectedCreate = await app.inject({
      method: "POST",
      url: "/api/v1/admin/backups/create",
      payload: { name: "bad" },
    });
    expect(rejectedCreate.statusCode).toBe(400);
    expect(rejectedCreate.json()).toEqual({ error: "backup rejected" });
  });

  it("rejects backup restore traversal before reaching the gateway", async () => {
    const restoreBackup = vi.fn(async () => {
      throw new Error("restore blocked: file path outside workspace");
    });
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: {} } as never);
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

  it("blocks live backup restore and points operators to the offline CLI path", async () => {
    const restoreBackup = vi.fn(async () => ({
      restored: true,
    }));
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: {} } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/backups/restore",
      payload: {
        filePath: "example.backup",
        confirm: true,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "offline_restore_required",
      code: "offline_restore_required",
      maintenanceRequired: true,
      supportedMode: "offline",
    });
    expect(response.json().cliHint).toContain("pnpm admin backup restore");
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("uses the shared backup directory resolution for the blocked live-restore payload", async () => {
    process.env.GOATCITADEL_BACKUP_DIR = "C:/custom-backups";
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: {} } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/backups/restore",
      payload: {
        filePath: "folder/runtime.backup",
        confirm: true,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      filePath: "C:\\custom-backups\\folder\\runtime.backup",
    });
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
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: { verifyBackup } } as never);
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
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: { verifyBackup } } as never);
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

  it("forwards database cutover requests to the gateway", async () => {
    const runDatabaseCutover = vi.fn(async () => ({
      cutoverId: "cut-1",
      profile: "local",
      mode: "dry_run",
      status: "ready",
      revision: 7,
      configuredDriver: "sqlite",
      activeStorageDriver: "sqlite",
      restartRequired: false,
      startedAt: "2026-04-09T12:00:00.000Z",
      finishedAt: "2026-04-09T12:00:01.000Z",
      runtimeFlipReady: false,
      summary: {
        sourceSessionCount: 2,
        sourceTranscriptEventCount: 4,
        sourceAuditEventCount: 1,
      },
      steps: [],
    }));
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: { runDatabaseCutover } } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/database/cutover",
      payload: {
        profile: "local",
        execute: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runDatabaseCutover).toHaveBeenCalledWith({
      profile: "local",
      execute: false,
      confirm: undefined,
      expectedRevision: undefined,
    });
    expect(response.json()).toMatchObject({
      cutoverId: "cut-1",
      status: "ready",
      revision: 7,
    });
  });

  it.each([
    { profile: "local", execute: true, confirm: true },
    { profile: "local", execute: true, confirm: true, expectedRevision: 0 },
    { profile: "local", execute: true, confirm: true, expectedRevision: -1 },
    { profile: "local", execute: true, confirm: true, expectedRevision: 1.5 },
  ])("rejects execute cutovers without a positive integer revision: %j", async (payload) => {
    const runDatabaseCutover = vi.fn();
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: { runDatabaseCutover } } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/database/cutover",
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(runDatabaseCutover).not.toHaveBeenCalled();
  });

  it("returns a structured 409 for a stale execute cutover", async () => {
    const runDatabaseCutover = vi.fn(async () => {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Settings changed during cutover.",
        details: { expectedRevision: 7, currentRevision: 8 },
      });
    });
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: { runDatabaseCutover } } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/database/cutover",
      payload: { profile: "hosted", execute: true, confirm: true, expectedRevision: 7 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "STATE_CONFLICT",
      details: { expectedRevision: 7, currentRevision: 8 },
    });
    expect(runDatabaseCutover).toHaveBeenCalledWith({
      profile: "hosted",
      execute: true,
      confirm: true,
      expectedRevision: 7,
    });
  });

  it("forwards database verify requests to the gateway", async () => {
    const verifyDatabaseCutover = vi.fn(async () => ({
      source: "example.backup",
      verified: true,
      sourceSessionCount: 1,
      sourceTranscriptEventCount: 2,
      sourceAuditEventCount: 1,
      targetTranscriptEventCount: 2,
      targetAuditEventCount: 1,
      issues: [],
    }));
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", { authAdmin: { verifyDatabaseCutover } } as never);
    await app.register(adminRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/database/verify",
      payload: {
        source: "example.backup",
        target: "postgresql://localhost/goat",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(verifyDatabaseCutover).toHaveBeenCalledWith({
      source: "example.backup",
      target: "postgresql://localhost/goat",
    });
    expect(response.json()).toMatchObject({
      verified: true,
      targetTranscriptEventCount: 2,
    });
  });
});
