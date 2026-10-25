import { redactSecretText, type ToolInvokeRequest } from "@goatcitadel/contracts";
import { CHANGE_REQUEST_TOOL_NAME } from "./tool-registry.js";

/** More lines than a reviewer can check is not an exact preview, so the summary is withheld instead of cut. */
const MAX_SUMMARY_ENTRIES = 40;
const MAX_DEPTH = 6;
const SECRET_LOOKING_KEY = /secret|token|password|credential|api[-_]?key|private[-_]?key/i;
/**
 * Change Plan intents are secret-free by contract; these secret-sounding names hold lifecycle choices or
 * environment-variable names, which the operator must see to tell, say, `replace_oauth` from `remove_oauth`.
 */
const NON_SECRET_KEYS = new Set(["credentialAction", "credentialStorage", "credentialDeleteScope"]);
/** `credentialEnvVar`, `apiKeyEnv`, `botTokenEnv`: environment-variable names, never their values. */
const ENVIRONMENT_REFERENCE_KEY = /Env(Var)?$/;
const REDACTED = "[redacted]";

interface RequestSummaryEntry {
  label: string;
  value: string;
}

/**
 * Display-only review projection of a `change.request` intent: one labelled line per requested field.
 * The executor re-validates and runs the exact approved args, never this summary. When the intent is too
 * large or deep to list exactly, `requestSummary` is left out so the review stays unavailable.
 */
export function changeRequestApprovalPreview(request: ToolInvokeRequest): Record<string, unknown> | undefined {
  if (request.toolName !== CHANGE_REQUEST_TOOL_NAME) return undefined;
  const requestSummary = summarizeIntent(request.args.intent);
  return {
    reviewKind: CHANGE_REQUEST_TOOL_NAME,
    toolName: request.toolName,
    sessionId: request.sessionId,
    taskId: request.taskId,
    ...(requestSummary ? { requestSummary } : {}),
  };
}

function summarizeIntent(intent: unknown): RequestSummaryEntry[] | undefined {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return undefined;
  const entries: RequestSummaryEntry[] = [];
  const complete = collect(intent as Record<string, unknown>, [], entries, 0);
  return complete && entries.length > 0 ? entries : undefined;
}

function collect(
  record: Record<string, unknown>,
  path: string[],
  entries: RequestSummaryEntry[],
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) return false;
  for (const [key, value] of Object.entries(record)) {
    const keyPath = [...path, key];
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (!collect(value as Record<string, unknown>, keyPath, entries, depth + 1)) return false;
      continue;
    }
    const text = describeLeaf(value);
    if (text === undefined) return false;
    entries.push({ label: labelFor(keyPath), value: redactsByKey(key, value) ? REDACTED : text });
    if (entries.length > MAX_SUMMARY_ENTRIES) return false;
  }
  return true;
}

/** A secret-sounding key hides its value unless the value can't be a secret (a flag or count) or the key is known metadata. */
function redactsByKey(key: string, value: unknown): boolean {
  if (typeof value === "boolean" || typeof value === "number") return false;
  if (NON_SECRET_KEYS.has(key) || ENVIRONMENT_REFERENCE_KEY.test(key)) return false;
  return SECRET_LOOKING_KEY.test(key);
}

function describeLeaf(value: unknown): string | undefined {
  if (value === null) return "none";
  if (typeof value === "string") return value.length ? redactSecretText(value, { env: process.env }).value : "(empty)";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
      return undefined;
    return value.length ? value.map((item) => describeLeaf(item)).join(", ") : "(none)";
  }
  return undefined;
}

/** `["change", "operation"]` → "Change operation"; `["providerId"]` → "Provider id". */
function labelFor(path: string[]): string {
  const words = path
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
