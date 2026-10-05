import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import { HEALTH_TONE_BG, STREAM_STATUS } from "./stream-status";
import { useHealthDigestStatus } from "./use-health-digest";

/**
 * Phones have no sidebar (NV-13), so the system and live-update dots sit in one 20 px row above the
 * tab bar. Each dot carries a title and screen-reader text; colour is never the only signal.
 */
export function MobileStatusStrip({
  workspaceId,
  streamState,
}: {
  workspaceId: string;
  streamState: EventStreamConnectionState;
}) {
  const health = useHealthDigestStatus(workspaceId, true);
  const stream = STREAM_STATUS[streamState];
  return (
    <div aria-label="System status" role="group" className="flex h-5 items-center justify-end gap-3 px-3">
      <span title={health.title} data-health-tone={health.tone} className="inline-flex items-center">
        <span aria-hidden="true" className={`size-2 rounded-full ${HEALTH_TONE_BG[health.tone]}`} />
        <span className="sr-only">{health.label}</span>
      </span>
      <span title={stream.label} data-stream-state={streamState} className="inline-flex items-center">
        <span aria-hidden="true" className={`size-2 rounded-full ${stream.tone}`} />
        <span className="sr-only">{stream.label}</span>
      </span>
    </div>
  );
}
