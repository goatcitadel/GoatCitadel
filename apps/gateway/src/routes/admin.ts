import os from "node:os";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const retentionPatchSchema = z.object({
  realtimeEventsDays: z.coerce.number().int().positive().max(365).optional(),
  backupsKeep: z.coerce.number().int().positive().max(500).optional(),
  transcriptsDays: z.union([z.coerce.number().int().positive().max(3650), z.literal("off"), z.null()]).optional(),
  auditDays: z.union([z.coerce.number().int().positive().max(3650), z.literal("off"), z.null()]).optional(),
});

const pruneSchema = z.object({
  dryRun: z.boolean().optional(),
});

const backupCreateSchema = z.object({
  name: z.string().optional(),
  outputPath: z.string().optional(),
});

const backupListQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
});

const backupRestoreSchema = z.object({
  filePath: z.string().min(1),
  confirm: z.boolean(),
});

const backupVerifySchema = z.object({
  filePath: z.string().min(1),
});

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/admin/retention", async (_request, reply) => {
    return reply.send(fastify.gateway.getRetentionPolicy());
  });

  fastify.patch("/api/v1/admin/retention", async (request, reply) => {
    const parsed = retentionPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const body = parsed.data;
    const patch: {
      realtimeEventsDays?: number;
      backupsKeep?: number;
      transcriptsDays?: number | undefined;
      auditDays?: number | undefined;
    } = {};
    if (body.realtimeEventsDays !== undefined) {
      patch.realtimeEventsDays = body.realtimeEventsDays;
    }
    if (body.backupsKeep !== undefined) {
      patch.backupsKeep = body.backupsKeep;
    }
    if (body.transcriptsDays !== undefined) {
      patch.transcriptsDays = body.transcriptsDays === "off" ? undefined : body.transcriptsDays ?? undefined;
    }
    if (body.auditDays !== undefined) {
      patch.auditDays = body.auditDays === "off" ? undefined : body.auditDays ?? undefined;
    }
    const updated = fastify.gateway.updateRetentionPolicy(patch);
    return reply.send(updated);
  });

  fastify.post("/api/v1/admin/retention/prune", async (request, reply) => {
    const parsed = pruneSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const result = await fastify.gateway.pruneRetention({
      dryRun: parsed.data.dryRun ?? true,
    });
    return reply.send(result);
  });

  fastify.get("/api/v1/admin/backups", async (request, reply) => {
    const parsed = backupListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const items = await fastify.gateway.listBackups(parsed.data.limit);
    return reply.send({ items });
  });

  fastify.post("/api/v1/admin/backups/create", async (request, reply) => {
    const parsed = backupCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const created = await fastify.gateway.createBackup(parsed.data);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/admin/backups/restore", async (request, reply) => {
    const parsed = backupRestoreSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const jailed = resolveBackupPathWithinRoot(parsed.data.filePath);
    if (!jailed.ok) {
      return reply.code(400).send({ error: jailed.error });
    }
    try {
      return reply.send(await fastify.gateway.restoreBackup(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/admin/backups/verify", async (request, reply) => {
    const parsed = backupVerifySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const jailed = resolveBackupPathWithinRoot(parsed.data.filePath);
    if (!jailed.ok) {
      return reply.code(400).send({ error: jailed.error });
    }
    try {
      return reply.send(await fastify.gateway.verifyBackup(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};

function resolveBackupPathWithinRoot(filePath: string): { ok: true; resolvedPath: string } | { ok: false; error: string } {
  const backupRoot = path.resolve(path.join(os.homedir(), ".GoatCitadel", "backups"));
  const resolvedPath = path.resolve(backupRoot, filePath);
  const relative = path.relative(backupRoot, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      error: "Backup file path must stay within the GoatCitadel backup directory.",
    };
  }
  return { ok: true, resolvedPath };
}
