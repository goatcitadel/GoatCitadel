import { useState } from "react";
import { clearGatewayAuthState } from "@goatcitadel/mission-control-shared/api/client-core";
import { Dialog } from "../../ui/Dialog";
import { useCurrentAccess } from "../../../app/use-current-access";
import { useQuery } from "@tanstack/react-query";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { GatewayAuthEditor } from "../../../features/native-routes/settings/GatewayAuthEditor";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { CALLER_SOURCE_LABELS } from "./settings-vocabulary";

export function GatewayAuthSettings() {
  const caller = useCurrentAccess();
  const signedInAs = caller.data ? (CALLER_SOURCE_LABELS[caller.data.actorSource] ?? "An operator") : "An operator";
  const canChangeSettings = Boolean(caller.data?.operatorAccess);
  const [logoutReview, setLogoutReview] = useState(false);
  const settings = useQuery({ queryKey: ["settings", "gateway-auth"], queryFn: fetchSettings });
  return (
    <section
      id="gateway-auth"
      aria-labelledby="gateway-auth-title"
      className="mt-4 space-y-3 rounded-lg border border-line bg-sunken p-4 text-sm text-fg-secondary"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 id="gateway-auth-title" className="font-display text-base font-semibold text-fg">
          Gateway authentication
        </h3>
        <Button
          size="sm"
          disabled={settings.isFetching}
          onClick={() => {
            void settings.refetch();
            void caller.refetch();
          }}
        >
          Refresh authentication
        </Button>
      </div>
      {settings.isLoading ? <p role="status">Loading Gateway authentication…</p> : null}
      {settings.isError ? <p role="alert">{describeApiError(settings.error).summary}</p> : null}
      <p role="status">
        {caller.isPending
          ? "Checking what you can change…"
          : caller.isError
            ? "Your access could not be checked. Configured sign-in settings do not show what you can change."
            : caller.data?.actorId
              ? `Signed in as: ${signedInAs}. ${canChangeSettings ? "You can change operator settings; individual policy checks still apply." : "You cannot change operator settings."}`
              : "No identified operator. This Gateway permits anonymous configuration access."}
      </p>
      {caller.data?.actorId ? (
        <TechnicalDetails label="Sign-in details">
          <p className="break-all font-mono text-xs">
            {caller.data.actorSource} · {caller.data.actorId}
          </p>
        </TechnicalDetails>
      ) : null}
      {caller.data?.actorId ? (
        <Button size="sm" onClick={() => setLogoutReview(true)}>
          Sign out of this browser
        </Button>
      ) : null}
      <Dialog
        open={logoutReview}
        onOpenChange={setLogoutReview}
        title="Sign out of this browser?"
        description="Remove this browser’s Gateway access credentials. Drafts stay in this app session, but protected work pauses until you sign in again. This does not revoke other approved devices."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            onClick={() => {
              setLogoutReview(false);
              clearGatewayAuthState();
            }}
          >
            Sign out
          </Button>
          <Button onClick={() => setLogoutReview(false)}>Keep access</Button>
        </div>
      </Dialog>
      <GatewayAuthEditor
        cockpit
        buttonComponent={Button}
        settings={settings.data}
        available={!settings.isError && !settings.isFetching && caller.isSuccess && caller.data.operatorAccess}
        reload={() => settings.refetch()}
        renderApprovalAction={(plan, receipt, pending) => (
          <SettingsApprovalOwnerAction
            plan={plan}
            receipt={receipt}
            owner="gateway-auth"
            workspaceId="default"
            disabled={pending}
          />
        )}
      />
    </section>
  );
}
