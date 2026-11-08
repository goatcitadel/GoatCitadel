import { beforeAll } from "vitest";

/** Owner tests can start with real dialog controls ready. Cold loading is covered by the dialog tests. */
export function prepareReadyDialogFixture(kind: "cockpit" | "shared" = "cockpit") {
  beforeAll(async () => {
    if (kind === "cockpit") {
      const { preloadCockpitDialogRuntime } = await import("../cockpit/ui/Dialog");
      await preloadCockpitDialogRuntime();
    } else {
      const { preloadGCModalRuntime } = await import("@goatcitadel/mission-control-shared/components/ui/GCModal");
      await preloadGCModalRuntime();
    }
  });
}
