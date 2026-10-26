import { MCP_APPROVAL_POSTURES } from "@goatcitadel/contracts";
import { z } from "zod";

export const serverParamsSchema = z.object({
  serverId: z.string().min(1),
});

const categorySchema = z.enum([
  "development",
  "browser",
  "automation",
  "research",
  "data",
  "creative",
  "orchestration",
  "other",
]);
const trustTierSchema = z.enum(["trusted", "restricted", "quarantined"]);
const costTierSchema = z.enum(["free", "mixed", "paid", "unknown"]);
const policySchema = z.object({
  requireFirstToolApproval: z.boolean().optional(),
  redactionMode: z.enum(["off", "basic", "strict"]).optional(),
  allowedToolPatterns: z.array(z.string()).optional(),
  blockedToolPatterns: z.array(z.string()).optional(),
  allowedEnvKeys: z.array(z.string()).optional(),
  notes: z.string().optional(),
});
const oauthSchema = z.object({
  authorizationUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  metadataDiscovery: z.boolean().optional(),
  clientIdEnv: z.string().trim().min(1).optional(),
  clientSecretEnv: z.string().trim().min(1).optional(),
  scopes: z.array(z.string().trim().min(1)).optional(),
  redirectUri: z.string().url().optional(),
  tokenRefreshSkewSeconds: z.number().int().nonnegative().optional(),
});

export const createServerSchema = z.object({
  label: z.string().min(1),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  authType: z.enum(["none", "token", "oauth2"]).optional(),
  oauth: oauthSchema.optional(),
  enabled: z.boolean().optional(),
  category: categorySchema.optional(),
  trustTier: trustTierSchema.optional(),
  costTier: costTierSchema.optional(),
  policy: policySchema.optional(),
  verifiedAt: z.string().optional(),
});

export const updateServerSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    label: z.string().min(1).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    authType: z.enum(["none", "token", "oauth2"]).optional(),
    oauth: oauthSchema.optional(),
    enabled: z.boolean().optional(),
    category: categorySchema.optional(),
    trustTier: trustTierSchema.optional(),
    costTier: costTierSchema.optional(),
    policy: policySchema.optional(),
    verifiedAt: z.string().optional(),
  })
  .strict();

export const revisionSchema = updateServerSchema.pick({ expectedRevision: true }).strict();
export const connectionReviewSchema = revisionSchema
  .extend({ expectedConnectionRevision: revisionSchema.shape.expectedRevision.nullable() })
  .strict();
export const updatePolicySchema = policySchema
  .extend({
    approvalPosture: z.enum(MCP_APPROVAL_POSTURES).optional(),
    expectedRevision: revisionSchema.shape.expectedRevision,
  })
  .strict();

export const oauthCompleteSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
});

export const invokeSchema = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  permissionProfileId: z.string().optional(),
  localOperatorOverrideId: z.string().optional(),
  surface: z.enum(["chat", "cowork", "code", "tools", "mcp", "all"]).optional(),
  autonomousActivation: z.boolean().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
});

export const serverModeCallSchema = z.object({
  descriptorName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  permissionProfileId: z.string().optional(),
  localOperatorOverrideId: z.string().optional(),
});

const elicitationStatusSchema = z.enum(["pending", "accepted", "declined", "cancelled", "expired"]);
const elicitationActionSchema = z.enum(["accept", "decline", "cancel"]);
const elicitationOwnerSchema = z.object({
  operatorId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  surface: z.enum(["chat", "cowork", "code", "tools", "mcp", "all"]).optional(),
});
const elicitationSourceSchema = z.object({
  sourceType: z.enum(["mcp_server", "gateway", "agent", "ui"]).optional(),
  serverId: z.string().trim().min(1).optional(),
  toolName: z.string().trim().min(1).optional(),
  jsonRpcRequestId: z.union([z.string().trim().min(1), z.number()]).optional(),
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  sourceRef: z.string().trim().min(1).optional(),
});
export const elicitationCreateSchema = z
  .object({
    prompt: z.string().optional(),
    message: z.string().optional(),
    requestedSchema: z.record(z.string(), z.unknown()),
    owner: elicitationOwnerSchema.optional(),
    source: elicitationSourceSchema.optional(),
    serverId: z.string().trim().min(1).optional(),
    toolName: z.string().trim().min(1).optional(),
    jsonRpcRequestId: z.union([z.string().trim().min(1), z.number()]).optional(),
    transport: z.enum(["stdio", "http", "sse"]).optional(),
  })
  .refine((input) => Boolean((input.prompt ?? input.message)?.trim()), {
    message: "MCP elicitation prompt/message is required.",
    path: ["prompt"],
  });
export const elicitationParamsSchema = z.object({
  elicitationId: z.string().min(1),
});
export const elicitationResponseSchema = z.object({
  action: elicitationActionSchema,
  content: z.record(z.string(), z.unknown()).optional(),
  owner: elicitationOwnerSchema.optional(),
});
export const elicitationListQuerySchema = z.object({
  status: elicitationStatusSchema.optional(),
  serverId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
});
