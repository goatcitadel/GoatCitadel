import React from "react";
import { createRoot } from "react-dom/client";
import "react-reflex/styles.css";
import "@awesome.me/webawesome/dist/styles/webawesome.css";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { MissionControlNextApp } from "@next/app/MissionControlNextApp";
import { retireMissionControlServiceWorkers } from "./service-worker-cleanup";
import "@next/styles/mission-control-next-foundation.css";
import "@next/styles/mission-control-next.css";

const visualRegressionMode =
  (import.meta.env.VITE_GOATCITADEL_VISUAL_REGRESSION_MODE as string | undefined)?.trim().toLowerCase() === "true";

if (visualRegressionMode) {
  document.documentElement.dataset.visualRegression = "true";
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
