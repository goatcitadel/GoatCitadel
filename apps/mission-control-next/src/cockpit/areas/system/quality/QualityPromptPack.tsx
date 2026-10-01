import { useQuery } from "@tanstack/react-query";
import type { PromptPackRecord } from "@goatcitadel/contracts";
import { fetchPromptPackReport } from "@goatcitadel/mission-control-shared/api/prompt-packs";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { QualityFacts, qualityNumber, promptPackQualityHref } from "./QualityEvidence";
import { ClassicOwnerLink } from "../../../ui/ClassicOwnerLink";

export function QualityPromptPack({ pack, observedAt }: { pack: PromptPackRecord | undefined; observedAt: string }) {
  const report = useQuery({ queryKey: ["quality", "prompt-pack-report", pack?.packId, pack?.updatedAt, pack?.contentSha256, observedAt],
    enabled: Boolean(pack), queryFn: async () => {
      if (!pack) throw new Error("Choose a prompt pack first.");
      const response = await fetchPromptPackReport(pack.packId);
      if (response.pack.packId !== pack.packId) throw new Error("The report belongs to a different prompt pack.");
      if (response.pack.updatedAt !== pack.updatedAt || response.pack.contentSha256 !== pack.contentSha256) {
        throw new Error("The prompt pack changed. Refresh Quality before inspecting its report.");
      }
      return response;
    } });
  return <section aria-label="Selected prompt pack" className="space-y-3 rounded-md border border-line bg-sunken p-3">
    {!pack ? <p role="status" className="text-sm text-fg-secondary">The selected prompt pack is no longer in the current evidence.</p>
      : <>
        <h3 className="font-medium text-fg">{pack.name}</h3>
        {report.isLoading ? <p role="status" className="text-sm text-fg-muted">Loading stored prompt-pack report…</p> : null}
        {report.isError ? <p role="alert" className="text-sm text-fg-secondary">Stored report unavailable. {describeApiError(report.error).summary}</p> : null}
        {report.data && !report.isError ? <QualityFacts items={[
          { label: "Total tests", value: report.data.summary.totalTests }, { label: "Completed runs", value: report.data.summary.completedRuns },
          { label: "Failed runs", value: report.data.summary.failedRuns }, { label: "Awaiting scores", value: report.data.summary.needsScoreCount },
          { label: "Pass / fail / review", value: `${report.data.summary.passCount} / ${report.data.summary.failCount} / ${report.data.summary.reviewCount}` },
          { label: "Effective pass rate", value: qualityNumber(report.data.summary.effectivePassRate * 100, "%") },
        ]} /> : null}
        <ClassicOwnerLink href={promptPackQualityHref(pack.packId)} scope={pack.packId} className="inline-block text-sm text-accent hover:underline" label="Open prompt-pack run and scoring controls" />
      </>}
  </section>;
}
