import { z } from "zod";

export const VerificationLaneSchema = z.enum(["fast", "deep-core", "deep-ecosystem", "soak", "review", "all"]);

export type VerificationLane = z.infer<typeof VerificationLaneSchema>;

export const VerificationScenarioStatusSchema = z.enum(["passed", "failed", "skipped", "not_configured", "degraded"]);

export type VerificationScenarioStatus = z.infer<typeof VerificationScenarioStatusSchema>;

export const VerificationFailureFamilySchema = z.enum([
  "provider_auth",
  "provider_outage",
  "client_render",
  "sse",
  "backup_runtime",
  "route_compatibility",
  "refresh_storm",
  "orchestration_route_mismatch",
  "install_failure",
  "addon_readiness",
  "voice_runtime_failure",
  "visual_perf_regression",
  "environment",
  "unknown",
]);

export type VerificationFailureFamily = z.infer<typeof VerificationFailureFamilySchema>;

export const VerificationSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);

export type VerificationSeverity = z.infer<typeof VerificationSeveritySchema>;

export const VerificationArtifactPointersSchema = z.object({
  diagnostics: z.array(z.string()).default([]),
  screenshots: z.array(z.string()).default([]),
  traces: z.array(z.string()).default([]),
  logs: z.array(z.string()).default([]),
  perf: z.array(z.string()).default([]),
  playwright: z.array(z.string()).default([]),
});

export type VerificationArtifactPointers = z.infer<typeof VerificationArtifactPointersSchema>;

export const VerificationScenarioResultSchema = z.object({
  id: z.string().min(1),
  lane: VerificationLaneSchema,
  title: z.string().min(1),
  subsystem: z.string().min(1),
  status: VerificationScenarioStatusSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  correlationId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  notes: z.array(z.string()).default([]),
  error: z.string().optional(),
  metrics: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  artifacts: VerificationArtifactPointersSchema.default({
    diagnostics: [],
    screenshots: [],
    traces: [],
    logs: [],
    perf: [],
    playwright: [],
  }),
});

export type VerificationScenarioResult = z.infer<typeof VerificationScenarioResultSchema>;

export const VerificationRunManifestSchema = z.object({
  runId: z.string().min(1),
  lane: VerificationLaneSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  status: z.enum(["running", "passed", "failed", "degraded"]).default("running"),
  repoRoot: z.string().min(1),
  artifactRoot: z.string().min(1),
  scenarios: z.array(VerificationScenarioResultSchema).default([]),
  counts: z
    .object({
      passed: z.number().int().nonnegative().default(0),
      failed: z.number().int().nonnegative().default(0),
      skipped: z.number().int().nonnegative().default(0),
      degraded: z.number().int().nonnegative().default(0),
      notConfigured: z.number().int().nonnegative().default(0),
    })
    .default({
      passed: 0,
      failed: 0,
      skipped: 0,
      degraded: 0,
      notConfigured: 0,
    }),
  metadata: z.record(z.unknown()).default({}),
});

export type VerificationRunManifest = z.infer<typeof VerificationRunManifestSchema>;

export const VerificationReviewItemSchema = z.object({
  scenarioId: z.string().min(1),
  title: z.string().min(1),
  subsystem: z.string().min(1),
  severity: VerificationSeveritySchema,
  family: VerificationFailureFamilySchema,
  summary: z.string().min(1),
  likelySurfaces: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
  checklist: z.array(z.string()).default([]),
});

export type VerificationReviewItem = z.infer<typeof VerificationReviewItemSchema>;

export const VerificationReviewSchema = z.object({
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  status: z.enum(["ok", "issues_found"]).default("ok"),
  items: z.array(VerificationReviewItemSchema).default([]),
  summary: z
    .object({
      totalFailures: z.number().int().nonnegative().default(0),
      critical: z.number().int().nonnegative().default(0),
      high: z.number().int().nonnegative().default(0),
      medium: z.number().int().nonnegative().default(0),
      low: z.number().int().nonnegative().default(0),
    })
    .default({
      totalFailures: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    }),
});

export type VerificationReview = z.infer<typeof VerificationReviewSchema>;

export const VerificationRepairPlanSchema = z.object({
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  mode: z.enum(["deterministic", "ai_assisted"]).default("deterministic"),
  summary: z.string().min(1),
  priorities: z.array(z.string()).default([]),
  recommendedReruns: z.array(z.string()).default([]),
  rawModelOutput: z.string().optional(),
});

export type VerificationRepairPlan = z.infer<typeof VerificationRepairPlanSchema>;

export const VerificationProviderReadinessSchema = z.object({
  providerId: z.string().min(1),
  label: z.string().min(1),
  hasSecret: z.boolean(),
  source: z.enum(["none", "keychain", "env", "inline"]),
  active: z.boolean().default(false),
  defaultModel: z.string().min(1),
});

export type VerificationProviderReadiness = z.infer<typeof VerificationProviderReadinessSchema>;

export const VerificationStatusResponseSchema = z.object({
  diagnosticsEnabled: z.boolean(),
  rootDir: z.string().min(1),
  activeProviderId: z.string().min(1).optional(),
  activeModel: z.string().min(1).optional(),
  providers: z.array(VerificationProviderReadinessSchema),
  latestDiagnosticsCount: z.number().int().nonnegative(),
});

export type VerificationStatusResponse = z.infer<typeof VerificationStatusResponseSchema>;
