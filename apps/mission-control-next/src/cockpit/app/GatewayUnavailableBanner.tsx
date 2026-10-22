import { formatClockTime } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../ui/Button";
import { currentGatewayHost, gatewayStartHint } from "./gateway-host-hint";
import type { GatewayReachability } from "./use-gateway-reachability";

function checkResult(reachability: GatewayReachability): string {
  if (reachability.checking) return "Checking…";
  if (reachability.lastCheckedAt) return `Still unreachable · checked ${formatClockTime(reachability.lastCheckedAt)}`;
  return "";
}

/**
 * Persistent outage notice. Only Chat sends, so only Chat claims that sending is paused. Only the outage sentence
 * is an alert, so it is announced once; the last-confirmed time and the recheck result change over time and sit
 * outside it (the recheck result in its own status line).
 */
export function GatewayUnavailableBanner({
  reachability,
  inChat,
}: {
  reachability: GatewayReachability;
  inChat: boolean;
}) {
  const lastConfirmed = reachability.lastConfirmedAt
    ? `Last connection confirmed at ${formatClockTime(reachability.lastConfirmedAt)}.`
    : "No confirmed connection yet.";
  return (
    <div
      data-gateway-banner=""
      className="flex flex-wrap items-start justify-between gap-2 border-b border-status-failed bg-sunken px-4 py-3 text-sm text-fg-secondary"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium text-status-failed">
          <span role="alert">
            {inChat
              ? "GoatCitadel is unreachable. Sending is paused; your draft is kept."
              : "GoatCitadel is unreachable. What you see here may be out of date."}
          </span>{" "}
          <span>{lastConfirmed}</span>
        </p>
        <p>{gatewayStartHint(currentGatewayHost())}</p>
        <p role="status" className="text-xs text-fg-muted">
          {checkResult(reachability)}
        </p>
      </div>
      {reachability.retry ? (
        <Button size="sm" loading={reachability.checking} onClick={reachability.retry}>
          Check again
        </Button>
      ) : null}
    </div>
  );
}
