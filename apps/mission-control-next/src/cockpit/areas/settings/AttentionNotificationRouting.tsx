import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchIntegrationConnections } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { NotificationRoutingSettings } from "./NotificationRoutingSettings";

/**
 * ST-09: notification routing sits beside General › Attention instead of four clicks deep under Connections.
 * Channel destinations come from the same integration directory read that Connections › Integrations uses.
 */
export function AttentionNotificationRouting({ workspaceId }: { workspaceId: string }) {
  const connections = useQuery({
    queryKey: ["settings", "integration-connections"],
    queryFn: () => fetchIntegrationConnections(),
  });
  const items = connections.data?.items;
  const channels = useMemo(() => (items ?? []).filter((item) => item.kind === "channel"), [items]);
  return (
    <div id="notification-routing" className="min-w-0 space-y-2 sm:col-span-2">
      {connections.isError ? (
        <p className="text-xs text-status-waiting">
          Channel destinations could not load: {describeApiError(connections.error).summary}
        </p>
      ) : null}
      <NotificationRoutingSettings key={workspaceId} workspaceId={workspaceId} channels={channels} />
    </div>
  );
}
