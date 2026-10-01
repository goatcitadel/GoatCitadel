import { useQuery } from "@tanstack/react-query";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { GatewayAuthEditor } from "../../../features/native-routes/settings/GatewayAuthEditor";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { Button } from "../../ui/Button";

export function GatewayAuthSettings() {
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
        <Button size="sm" disabled={settings.isFetching} onClick={() => void settings.refetch()}>
          Refresh authentication
        </Button>
      </div>
      {settings.isLoading ? <p role="status">Loading Gateway authentication…</p> : null}
      {settings.isError ? <p role="alert">{describeApiError(settings.error).summary}</p> : null}
      <GatewayAuthEditor
        cockpit
        buttonComponent={Button}
        settings={settings.data}
        available={!settings.isError && !settings.isFetching}
        reload={() => settings.refetch()}
        renderApprovalAction={(plan, receipt, pending) => <SettingsApprovalOwnerAction
          plan={plan} receipt={receipt} owner="gateway-auth" workspaceId="default" disabled={pending}
        />}
      />
    </section>
  );
}
