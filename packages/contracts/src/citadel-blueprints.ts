// Citadel Blueprints: portable, secrets-free, inspectable Citadel configuration.
// A Blueprint captures structure only (Charter + Chambers) — never credentials,
// tokens, private data, or identity (citadelId/chamberId/timestamps). See spec §8.

import type {
  ChamberSensitivity,
  Citadel,
  CitadelKind,
  CitadelModelPolicy,
  CitadelRiskPosture,
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

// Conservative secret-shaped patterns. The scan is a safety net, not a guarantee.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-z0-9]{8,}/i,
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
  const errors: string[] = [];
  if (!value || typeof value !== "object") {
    return { ok: false, errors: ["Blueprint must be an object."] };
  }
  const blueprint = value as Partial<CitadelBlueprint>;
  if (blueprint.schemaVersion !== CITADEL_BLUEPRINT_SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion (expected ${CITADEL_BLUEPRINT_SCHEMA_VERSION}).`);
  }
  if (
    !blueprint.charter ||
    typeof blueprint.charter !== "object" ||
    typeof (blueprint.charter as { purpose?: unknown }).purpose !== "string" ||
    ((blueprint.charter as { purpose: string }).purpose ?? "").trim().length === 0
  ) {
    errors.push("Blueprint charter.purpose is required.");
  }
  if (!Array.isArray(blueprint.chambers)) {
    errors.push("Blueprint chambers must be an array.");
  }

  const serialized = safeStringify(value);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(serialized))) {
    errors.push("Blueprint appears to contain a secret-like value; Blueprints must never include secrets.");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Import a (validated) Blueprint into a Citadel: upsert the Charter and create the
 * Chambers through an injected persistence target, then return the assembled Citadel.
 */
export function applyCitadelBlueprint(
  target: CitadelTemplateTarget,
  citadelId: string,
  blueprint: CitadelBlueprint,
): Citadel {
  target.upsertCharter({
    citadelId,
    purpose: blueprint.charter.purpose,
    kind: blueprint.charter.kind,
    goals: blueprint.charter.goals,
    boundaries: blueprint.charter.boundaries,
    successDefinition: blueprint.charter.successDefinition,
    riskPosture: blueprint.charter.riskPosture,
    modelPolicyDefault: blueprint.charter.modelPolicyDefault,
  });
  for (const chamber of blueprint.chambers) {
    target.createChamber({
      citadelId,
      name: chamber.name,
      sensitivity: chamber.sensitivity,
      sealed: chamber.sealed,
    });
  }
  const citadel = target.getCitadel(citadelId);
  if (!citadel) {
    throw new Error(`Failed to import Blueprint into citadel ${citadelId}`);
  }
  return citadel;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
