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

export function GatewayAuthSettings() {
  const caller = useCurrentAccess();
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
          ? "Checking current caller permissions…"
          : caller.isError
            ? "Current caller permissions unavailable. Configured authentication does not establish your access."
            : caller.data?.actorId
              ? `Current caller: ${caller.data.actorSource}. ${caller.data.operatorAccess ? "Operator routes permitted; individual policy gates still apply." : "Operator changes are not permitted."}`
              : "No identified operator. This Gateway permits anonymous configuration access."}
      </p>
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
        <Button
          onClick={() => {
            setLogoutReview(false);
            clearGatewayAuthState();
          }}
        >
          Sign out
        </Button>
        <Button onClick={() => setLogoutReview(false)}>Keep access</Button>
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
