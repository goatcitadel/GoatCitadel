import { useQuery } from "@tanstack/react-query";
import type { CodeModeReadiness } from "@goatcitadel/contracts";
import { fetchCodeModeReadiness } from "@goatcitadel/mission-control-shared/api/client";

export const CODE_MODE_READINESS_KEY = ["code-mode", "readiness"] as const;

/** Whether Code Mode can run now. Read only while a request waits for the operator, so a quiet transcript asks nothing. */
export function useCodeModeReadiness(enabled: boolean) {
  return useQuery<CodeModeReadiness>({
    queryKey: CODE_MODE_READINESS_KEY,
    queryFn: () => fetchCodeModeReadiness(),
    enabled,
    staleTime: 0,
  });
}
