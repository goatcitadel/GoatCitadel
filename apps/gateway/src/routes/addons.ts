import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const addonParamsSchema = z.object({
  addonId: z.string().min(1),
});

const installSchema = z.object({
  confirmRepoDownload: z.boolean(),
  actorId: z.string().trim().min(1).optional(),
});

const ADDON_DASHBOARD_SLOT_VALUES = [
  "ops.approvals.actions",
  "ops.runtime.actions",
  "ops.runtime.statusbar",
  "library.skills.cards",
  "library.memory.actions",
  "projects.detail.toolbar",
  "settings.account.sections",
] as const;

const addonSlotsQuerySchema = z.object({
  route: z.string().trim().min(1).optional(),
  slot: z.enum(ADDON_DASHBOARD_SLOT_VALUES).optional(),
});

export const addonsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/addons/catalog", async (_request, reply) => {
    return reply.send({ items: fastify.services.addons.listAddonsCatalog() });
  });

  fastify.get("/api/v1/addons/installed", async (_request, reply) => {
    return reply.send({ items: await fastify.services.addons.listInstalledAddons() });
  });

  fastify.get("/api/v1/addons/slots", async (request, reply) => {
    const parsed = addonSlotsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.addons.listAddonSlots(parsed.data.route, parsed.data.slot),
    });
  });

  fastify.get("/api/v1/addons/:addonId/status", async (request, reply) => {
    const parsed = addonParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.addons.getAddonStatus(parsed.data.addonId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/addons/:addonId/install", async (request, reply) => {
    const params = addonParamsSchema.safeParse(request.params);
    const body = installSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.code(201).send(await fastify.services.addons.installAddon(params.data.addonId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/addons/:addonId/update", async (request, reply) => {
    const params = addonParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.addons.updateAddon(params.data.addonId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/addons/:addonId/launch", async (request, reply) => {
    const params = addonParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.addons.launchAddon(params.data.addonId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/addons/:addonId/stop", async (request, reply) => {
    const params = addonParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.addons.stopAddon(params.data.addonId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/addons/:addonId/uninstall", async (request, reply) => {
    const params = addonParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.addons.uninstallAddon(params.data.addonId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
