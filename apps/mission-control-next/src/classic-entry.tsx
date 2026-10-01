import React from "react";
import { renderApplicationRoot } from "./app/application-root";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { MissionControlNextApp } from "@next/app/MissionControlNextApp";
import "@next/styles/mission-control-next-tokens.css";
import "@next/styles/mission-control-next-foundation.css";
import "@next/styles/mission-control-next-theme-bridge.css";
import "@next/styles/mission-control-next.css";
import "@next/features/native-routes/primitives/primitives.css";

export function mountClassic(root: HTMLElement): void {
  renderApplicationRoot(root,
    <React.StrictMode>
      <UiPreferencesProvider>
        <MissionControlNextApp />
      </UiPreferencesProvider>
    </React.StrictMode>,
  );
}
