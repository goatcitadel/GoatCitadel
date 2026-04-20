import { useEffect, useMemo, type ReactNode } from "react";
import { PageTabs } from "./PageTabs";
import { SectionTitle } from "./SectionTitle";
import { StatCard } from "./StatCard";
import { useShellDetailPanel } from "./ShellDetailPanelContext";

type SummaryTone = "default" | "accent" | "warning" | "success";
type TuneHubSummaryMode = "cards" | "posture";

interface TuneHubSummaryItem {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: SummaryTone;
}

interface TuneHubLayoutProps<TTab extends string> {
  className?: string;
  title: string;
  subtitle: ReactNode;
  summaries?: TuneHubSummaryItem[];
  summaryMode?: TuneHubSummaryMode;
  showSummaryNotes?: boolean;
  guideTitle?: ReactNode;
  guideBody?: ReactNode;
  tabItems?: Array<{ id: TTab; label: string }>;
  activeTab?: TTab;
  onTabChange?: (tab: TTab) => void;
  tabAriaLabel?: string;
  children: ReactNode;
}

export function TuneHubLayout<TTab extends string>({
  className,
  title,
  subtitle,
  summaries,
  summaryMode = "cards",
  showSummaryNotes = false,
  guideTitle,
  guideBody,
  tabItems,
  activeTab,
  onTabChange,
  tabAriaLabel,
  children,
}: TuneHubLayoutProps<TTab>) {
  const { registerEntry } = useShellDetailPanel();
  const visibleSummaries = summaries?.filter((item) => item.value !== null && item.value !== undefined) ?? [];
  const detailBody = useMemo(() => <div className="tune-hub-guide-body">{guideBody}</div>, [guideBody]);

  useEffect(() => {
    if (!guideTitle && !guideBody) {
      return undefined;
    }
    return registerEntry({
      id: `tune-hub-guide:${title}`,
      title: typeof guideTitle === "string" ? guideTitle : "Page details",
      kicker: "Setup context",
      subtitle: subtitle,
      body: detailBody,
      priority: 10,
    });
  }, [detailBody, guideBody, guideTitle, registerEntry, subtitle, title]);

  return (
    <section className={`space-page stack-lg tune-hub-layout${className ? ` ${className}` : ""}`}>
      <SectionTitle title={title} subtitle={subtitle} density="compact" />
      {visibleSummaries.length > 0 ? (
        summaryMode === "posture" ? (
          <div className="tune-posture-bar" aria-label={`${title} posture summary`}>
            {visibleSummaries.map((item) => (
              <div
                key={`${title}-${item.label}`}
                className={`tune-posture-item tune-posture-item-${item.tone ?? "default"}`}
              >
                <p className="tune-posture-label">{item.label}</p>
                <p className="tune-posture-value">{item.value}</p>
                {showSummaryNotes && item.note ? <p className="tune-posture-note">{item.note}</p> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="tune-hub-summary-strip operator-summary-strip">
            {visibleSummaries.map((item) => (
              <StatCard
                key={`${title}-${item.label}`}
                label={item.label}
                value={item.value}
                note={item.note}
                tone={item.tone}
                compact
                className="operator-summary-card tune-hub-summary-card"
              />
            ))}
          </div>
        )
      ) : null}
      {tabItems && activeTab && onTabChange ? (
        <PageTabs
          items={tabItems}
          activeId={activeTab}
          tier="section"
          ariaLabel={tabAriaLabel}
          onSelect={(value) => onTabChange(value as TTab)}
        />
      ) : null}
      {children}
    </section>
  );
}
