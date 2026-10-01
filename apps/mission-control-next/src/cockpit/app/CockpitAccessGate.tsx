import type { GatewayAccessViewState } from "../../app/use-gateway-access";
import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

export function CockpitAccessGate({ access, busy, onRetry }: { access: GatewayAccessViewState; busy: boolean; onRetry: () => void }) {
  const shellSwitch = useCockpitShellSwitch();
  const needsSignIn = access.status === "needs-auth";
  const checking = access.status === "checking";
  const misconfigured = access.status === "misconfigured";
  const title = checking ? "Connecting to GoatCitadel" : needsSignIn ? "Sign in to continue" : misconfigured ? "Gateway setup needs attention" : "Can't reach the GoatCitadel gateway";
  const description = needsSignIn || misconfigured
    ? "Continue in the classic view to complete gateway access. The cockpit uses the same access state."
    : checking ? "Checking gateway access." : "Check that the gateway is running. This page retries automatically.";
  return <main className="flex h-dvh items-center justify-center bg-canvas">
    <EmptyState title={title} description={description} action={
      needsSignIn || misconfigured
        ? <Button variant="primary" onClick={shellSwitch.request}>Open classic view</Button>
        : <Button disabled={busy || checking} onClick={onRetry}>{busy || checking ? "Checking…" : "Try again"}</Button>
    } />
    {shellSwitch.feedback}
  </main>;
}
