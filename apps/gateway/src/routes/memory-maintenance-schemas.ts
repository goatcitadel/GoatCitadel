import { z } from "zod";

export const maintenancePolicyPatchSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  enabled: z.boolean().optional(),
  runMode: z.enum(["manual", "scheduled", "hybrid"]).optional(),
  timingStrategy: z.enum(["fixed", "recommendation_first"]).optional(),
  schedule: z.object({
    frequency: z.enum(["daily", "weekly"]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(0).max(6).optional(),
  }).nullable().optional(),
  timeZone: z.string().trim().min(1).optional(),
  minHoursSinceLastSuccess: z.number().int().min(0).max(24 * 365).optional(),
  minChangedSessions: z.number().int().min(1).max(10_000).optional(),
  providerId: z.string().trim().min(1).nullable().optional(),
  model: z.string().trim().min(1).nullable().optional(),
  executionTarget: z.enum(["auto", "local", "cloud"]).optional(),
  unavailableModelPolicy: z.enum(["skip", "error"]).optional(),
});

export const maintenanceRecommendationDecisionSchema = z.object({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const maintenanceRecommendationAcceptSchema = maintenanceRecommendationDecisionSchema.extend({
  expectedPolicyRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const maintenanceRunNowSchema = z.object({
  workspaceId: z.string().trim().min(1),
  triggerSource: z.enum(["manual", "recommendation"]).optional(),
});
export const maintenanceRunParamsSchema = z.object({ runId: z.string().trim().min(1) });
export const maintenanceRecommendationParamsSchema = z.object({ recommendationId: z.string().trim().min(1) });
