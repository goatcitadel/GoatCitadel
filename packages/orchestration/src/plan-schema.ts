import { z } from "zod";

const ID_MAX_LENGTH = 256;
const TEXT_MAX_LENGTH = 2048;
const PATH_MAX_LENGTH = 2048;
const MAX_PLAN_ITERATIONS = 1000;
const MAX_PLAN_RUNTIME_MINUTES = 60 * 24 * 30;
const MAX_PLAN_COST_USD = 10000;

const idSchema = z.string().trim().min(1).max(ID_MAX_LENGTH);
const boundedTextSchema = z.string().trim().min(1).max(TEXT_MAX_LENGTH);
const boundedPathSchema = z.string().trim().min(1).max(PATH_MAX_LENGTH);
const boundedBudgetSchema = z.number().finite().nonnegative().max(MAX_PLAN_COST_USD);

export const phaseSchema = z.object({
  phaseId: idSchema,
  ownerAgentId: idSchema,
  specPath: boundedPathSchema,
  loopMode: z.enum(["fresh-context", "compaction"]),
  requiresApproval: z.boolean(),
});

export const waveSchema = z.object({
  waveId: idSchema,
  verify: z.array(idSchema).default([]),
  budgetUsd: boundedBudgetSchema,
  ownership: z.array(
    z.object({
      agentId: idSchema,
      paths: z.array(boundedPathSchema).min(1),
    }),
  ),
  phases: z.array(phaseSchema).min(1),
});

export const planSchema = z
  .object({
    planId: idSchema,
    goal: boundedTextSchema,
    mode: z.enum(["auto", "hitl"]),
    maxIterations: z.number().int().positive().finite().max(MAX_PLAN_ITERATIONS),
    maxRuntimeMinutes: z.number().int().positive().finite().max(MAX_PLAN_RUNTIME_MINUTES),
    maxCostUsd: z.number().positive().finite().max(MAX_PLAN_COST_USD),
    waves: z.array(waveSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const waveIds = new Set<string>();
    const phaseIds = new Set<string>();
    const phaseWaveIndexes = new Map<string, number>();

    plan.waves.forEach((wave, waveIndex) => {
      if (waveIds.has(wave.waveId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["waves", waveIndex, "waveId"],
          message: `Duplicate waveId ${wave.waveId}.`,
        });
      }
      waveIds.add(wave.waveId);

      const ownerIds = new Set<string>();
      wave.ownership.forEach((owner, ownerIndex) => {
        if (ownerIds.has(owner.agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["waves", waveIndex, "ownership", ownerIndex, "agentId"],
            message: `Duplicate owner agentId ${owner.agentId} in wave ${wave.waveId}.`,
          });
        }
        ownerIds.add(owner.agentId);
      });

      wave.phases.forEach((phase, phaseIndex) => {
        if (phaseIds.has(phase.phaseId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["waves", waveIndex, "phases", phaseIndex, "phaseId"],
            message: `Duplicate phaseId ${phase.phaseId}.`,
          });
        }
        phaseIds.add(phase.phaseId);
        phaseWaveIndexes.set(phase.phaseId, waveIndex);

        if (!ownerIds.has(phase.ownerAgentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["waves", waveIndex, "phases", phaseIndex, "ownerAgentId"],
            message: `Phase owner ${phase.ownerAgentId} is not declared in wave ${wave.waveId} ownership.`,
          });
        }
      });
    });

    plan.waves.forEach((wave, waveIndex) => {
      wave.verify.forEach((verifyPhaseId, verifyIndex) => {
        if (!phaseIds.has(verifyPhaseId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["waves", waveIndex, "verify", verifyIndex],
            message: `verify entry ${verifyPhaseId} does not reference any declared phaseId.`,
          });
          return;
        }
        const referencedWaveIndex = phaseWaveIndexes.get(verifyPhaseId);
        if (referencedWaveIndex === undefined || referencedWaveIndex >= waveIndex) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["waves", waveIndex, "verify", verifyIndex],
            message: `verify entry ${verifyPhaseId} must reference a phase from a preceding wave.`,
          });
        }
      });
    });
  });

export type ParsedPlan = z.infer<typeof planSchema>;

export function validatePlan(input: unknown): ParsedPlan {
  return planSchema.parse(input);
}
