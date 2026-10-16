import { createContext, useContext, type ReactNode } from "react";

const EmbeddedPageHeaderContext = createContext(false);

/**
 * Marks shared feature pages as embedded in a host that already draws the page's single h1 (the Cockpit's
 * AreaHeader). Inside it, `NativePageFrame` and the prompt-pack hero drop their own h1 and keep their non-title
 * parts (description, release-scope badge, metrics, actions). Outside it, Classic rendering is unchanged.
 */
export function EmbeddedPageHeaderProvider({ children }: { children: ReactNode }) {
  return <EmbeddedPageHeaderContext.Provider value>{children}</EmbeddedPageHeaderContext.Provider>;
}

/** True when a host above already owns the page heading. */
export function useEmbeddedPageHeader(): boolean {
  return useContext(EmbeddedPageHeaderContext);
}
