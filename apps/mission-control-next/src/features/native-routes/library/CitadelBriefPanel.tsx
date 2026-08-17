import { useCallback, useEffect, useState } from "react";
import { ClipboardCopy, RefreshCw, Sunrise } from "lucide-react";
import type { CitadelBrief } from "@goatcitadel/contracts";
import { fetchCitadelBrief } from "@goatcitadel/mission-control-shared/api/client";
import { formatUsd } from "@next/app/mission-control-shell-model";
import { NativeCard, NativeList } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { getErrorMessage, humanizeEnumToken } from "../shared/native-helpers";

interface BriefState {
  loading: boolean;
  error: string | null;
  brief: CitadelBrief | null;
}

const INITIAL: BriefState = { loading: true, error: null, brief: null };

export function formatBriefAge(ageMs: number): string {
  const totalMinutes = Math.floor(ageMs / 60_000);
  if (totalMinutes < 1) {
    return "just now";
  }
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function buildBriefMarkdown(brief: CitadelBrief): string {
  const lines = [
    `# Daily brief — ${brief.citadelName ?? brief.citadelId}`,
    `Window: ${brief.since} → ${brief.generatedAt}`,
    "",
    `- Pending approvals: ${brief.approvals.pendingCount}` +
      (brief.approvals.oldestAgeMs !== null ? ` (oldest ${formatBriefAge(brief.approvals.oldestAgeMs)})` : ""),
    `- Activity: ${brief.activity.eventsSince} events · ${brief.activity.completedSince} completed · ${brief.activity.failedSince} failed · ${brief.activity.wardHitsSince} ward hits`,
    `- Spend (${brief.spend.scope}): ${formatUsd(brief.spend.sinceUsd)} · ${brief.spend.sinceTokens} tokens` +
      (brief.spend.complete ? "" : " (partial data)"),
    "unavailable" in brief.memory
      ? `- Memory: unavailable (${brief.memory.unavailable})`
      : `- Memory: ${brief.memory.pendingRecommendations} recommendation(s) pending review`,
  ];
  if (brief.approvals.pending.length > 0) {
    lines.push("", "## Waiting on you");
    for (const item of brief.approvals.pending) {
      lines.push(
        `- ${humanizeEnumToken(item.kind)} · ${item.riskLevel} · waiting ${formatBriefAge(item.ageMs)} (${item.workspaceId})`,
      );
    }
  }
  return lines.join("\n");
}

export function CitadelBriefPanel({ citadelId }: { citadelId: string }) {
  const [state, setState] = useState<BriefState>(INITIAL);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const brief = await fetchCitadelBrief(citadelId);
      setState({ loading: false, error: null, brief });
    } catch (error) {
      setState({ loading: false, error: getErrorMessage(error), brief: null });
    }
  }, [citadelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCopyMarkdown = async () => {
    if (!state.brief) {
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setCopyNotice("Clipboard is unavailable in this browser.");
      return;
    }
    try {
      await navigator.clipboard.writeText(buildBriefMarkdown(state.brief));
      setCopyNotice("Brief copied as Markdown.");
    } catch (error) {
      setCopyNotice(getErrorMessage(error));
    }
  };

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
            disabled={state.loading || !brief}
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
      {copyNotice ? <NoticeBanner tone="success" message={copyNotice} /> : null}
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
