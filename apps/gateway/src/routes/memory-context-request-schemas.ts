import { z } from "zod";

export const composeSchema = z.object({
  scope: z.enum(["chat", "orchestration"]),
  prompt: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  phaseId: z.string().min(1).optional(),
  citadelId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  workspace: z.string().min(1).optional(),
  relationScope: z.enum(["self", "peer", "project"]).optional(),
  maxContextTokens: z.number().int().positive().optional(),
  forceRefresh: z.boolean().optional(),
  queryEmbedding: z.array(z.number()).min(1).max(4096).optional(),
});

export const statsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(60),
});

export const retrievalBenchmarkSchema = z.object({
  prompts: z.array(z.string().trim().min(1)).min(1).max(25),
  labels: z
    .array(
      z
        .object({
          prompt: z.string().trim().min(1).max(8192),
          relevantSources: z
            .array(
              z
                .object({
                  sourceType: z.enum(["transcript", "file", "memory_item"]),
                  sourceRef: z.string().min(1).max(1024),
                })
                .strict(),
            )
            .max(100),
          forbiddenSources: z
            .array(
              z
                .object({
                  sourceType: z.enum(["transcript", "file", "memory_item"]),
                  sourceRef: z.string().min(1).max(1024),
                })
                .strict(),
            )
            .max(100)
            .optional(),
          expectNoResults: z.boolean().optional(),
        })
        .strict(),
    )
    .max(25)
    .optional(),
  workspace: z.string().trim().min(1).optional(),
  relationScope: z.enum(["self", "peer", "project"]).optional(),
  maxContextTokens: z.number().int().positive().optional(),
});
