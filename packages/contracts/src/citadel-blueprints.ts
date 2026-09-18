// Citadel Blueprints: portable, secrets-free, inspectable Citadel configuration.
// A Blueprint captures structure only (Charter + Chambers) — never credentials,
// tokens, private data, or identity (citadelId/chamberId/timestamps). See spec §8.

import { z } from "zod";
import type {
  ChamberSensitivity,
  Citadel,
  CitadelKind,
  CitadelModelPolicy,
  CitadelRiskPosture,
  CitadelStructureMutation,
  CitadelStructureSnapshot,
  CitadelTemplateTarget,
} from "./citadels.js";

export const CITADEL_BLUEPRINT_SCHEMA_VERSION = "goatcitadel.blueprint.v1";

export interface CitadelBlueprintChamber {
  name: string;
  sensitivity: ChamberSensitivity;
  sealed: boolean;
}

export interface CitadelBlueprintCharter {
  purpose: string;
  kind: CitadelKind;
  goals: string[];
  boundaries: string[];
  successDefinition: string[];
  riskPosture: CitadelRiskPosture;
  modelPolicyDefault: CitadelModelPolicy;
}

export interface CitadelBlueprint {
  schemaVersion: typeof CITADEL_BLUEPRINT_SCHEMA_VERSION;
  metadata: {
    name: string;
    description?: string;
    exportedAt?: string;
  };
  charter: CitadelBlueprintCharter;
  chambers: CitadelBlueprintChamber[];
  riskNotes: string[];
}

export interface CitadelBlueprintValidationResult {
  ok: boolean;
  errors: string[];
}

const blueprintText = z.string().refine((value) => value.trim().length > 0);
const blueprintSchema: z.ZodType<CitadelBlueprint> = z.object({
  schemaVersion: z.literal(CITADEL_BLUEPRINT_SCHEMA_VERSION),
  metadata: z.object({
    name: blueprintText,
    description: z.string().optional(),
    exportedAt: z.string().optional(),
  }).strict(),
  charter: z.object({
    purpose: blueprintText,
    kind: z.enum(["personal", "company", "project", "household", "client", "creator", "learning", "team", "custom"]),
    goals: z.array(blueprintText),
    boundaries: z.array(blueprintText),
    successDefinition: z.array(blueprintText),
    riskPosture: z.enum(["conservative", "balanced", "collaborative", "automation_forward"]),
    modelPolicyDefault: z.enum(["local_only", "hybrid_guarded", "approved_cloud", "hosted_team"]),
  }).strict(),
  chambers: z.array(z.object({
    name: blueprintText,
    sensitivity: z.enum(["public", "internal", "private", "sensitive", "restricted", "secret"]),
    sealed: z.boolean(),
  }).strict()),
  riskNotes: z.array(z.string()),
}).strict();

// Conservative secret-shaped patterns. The scan is a safety net, not a guarantee.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-z0-9-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\b\s*[:=]/i,
  /\bbearer\s+[a-z0-9._-]{12,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
];

export function exportCitadelBlueprint(
  citadel: Citadel,
  options?: { name?: string; description?: string; exportedAt?: string },
): CitadelBlueprint {
  return {
    schemaVersion: CITADEL_BLUEPRINT_SCHEMA_VERSION,
    metadata: {
      name: options?.name ?? citadel.charter.purpose,
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.exportedAt ? { exportedAt: options.exportedAt } : {}),
    },
    charter: {
      purpose: citadel.charter.purpose,
      kind: citadel.charter.kind,
      goals: citadel.charter.goals,
      boundaries: citadel.charter.boundaries,
      successDefinition: citadel.charter.successDefinition,
      riskPosture: citadel.charter.riskPosture,
      modelPolicyDefault: citadel.charter.modelPolicyDefault,
    },
    chambers: citadel.chambers.map((chamber) => ({
      name: chamber.name,
      sensitivity: chamber.sensitivity,
      sealed: chamber.sealed,
    })),
    riskNotes: ["This Blueprint contains structure only — no credentials, secrets, tokens, or private data."],
  };
}

export function validateCitadelBlueprint(value: unknown): CitadelBlueprintValidationResult {
  const result = blueprintSchema.safeParse(value);
  // Schema issue messages can echo invalid enum values or unknown key names.
  // Report only schema-owned paths, never caller-provided values or keys.
  const errors: string[] = result.success ? [] : result.error.issues.slice(0, 20).map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "root";
    return issue.code === "unrecognized_keys"
      ? `Blueprint ${field} contains unsupported fields.`
      : `Blueprint ${field} is missing or invalid.`;
  });

  const serialized = safeStringify(value);
  if (serialized === undefined) {
    errors.push("Blueprint must be serializable as JSON.");
  } else if (SECRET_PATTERNS.some((pattern) => pattern.test(serialized))) {
    errors.push("Blueprint appears to contain a secret-like value; Blueprints must never include secrets.");
  }

  return { ok: errors.length === 0, errors: errors.slice(0, 20) };
}

/** Translate a validated Blueprint into one reviewed persistence command. */
export function createCitadelBlueprintMutation(citadelId: string, expectedRevision: string, blueprint: CitadelBlueprint): CitadelStructureMutation {
  return { citadelId, expectedRevision, change: {
    type: "setup",
    charter: { ...blueprint.charter },
    chambers: blueprint.chambers.map((chamber) => ({ ...chamber })),
  } };
}

export function applyCitadelBlueprint(
  target: CitadelTemplateTarget,
  citadelId: string,
  blueprint: CitadelBlueprint,
  expectedRevision: string,
): CitadelStructureSnapshot {
  return target.mutateStructure(createCitadelBlueprintMutation(citadelId, expectedRevision, blueprint));
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
