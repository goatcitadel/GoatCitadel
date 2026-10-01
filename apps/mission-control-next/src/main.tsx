import { retireMissionControlServiceWorkers } from "./service-worker-cleanup";
import { resolveShellPreference } from "./shell-preference";

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
