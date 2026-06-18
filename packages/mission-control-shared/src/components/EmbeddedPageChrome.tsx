import { createContext, useContext, type ReactNode } from "react";

const EmbeddedPageChromeContext = createContext(false);

export function EmbeddedPageChromeProvider({ children }: { children: ReactNode }) {
  return <EmbeddedPageChromeContext.Provider value>{children}</EmbeddedPageChromeContext.Provider>;
}

export function useEmbeddedPageChrome(): boolean {
  return useContext(EmbeddedPageChromeContext);
}
