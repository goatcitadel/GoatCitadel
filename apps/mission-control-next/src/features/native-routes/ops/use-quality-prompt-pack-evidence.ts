import {
  canonicalJsonString,
  type PromptPackRecord,
  type PromptPackExportRecord,
  type PromptPackReportRecord,
} from "@goatcitadel/contracts";
import { fetchPromptPackExport, fetchPromptPackReport } from "@goatcitadel/mission-control-shared/api/client";
import { nativeLoad, nativeLoadIssues, useAsyncLoad } from "../shared/native-helpers";

/** The selected definition and observed snapshot bind report/export presentation. */
export function useQualityPromptPackEvidence(active: boolean, pack: PromptPackRecord | null, observedAt?: string) {
  const selection = canonicalJsonString([active, pack?.packId, pack?.updatedAt, pack?.contentSha256, observedAt]);
  const state = useAsyncLoad(async () => {
    if (!active || !pack) return { selection, issues: [], report: null, exportInfo: null };
    const [report, exportInfo] = await Promise.all([
      nativeLoad(
        "Prompt-pack report",
        (async () => {
          const response = await fetchPromptPackReport(pack.packId);
          if (
            response.pack.packId !== pack.packId ||
            response.pack.updatedAt !== pack.updatedAt ||
            response.pack.contentSha256 !== pack.contentSha256
          ) {
            throw new Error("The prompt pack changed. Refresh Quality before inspecting its report.");
          }
          return response;
        })(),
        null as PromptPackReportRecord | null,
      ),
      nativeLoad(
        "Prompt-pack export",
        (async () => {
          const response = await fetchPromptPackExport(pack.packId);
          if (response.packId !== pack.packId) throw new Error("The export belongs to a different prompt pack.");
          return response;
        })(),
        null as PromptPackExportRecord | null,
      ),
    ]);
    return {
      selection,
      issues: nativeLoadIssues([report, exportInfo]),
      report: report.data,
      exportInfo: exportInfo.data,
    };
  }, [selection]);
  const current = !state.loading && state.data?.selection === selection;
  return {
    ...state,
    data: current ? state.data : null,
    report: current ? state.data?.report : null,
    exportInfo: current ? state.data?.exportInfo : null,
  };
}
