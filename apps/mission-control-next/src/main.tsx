import React from "react";
import { createRoot } from "react-dom/client";
import "react-reflex/styles.css";
import "@awesome.me/webawesome/dist/styles/webawesome.css";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
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
