import type { IntegrationConnection, NotificationTargetKind } from "@goatcitadel/contracts";
import { useNotificationRoutingState } from "./use-notification-routing-state";
import { useNotificationRoutingActions } from "./use-notification-routing-actions";

export function useNotificationRouting(
  workspaceId: string,
  channels: IntegrationConnection[],
  defaultTargetKind: NotificationTargetKind = "channel_connection",
) {
  const state = useNotificationRoutingState(workspaceId, channels, defaultTargetKind);
  return { ...state, ...useNotificationRoutingActions(state) };
}
export type NotificationRoutingOwner = ReturnType<typeof useNotificationRouting>;
