import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { SectionTitle } from "../components/SectionTitle";
import { OnboardingPage } from "./OnboardingPage";
import { SettingsPage } from "./SettingsPage";

export type GeneralTab = "general" | "providers" | "access" | "budget" | "onboarding";

interface GeneralHubPageProps {
  activeTab: GeneralTab;
  onTabChange: (tab: GeneralTab) => void;
  onOnboardingCompleted?: () => void;
}

const ITEMS: Array<{ id: GeneralTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "access", label: "Access" },
  { id: "budget", label: "Budget" },
  { id: "onboarding", label: "Onboarding" },
];

export function GeneralHubPage({ activeTab, onTabChange, onOnboardingCompleted }: GeneralHubPageProps) {
  return (
    <section className="space-page stack-lg">
      <SectionTitle
        title="General"
        subtitle="Core defaults, provider posture, access controls, budgets, and onboarding belong in one Tune surface."
      />
      <PageTabs items={ITEMS} activeId={activeTab} onSelect={(value) => onTabChange(value as GeneralTab)} />
      <EmbeddedPageChromeProvider>
        {activeTab === "onboarding" ? <OnboardingPage onCompleted={onOnboardingCompleted} /> : <SettingsPage activeTab={activeTab} />}
      </EmbeddedPageChromeProvider>
    </section>
  );
}
