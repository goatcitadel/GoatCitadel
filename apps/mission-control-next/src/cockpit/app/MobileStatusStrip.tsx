import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import { Activity, RotateCw } from "lucide-react";
import { HEALTH_TONE_ICON, presentCockpitStream } from "./stream-status";
import { useHealthDigestStatus } from "./use-health-digest";

const ROW = "flex min-h-11 items-center gap-3 rounded-md px-3 text-left";

/**
 * Phones have no sidebar (NV-13). SH-01/SH-22: system health and live updates sit at the top of the More sheet as
 * text lines with distinct icon shapes, so the bottom chrome stays the tab bar and status never rests on colour.
 */
export function MobileStatusStrip({
  workspaceId,
  streamState,
  replayRecovery = false,
  onOpenHealth,
}: {
  workspaceId: string;
  streamState: EventStreamConnectionState;
  replayRecovery?: boolean;
  onOpenHealth?: () => void;
}) {
  const health = useHealthDigestStatus(workspaceId, true, true);
  const stream = presentCockpitStream(streamState, replayRecovery);
  const { Icon: HealthIcon, text: healthText } = HEALTH_TONE_ICON[health.tone];
  const { Icon: StreamIcon, text: streamText } = stream;
  return (
    <div aria-label="System status" role="group" className="grid gap-1 border-b border-line-subtle pb-2">
      <div title={health.title} data-health-tone={health.tone} className={`${ROW} text-sm text-fg`}>
        <HealthIcon aria-hidden="true" className={`size-4 shrink-0 ${healthText}`} />
        <span className="min-w-0 flex-1">{health.label}</span>
        {health.phase === "unavailable" ? (
          <button
            type="button"
            aria-label="Retry system checks"
            onClick={health.retry}
            className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-fg-secondary hover:bg-sunken hover:text-fg"
          >
            <RotateCw aria-hidden="true" className="size-4" />
            Retry
          </button>
        ) : null}
      </div>
      <div
        role="group"
        title={stream.label}
        aria-label={stream.ariaLabel}
        data-stream-state={streamState}
        className={`${ROW} text-sm text-fg`}
      >
        <StreamIcon aria-hidden="true" className={`size-4 shrink-0 ${streamText}`} />
        <span className="min-w-0 flex-1">{stream.label}</span>
      </div>
      {onOpenHealth ? (
        <button type="button" onClick={onOpenHealth} className={`${ROW} text-fg hover:bg-sunken`}>
          <Activity aria-hidden="true" className="size-4" />
          Open System health
        </button>
      ) : null}
    </div>
  );
}
