import type { ReactNode } from "react";

export function OnboardingWizardLayout({
  leftRail,
  main,
  rightRail,
}: {
  leftRail: ReactNode;
  main: ReactNode;
  rightRail: ReactNode;
}) {
  return (
    <div className="onboarding-wizard-layout">
      <aside className="onboarding-wizard-rail onboarding-wizard-rail-left">{leftRail}</aside>
      <div className="onboarding-wizard-main">{main}</div>
      <aside className="onboarding-wizard-rail onboarding-wizard-rail-right">{rightRail}</aside>
    </div>
  );
}
