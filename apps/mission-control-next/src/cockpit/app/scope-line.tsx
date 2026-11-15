import { createContext, useContext, type ReactNode } from "react";
import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCitadelName } from "../data/use-citadel-name";
import { useWorkspaceName } from "../data/use-workspace-name";

/** The Citadel and workspace the page belongs to, in the wording the More sheet uses. */
export function cockpitScopeLine(citadelName: string, workspaceName: string | undefined): string {
  return citadelName.startsWith("Reading Citadel")
    ? "Loading workspace…"
    : `${citadelName} / ${workspaceName ?? "Workspace"}`;
}

const ScopeLineContext = createContext(false);

/**
 * Below the desktop width the sidebar that names the workspace is not on screen, so pages say where they are. The
 * provider only decides whether that applies; the names are read by the line itself, so the shell reads nothing
 * (and needs no query client) on a desktop.
 */
export function ScopeLineProvider({ children }: { children: ReactNode }) {
  const small = useMediaQuery(RESPONSIVE_QUERIES.belowDesktop);
  return <ScopeLineContext.Provider value={small}>{children}</ScopeLineContext.Provider>;
}

function ScopeLineText() {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const workspaceName = useWorkspaceName(activeCitadelId, activeWorkspaceId);
  const citadelName = useCitadelName(activeCitadelId, true);
  const line = cockpitScopeLine(citadelName, workspaceName);
  return (
    <p data-cockpit-page-scope="" className="mt-1 truncate text-xs text-fg-muted">
      {line.startsWith("Loading") ? line : `In ${line}`}
    </p>
  );
}

/** One quiet line under a page heading naming the Citadel and workspace; nothing outside a provider or on a desktop. */
export function ScopeLine() {
  return useContext(ScopeLineContext) ? <ScopeLineText /> : null;
}
