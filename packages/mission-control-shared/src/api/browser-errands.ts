import { request } from "./client-core.js";
import { isApiRequestError } from "./http-internal.js";

export type BrowserErrandState = "running" | "waiting_on_you" | "taken_over" | "finished";
export type BrowserErrandOutcome =
  | "done"
  | "stopped"
  | "declined"
  | "expired"
  | "failed"
  | "step_limit"
  | "time_limit"
  | "window_closed";

/** The Gateway's live view of one browser errand, keyed by the chat tool run that started it. */
export interface BrowserErrandStatus {
  errandId: string;
  toolRunId: string;
  state: BrowserErrandState;
  stepCount: number;
  stepText: string;
  thumbnailAttachmentId?: string;
  finalAttachmentId?: string;
  modelRequests: number;
  outcome?: BrowserErrandOutcome;
  summary?: string;
}

/**
 * The errand's status, or null when the Gateway holds none for this tool run (404), for instance after a Gateway
 * restart. Callers fall back to the tool run's own result.
 */
export async function fetchBrowserErrandStatus(
  toolRunId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BrowserErrandStatus | null> {
  try {
    return await request<BrowserErrandStatus>(
      `/api/v1/browser-errands/by-tool-run/${encodeURIComponent(toolRunId)}`,
      options.signal ? { cache: "no-store", signal: options.signal } : { cache: "no-store" },
    );
  } catch (error) {
    if (isApiRequestError(error) && error.kind === "http" && error.status === 404) return null;
    throw error;
  }
}

export function stopBrowserErrand(errandId: string): Promise<{ stopped: boolean }> {
  return request<{ stopped: boolean }>(`/api/v1/browser-errands/${encodeURIComponent(errandId)}/stop`, {
    method: "POST",
  });
}
