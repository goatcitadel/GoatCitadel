import { retireMissionControlServiceWorkers } from "./service-worker-cleanup";
import { resolveShellPreference } from "./shell-preference";
import { resetDevBrowserStorage } from "./dev-reset";

declare const __GC_DEV_RESET_ID__: string;

// Run before loading either entry: imported auth/preference owners may cache storage.
for (const name of ["localStorage", "sessionStorage"] as const) {
  try {
    resetDevBrowserStorage(__GC_DEV_RESET_ID__, window[name]);
  } catch {
    // Browser privacy settings can make the storage accessor itself unavailable.
    // eslint-disable-next-line no-console -- dev-only reset failure must stay visible to the developer.
    if (__GC_DEV_RESET_ID__) console.warn("Use a private window if GoatCitadel browser storage is unavailable.");
  }
}

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

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

const shell = resolveShellPreference({ search: globalThis.location?.search ?? "", storage });
document.documentElement.dataset.shell = shell;

if (shell === "cockpit") {
  void import("./cockpit-entry").then(({ mountCockpit }) => mountCockpit(root));
} else {
  void import("./classic-entry").then(({ mountClassic }) => mountClassic(root));
}
