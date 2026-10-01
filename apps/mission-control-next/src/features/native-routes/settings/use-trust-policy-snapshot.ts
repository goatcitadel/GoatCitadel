import { useCallback } from "react";
import { fetchTrustPolicySnapshot } from "@goatcitadel/mission-control-shared/api/trust";
import { useAsyncLoad, type NativeLoadIssue } from "../shared/native-helpers";

/** The Gateway owns this mixed-scope, read-only snapshot; it does not authorize an invocation. */
export function useTrustPolicySnapshot() {
  const load = useCallback(async () => {
    const snapshot = await fetchTrustPolicySnapshot();
    if (snapshot.readOnly !== true || snapshot.mutationSemantics !== "none") {
      throw new Error("The Gateway did not provide the read-only Trust snapshot contract.");
    }
    const issues: NativeLoadIssue[] = snapshot.sources
      .filter((source) => source.status === "unavailable")
      .map((source) => ({ label: source.owner, message: source.error ?? "Source unavailable" }));
    return { snapshot, issues };
  }, []);
  return useAsyncLoad(load, [load]);
}
