import { describe, expect, it } from "vitest";
import { RUN_VARIABLE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import {
  buildPromptLabRunVariableSessionKey,
  loadPromptLabRunVariableSession,
  savePromptLabRunVariableSession,
} from "./prompt-run-variable-session";

describe("Prompt Lab run-variable session storage", () => {
  it("keeps entered bindings session-local and validates them on restore", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const key = buildPromptLabRunVariableSessionKey("pack-1", "test-1");
    savePromptLabRunVariableSession(storage, key, {
      bindings: { count: 3, topic: "leases" },
      placeholders: { legacy: "value" },
    });
    expect(
      loadPromptLabRunVariableSession(storage, key, {
        version: RUN_VARIABLE_SCHEMA_VERSION,
        fields: [
          { id: "topic", label: "Topic", type: "text", required: true },
          { id: "count", label: "Count", type: "number", minimum: 1, maximum: 5 },
        ],
      }),
    ).toEqual({ bindings: { topic: "leases", count: 3 }, placeholders: { legacy: "value" } });
  });

  it("drops corrupt or stale bindings instead of silently executing them", () => {
    const storage = {
      getItem: () => JSON.stringify({ bindings: { count: 99 } }),
      setItem: () => undefined,
    };
    expect(
      loadPromptLabRunVariableSession(storage, "key", {
        version: RUN_VARIABLE_SCHEMA_VERSION,
        fields: [{ id: "count", label: "Count", type: "number", maximum: 5, default: 2 }],
      }).bindings,
    ).toEqual({ count: 2 });
  });
});
