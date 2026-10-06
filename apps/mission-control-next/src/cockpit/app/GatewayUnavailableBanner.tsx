import { Button } from "../ui/Button";
import { currentGatewayHost, gatewayStartHint } from "./gateway-host-hint";
import type { GatewayReachability } from "./use-gateway-reachability";

function checkResult(reachability: GatewayReachability): string {
  if (reachability.checking) return "Checking…";
  if (reachability.lastCheckedAt)
    return `Still unreachable · checked ${new Date(reachability.lastCheckedAt).toLocaleTimeString()}`;
  return "";
}

/**
 * Persistent outage notice. Only Chat sends, so only Chat claims that sending is paused. The check
 * result is a separate status line, so a recheck is announced without raising the alert again.
 */
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
      data-gateway-banner=""
      className="flex flex-wrap items-start justify-between gap-2 border-b border-status-failed bg-sunken px-4 py-3 text-sm text-fg-secondary"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium text-status-failed">
          {inChat
            ? "Gateway unavailable. Sending is paused; your draft is preserved."
            : "Gateway unavailable. What you see here may be out of date."}{" "}
          {lastConfirmed}
        </p>
        <p>{gatewayStartHint(currentGatewayHost())}</p>
        <p role="status" className="text-xs text-fg-muted">
          {checkResult(reachability)}
        </p>
      </div>
      {reachability.retry ? (
        <Button size="sm" disabled={reachability.checking} onClick={reachability.retry}>
          Check again
        </Button>
      ) : null}
    </div>
  );
}
