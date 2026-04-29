import React from "react";
import { createRoot } from "react-dom/client";
import "react-reflex/styles.css";
import { App } from "./App";
import { retireMissionControlServiceWorkers } from "./service-worker-cleanup";
import { UiPreferencesProvider } from "./state/ui-preferences";
import "./styles.css";

const visualRegressionMode =
  (import.meta.env.VITE_GOATCITADEL_VISUAL_REGRESSION_MODE as string | undefined)?.trim().toLowerCase() === "true";

if (visualRegressionMode) {
  document.documentElement.dataset.visualRegression = "true";
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

void retireMissionControlServiceWorkers();

createRoot(root).render(
  <React.StrictMode>
    <UiPreferencesProvider>
      <App />
    </UiPreferencesProvider>
  </React.StrictMode>,
);
