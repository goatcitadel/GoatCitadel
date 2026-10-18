import { z } from "zod";

/** Body schemas for the cron job create/update routes. */
export const cronJobCreateSchema = z
  .object({
    jobId: z.string().min(3).max(64),
    name: z.string().min(1).max(120),
    action: z
      .enum([
        "task",
        "improvement",
        "curator",
        "backup",
        "memory_flush",
        "memory_consolidation",
        "cost_report",
        "update_review",
        "watchdog",
        "no_agent",
        "agent_turn",
      ])
      .optional(),
    actionConfig: z.record(z.string(), z.unknown()).optional(),
    description: z.string().max(2000).optional(),
    schedule: z.string().min(1).max(128),
    enabled: z.boolean().optional(),
    endAt: z.string().datetime().optional(),
    workdir: z.string().min(1).optional(),
    contextFrom: z.string().min(1).optional(),
    citadelId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const cronJobUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: z.string().min(1).max(120).optional(),
    action: z
      .enum([
        "task",
        "improvement",
        "curator",
        "backup",
        "memory_flush",
        "memory_consolidation",
        "cost_report",
        "update_review",
        "watchdog",
        "no_agent",
        "agent_turn",
      ])
      .optional(),
    actionConfig: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
    description: z.string().max(2000).optional(),
    schedule: z.string().min(1).max(128).optional(),
    enabled: z.boolean().optional(),
    endAt: z.union([z.string().datetime(), z.null()]).optional(),
    workdir: z.union([z.string().min(1), z.null()]).optional(),
    contextFrom: z.union([z.string().min(1), z.null()]).optional(),
    citadelId: z.union([z.string().trim().min(1).max(200), z.null()]).optional(),
  })
  .strict();
