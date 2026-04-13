import { useEffect, useMemo, type ReactNode } from "react";
import { PageTabs } from "./PageTabs";
import { SectionTitle } from "./SectionTitle";
import { StatCard } from "./StatCard";
import { useShellDetailPanel } from "./ShellDetailPanelContext";

type SummaryTone = "default" | "accent" | "warning" | "success";

interface TuneHubSummaryItem {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: SummaryTone;
}

interface TuneHubLayoutProps<TTab extends string> {
  title: string;
  subtitle: ReactNode;
  summaries?: TuneHubSummaryItem[];
  guideTitle?: ReactNode;
  guideBody?: ReactNode;
  tabItems?: Array<{ id: TTab; label: string }>;
  activeTab?: TTab;
  onTabChange?: (tab: TTab) => void;
  tabAriaLabel?: string;
  children: ReactNode;
}

export function TuneHubLayout<TTab extends string>({
  title,
  subtitle,
  summaries,
  guideTitle,
  guideBody,
  tabItems,
  activeTab,
  onTabChange,
  tabAriaLabel,
  children,
}: TuneHubLayoutProps<TTab>) {
  const { registerEntry, openPanel, closePanel, isOpen } = useShellDetailPanel();
  const visibleSummaries = summaries?.filter((item) => item.value !== null && item.value !== undefined) ?? [];
  const detailBody = useMemo(() => <div className="tune-hub-guide-body">{guideBody}</div>, [guideBody]);

  useEffect(() => {
    if (!guideTitle && !guideBody) {
      return undefined;
    }
    return registerEntry({
      id: `tune-hub-guide:${title}`,
      title: typeof guideTitle === "string" ? guideTitle : "Page details",
      kicker: "Tune context",
      subtitle: subtitle,
      body: detailBody,
      priority: 10,
    });
  }, [detailBody, guideBody, guideTitle, registerEntry, subtitle, title]);

  return (
    <section className="space-page stack-lg tune-hub-layout">
      <SectionTitle
        title={title}
        subtitle={subtitle}
        density="compact"
        actions={
          guideTitle || guideBody ? (
            <button
              type="button"
              className="gc-button"
              onClick={() => {
                if (isOpen) {
                  closePanel();
                  return;
                }
                openPanel();
              }}
            >
              {isOpen ? "Hide details" : "Open details"}
            </button>
          ) : undefined
        }
      />
      {visibleSummaries.length > 0 ? (
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
