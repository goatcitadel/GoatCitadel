import { lazy, Suspense } from "react";
const GatewayAccessGate = lazy(async () => ({
  default: (await import("@goatcitadel/mission-control-shared/components/GatewayAccessGate")).GatewayAccessGate,
}));
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { GatewayAccessViewState } from "../../app/use-gateway-access";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { currentGatewayHost, gatewayStartHint } from "./gateway-host-hint";

/**
 * Sign-in and blocked access use the shared credential form with cockpit wording; the drafts note sits inside its
 * card. The classic view shows the same gate for every state here, so there is no Classic action (SH-23).
 */
export function CockpitAccessGate({
  access,
  busy,
  onRetry,
}: {
  access: GatewayAccessViewState;
  busy: boolean;
  onRetry: () => void;
}) {
  const checking = access.status === "checking";
  const misconfigured = access.status === "misconfigured";
  if (access.status === "needs-auth" || access.status === "access-blocked")
    return (
      // The shared shell fills the viewport by default; here it shrinks so the note sits directly under its card.
      <main className="cockpit-access flex min-h-dvh flex-col items-center justify-center overflow-auto bg-canvas p-4">
        <Suspense fallback={<p role="status">Loading sign-in…</p>}>
          <GatewayAccessGate
            gatewayBaseUrl={getGatewayApiBaseUrl()}
            access={access}
            busy={busy}
            onRetry={onRetry}
            title={
              access.status === "access-blocked" ? "This browser can't open the cockpit yet" : "Sign in to continue"
            }
            subtitle="Connect to GoatCitadel to load your workspace."
            footer={
              <p className="text-sm text-fg-secondary">Unsaved drafts stay in this app session while you sign in.</p>
            }
          />
        </Suspense>
      </main>
    );
  const title = checking
    ? "Connecting to GoatCitadel"
    : misconfigured
      ? "Setup needs attention"
      : "Can't reach GoatCitadel";
  const description = misconfigured
    ? access.message
    : checking
      ? "Checking access."
      : `It may not be running. ${gatewayStartHint(currentGatewayHost())} This page retries automatically.`;
  return (
    <main className="flex h-dvh items-center justify-center bg-canvas">
      <EmptyState
        // The gate replaces the whole cockpit, so its title is the page heading.
        headingLevel={1}
        title={title}
        description={description}
        action={
          <Button disabled={busy || checking} onClick={onRetry}>
            {busy || checking ? "Checking…" : "Try again"}
          </Button>
        }
      />
    </main>
  );
}
