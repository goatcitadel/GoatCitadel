import type { ReactNode } from "react";
import { PageTabs } from "./PageTabs";
import { Panel } from "./Panel";
import { SectionTitle } from "./SectionTitle";
import { StatCard } from "./StatCard";

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
  summaries: TuneHubSummaryItem[];
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
  return (
    <section className="space-page stack-lg tune-hub-layout">
      <SectionTitle title={title} subtitle={subtitle} density="compact" />
      <div className="tune-hub-summary-strip operator-summary-strip">
        {summaries.map((item) => (
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
      {guideTitle || guideBody ? (
        <Panel
          title={guideTitle}
          subtitle={guideBody}
          tone="soft"
          rank="muted"
          padding="compact"
          collapsible
          defaultExpanded={false}
          className="tune-hub-guide"
        >
          <></>
        </Panel>
      ) : null}
    </section>
  );
}
