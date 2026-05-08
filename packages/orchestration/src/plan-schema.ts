import { z } from "zod";

export const phaseSchema = z.object({
  phaseId: z.string().min(1),
  ownerAgentId: z.string().min(1),
  specPath: z.string().min(1),
  loopMode: z.enum(["fresh-context", "compaction"]),
  requiresApproval: z.boolean(),
});

export const waveSchema = z.object({
  waveId: z.string().min(1),
  verify: z.array(z.string().min(1)).default([]),
  budgetUsd: z.number().nonnegative(),
  ownership: z.array(
    z.object({
      agentId: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
  ),
  phases: z.array(phaseSchema).min(1),
});

export const planSchema = z
  .object({
    planId: z.string().min(1),
    goal: z.string().min(1),
    mode: z.enum(["auto", "hitl"]),
    maxIterations: z.number().int().positive(),
    maxRuntimeMinutes: z.number().int().positive(),
    maxCostUsd: z.number().positive(),
    waves: z.array(waveSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const waveIds = new Set<string>();
    const phaseIds = new Set<string>();

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
        }
      });
    });
  });

export type ParsedPlan = z.infer<typeof planSchema>;

export function validatePlan(input: unknown): ParsedPlan {
  return planSchema.parse(input);
}
