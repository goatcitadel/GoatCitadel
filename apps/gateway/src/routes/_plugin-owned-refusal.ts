import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { isPluginOwnedError } from "../services/plugin-owned-refusal.js";
import { sendRouteError } from "./_error-handler.js";

/**
 * Answers the refusal of a piece a plugin added: 409 `PLUGIN_OWNED`, named after the plugin when its record is saved
 * (an owner that can't name it from its own record says it came with a plugin that isn't installed). Anything else
 * answers `undefined`, for the route's own error handling.
 */
export async function sendPluginOwnedRefusal(
  fastify: FastifyInstance,
  reply: FastifyReply,
  error: unknown,
  log: FastifyBaseLogger,
): Promise<FastifyReply | undefined> {
  if (!isPluginOwnedError(error)) return undefined;
  const named = (await fastify.services.capabilityPlugins?.namePluginOwnedError(error)) ?? error;
  return sendRouteError(reply, named, log);
}
