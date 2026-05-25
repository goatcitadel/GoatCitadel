import React from "react";
import { createRoot } from "react-dom/client";
// Task #16: webawesome.css already @imports themes/default.css, so importing
// it explicitly here duplicated ~51KB of theme content in the initial shell
// bundle. Single import is sufficient. react-reflex/styles.css was also
// imported here but no next-app source uses ReflexContainer/Element/Splitter
// (the legacy mission-control app is the only consumer of that pattern).
import "@awesome.me/webawesome/dist/styles/webawesome.css";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { MissionControlNextApp } from "@next/app/MissionControlNextApp";
import { retireMissionControlServiceWorkers } from "./service-worker-cleanup";
import "@next/styles/mission-control-next-tokens.css";
import "@next/styles/mission-control-next-foundation.css";
import "@next/styles/mission-control-next.css";
import "@next/features/native-routes/primitives/primitives.css";

const visualRegressionMode =
  (import.meta.env.VITE_GOATCITADEL_VISUAL_REGRESSION_MODE as string | undefined)?.trim().toLowerCase() === "true";

if (visualRegressionMode) {
  document.documentElement.dataset.visualRegression = "true";
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  if (params.get("vr-blocked") === "1") {
    document.documentElement.dataset.visualRegressionShowBlocked = "true";
  }
}

void retireMissionControlServiceWorkers();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <React.StrictMode>
    <UiPreferencesProvider>
      <MissionControlNextApp />
    </UiPreferencesProvider>
  </React.StrictMode>,
);
