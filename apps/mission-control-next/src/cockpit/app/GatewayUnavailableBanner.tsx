import { Button } from "../ui/Button";
import { GATEWAY_START_HINT, type GatewayReachability } from "./use-gateway-reachability";

/** Persistent outage notice. Only Chat sends, so only Chat claims that sending is paused. */
export function GatewayUnavailableBanner({
  reachability,
  inChat,
}: {
  reachability: GatewayReachability;
  inChat: boolean;
}) {
  const lastConfirmed = reachability.lastConfirmedAt
    ? `Last connection confirmed at ${new Date(reachability.lastConfirmedAt).toLocaleTimeString()}.`
    : "Reconnecting…";
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start justify-between gap-2 border-b border-status-failed bg-sunken px-4 py-3 text-sm text-fg-secondary"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium text-status-failed">
          {inChat
            ? "Gateway unavailable. Sending is paused; your draft is preserved."
            : "Gateway unavailable. What you see here may be out of date."}{" "}
          {lastConfirmed}
        </p>
        <p>{GATEWAY_START_HINT}</p>
      </div>
      {reachability.retry ? (
        <Button size="sm" onClick={reachability.retry}>
          Check again
        </Button>
      ) : null}
    </div>
  );
}
