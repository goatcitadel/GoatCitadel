import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether a tooltip may open when its control takes focus. Dialogs, sheets, popovers and menus switch it off for what
 * they hold: their first control is focused by the layer itself, and a tooltip opened by that focus would take the
 * first Escape that is meant to close the layer. Hover and long-press still show the name.
 */
const TooltipFocusContext = createContext(true);

export const useTooltipOpensOnFocus = () => useContext(TooltipFocusContext);

export function NoFocusTooltips({ children }: { children: ReactNode }) {
  return <TooltipFocusContext.Provider value={false}>{children}</TooltipFocusContext.Provider>;
}
