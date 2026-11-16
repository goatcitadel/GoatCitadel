import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { Callout } from "../../ui/Callout";

/** The frame props that make the Cockpit own the chat frame: no Classic page header, loading shell or status line. */
export const CHAT_SHELL_FRAME = {
  lockSurface: true,
  hidePageHeader: true,
  renderWhileLoading: true,
  ownsFrameStatus: true,
} as const;

/**
 * The chat host's own error and refresh state, drawn with Cockpit parts. Neither is a live region: the error
 * is already in the page where the operator is working, and the refresh line is polled state.
 */
export function ChatHostStatus({ status }: { status?: MissionThreadedRenderSurfaceInput["hostStatus"] }) {
  if (!status?.error && !status?.refreshing) return null;
  return (
    <>
      {status.error ? (
        <div className="px-3 pt-2">
          <Callout tone="error" announce={false}>
            {status.error}
          </Callout>
        </div>
      ) : null}
      {status.refreshing ? <p className="px-3 py-1 text-xs text-fg-muted">Refreshing the conversation…</p> : null}
    </>
  );
}
