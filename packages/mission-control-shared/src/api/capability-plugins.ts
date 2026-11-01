import type {
  CapabilityPluginDetail,
  CapabilityPluginInspection,
  CapabilityPluginInspectionRequest,
  CapabilityPluginInstallRequest,
  CapabilityPluginListResponse,
  CapabilityPluginUninstallRequest,
  PluginActionOutcome,
} from "@goatcitadel/contracts";
import { request, type GatewayRequestInit } from "./client-core.js";

/**
 * One press of a plugin action. `attemptKey` (a UUID) is the request's Idempotency-Key, which the route replays by:
 * the caller keeps one per press and sends it again only to retry a request whose answer never came, so the retry gets
 * the first answer. Without it, every call is a new attempt with a fresh key.
 */
export interface CapabilityPluginActionOptions {
  attemptKey?: string;
}

/**
 * The installed plugins (install-wide) and the built-in ones, with whether the operator's skip applies and whether a
 * folder can be added. The Gateway builds every row and state; the cockpit only renders it. The route requires the
 * workspace though the list doesn't depend on it.
 */
export async function fetchCapabilityPlugins(
  workspaceId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CapabilityPluginListResponse> {
  const query = new URLSearchParams({ workspaceId });
  return request<CapabilityPluginListResponse>(`/api/v1/capabilities/plugins?${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** One installed plugin and each of its pieces. A plugin that isn't installed is a 404. */
export async function fetchCapabilityPluginDetail(
  workspaceId: string,
  pluginId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CapabilityPluginDetail> {
  const query = new URLSearchParams({ pluginId, workspaceId });
  return request<CapabilityPluginDetail>(`/api/v1/capabilities/plugins/detail?${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * A kept inspection, read back by its id (a refused manifest's too). The route takes no query at all, so none is sent.
 * One that is gone or ran out of time is a 404.
 */
export async function fetchCapabilityPluginInspection(
  inspectionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CapabilityPluginInspection> {
  return request<CapabilityPluginInspection>(
    `/api/v1/capabilities/plugins/inspections/${encodeURIComponent(inspectionId)}`,
    { cache: "no-store", ...(options.signal ? { signal: options.signal } : {}) },
  );
}

/**
 * Fetches a source and checks every piece (201). It installs nothing. A source that can't be fetched, or a refused
 * manifest, is an error whose body is the Gateway's `CapabilityPluginRefusal`.
 */
export async function inspectCapabilityPlugin(
  input: CapabilityPluginInspectionRequest,
  options: CapabilityPluginActionOptions = {},
): Promise<CapabilityPluginInspection> {
  return request<CapabilityPluginInspection>("/api/v1/capabilities/plugins/inspections", mutation(input, options));
}

/**
 * Installs an inspection's pieces through one Change Plan (202). No field chooses the operator's skip; the Gateway
 * decides it. `hookSecrets` holds one signing secret per hook piece and is sent only in this request.
 */
export async function installCapabilityPlugin(
  input: CapabilityPluginInstallRequest,
  options: CapabilityPluginActionOptions = {},
): Promise<PluginActionOutcome> {
  return request<PluginActionOutcome>("/api/v1/capabilities/plugins/install", mutation(input, options));
}

/**
 * Removes exactly what a plugin added through one Change Plan (202), from the workspace it was installed in. No field
 * chooses the operator's skip; the Gateway decides it.
 */
export async function uninstallCapabilityPlugin(
  input: CapabilityPluginUninstallRequest,
  options: CapabilityPluginActionOptions = {},
): Promise<PluginActionOutcome> {
  return request<PluginActionOutcome>("/api/v1/capabilities/plugins/uninstall", mutation(input, options));
}

/** A JSON POST; the client adds the Idempotency-Key, the caller's `attemptKey` when given. */
function mutation(body: unknown, options: CapabilityPluginActionOptions): GatewayRequestInit {
  return {
    method: "POST",
    body: JSON.stringify(body),
    ...(options.attemptKey !== undefined ? { attemptKey: options.attemptKey } : {}),
  };
}
