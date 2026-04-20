import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { TuneHubLayout } from "../components/TuneHubLayout";
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
  const activeLabel = ITEMS.find((item) => item.id === activeTab)?.label ?? "General";
  const decisionSummary =
    activeTab === "providers"
      ? "Choose the provider and model defaults every Work surface inherits."
      : activeTab === "access"
        ? "Lock down tokens, device grants, and gateway entry before broader tuning."
        : activeTab === "budget"
          ? "Keep spend and read access defaults aligned with runtime risk."
          : activeTab === "onboarding"
            ? "Use onboarding to tighten defaults before the workspace gets busy."
            : "Set the base defaults Mission Control will reuse everywhere else.";

  return (
    <TuneHubLayout
      title="General"
      subtitle={
        <>
          <strong>{activeLabel}</strong>
          {" · "}
          {decisionSummary}
        </>
      }
      guideTitle="What this controls"
      guideBody="Use General to lock the defaults that other surfaces inherit. Reach for this before you debug behavior downstream."
      tabItems={ITEMS}
      activeTab={activeTab}
      onTabChange={(value) => onTabChange(value as GeneralTab)}
      tabAriaLabel="General settings sections"
    >
      <EmbeddedPageChromeProvider>
        {activeTab === "onboarding" ? (
          <OnboardingPage onCompleted={onOnboardingCompleted} />
        ) : (
          <SettingsPage activeTab={activeTab} />
        )}
      </EmbeddedPageChromeProvider>
    </TuneHubLayout>
  );
}
