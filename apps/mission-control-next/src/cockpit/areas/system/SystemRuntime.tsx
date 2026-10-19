import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import {
  getGatewayCallerScopeRevision,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { buildAppHref, parseAppRoute } from "../../../app/route-model";
import { RuntimeRoutePage } from "../../../features/native-routes/ops/RuntimeRoutePage";
import type { NativeRoutePagesProps } from "../../../features/native-routes/types";
import { resolveCockpitCompatibility } from "../../app/cockpit-compatibility";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useWorkspaceName } from "../../data/use-workspace-name";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { EmbeddedClassicPage } from "../../ui/EmbeddedClassicPage";

const RemoteWorkersRoutePage = lazy(async () => ({
  default: (await import("../../../features/native-routes/ops/RemoteWorkersRoutePage")).RemoteWorkersRoutePage,
}));
function readWorkerSelection(search: string) {
  const params = new URLSearchParams(search);
  const workers = params.getAll("workerId"),
    assignments = params.getAll("assignmentId");
  const workerId = workers[0],
    assignmentId = assignments[0];
  const invalid =
    workers.some((value) => !value || value !== workerId) ||
    assignments.some((value) => !value || value !== assignmentId) ||
    (assignmentId !== undefined && workerId === undefined);
  return { workerId, assignmentId, invalid };
}
/** Keep the existing runtime reads, controls and held boundaries with their canonical owner. */
export function SystemRuntime({ section = "runtime" }: { section?: "runtime" | "diagnostics" | "costs" | "workers" }) {
  const preferences = useUiPreferences(),
    location = useCockpitRoute();
  const workspaceId = preferences.activeWorkspaceId ?? "default";
  const workerSelection = readWorkerSelection(location.search);
  const workerRecovery = new URLSearchParams(location.search);
  workerRecovery.delete("workerId");
  workerRecovery.delete("assignmentId");
  const workerRecoveryHref =
    "/system/runtime/workers" + (workerRecovery.size ? "?" + workerRecovery : "") + location.hash;
  const callerRevision = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScopeRevision, () => 0);
  const access = useProjectAccess(
    JSON.stringify(["system-runtime", preferences.activeCitadelId, workspaceId, callerRevision]),
  );
  const workspaceName = useWorkspaceName(preferences.activeCitadelId, workspaceId);
  const route = parseAppRoute(new URL("/ops/" + section + location.search + location.hash, "http://cockpit.invalid"));
  const [navigationUnavailable, setNavigationUnavailable] = useState<string | null>(null);
  const navigate: NativeRoutePagesProps["navigate"] = (next, options) => {
    if (!access.current() || getGatewayCallerScopeRevision() !== callerRevision) return;
    const target = new URL(buildAppHref(next), "http://cockpit.invalid");
    const parameters = new URLSearchParams(location.search);
    target.searchParams.forEach((value, key) => parameters.set(key, value));
    parameters.set("workspaceId", workspaceId);
    if (preferences.activeCitadelId) parameters.set("citadelId", preferences.activeCitadelId);
    parameters.delete("shell");
    parameters.delete("shellScope");
    const resolution = resolveCockpitCompatibility(target.pathname + "?" + parameters + (target.hash || location.hash));
    if (resolution.kind !== "native") {
      setNavigationUnavailable(access.identity);
      return;
    }
    setNavigationUnavailable(null);
    location.navigate(resolution.href, options);
  };
  return (
    <section className="min-w-0">
      {/* The area header keeps the System tabs in every state; the embedded runtime page below keeps its own controls. */}
      <div className={AREA_PAGE}>
        <AreaHeader
          title={section === "costs" ? "Spend details" : "Runtime"}
          description={
            section === "costs"
              ? "Cost coverage and per-provider records from the Gateway."
              : "Runtime records, controls and held boundaries from the Gateway."
          }
        />
      </div>
      {navigationUnavailable === access.identity ? (
        <p role="status" className="p-4 text-sm text-fg-secondary">
          This source destination is unavailable in Cockpit.
        </p>
      ) : null}
      {section === "workers" ? (
        workerSelection.invalid ? (
          <div role="alert" className="p-4 text-sm text-fg-secondary">
            <p>This link does not identify one worker and its assignment.</p>
            <NativeOwnerLink
              href={workerRecoveryHref}
              scope={[access.identity, location.search, location.hash]}
              className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
            >
              Open worker records
            </NativeOwnerLink>
          </div>
        ) : (
          <EmbeddedClassicPage>
            <Suspense
              fallback={
                <p role="status" className="p-4 text-sm text-fg-secondary">
                  Loading worker inspection…
                </p>
              }
            >
              <RemoteWorkersRoutePage
                key={
                  access.identity +
                  ":workers:" +
                  JSON.stringify([workerSelection.workerId, workerSelection.assignmentId])
                }
                initialWorkerId={workerSelection.workerId}
                initialAssignmentId={workerSelection.assignmentId}
                route={route}
                activeWorkspaceId={workspaceId}
                activeWorkspaceName={workspaceName ?? "Current workspace"}
                activeCitadelId={preferences.activeCitadelId ?? undefined}
                setActiveWorkspaceId={preferences.setActiveWorkspaceId}
                navigate={navigate}
              />
            </Suspense>
          </EmbeddedClassicPage>
        )
      ) : (
        <EmbeddedClassicPage>
          <RuntimeRoutePage
            key={access.identity + ":" + section}
            route={route}
            activeWorkspaceId={workspaceId}
            activeWorkspaceName={workspaceName ?? "Current workspace"}
            activeCitadelId={preferences.activeCitadelId ?? undefined}
            setActiveWorkspaceId={preferences.setActiveWorkspaceId}
            navigate={navigate}
          />
        </EmbeddedClassicPage>
      )}
    </section>
  );
}
