import type { PersonalityCatalogResponse } from "@goatcitadel/contracts";
import { z } from "zod";
import { listPersonalityPresets } from "../services/channel-personalities.js";
import { coerceBoundedInteger } from "./runtime-boundary-coercion.js";

export const kindEnum = z.enum([
  "channel",
  "model_provider",
  "productivity",
  "automation",
  "platform",
  "external_connector",
]);

export const catalogQuerySchema = z.object({
  kind: kindEnum.optional(),
});

export function resolveRoutePersonalityCatalog(services: unknown): PersonalityCatalogResponse {
  const settings = (
    services as {
      settings?: { getPersonalityCatalog?: () => PersonalityCatalogResponse };
    }
  ).settings;
  return settings?.getPersonalityCatalog?.() ?? { items: listPersonalityPresets(), defaultPersonalityId: "default" };
}

export const connectionsQuerySchema = z.object({
  kind: kindEnum.optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

export const externalSideEffectRunsQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(200).optional(),
  connectionId: z.string().trim().min(1).max(200).optional(),
  limit: z.preprocess((value) => coerceBoundedInteger(value, { defaultValue: 200, min: 1, max: 500 }), z.number()),
});

const externalConnectorStatusEnum = z.enum(["new", "reviewed", "hidden", "staged"]);
const externalConnectorWorkspaceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9._-]+$/, "workspaceId contains unsupported characters");

export const externalConnectorServicesQuerySchema = z.object({
  workspaceId: externalConnectorWorkspaceIdSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
  status: z.union([externalConnectorStatusEnum, z.literal("all")]).optional(),
  includeActions: z.preprocess((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "off", ""].includes(normalized)) {
        return false;
      }
    }
    return value;
  }, z.boolean().optional()),
  limit: z.preprocess((value) => coerceBoundedInteger(value, { defaultValue: 200, min: 1, max: 1000 }), z.number()),
});

export const externalConnectorServiceParamsSchema = z.object({
  sourceId: z.literal("mscr"),
  serviceId: z.string().trim().min(1).max(120),
});

export const externalConnectorActionParamsSchema = externalConnectorServiceParamsSchema.extend({
  actionId: z.string().trim().min(1).max(160),
});

export const externalConnectorDetailQuerySchema = z.object({
  workspaceId: externalConnectorWorkspaceIdSchema.optional(),
});

export const externalConnectorReviewPatchSchema = z.object({
  workspaceId: externalConnectorWorkspaceIdSchema.optional(),
  status: externalConnectorStatusEnum.optional(),
  pinned: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
  proposalId: z.string().trim().min(1).max(200).nullable().optional(),
});

export const externalConnectorStageActionSchema = z.object({
  workspaceId: externalConnectorWorkspaceIdSchema.optional(),
  note: z.string().trim().min(1).max(2000).optional(),
});

export const createConnectionSchema = z.object({
  catalogId: z.string().min(3),
  label: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["connected", "disconnected", "error", "paused"]).optional(),
  config: z.record(z.unknown()).optional(),
});

export const updateConnectionSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["connected", "disconnected", "error", "paused"]).optional(),
  config: z.record(z.unknown()).optional(),
  lastSyncAt: z.string().datetime().optional(),
  lastError: z.string().max(4000).optional(),
});

export const connectionParamsSchema = z.object({
  connectionId: z.string().uuid(),
});

export const connectionActionParamsSchema = z.object({
  connectionId: z.string().uuid(),
  actionId: z.string().min(1).max(120),
});

export const connectionActionBodySchema = z.object({
  input: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export const discordPairingParamsSchema = z.object({
  connectionId: z.string().uuid(),
  pairingId: z.string().uuid(),
});

export const catalogParamsSchema = z.object({
  catalogId: z.string().min(3),
});

export const channelDraftParamsSchema = z.object({
  draftId: z.string().uuid(),
});

export const channelDraftListQuerySchema = z.object({
  catalogId: z.string().min(3).optional(),
  connectionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const createChannelDraftSchema = z.object({
  catalogId: z.string().min(3),
  connectionId: z.string().uuid().optional(),
  lifecycleMode: z.enum(["create", "edit", "repair", "rotate_secret", "retest"]).optional(),
});

export const updateChannelDraftSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  draft: z.record(z.unknown()).optional(),
  lastFailureCategory: z
    .enum([
      "missing_input",
      "malformed_value",
      "credential_rejected",
      "permission_mismatch",
      "destination_mismatch",
      "platform_unavailable",
      "bridge_unavailable",
      "deprecated_path",
      "unknown",
    ])
    .optional(),
});

export const pluginInstallSchema = z.object({
  source: z.string().min(1),
  pluginId: z.string().optional(),
  sourceType: z.enum(["local", "npm", "git", "url", "manual", "unknown"]).optional(),
  expectedIntegrity: z.string().min(1).optional(),
});

export const pluginParamsSchema = z.object({
  pluginId: z.string().min(1),
});

export const obsidianPatchSchema = z.object({
  enabled: z.boolean().optional(),
  vaultPath: z.string().optional(),
  mode: z.enum(["read_append", "read_only"]).optional(),
  allowedSubpaths: z.array(z.string().min(1)).optional(),
});

export const obsidianSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
});

export const obsidianReadQuerySchema = z.object({
  path: z.string().min(1),
});

export const obsidianAppendSchema = z.object({
  path: z.string().min(1),
  markdownBlock: z.string().min(1),
});

export const obsidianInboxCaptureSchema = z.object({
  id: z.string().min(1),
  request: z.string().min(1),
  type: z.string().optional(),
  priority: z.string().optional(),
  neededBy: z.string().optional(),
  owner: z.string().optional(),
  state: z.string().optional(),
  taskLink: z.string().optional(),
  decisionLink: z.string().optional(),
  notes: z.string().optional(),
});

export const slackOAuthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const slackOAuthDisconnectSchema = z.object({
  connectionId: z.string().uuid(),
});

export const telegramDiscoverTargetsSchema = z.object({
  connectionId: z.string().uuid().optional(),
  botToken: z.string().min(1).optional(),
  botTokenEnv: z.string().min(1).optional(),
  setupCode: z.string().min(1).optional(),
});

export const telegramPairingApproveSchema = z.object({
  code: z.string().min(1).max(64),
});

const queryBooleanSchema = z.preprocess((value) => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }
  return value;
}, z.boolean().optional());

export const channelTargetDirectoryQuerySchema = z.object({
  refresh: queryBooleanSchema,
  query: z.string().min(1).optional(),
});

export function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readEnvConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const envName = readConfigString(config, key);
  return envName ? process.env[envName] : undefined;
}
