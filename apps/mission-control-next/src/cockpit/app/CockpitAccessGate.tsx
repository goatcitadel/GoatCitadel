import { GatewayAccessGate } from "@goatcitadel/mission-control-shared/components/GatewayAccessGate";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { GatewayAccessViewState } from "../../app/use-gateway-access";
import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { currentGatewayHost, gatewayStartHint } from "./gateway-host-hint";

export function CockpitAccessGate({
  access,
  busy,
  onRetry,
}: {
  access: GatewayAccessViewState;
  busy: boolean;
  onRetry: () => void;
}) {
  const shellSwitch = useCockpitShellSwitch();
  const needsSignIn = access.status === "needs-auth";
  const blocked = access.status === "access-blocked";
  const checking = access.status === "checking";
  const misconfigured = access.status === "misconfigured";
  const title = checking
    ? "Connecting to GoatCitadel"
    : blocked
      ? "Access blocked for this caller"
      : needsSignIn
        ? "Sign in to continue"
        : misconfigured
          ? "Gateway setup needs attention"
          : "Can't reach the GoatCitadel gateway";
  const description = blocked
    ? access.message
    : misconfigured
      ? access.message
    : needsSignIn
      ? "Continue in the classic view to complete gateway access. The cockpit uses the same access state."
      : checking
        ? "Checking gateway access."
        : `It may not be running. ${gatewayStartHint(currentGatewayHost())} This page retries automatically.`;
  if (needsSignIn || blocked)
    return (
      <main className="cockpit-access min-h-dvh overflow-auto bg-canvas p-4">
        <GatewayAccessGate gatewayBaseUrl={getGatewayApiBaseUrl()} access={access} busy={busy} onRetry={onRetry} />
        <p className="text-sm text-fg-secondary">Unsaved drafts stay in this app session while access is restored.</p>
        <Button onClick={shellSwitch.visit}>Open classic view</Button>
        {shellSwitch.feedback}
      </main>
    );
  return (
    <main className="flex h-dvh items-center justify-center bg-canvas">
      <EmptyState
        title={title}
        description={description}
        action={
          misconfigured ? (
            <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={onRetry}>{busy ? "Checking…" : "Try again"}</Button><Button onClick={shellSwitch.visit}>Open classic view</Button></div>
          ) : (
            <Button disabled={busy || checking} onClick={onRetry}>
              {busy || checking ? "Checking…" : "Try again"}
            </Button>
          )
        }
      />
      {shellSwitch.feedback}
    </main>
  );
}
