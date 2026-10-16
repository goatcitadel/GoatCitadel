import { lazy, Suspense, useCallback } from "react";
import { buildAppHref, type AppRoute } from "../../../app/route-model";
import { resolveCockpitCompatibility } from "../../app/cockpit-compatibility";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_COLUMN } from "../../ui/area-layout";
import { LIBRARY_SECTION_LABELS } from "./library-sections";

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
  const query = new URLSearchParams(route.search);
  const view = query.get("view") ?? "";
  const initialPackId = view.startsWith(PACK_VIEW) ? view.slice(PACK_VIEW.length).trim() || undefined : undefined;
  const requestedRun = query.get("runId"),
    requestedSession = query.get("sessionId"),
    requestedScoring = query.get("scoring");
  const initialRunId = requestedRun && requestedRun.trim() ? requestedRun : undefined,
    initialSessionId = requestedSession && requestedSession.trim() ? requestedSession : undefined;
  const focusError = ["view", "runId", "sessionId", "scoring"].some((key) => query.getAll(key).length > 1)
    ? "The prompt-pack record link contains conflicting selection values."
    : (requestedRun !== null && requestedRun.length > 256) ||
        (requestedSession !== null && requestedSession.length > 256)
      ? "The prompt-pack run or session link is too long."
      : requestedRun !== null && !initialRunId
        ? "The prompt-pack run link is incomplete."
        : (requestedRun !== null || requestedSession !== null || requestedScoring !== null) &&
            (!initialPackId || !initialRunId)
          ? "Run and scoring inspection requires a prompt pack and run."
          : requestedSession !== null && !initialSessionId
            ? "The prompt-pack session link is incomplete."
            : requestedScoring !== null && requestedScoring !== "human" && requestedScoring !== "auto"
              ? "The requested prompt-pack scoring view is unavailable."
              : undefined;
  const navigate = useCallback(
    (target: AppRoute) => {
      const owner = resolveCockpitCompatibility(buildAppHref(target));
      if (owner.kind === "native") route.navigate(owner.href);
    },
    [route],
  );
  // The area's title row and tabs stay in every state; the shared workbench below keeps its own layout.
  const header = (
    <div className={`${AREA_COLUMN} px-4 pt-4 sm:px-6 sm:pt-6`}>
      <AreaHeader title={LIBRARY_SECTION_LABELS["prompt-packs"]} />
    </div>
  );
  if (focusError) {
    const inspect = new URLSearchParams(route.search);
    inspect.delete("runId");
    inspect.delete("sessionId");
    inspect.delete("scoring");
    if (query.getAll("view").length !== 1) inspect.delete("view");
    return (
      <>
        {header}
        <section aria-label="Prompt-pack record outcome" className={`${AREA_COLUMN} space-y-3 p-4 sm:px-6`}>
          <p role="status">{focusError}</p>
          <NativeOwnerLink
            href={`/library/prompt-packs?${inspect}${route.hash}`}
            scope={JSON.stringify([workspaceId, initialPackId, requestedRun, requestedSession, requestedScoring])}
          >
            {initialPackId && query.getAll("view").length === 1 ? "Inspect this pack" : "Browse prompt packs"}
          </NativeOwnerLink>
        </section>
      </>
    );
  }
  return (
    <>
      {header}
      <Suspense
        fallback={
          <p role="status" className="p-4 text-sm text-fg-muted">
            Loading prompt packs…
          </p>
        }
      >
        <PromptPacksWorkbenchPage
          key={JSON.stringify([workspaceId, initialPackId, initialRunId, initialSessionId, requestedScoring])}
          workspaceId={workspaceId}
          variant="library"
          navigate={navigate}
          initialPackId={initialPackId}
          initialRunId={initialRunId}
          initialSessionId={initialSessionId}
          initialDetailTab={
            requestedScoring === "human" ? "review" : requestedScoring === "auto" ? "assessment" : undefined
          }
        />
      </Suspense>
    </>
  );
}
