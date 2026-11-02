import { isApiRequestError } from "./http-internal.js";

/** A change GoatCitadel refused because a plugin owns what it would change, in GoatCitadel's own words. */
export interface PluginOwnedRefusal {
  /** The sentence GoatCitadel sent, such as "From Browser checks. Uninstall it to remove this." */
  message: string;
  /** The plugin that owns it, when GoatCitadel named one. */
  pluginId?: string;
}

/**
 * Reads a 409 `PLUGIN_OWNED` refusal: its sentence and the plugin it names. Any other error, a refusal without a
 * sentence included, reads as undefined, so the caller keeps its own wording for it.
 */
export function readPluginOwnedRefusal(error: unknown): PluginOwnedRefusal | undefined {
  if (!isApiRequestError(error) || error.status !== 409) return undefined;
  const body = error.body;
  if (typeof body !== "object" || body === null) return undefined;
  const { code, error: message, details } = body as { code?: unknown; error?: unknown; details?: unknown };
  if (code !== "PLUGIN_OWNED" || typeof message !== "string" || message.trim() === "") return undefined;
  const pluginId =
    typeof details === "object" && details !== null ? (details as { pluginId?: unknown }).pluginId : undefined;
  return { message: message.trim(), ...(typeof pluginId === "string" && pluginId ? { pluginId } : {}) };
}
