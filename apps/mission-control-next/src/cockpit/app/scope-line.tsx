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

const ScopeLineContext = createContext<string | null>(null);

/**
 * Below the desktop width the sidebar that names the workspace is not on screen, so pages say where they are. The
 * names are read only there; on a desktop this provides nothing and reads nothing.
 */
export function ScopeLineProvider({ children }: { children: ReactNode }) {
  const small = useMediaQuery(RESPONSIVE_QUERIES.belowDesktop);
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const workspaceName = useWorkspaceName(activeCitadelId, activeWorkspaceId, small);
  const citadelName = useCitadelName(activeCitadelId, small);
  return (
    <ScopeLineContext.Provider value={small ? cockpitScopeLine(citadelName, workspaceName) : null}>
      {children}
    </ScopeLineContext.Provider>
  );
}

/** One quiet line under a page heading naming the Citadel and workspace; nothing outside a provider or on a desktop. */
export function ScopeLine() {
  const line = useContext(ScopeLineContext);
  if (!line) return null;
  return (
    <p data-cockpit-page-scope="" className="mt-1 truncate text-xs text-fg-muted">
      {line.startsWith("Loading") ? line : `In ${line}`}
    </p>
  );
}
