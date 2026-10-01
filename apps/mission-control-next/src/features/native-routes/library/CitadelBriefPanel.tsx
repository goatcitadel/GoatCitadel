import { ClipboardCopy, RefreshCw, Sunrise } from "lucide-react";
import { formatUsd } from "@next/app/mission-control-shell-model";
import { NativeCard, NativeList } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { humanizeEnumToken } from "../shared/native-helpers";
import { formatBriefAge } from "./citadel-brief-format";
import { useCitadelBrief } from "./use-citadel-brief";
export { buildBriefMarkdown, formatBriefAge } from "./citadel-brief-format";

export function CitadelBriefPanel({ citadelId }: { citadelId: string }) {
  const { state, copyNotice, load, copy: handleCopyMarkdown, copying } = useCitadelBrief(citadelId);

  const brief = state.brief;
  return (
    <NativeCard
      title="Daily brief"
      subtitle={
        brief
          ? `What happened since ${new Date(brief.since).toLocaleString()} across ${brief.workspaces.length} workspace${brief.workspaces.length === 1 ? "" : "s"}.`
          : "What happened in this Citadel while you were away."
      }
      stats={
        brief
          ? [
              { label: "Pending approvals", value: String(brief.approvals.pendingCount) },
              { label: "Completed", value: String(brief.activity.completedSince) },
              { label: "Failed", value: String(brief.activity.failedSince) },
              { label: "Ward hits", value: String(brief.activity.wardHitsSince) },
              {
                label: "Spend",
                value: `${formatUsd(brief.spend.sinceUsd)}${brief.spend.complete ? "" : " (partial)"}`,
              },
            ]
          : undefined
      }
      actions={
        <>
          <NativeButton
            variant="secondary"
            disabled={state.loading || !brief || copying}
            onClick={() => void handleCopyMarkdown()}
          >
            <ClipboardCopy size={16} />
            Copy as Markdown
          </NativeButton>
          <NativeButton variant="outline" disabled={state.loading} onClick={() => void load()}>
            <RefreshCw size={16} />
            Refresh
          </NativeButton>
        </>
      }
    >
      {copyNotice ? <NoticeBanner tone={copyNotice.tone} message={copyNotice.message} /> : null}
      {state.error ? <NoticeBanner tone="warning" message={state.error} /> : null}
      {state.loading && !brief ? (
        <EmptyState size="compact" icon={<Sunrise size={20} />} title="Assembling the last 24 hours..." />
      ) : brief ? (
        <>
          <NativeList
            ariaLabel="Approvals waiting on you"
            density="compact"
            emptyLabel="Nothing is waiting on you."
            items={brief.approvals.pending.map((item) => ({
              title: humanizeEnumToken(item.kind),
              meta: `waiting ${formatBriefAge(item.ageMs)}`,
              body: `${humanizeEnumToken(item.riskLevel)} risk · ${item.workspaceId}`,
            }))}
            maxHeight="14rem"
          />
          <p className="mc-next-muted">
            {"unavailable" in brief.memory
              ? `Memory review is unavailable: ${brief.memory.unavailable}`
              : `${brief.memory.pendingRecommendations} memory recommendation${brief.memory.pendingRecommendations === 1 ? "" : "s"} pending review.`}
          </p>
        </>
      ) : null}
    </NativeCard>
  );
}
