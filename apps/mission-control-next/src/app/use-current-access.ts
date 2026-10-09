import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchGatewayCurrentAccess } from "@goatcitadel/mission-control-shared/api/shell-client";
import {
  getGatewayAccessRevision,
  subscribeGatewayAccessChange,
  getGatewayApiBaseUrl,
} from "@goatcitadel/mission-control-shared/api/client-core";
export function useCurrentAccess() {
  const revision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  return useQuery({
    queryKey: ["gateway-current-access", getGatewayApiBaseUrl(), revision],
    queryFn: fetchGatewayCurrentAccess,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
}
