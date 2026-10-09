import { useQuery } from "@tanstack/react-query";
import { getCitadelStructureSnapshot } from "@goatcitadel/mission-control-shared/api/citadels";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { hasCitadelRecord } from "../../features/native-routes/settings/directory-lifecycle-binding";
import { recordView } from "./record-view";

/** Shared authorized-directory projection for the existing scope picker and phone label. */
export function useCitadelName(citadelId: string, enabled: boolean) {
  const query = useQuery({
    queryKey: ["system", "directory", "active-citadel", getGatewayApiBaseUrl(), citadelId],
    queryFn: ({ signal }) => getCitadelStructureSnapshot(citadelId, { signal }),
    enabled: enabled && Boolean(citadelId), staleTime: 30_000,
  });
  const view = recordView(query), record = view.record?.record;
  return view.phase === "loading" ? "Reading Citadel..." : view.record?.citadelId === citadelId && hasCitadelRecord(record) && record.citadelId === citadelId && record.lifecycleStatus === "active" ? record.name : "Citadel unavailable";
}
