import { useEffect } from "react";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import { listCitadels } from "@goatcitadel/mission-control-shared/api/citadels";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { requestCockpitToast } from "../../cockpit/ui/toast-runtime";
import { clearTutorialReturn, readTutorialReturn } from "./handoff";

export function useTutorialReturn(ready: boolean, accessRevision: number): void {
  const { setActiveScope } = useUiPreferences();

  useEffect(() => {
    if (!ready) return;
    const url = new URL(location.href);
    const outcome = url.searchParams.get("tutorialEnded");
    if (outcome !== "finished" && outcome !== "exited" && outcome !== "unavailable") return;
    const scope = readTutorialReturn();
    const controller = new AbortController();
    const { signal } = controller;
    async function restore() {
      let restored = false;
      if (scope) {
        try {
          const [citadels, workspaces] = await Promise.all([
            listCitadels("active", 500, { signal }),
            fetchWorkspaces("active", 500, scope.citadelId, { signal }),
          ]);
          if (signal.aborted) return;
          restored =
            citadels.items.some((item) => item.citadelId === scope.citadelId && item.lifecycleStatus === "active") &&
            workspaces.items.some(
              (item) =>
                item.workspaceId === scope.workspaceId &&
                item.citadelId === scope.citadelId &&
                item.lifecycleStatus === "active",
            );
          if (restored) setActiveScope(scope, { tabOnly: true });
        } catch {
          // Keep the normal saved scope if the returning scope cannot be confirmed.
        }
      }
      if (signal.aborted) return;
      clearTutorialReturn();
      const current = new URL(location.href);
      current.searchParams.delete("tutorialEnded");
      history.replaceState(history.state, "", current);
      const message =
        outcome === "finished"
          ? "Tutorial complete. Practice data cleared."
          : outcome === "exited"
            ? "Tutorial ended. Practice data cleared."
            : "The tutorial could not start. You can continue in Chat.";
      requestCockpitToast(
        (toast) =>
          toast.info(
            message,
            scope && !restored
              ? { description: "The original workspace could not be confirmed. Chat opened in your current workspace." }
              : undefined,
          ),
        () => true,
      );
    }
    void restore();
    return () => controller.abort();
  }, [ready, accessRevision, setActiveScope]);
}
