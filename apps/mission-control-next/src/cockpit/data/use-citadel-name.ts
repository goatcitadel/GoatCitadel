import { useQuery } from "@tanstack/react-query";
import { getCitadelStructureSnapshot } from "@goatcitadel/mission-control-shared/api/citadels";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { hasCitadelRecord } from "../../features/native-routes/settings/directory-lifecycle-binding";
import { recordView } from "./record-view";

/** The active Citadel read with its state kept distinct from its name: still loading, failed or unavailable, or read. */
export function useCitadelNameRead(
  citadelId: string,
  enabled: boolean,
): { phase: "loading" | "failed" | "ready"; name?: string } {
  const query = useQuery({
    queryKey: ["system", "directory", "active-citadel", getGatewayApiBaseUrl(), citadelId],
    queryFn: ({ signal }) => getCitadelStructureSnapshot(citadelId, { signal }),
    enabled: enabled && Boolean(citadelId),
    staleTime: 30_000,
  });
  const view = recordView(query),
    record = view.record?.record;
  if (view.phase === "loading") return { phase: "loading" };
  return view.record?.citadelId === citadelId &&
    hasCitadelRecord(record) &&
    record.citadelId === citadelId &&
    record.lifecycleStatus === "active"
    ? { phase: "ready", name: record.name }
    : { phase: "failed" };
}

/** Shared authorized-directory projection for the existing scope picker and phone label. */
export function useCitadelName(citadelId: string, enabled: boolean) {
  const read = useCitadelNameRead(citadelId, enabled);
  return read.phase === "loading" ? "Reading Citadel..." : read.phase === "ready" ? read.name! : "Citadel unavailable";
}
