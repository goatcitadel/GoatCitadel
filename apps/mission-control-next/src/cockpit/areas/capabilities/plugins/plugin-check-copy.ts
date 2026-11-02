import { CAPABILITY_PLUGIN_REFUSED_CODE, type PluginManifestRefusalCode } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { CANT_BE_INSTALLED } from "../skills/skill-check-copy";

export { CANT_BE_INSTALLED };

// Why a plugin can't be checked or installed, in plain words. The codes come from the Gateway and appear on screen only
// inside Technical details; nothing here decides whether a manifest or a plugin passes.

/** One plain sentence for each code a refused manifest can carry (contracts' `PLUGIN_MANIFEST_REFUSAL_CODES`). */
export const PLUGIN_REFUSAL_COPY: Readonly<Record<PluginManifestRefusalCode, string>> = {
  FEATURE_FLAGS_NOT_ALLOWED: "Plugins can't change GoatCitadel's feature settings.",
  CHAT_INSTRUCTIONS_NOT_ALLOWED: "Plugins can only add instructions as skills, which GoatCitadel checks.",
  HOOK_MUST_ONLY_OBSERVE: "Its hooks try to change what happens, but plugin hooks can only watch.",
  HOOK_CODE_NOT_ALLOWED: "Its hooks would run code, which plugins can't.",
  PRESET_MUST_TIGHTEN: "It tries to loosen a safety rule, but plugins can only tighten them.",
  UNKNOWN_PIECE_KIND: "It includes a kind of piece GoatCitadel doesn't support.",
  PIECE_PATH_INVALID: "One of its file paths points outside the plugin.",
  // The files' names stay: they are what the plugin's author has to add.
  MANIFEST_MISSING: "There's no goatcitadel-plugin.json or .claude-plugin/plugin.json at its top level.",
  MANIFEST_TOO_LARGE: "Its goatcitadel-plugin.json is too large for GoatCitadel to read.",
  DUPLICATE_PIECE_ID: "Two of its pieces have the same id.",
  MANIFEST_INVALID: "Its goatcitadel-plugin.json isn't one GoatCitadel can read.",
  CLAUDE_CODE_MANIFEST_INVALID: "Its .claude-plugin/plugin.json isn't one GoatCitadel can read.",
  NOTHING_TO_INSTALL: "GoatCitadel can't use any of its parts.",
  TOO_MANY_PIECES: "It has more parts GoatCitadel could take than one plugin can hold.",
};

/**
 * The lines of a refused manifest: its code's own sentence (or, for a code without one, `fallback`, the refusal's own
 * plain sentence), then the line that says it can't be installed. An inspection holds one refusal, so one line.
 */
export function manifestRefusalLines(code: string, fallback: string): string[] {
  const line = Object.hasOwn(PLUGIN_REFUSAL_COPY, code)
    ? PLUGIN_REFUSAL_COPY[code as PluginManifestRefusalCode]
    : fallback;
  return [line, CANT_BE_INSTALLED];
}

/** The route's own plain line for a refusal, read first; a plain summary when it has none, or never answered. */
export function refusalMessage(error: unknown): string {
  if (isApiRequestError(error) && typeof error.body === "object" && error.body !== null) {
    const message = (error.body as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return describeApiError(error).summary;
}

/** Why a plugin check was refused: the source's or the manifest's code, and the inspection a refused manifest kept. */
export interface PluginRefusal {
  code: string;
  inspectionId?: string;
  field?: string;
}

/** The plugin check's own refusal in an error, or undefined for any other error. */
export function pluginRefusalOf(error: unknown): PluginRefusal | undefined {
  if (!isApiRequestError(error) || typeof error.body !== "object" || error.body === null) return undefined;
  const body = error.body as { code?: unknown; details?: { code?: unknown; inspectionId?: unknown; field?: unknown } };
  if (body.code !== CAPABILITY_PLUGIN_REFUSED_CODE || typeof body.details?.code !== "string") return undefined;
  const { code, inspectionId, field } = body.details;
  return {
    code,
    ...(typeof inspectionId === "string" && inspectionId ? { inspectionId } : {}),
    ...(typeof field === "string" && field ? { field } : {}),
  };
}

/** Whether a request was answered at all: one that never was may be sent again with its own attempt key. */
export function wasAnswered(error: unknown): boolean {
  return isApiRequestError(error) && error.kind === "http";
}
