import {
  normalizeRunVariableSchema,
  RUN_VARIABLE_SCHEMA_VERSION,
  type RunVariableSchema,
} from "@goatcitadel/contracts";

const VARIABLES_FENCE = /```goatcitadel-variables\s*\r?\n([\s\S]*?)\r?\n```/giu;

export function parsePromptPackRunVariableSchema(content: string): RunVariableSchema | undefined {
  const matches = [...content.matchAll(VARIABLES_FENCE)];
  if (matches.length > 1) throw new TypeError("Prompt packs may contain only one goatcitadel-variables fence.");
  const raw = matches[0]?.[1];
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`Invalid goatcitadel-variables JSON: ${(error as Error).message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object") throw new TypeError("goatcitadel-variables must contain a JSON object.");
  const candidate = parsed as Partial<RunVariableSchema>;
  return normalizeRunVariableSchema({
    version: candidate.version ?? RUN_VARIABLE_SCHEMA_VERSION,
    fields: candidate.fields as RunVariableSchema["fields"],
  });
}

export function renderPromptPackRunVariableSchema(schema: RunVariableSchema): string[] {
  const normalized = normalizeRunVariableSchema(schema);
  return ["```goatcitadel-variables", JSON.stringify(normalized, null, 2), "```"];
}
