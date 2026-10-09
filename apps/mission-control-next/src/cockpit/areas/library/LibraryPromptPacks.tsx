import { lazy, Suspense, useCallback } from "react";
import { buildAppHref, type AppRoute } from "../../../app/route-model";
import { resolveCockpitCompatibility } from "../../app/cockpit-compatibility";
import { useCockpitRoute } from "../../app/use-cockpit-route";

// The heavy workbench stays lazy (Task16); it is the same shared owner Classic mounts, not a copy.
const PromptPacksWorkbenchPage = lazy(async () => ({
  default: (await import("../../../features/prompt-packs/PromptPacksWorkbenchPage")).PromptPacksWorkbenchPage,
}));

const PACK_VIEW = "pack:";

/**
 * Native Library prompt packs: the shared prompt-pack workbench (authoring, runs, scoring, review, comparison, export)
 * in the cockpit, scoped to the active workspace. `view=pack:<id>` focuses one pack. The workbench only navigates to
 * a pack run's conversation, which opens natively in Chat.
 */
export function LibraryPromptPacks({ workspaceId }: { workspaceId: string }) {
  const route = useCockpitRoute();
  const view = new URLSearchParams(route.search).get("view") ?? "";
  const initialPackId = view.startsWith(PACK_VIEW) ? view.slice(PACK_VIEW.length).trim() || undefined : undefined;
  const navigate = useCallback(
    (target: AppRoute) => {
      const owner = resolveCockpitCompatibility(buildAppHref(target));
      if (owner.kind === "native") route.navigate(owner.href);
    },
    [route],
  );
  return (
    <Suspense
      fallback={
        <p role="status" className="p-4 text-sm text-fg-muted">
          Loading prompt packs…
        </p>
      }
    >
      <PromptPacksWorkbenchPage
        key={`${workspaceId}:${initialPackId ?? ""}`}
        workspaceId={workspaceId}
        variant="library"
        navigate={navigate}
        initialPackId={initialPackId}
      />
    </Suspense>
  );
}
