import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildOfflineRestoreRequiredResponse, resolveBackupPathWithinDirectory } from "../services/backup-paths.js";

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

const databaseCutoverSchema = z.object({
  profile: z.enum(["local", "hosted"]),
  execute: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

const databaseVerifySchema = z.object({
  source: z.string().min(1),
  target: z.string().optional(),
});

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = {
    preHandler: fastify.requireOperatorAuth,
  } as const;

  fastify.get("/api/v1/admin/retention", operatorOnly, async (_request, reply) => {
    return reply.send(fastify.gateway.getRetentionPolicy());
  });

  fastify.patch("/api/v1/admin/retention", operatorOnly, async (request, reply) => {
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
      patch.transcriptsDays = body.transcriptsDays === "off" ? undefined : (body.transcriptsDays ?? undefined);
    }
    if (body.auditDays !== undefined) {
      patch.auditDays = body.auditDays === "off" ? undefined : (body.auditDays ?? undefined);
    }
    const updated = fastify.gateway.updateRetentionPolicy(patch);
    return reply.send(updated);
  });

  fastify.post("/api/v1/admin/retention/prune", operatorOnly, async (request, reply) => {
    const parsed = pruneSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const result = await fastify.gateway.pruneRetention({
      dryRun: parsed.data.dryRun ?? true,
    });
    return reply.send(result);
  });

  fastify.get("/api/v1/admin/backups", operatorOnly, async (request, reply) => {
    const parsed = backupListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const items = await fastify.gateway.listBackups(parsed.data.limit);
    return reply.send({ items });
  });

  fastify.post("/api/v1/admin/backups/create", operatorOnly, async (request, reply) => {
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

  fastify.post("/api/v1/admin/backups/restore", operatorOnly, async (request, reply) => {
    const parsed = backupRestoreSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const blocked = buildOfflineRestoreRequiredResponse(parsed.data.filePath);
    if (!blocked.ok) {
      return reply.code(400).send({ error: blocked.error });
    }
    return reply.code(409).send(blocked.response);
  });

  fastify.post("/api/v1/admin/backups/verify", operatorOnly, async (request, reply) => {
    const parsed = backupVerifySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const jailed = resolveBackupPathWithinDirectory(parsed.data.filePath);
    if (!jailed.ok) {
      return reply.code(400).send({ error: jailed.error });
    }
    try {
      return reply.send(await fastify.gateway.verifyBackup(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/admin/database/cutover", operatorOnly, async (request, reply) => {
    const parsed = databaseCutoverSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const result = await fastify.gateway.runDatabaseCutover({
        profile: parsed.data.profile,
        execute: parsed.data.execute ?? false,
        confirm: parsed.data.confirm,
      });
      return reply.send(result);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/admin/database/verify", operatorOnly, async (request, reply) => {
    const parsed = databaseVerifySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.verifyDatabaseCutover(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
