import path from "node:path";
import { createHash } from "node:crypto";
import { legacyPlaceholderSchema, normalizeRunVariableSchema } from "@goatcitadel/contracts";
import {
  extractPromptPlaceholders,
  extractPromptPackVersionLabel,
  parsePromptPackTests,
  validatePromptPackStructure,
} from "./parser.js";
import { parsePromptPackRunVariableSchema } from "./run-variable-markdown.js";

export interface PromptPackImportSource {
  content: string;
  name?: string;
  sourceLabel?: string;
  packId?: string;
}

/** Pure preparation shared by ordinary imports and the guarded bundled-definition owner. */
export function preparePromptPackImport(input: PromptPackImportSource) {
  const tests = parsePromptPackTests(input.content);
  if (tests.length === 0) throw new Error("No tests found in prompt-pack markdown.");
  const issues = validatePromptPackStructure(input.content, tests);
  if (issues.length) throw new Error(`Prompt pack structure validation failed: ${issues.join("; ")}`);
  const versionLabel = extractPromptPackVersionLabel(input.content);
  const declaredSchema = parsePromptPackRunVariableSchema(input.content);
  const placeholders = [...new Set(tests.flatMap((test) => extractPromptPlaceholders(test.prompt)))];
  const schema = declaredSchema ?? (placeholders.length ? legacyPlaceholderSchema(placeholders) : undefined);
  return {
    hasDeclaredSchema: Boolean(declaredSchema),
    write: {
      packId: input.packId,
      name: input.name?.trim() || versionLabel || inferPromptPackName(input.sourceLabel),
      sourceLabel: input.sourceLabel?.trim() || versionLabel,
      contentSha256: createHash("sha256").update(input.content, "utf8").digest("hex"),
      tests,
      runVariableSchema: schema ? normalizeRunVariableSchema(schema) : undefined,
    },
  };
}

function inferPromptPackName(sourceLabel?: string): string {
  if (!sourceLabel) return "GoatCitadel Prompt Pack";
  const base = path.basename(sourceLabel).replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[_-]+/g, " ").trim();
  return cleaned
    ? cleaned
        .split(/[-_.]/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
    : "GoatCitadel Prompt Pack";
}
