import { validateRunVariableBindings, type RunVariableBindings, type RunVariableSchema } from "@goatcitadel/contracts";

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function buildPromptLabRunVariableSessionKey(packId: string, testId: string): string {
  return `goatcitadel.prompt-lab.run-variables.v1.${packId}.${testId}`;
}

export function loadPromptLabRunVariableSession(
  storage: SessionStorageLike,
  key: string,
  schema?: RunVariableSchema,
): { bindings: RunVariableBindings; placeholders: Record<string, string> } {
  let stored: { bindings?: Record<string, unknown>; placeholders?: Record<string, string> } = {};
  try {
    const raw = storage.getItem(key);
    stored = raw ? (JSON.parse(raw) as typeof stored) : {};
  } catch {
    stored = {};
  }
  let bindings: RunVariableBindings = {};
  if (schema) {
    try {
      bindings = validateRunVariableBindings(schema, stored.bindings ?? {}, {
        allowMissingRequired: true,
      }).bindings;
    } catch {
      bindings = validateRunVariableBindings(schema, {}, { allowMissingRequired: true }).bindings;
    }
  }
  return {
    bindings,
    placeholders: stored.placeholders && typeof stored.placeholders === "object" ? stored.placeholders : {},
  };
}

export function savePromptLabRunVariableSession(
  storage: SessionStorageLike,
  key: string,
  value: { bindings: RunVariableBindings; placeholders: Record<string, string> },
): void {
  storage.setItem(key, JSON.stringify(value));
}
